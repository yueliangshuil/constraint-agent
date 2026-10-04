import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { canViewAllExecutions, getAuthUser } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** 执行详情（含全链路步骤与裁决记录）；跨租户/越权访问一律 404/403 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
  }
  const db = getSupabaseAdmin();
  const { data: execution } = await db.from("executions").select("*").eq("id", id).single();
  if (!execution) {
    return NextResponse.json({ error: "执行记录不存在" }, { status: 404 });
  }
  if (execution.tenant_id !== user.tenantId) {
    return NextResponse.json({ error: "执行记录不存在" }, { status: 404 });
  }
  if (!canViewAllExecutions(user) && execution.user_id !== user.id) {
    return NextResponse.json({ error: "无权查看该记录" }, { status: 403 });
  }
  const { data: decisions } = await db.from("decisions").select("*").eq("execution_id", id);
  return NextResponse.json({ execution, decisions });
}
