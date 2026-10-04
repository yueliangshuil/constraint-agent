import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { canManageRules, getAuthUser } from "@/lib/auth";

const RAG_BASE = () => getEnv("RAG_API_BASE");
const SERVICE_TOKEN = () => getEnv("RAG_SERVICE_TOKEN");

/** 规则文档列表（登录即可读） */
export async function GET(request: Request) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
  }
  try {
    const res = await fetch(`${RAG_BASE()}/api/documents`, {
      headers: { "x-service-token": SERVICE_TOKEN() },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "规则文档加载失败" },
      { status: 502 }
    );
  }
}

/** 上传规则文档（仅 director——规则管理 RBAC） */
export async function POST(request: Request) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
  }
  if (!canManageRules(user)) {
    return NextResponse.json({ error: "仅总监角色可管理规则文档" }, { status: 403 });
  }
  try {
    const formData = await request.formData();
    const res = await fetch(`${RAG_BASE()}/api/documents`, {
      method: "POST",
      headers: { "x-service-token": SERVICE_TOKEN() },
      body: formData,
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "规则文档上传失败" },
      { status: 502 }
    );
  }
}
