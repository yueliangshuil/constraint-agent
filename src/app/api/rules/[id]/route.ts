import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { canManageRules, getAuthUser } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** 删除规则文档（仅 director） */
export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
  }
  if (!canManageRules(user)) {
    return NextResponse.json({ error: "仅总监角色可管理规则文档" }, { status: 403 });
  }
  try {
    const res = await fetch(`${getEnv("RAG_API_BASE")}/api/documents/${id}`, {
      method: "DELETE",
      headers: { "x-service-token": getEnv("RAG_SERVICE_TOKEN") },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "规则文档删除失败" },
      { status: 502 }
    );
  }
}
