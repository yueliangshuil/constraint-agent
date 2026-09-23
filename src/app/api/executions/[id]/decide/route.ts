import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase";

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

  return NextResponse.json({ decision }, { status: 201 });
}
