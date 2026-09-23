import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

/** 执行详情（含全链路步骤与裁决记录） */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getSupabaseAdmin();
  const { data: execution } = await db
    .from("executions")
    .select("*")
    .eq("id", id)
    .single();
  if (!execution) {
    return NextResponse.json({ error: "执行记录不存在" }, { status: 404 });
  }
  const { data: decisions } = await db
    .from("decisions")
    .select("*")
    .eq("execution_id", id);
  return NextResponse.json({ execution, decisions });
}
