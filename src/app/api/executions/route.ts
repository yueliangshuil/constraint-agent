import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

/** 执行记录列表（审计回放） */
export async function GET() {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("executions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ executions: data });
}
