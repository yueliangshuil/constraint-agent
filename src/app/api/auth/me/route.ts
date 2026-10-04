import { NextResponse } from "next/server";
import { getAuthUser, logout } from "@/lib/auth";

/** 当前登录用户信息（前端启动时校验会话） */
export async function GET(request: Request) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ user: null }, { status: 200 });
  }
  return NextResponse.json({ user });
}

/** 退出登录 */
export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) await logout(token);
  return NextResponse.json({ ok: true });
}
