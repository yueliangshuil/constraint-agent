/**
 * 手写 ReAct 循环（设计过程见 DEV_LOG #9）：
 * 模型产出工具调用 → Zod 校验入参 → 组装执行上下文 → 规则引擎判定（硬门槛）
 * → pass 走 MCP 执行 / block 反馈违规约束让模型重规划 / conflict 暂停待人工裁决
 * → 最大 6 轮强制终止，全程事件回调（SSE 推送）+ 审计落库。
 */
import { z } from "zod";
import { chatWithTools, type PlainMessage, type ToolDef } from "./llm";
import { getSupabaseAdmin } from "./supabase";
import { evaluateConstraints } from "./rule-engine";
import { structurizeRules } from "./structurize";
import { connectMcpServer, callMcpTool, toOpenAIToolDefs } from "./mcp/client";
import { createAllServers } from "./mcp/servers";
import { bindSystemArgs, filterToolsForTask } from "./agent-helpers";
import type { ExecContext } from "@/types/constraint";

export interface AgentEvent {
  type:
    | "stage"
    | "plan"
    | "constraints"
    | "validation"
    | "tool_call"
    | "tool_result"
    | "decision_request"
    | "execution"
    | "done";
  data: Record<string, unknown>;
}

export interface TaskInput {
  task: string;
  role: ExecContext["role"];
  env: "prod" | "staging";
  isEmergency: boolean;
  hasTicket: boolean;
  approvedByDirector: boolean;
  quotaUsed: number;
  /** 模拟小时（0-23）：演示/评测时可控触发时间类约束，缺省用服务器时钟 */
  hourOverride?: number;
  /** 模拟星期（1=周一 ~ 7=周日）：与 hourOverride 配套的时间模拟器，缺省用服务器时钟 */
  weekdayOverride?: number;
  /** 任务核心动作：该动作执行成功才算任务完成（辅助动作成功不能算完成） */
  expectedAction?: ExecContext["action"];
  /** 认证用户 ID（审计归属，路由层注入） */
  userId?: string;
  /** 租户 ID（数据隔离，路由层注入） */
  tenantId?: string;
}

export interface AgentResult {
  status: "completed" | "blocked" | "conflict" | "cancelled";
  conclusion: string;
  steps: unknown[];
}

const MAX_ROUNDS = 6;
const SIMILARITY_FLOOR = 0.5; // fail-closed：召回相似度低于阈值 → 保守拦截

/** 模型工具调用的入参 Schema（Agent 层校验，第二重保险） */
const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  deploy_service: z.object({
    service: z.string().min(1),
    // env 由系统绑定（bindSystemArgs 注入场景环境），模型传值仅作校验
    env: z.enum(["prod", "staging"]).optional(),
    version: z.string().min(1),
  }),
  create_change_ticket: z.object({
    service: z.string().min(1),
    reason: z.string().min(1),
    severity: z.enum(["normal", "urgent"]),
  }),
  query_quota: z.object({
    service: z.string().min(1),
  }),
};

