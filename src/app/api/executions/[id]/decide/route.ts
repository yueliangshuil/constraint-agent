import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getEnv } from "@/lib/env";
import { canDecide, getAuthUser } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

const decideSchema = z.object({
  decision: z.enum(["allow", "block"]),
  // decidedBy 不再接受客户端输入：裁决人来自认证会话（审计可信）
});

/**
 * 人工裁决：记录冲突决策（P2）
 * 裁决结果落 decisions 表；P3 将把裁决案例回写知识库形成规则迭代闭环。
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;

  // 鉴权：仅 director 可裁决；身份来自认证会话
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
  }
  if (!canDecide(user)) {
    return NextResponse.json({ error: "仅总监角色可执行人工裁决" }, { status: 403 });
  }

  const parsed = decideSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "参数不合法" }, { status: 400 });
  }

  const db = getSupabaseAdmin();
  const { data: execution } = await db
    .from("executions")
    .select("id, task, status, steps, tenant_id")
    .eq("id", id)
    .single();
  if (!execution) {
    return NextResponse.json({ error: "执行记录不存在" }, { status: 404 });
  }
  if (execution.tenant_id !== user.tenantId) {
    return NextResponse.json({ error: "执行记录不存在" }, { status: 404 });
  }
  if (execution.status !== "conflict") {
    return NextResponse.json({ error: `当前状态为 ${execution.status}，无需裁决` }, { status: 409 });
  }

  // 从步骤中提取冲突快照
  const steps = (execution.steps ?? []) as Record<string, unknown>[];
  const conflictStep = steps.find((s) => s.kind === "conflict");

  const { data: decision, error } = await db
    .from("decisions")
    .insert({
      execution_id: id,
      conflicting_rules: (conflictStep as Record<string, unknown> | undefined) ?? {},
      decision: parsed.data.decision,
      decided_by: user.name, // 裁决人来自认证身份，不可自述
      user_id: user.id,
      tenant_id: user.tenantId,
    })
    .select()
    .single();
  if (error || !decision) {
    return NextResponse.json({ error: error?.message ?? "裁决记录失败" }, { status: 500 });
  }

  // 状态流转：conflict → resolved（裁决结果存 decisions 表，可追溯）
  await db
    .from("executions")
    .update({ status: "resolved", finished_at: new Date().toISOString() })
    .eq("id", id);

  // 4. 裁决判例回写知识库（按冲突对聚合 + 复用版本化，防同质堆积）
  // 设计：文件名 = 冲突对签名；同一冲突对反复裁决 → 同名上传 → RAG 版本化
  // 自动以新版本替换检索（历史版本保留可追溯），知识库每个冲突对仅一条判例。
  // 失败不阻塞裁决主流程（审计记录失败原因）
  try {
    const conflictData = (conflictStep as Record<string, unknown> | undefined) ?? {};
    const blockers = (conflictData.blockers ?? []) as { ruleName: string }[];
    const exemptions = (conflictData.exemptions ?? []) as { ruleName: string }[];
    const blockerNames = blockers.map((b) => b.ruleName).sort();
    const exemptNames = exemptions.map((e) => e.ruleName).sort();
    const signature = `${blockerNames.join("+") || "unknown"}-vs-${exemptNames.join("+") || "unknown"}`;
    const caseDoc = [
      "# 裁决判例（人工裁决先例）",
      `- 冲突对：禁止侧「${blockerNames.join("、") || "无"}」 / 豁免侧「${exemptNames.join("、") || "无"}」`,
      `- 最近裁决：${parsed.data.decision === "allow" ? "放行" : "拦截"}（裁决人：${user.name}，时间：${new Date().toISOString()}）`,
      "",
      "判例说明：同类约束冲突可参考本判例；系统不自动消解冲突，仍须人工裁决。",
    ].join("\n");
    const formData = new FormData();
    formData.append(
      "file",
      new File([caseDoc], `decision-case-${signature}.md`, { type: "text/markdown" })
    );
    const upRes = await fetch(`${getEnv("RAG_API_BASE")}/api/documents`, {
      method: "POST",
      body: formData,
      headers: { "x-service-token": getEnv("RAG_SERVICE_TOKEN") },
    });
    if (!upRes.ok) {
      console.warn(`[decide] 判例回写知识库失败: HTTP ${upRes.status}`);
    } else {
      console.log(`[decide] 判例已回写/更新（冲突对 ${signature}，${parsed.data.decision}）`);
    }
  } catch (err) {
    console.warn("[decide] 判例回写异常（不影响裁决主流程）:", err);
  }

  return NextResponse.json({ decision }, { status: 201 });
}
