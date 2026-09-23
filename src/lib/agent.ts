/**
 * 手写 ReAct 循环（设计过程见 DEV_LOG #9）：
 * 模型产出工具调用 → Zod 校验入参 → 组装执行上下文 → 规则引擎判定（硬门槛）
 * → pass 走 MCP 执行 / block 反馈违规约束让模型重规划 / conflict 暂停待人工裁决
 * → 最大 6 轮强制终止，全程事件回调（SSE 推送）+ 审计落库。
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getChatModel } from "./llm";
import { getSupabaseAdmin } from "./supabase";
import { evaluateConstraints } from "./rule-engine";
import { structurizeRules } from "./structurize";
import { connectMcpServer, callMcpTool, toOpenAIToolDefs } from "./mcp/client";
import { createAllServers } from "./mcp/servers";
import { bindSystemArgs } from "./agent-helpers";
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
  /** 任务核心动作：该动作执行成功才算任务完成（辅助动作成功不能算完成） */
  expectedAction?: ExecContext["action"];
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
  const ctxBase: ExecContext = {
    hour,
    weekday: now.getDay() === 0 ? 7 : now.getDay(),
    isWorkday: now.getDay() >= 1 && now.getDay() <= 5,
    role: input.role,
    action: "deploy_service",
    env: input.env,
    quotaUsed: input.quotaUsed,
    quotaLimit: 3,
    isEmergency: input.isEmergency,
    hasTicket: input.hasTicket,
    approvedByDirector: input.approvedByDirector,
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
        weekday: now.getDay() === 0 ? 7 : now.getDay(),
        isWorkday: now.getDay() >= 1 && now.getDay() <= 5,
      },
      status: "running",
      steps: [],
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

  // ---------- 1. MCP 连接（部署工具 + 规则检索） ----------
  const servers = createAllServers(recordAudit);
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
  const model = getChatModel().bindTools(
    (await toOpenAIToolDefs([deployConn])) as never
  );

  const constraintText = constraints
    .map(
      (c, i) =>
        `[${i + 1}] 「${c.ruleName}」(type=${c.ruleType}, priority=${c.priority}, 适用=${c.forbidAction.join("/")}) ${c.sourceChunk}`
    )
    .join("\n");

  const systemPrompt = [
    "你是业务约束感知的规划 Agent，负责在规则约束下规划并执行任务。",
    "【当前生效的业务约束】",
    constraintText || "（无）",
    "",
    "【执行规则】",
    "1. 每次工具调用都会被规则引擎校验：通过才执行；违规会被拦截并反馈给你，收到拦截后请重新规划合规方案；",
    "2. 上下文：用户的角色、环境、紧急标记等由系统提供，不要假设；",
    "3. 任务完成或确认无法合规完成时，输出最终结论（Markdown 格式，说明执行了什么/被拦截的原因）。",
  ].join("\n");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [new SystemMessage(systemPrompt), new HumanMessage(input.task)];
  let executedAny = false; // 是否有工具被放行执行
  let blockedAny = false; // 是否有工具调用被拦截
  const executedActions: string[] = []; // 成功执行的动作清单（终态判定用）
  emit({ type: "stage", data: { stage: "planning" } });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) {
      return finalize("cancelled", "任务已取消");
    }
    const response = await model.invoke(messages);
    messages.push(new AIMessage(response as never));

    const toolCalls = (response.tool_calls ?? []) as {
      id: string;
      name: string;
      args: Record<string, unknown>;
    }[];

    if (toolCalls.length === 0) {
      const conclusion =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);
      // 终态判定：核心动作执行成功 → completed；
      // 核心动作未执行且发生过拦截 → blocked（辅助动作成功 ≠ 任务完成）
      const coreDone =
        input.expectedAction !== undefined && executedActions.includes(input.expectedAction);
      const effectiveStatus = coreDone ? "completed" : blockedAny ? "blocked" : "completed";
      emit({ type: "done", data: { conclusion, status: effectiveStatus } });
      return finalize(effectiveStatus, conclusion);
    }

    for (const tc of toolCalls) {
      emit({ type: "tool_call", data: { name: tc.name, args: tc.args } });

      // 2a. 入参校验（第二重保险）
      const schema = TOOL_SCHEMAS[tc.name];
      if (!schema) {
        const msg = `工具 ${tc.name} 不存在，已拦截`;
        await recordAudit({ action: tc.name, detail: msg, result: "block" });
        messages.push(new ToolMessage({ tool_call_id: tc.id, content: msg }));
        continue;
      }
      const parsedArgs = schema.safeParse(tc.args);
      if (!parsedArgs.success) {
        const msg = `工具 ${tc.name} 入参非法：${parsedArgs.error.issues[0]?.message ?? "格式错误"}`;
        await recordAudit({ action: tc.name, detail: msg, result: "block" });
        messages.push(new ToolMessage({ tool_call_id: tc.id, content: msg }));
        continue;
      }

      // 2b. 系统参数绑定：关键参数（env）由任务场景决定，模型不可自由指定
      const rawArgs = parsedArgs.data as { env?: "prod" | "staging" };
      const bind = bindSystemArgs(tc.name, rawArgs as Record<string, unknown>, ctxBase.env);
      if (bind.violation) {
        blockedAny = true;
        steps.push({ tool: tc.name, args: rawArgs, verdict: "block", violated: bind.violation });
        await recordAudit({ action: tc.name, detail: bind.violation, result: "block" });
        messages.push(new ToolMessage({ tool_call_id: tc.id, content: bind.violation + "，请重新规划。" }));
        continue;
      }
      const args = bind.args as { env?: "prod" | "staging" };

      // 2c. 组装执行上下文 → 规则引擎判定（硬门槛）
      const ctx: ExecContext = {
        ...ctxBase,
        action: tc.name as ExecContext["action"],
        env: ctxBase.env, // 校验环境永远取场景值，与模型声称无关
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
          executedAny = true;
          executedActions.push(tc.name);
          steps.push({ tool: tc.name, args, verdict: "pass" });
          await recordAudit({
            action: tc.name,
            detail: `校验通过并执行：${result}`,
            result: "executed",
          });
          messages.push(new ToolMessage({ tool_call_id: tc.id, content: result }));
        } catch (err) {
          const msg = `工具执行失败：${err instanceof Error ? err.message : "未知错误"}`;
          messages.push(new ToolMessage({ tool_call_id: tc.id, content: msg }));
        }
      } else if (decision.verdict === "block") {
        blockedAny = true;
        const violated = decision.violated
          .map((v) => `「${v.constraint.ruleName}」（${v.constraint.expression}）`)
          .join("；");
        const msg = `执行被规则引擎拦截。违规约束：${violated}。请重新规划合规方案。`;
        steps.push({ tool: tc.name, args, verdict: "block", violated });
        await recordAudit({ action: tc.name, detail: msg, result: "block" });
        messages.push(new ToolMessage({ tool_call_id: tc.id, content: msg }));
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
}
