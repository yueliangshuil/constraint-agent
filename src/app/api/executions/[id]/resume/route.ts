import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { canDecide, getAuthUser } from "@/lib/auth";
import { runAgent, type ResumeState, type TaskInput } from "@/lib/agent";
import type { PlainMessage } from "@/lib/llm";

type Params = { params: Promise<{ id: string }> };

export const maxDuration = 300;

/**
 * 任务中断恢复（Checkpoint，P5）：
 * 从持久化现场（messages + steps）重建执行，跳过已执行动作继续 ReAct 循环。
 * 同步接口（低频操作，无 SSE 订阅者；恢复结果落库后由历史视图刷新展示）。
 *
 * 设计决策：
 * - 规则约束重新召回：恢复执行遵守"当前生效规则"而非旧规则快照（规则变更即时生效的卖点一致）；
 * - 时间事实用当前服务器时间：时间类约束按"恢复时刻"判定；
 * - role 用当前认证用户：恢复人以自己的身份执行，审计归属当前用户；
 * - 重复副作用防护：模型重复提议已执行动作时，幂等/配额规则（真实落库状态）天然拦截。
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;

  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
  }

  const db = getSupabaseAdmin();
  const { data: execution } = await db
    .from("executions")
    .select("*")
    .eq("id", id)
    .single();
  if (!execution) {
    return NextResponse.json({ error: "执行记录不存在" }, { status: 404 });
  }
  if (execution.tenant_id !== user.tenantId) {
    return NextResponse.json({ error: "执行记录不存在" }, { status: 404 });
  }
  // 权限：任务本人或总监可恢复（与执行历史的可见性口径一致）
  const isOwner = execution.user_id === user.id;
  if (!isOwner && !canDecide(user)) {
    return NextResponse.json({ error: "仅任务本人或总监可恢复执行" }, { status: 403 });
  }
  if (execution.status !== "paused" && execution.status !== "cancelled") {
    return NextResponse.json(
      { error: `当前状态为 ${execution.status}，仅暂停/取消的任务可恢复` },
      { status: 409 }
    );
  }

  // ---------- 从持久化现场重建 ----------
  const steps = (execution.steps ?? []) as Record<string, unknown>[];
  // 已执行动作：从审计推导（kind=audit && result=executed）
  const executedActions = steps
    .filter((s) => s.kind === "audit" && s.result === "executed")
    .map((s) => String(s.action));
  // 对话现场：去掉 system（恢复时用当前召回的最新规则重建 system）
  const historyMessages = ((execution.messages ?? []) as PlainMessage[]).filter(
    (m) => m.role !== "system"
  );
  // 核心动作：优先取持久化 context，向后兼容从已执行动作推导
  const context = (execution.context ?? {}) as Record<string, unknown>;
  const expectedAction = (context.expectedAction as string | undefined) ??
    executedActions[0] ??
    (steps.find((s) => typeof s.tool === "string")?.tool as string | undefined);

  const input: TaskInput = {
    task: execution.task,
    // 恢复人以当前认证身份执行（审计归属当前用户）；时间用服务器当前时刻
    role: user.role,
    env: (context.env as "prod" | "staging") ?? "prod",
    isEmergency: Boolean(context.isEmergency),
    hasTicket: Boolean(context.hasTicket),
    approvedByDirector: user.role === "director" ? true : Boolean(context.approvedByDirector),
    quotaUsed: Number(context.quotaUsed ?? 0),
    expectedAction: (expectedAction as TaskInput["expectedAction"]) ?? undefined,
    userId: user.id,
    tenantId: user.tenantId,
  };

  const resume: ResumeState = { executionId: id, steps, executedActions, historyMessages };

  const result = await runAgent(input, () => {}, undefined, resume);
  return NextResponse.json({ status: result.status, conclusion: result.conclusion });
}
