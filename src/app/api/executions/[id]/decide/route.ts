import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getEnv } from "@/lib/env";

type Params = { params: Promise<{ id: string }> };

const decideSchema = z.object({
  decision: z.enum(["allow", "block"]),
  decidedBy: z.string().max(50).optional(),
});

/**
 * 人工裁决：记录冲突决策（P2）
 * 裁决结果落 decisions 表；P3 将把裁决案例回写知识库形成规则迭代闭环。
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const parsed = decideSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "参数不合法" }, { status: 400 });
  }

  const db = getSupabaseAdmin();
  const { data: execution } = await db
    .from("executions")
    .select("id, status, steps")
    .eq("id", id)
    .single();
  if (!execution) {
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
      decided_by: parsed.data.decidedBy ?? null,
    })
    .select()
    .single();
  if (error || !decision) {
    return NextResponse.json({ error: error?.message ?? "裁决记录失败" }, { status: 500 });
  }

  // 4. 裁决案例回写知识库（经验自适应：同类冲突下次可检索到先例）
  // 失败不阻塞裁决主流程（审计记录失败原因）
  try {
    const conflictData = (conflictStep as Record<string, unknown> | undefined) ?? {};
    const blockers = (conflictData.blockers ?? []) as { ruleName: string }[];
    const exemptions = (conflictData.exemptions ?? []) as { ruleName: string }[];
    const caseDoc = [
      "# 裁决案例",
      `- 任务：${execution.task}`,
      `- 冲突工具：${String(conflictData.tool ?? "未知")}`,
      `- 禁止侧：${blockers.map((b) => b.ruleName).join("、") || "无"}`,
      `- 豁免侧：${exemptions.map((e) => e.ruleName).join("、") || "无"}`,
      `- 裁决结果：${parsed.data.decision === "allow" ? "放行" : "拦截"}`,
      `- 裁决人：${parsed.data.decidedBy ?? "未署名"}`,
      `- 裁决时间：${new Date().toISOString()}`,
      "",
      "本案例作为同类约束冲突的裁决先例，供后续任务参考。",
    ].join("\n");
    const formData = new FormData();
    formData.append(
      "file",
      new File([caseDoc], `decision-case-${Date.now()}.md`, { type: "text/markdown" })
    );
    const upRes = await fetch(`${getEnv("RAG_API_BASE")}/api/documents`, {
      method: "POST",
      body: formData,
    });
    if (!upRes.ok) {
      console.warn(`[decide] 案例回写知识库失败: HTTP ${upRes.status}`);
    } else {
      console.log(`[decide] 裁决案例已回写知识库（${parsed.data.decision}）`);
    }
  } catch (err) {
    console.warn("[decide] 案例回写异常（不影响裁决主流程）:", err);
  }

  return NextResponse.json({ decision }, { status: 201 });
}