export async function runAgent(
  input: TaskInput,
  emit: (e: AgentEvent) => void,
  signal?: AbortSignal
): Promise<AgentResult> {
  const now = new Date();
  const hour = input.hourOverride ?? now.getHours();
  const weekday = input.weekdayOverride ?? (now.getDay() === 0 ? 7 : now.getDay());
  const ctxBase: ExecContext = {
    hour,
    weekday,
    isWorkday: weekday >= 1 && weekday <= 5,
    role: input.role,
    action: "deploy_service",
    env: input.env,
    quotaUsed: input.quotaUsed,
    quotaLimit: 3,
    isEmergency: input.isEmergency,
    hasTicket: input.hasTicket,
    approvedByDirector: input.approvedByDirector,
    hasVersionDeployed: false,
  };

  const recordAudit = async (r: { action: string; detail: string; result: string }) => {
    steps.push({ kind: "audit", ...r });
    emit({ type: "tool_result", data: { kind: "audit", ...r } });
  };

  const steps: Record<string, unknown>[] = [];

  // 执行记录持久化（审计可回放）
  const db = getSupabaseAdmin();
  const { data: execRow } = await db
    .from("executions")
    .insert({
      task: input.task,
      context: {
        role: input.role,
        env: input.env,
        isEmergency: input.isEmergency,
        hasTicket: input.hasTicket,
        approvedByDirector: input.approvedByDirector,
        quotaUsed: input.quotaUsed,
        hour: hour,
        weekday: weekday,
        isWorkday: weekday >= 1 && weekday <= 5,
      },
      status: "running",
      steps: [],
      user_id: input.userId ?? null,
      tenant_id: input.tenantId ?? "demo-tenant",
    })
    .select()
    .single();
  const executionId = execRow?.id as string | undefined;
  if (executionId) {
    emit({ type: "execution", data: { id: executionId } });
  }
  const finalize = async (
    status: "completed" | "blocked" | "conflict" | "cancelled",
    conclusion: string
  ): Promise<AgentResult> => {
    if (executionId) {
      await db
        .from("executions")
        .update({
          status,
          steps: steps as never,
          finished_at: new Date().toISOString(),
          plan: { conclusion } as never,
        })
        .eq("id", executionId);
    }
    return { status, conclusion, steps };
  };

  emit({ type: "plan", data: { task: input.task } });

  try {
  // ---------- 1. MCP 连接（部署工具 + 规则检索） ----------
  // 部署事件落库：配额约束的真实状态来源（DEV_LOG #21）
  const onDeploy = async (r: { service: string; env: string; version: string }) => {
    await db.from("deploy_records").insert({
      service: r.service,
      env: r.env,
      version: r.version,
      execution_id: executionId ?? null,
      user_id: input.userId ?? null,
      tenant_id: input.tenantId ?? "demo-tenant",
    });
  };
  // 配额查询与规则引擎同源（deploy_records 真实计数），杜绝 mock 回复与校验状态不一致
  const onQueryQuota = async (service: string): Promise<string> => {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const { count } = await db
      .from("deploy_records")
      .select("id", { count: "exact", head: true })
      .eq("service", service)
      .eq("env", ctxBase.env)
      .gte("created_at", startOfDay.toISOString());
    const used = (count ?? 0) + ctxBase.quotaUsed;
    return `${service} 当日已发布 ${used} 次，配额 ${ctxBase.quotaLimit} 次，剩余 ${Math.max(0, ctxBase.quotaLimit - used)} 次`;
  };
  // 工单落库：hasTicket 约束的真实状态来源（模型创建的工单真实生效）
  const onTicket = async (r: { service: string; env: string; reason: string; severity: string }) => {
    await db.from("ticket_records").insert({
      service: r.service,
      env: r.env,
      reason: r.reason,
      severity: r.severity,
      execution_id: executionId ?? null,
      user_id: input.userId ?? null,
      tenant_id: input.tenantId ?? "demo-tenant",
    });
  };
  const servers = createAllServers(recordAudit, onDeploy, onQueryQuota, onTicket);
  const [deployConn, ruleConn] = await Promise.all([
    connectMcpServer(servers.deploy, "deploy-tools"),
    connectMcpServer(servers.ruleSearch, "rule-search"),
  ]);

  // ---------- 2. 约束召回（规则检索 MCP → RAG 检索服务） ----------
  emit({ type: "stage", data: { stage: "retrieving" } });
  let ruleText = "";
  let maxSimilarity = 0;
  try {
    const payload = await callMcpTool(ruleConn, "search_rules", {
      query: `${input.task} ${input.env} 环境 业务约束规则`,
    });
    const parsed = JSON.parse(payload) as { chunks: { content: string; similarity: number }[]; text: string };
    maxSimilarity = Math.max(0, ...parsed.chunks.map((c) => c.similarity));
    ruleText = parsed.text;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "规则检索失败";
    await recordAudit({ action: "search_rules", detail: reason, result: "block" });
    return finalize("blocked", `规则检索失败，保守拦截：${reason}`);
  }

  // fail-closed：召回质量不足 → 保守拦截（宁拦勿放）
  if (maxSimilarity < SIMILARITY_FLOOR) {
    const msg = `未匹配到明确约束（最高相似度 ${maxSimilarity.toFixed(3)} < ${SIMILARITY_FLOOR}），按 fail-closed 策略保守拦截，需人工确认。`;
    await recordAudit({ action: "constraint_recall", detail: msg, result: "block" });
    emit({ type: "done", data: { conclusion: msg, status: "blocked" } });
    return finalize("blocked", msg);
  }

  // ---------- 3. 约束结构化（LLM + Zod + 白名单） ----------
  emit({ type: "stage", data: { stage: "structuring" } });
  const { constraints, invalid } = await structurizeRules(ruleText);
  emit({
    type: "constraints",
    data: { constraints, invalid },
  });
  if (invalid.length > 0) {
    const msg = `约束结构化失败（${invalid.map((i) => i.ruleName).join("、")}），保守拦截需人工复核。`;
    await recordAudit({ action: "structurize", detail: msg, result: "block" });
    return finalize("blocked", msg);
  }

  // ---------- 4. 手写 ReAct 循环 ----------
  // Agent 最小权限：按任务核心动作裁剪工具集（模型物理上拿不到范围外工具）
  const allToolDefs = await toOpenAIToolDefs([deployConn]);
  const scopedToolDefs = filterToolsForTask(allToolDefs, input.expectedAction);
  emit({
    type: "stage",
    data: {
      stage: "planning",
      scopedTools: scopedToolDefs.map((t) => t.function.name),
    },
  });
  const model = null; // 模型调用走手写客户端 chatWithTools（DEV_LOG #26）

  const constraintText = constraints
    .map(
      (c, i) =>
        `[${i + 1}] 「${c.ruleName}」(type=${c.ruleType}, priority=${c.priority}, 适用=${c.forbidAction.join("/")}) ${c.sourceChunk}`
    )
    .join("\n");

  const weekdayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const systemPrompt = [
    "你是业务约束感知的规划 Agent，负责在规则约束下规划并执行任务。",
    "",
    "【当前执行上下文（系统提供的事实，据此规划，不要假设）】",
    `- 执行角色：${ctxBase.role}（身份由登录认证决定）`,
    `- 目标环境：${ctxBase.env}`,
    `- 当前时间：${String(ctxBase.hour).padStart(2, "0")}:00，${weekdayNames[ctxBase.weekday - 1]}${ctxBase.isWorkday ? "（工作日）" : "（非工作日）"}`,
    `- 紧急发布：${ctxBase.isEmergency ? "是" : "否"}`,
    `- 已关联变更工单：${ctxBase.hasTicket ? "是" : "否"}`,
    `- 已获总监审批：${ctxBase.approvedByDirector ? "是" : "否"}`,
    `- 当日该服务已发布次数：${ctxBase.quotaUsed}（上限 ${ctxBase.quotaLimit}）`,
    "",
    "【当前生效的业务约束】",
    constraintText || "（无）",
    "",
    "【执行规则】",
    "1. 依据执行上下文与业务约束规划工具调用序列；每次工具调用都会被规则引擎校验：通过才执行，违规会被拦截并反馈给你，收到拦截后请重新规划合规方案；",
    "2. 任务完成或确认无法合规完成时，输出最终结论（简体中文，Markdown 格式：分点说明执行了什么、校验结果与被拦截的原因）。",
    "3. 所有面向用户的输出一律使用简体中文。",
  ].join("\n");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: PlainMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: input.task },
  ];
  let blockedAny = false; // 是否有工具调用被拦截
  const executedActions: string[] = []; // 成功执行的动作清单（终态判定用）

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) {
      return finalize("cancelled", "任务已取消");
    }
    const response = await chatWithTools(messages, scopedToolDefs as ToolDef[]);
    const toolCalls = response.toolCalls;

    if (toolCalls.length === 0) {
      let conclusion = response.content ?? "";
      // 终态判定（三规则）：
      // 1. 核心动作执行成功 → completed
      // 2. 有任何拦截 → blocked（辅助动作成功 ≠ 任务完成）
      // 3. 声明了核心动作但从未执行 → blocked（模型空口"完成"不可信——
      //    用户实测"发布完成但执行 0 次"的漏洞修复）
      const coreDone =
        input.expectedAction !== undefined && executedActions.includes(input.expectedAction);
      let effectiveStatus: "completed" | "blocked" = "completed";
      if (coreDone) {
        effectiveStatus = "completed";
      } else if (blockedAny) {
        effectiveStatus = "blocked";
      } else if (input.expectedAction !== undefined) {
        effectiveStatus = "blocked";
        steps.push({
          kind: "note",
          detail: `模型未执行核心动作（${input.expectedAction}）即输出结论，按未完成处理`,
        });
        conclusion = `【系统判定】任务核心动作（${input.expectedAction}）未执行，本次任务按未完成处理。\n\n模型原结论：\n${conclusion}`;
      }
      emit({ type: "done", data: { conclusion, status: effectiveStatus } });
      return finalize(effectiveStatus, conclusion);
    }

    // 记录本轮 assistant 消息（含工具调用）
    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    for (const tc of toolCalls) {
      // 模型工具参数是 JSON 字符串，解析失败按入参非法处理
      let tcArgs: Record<string, unknown> = {};
      try {
        tcArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        /* 保持空对象，走入参校验拦截 */
      }
      emit({ type: "tool_call", data: { name: tc.name, args: tcArgs } });

      // 2a. 入参校验（第二重保险）
      const schema = TOOL_SCHEMAS[tc.name];
      if (!schema) {
        const msg = `工具 ${tc.name} 不存在，已拦截`;
        await recordAudit({ action: tc.name, detail: msg, result: "block" });
        messages.push({ role: "tool", content: msg, tool_call_id: tc.id });
        continue;
      }
      const parsedArgs = schema.safeParse(tcArgs);
      if (!parsedArgs.success) {
        const msg = `工具 ${tc.name} 入参非法：${parsedArgs.error.issues[0]?.message ?? "格式错误"}`;
        await recordAudit({ action: tc.name, detail: msg, result: "block" });
        messages.push({ role: "tool", content: msg, tool_call_id: tc.id });
        continue;
      }

      // 2b. 系统参数绑定：关键参数（env）由任务场景决定，模型不可自由指定
      const rawArgs = parsedArgs.data as { env?: "prod" | "staging" };
      const bind = bindSystemArgs(tc.name, rawArgs as Record<string, unknown>, ctxBase.env);
      if (bind.violation) {
        blockedAny = true;
        steps.push({ tool: tc.name, args: rawArgs, verdict: "block", violated: bind.violation });
        await recordAudit({ action: tc.name, detail: bind.violation, result: "block" });
        messages.push({ role: "tool", content: bind.violation + "，请重新规划。", tool_call_id: tc.id });
        continue;
      }
      const args = bind.args as { env?: "prod" | "staging"; service?: string; version?: string };

      // 2c. 组装执行上下文 → 规则引擎判定（硬门槛）
      // 配额/幂等/工单真实状态：当日记录（跨任务、跨会话真实累积）
      let quotaUsed = ctxBase.quotaUsed;
      let hasVersionDeployed = false;
      let hasTicketReal = ctxBase.hasTicket;
      if (tc.name === "deploy_service") {
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const service = String(args.service ?? "");
        const version = String(args.version ?? "");
        const { count } = await db
          .from("deploy_records")
          .select("id", { count: "exact", head: true })
          .eq("service", service)
          .eq("env", ctxBase.env)
          .gte("created_at", startOfDay.toISOString());
        quotaUsed += count ?? 0;
        const { count: sameVersion } = await db
          .from("deploy_records")
          .select("id", { count: "exact", head: true })
          .eq("service", service)
          .eq("env", ctxBase.env)
          .eq("version", version)
          .gte("created_at", startOfDay.toISOString());
        hasVersionDeployed = (sameVersion ?? 0) > 0;
        // hasTicket 真实状态：表单预置 OR 当日该服务已有工单记录（模型创建的工单真实生效）
        const { count: ticketCount } = await db
          .from("ticket_records")
          .select("id", { count: "exact", head: true })
          .eq("service", service)
          .eq("env", ctxBase.env)
          .gte("created_at", startOfDay.toISOString());
        hasTicketReal = ctxBase.hasTicket || (ticketCount ?? 0) > 0;
      }
      const ctx: ExecContext = {
        ...ctxBase,
        action: tc.name as ExecContext["action"],
        env: ctxBase.env, // 校验环境永远取场景值，与模型声称无关
        quotaUsed,
        hasVersionDeployed,
        hasTicket: hasTicketReal,
      };
      const decision = evaluateConstraints(constraints, ctx);
      emit({
        type: "validation",
        data: {
          tool: tc.name,
          verdict: decision.verdict,
          context: { ...ctx },
          violated:
            decision.verdict === "block"
              ? decision.violated.map((v) => v.constraint.ruleName)
              : [],
        },
      });

      // 2c. 三分支
      if (decision.verdict === "pass") {
        try {
          const result = await callMcpTool(deployConn, tc.name, args);
          executedActions.push(tc.name);
          steps.push({ tool: tc.name, args, verdict: "pass" });
          await recordAudit({
            action: tc.name,
            detail: `校验通过并执行：${result}`,
            result: "executed",
          });
          messages.push({ role: "tool", content: result, tool_call_id: tc.id });
        } catch (err) {
          const msg = `工具执行失败：${err instanceof Error ? err.message : "未知错误"}`;
          messages.push({ role: "tool", content: msg, tool_call_id: tc.id });
        }
      } else if (decision.verdict === "block") {
        blockedAny = true;
        const violated = decision.violated
          .map((v) => `「${v.constraint.ruleName}」（${v.constraint.expression}）`)
          .join("；");
        const msg = `执行被规则引擎拦截。违规约束：${violated}。请重新规划合规方案。`;
        steps.push({ tool: tc.name, args, verdict: "block", violated });
        await recordAudit({ action: tc.name, detail: msg, result: "block" });
        messages.push({ role: "tool", content: msg, tool_call_id: tc.id });
      } else {
        // conflict → 暂停，P2 接人工裁决面板
        emit({
          type: "decision_request",
          data: {
            blockers: decision.blockers.map((b) => b.constraint),
            exemptions: decision.exemptions.map((e) => e.constraint),
            tool: tc.name,
          },
        });
        const msg = "检测到同优先级约束冲突，任务暂停，等待人工裁决。";
        steps.push({
          kind: "conflict",
          tool: tc.name,
          blockers: decision.blockers.map((b) => b.constraint),
          exemptions: decision.exemptions.map((e) => e.constraint),
        });
        await recordAudit({ action: tc.name, detail: msg, result: "conflict" });
        return finalize("conflict", msg);
      }
    }
  }

  const msg = `达到最大轮数（${MAX_ROUNDS}），任务强制终止。`;
  emit({ type: "done", data: { conclusion: msg, status: "blocked" } });
  return finalize("blocked", msg);
  } catch (err) {
    // 任何未捕获异常：执行记录必须落终态，绝不卡在 running（用户实测反馈的僵尸状态）
    const message = err instanceof Error ? err.message : "未知异常";
    console.error("[agent] 执行异常:", err);
    return finalize("blocked", `执行异常：${message}`);
  }
}
