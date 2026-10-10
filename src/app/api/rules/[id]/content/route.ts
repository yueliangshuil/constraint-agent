import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getAuthUser } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** 规则/判例文档内容（登录即可查看；管理权限仅限 director 另行管控） */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
  }
  try {
    const res = await fetch(`${getEnv("RAG_API_BASE")}/api/documents/${id}/content`, {
      headers: { "x-service-token": getEnv("RAG_SERVICE_TOKEN") },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "文档内容加载失败" },
      { status: 502 }
    );
  }
}
