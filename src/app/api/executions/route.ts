import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { canViewAllExecutions, getAuthUser } from "@/lib/auth";

/** 执行记录列表：lead/director 看租户内全部，其他角色仅看本人 */
export async function GET(request: Request) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
  }
  const db = getSupabaseAdmin();
  let query = db
    .from("executions")
    .select("*")
    .eq("tenant_id", user.tenantId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (!canViewAllExecutions(user)) {
    query = query.eq("user_id", user.id);
  }
  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ executions: data });
}
