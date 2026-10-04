/**
 * 认证与 RBAC（用户权限管理层）
 *
 * 设计要点：
 * - 身份事实来源：ExecContext.role 等业务判定上下文必须来自本模块解析的
 *   认证用户档案，绝不接受表单/模型自述（「模型可提议、系统可决定」）；
 * - 单一角色字段同时驱动平台权限（能否执行/裁决/管规则/看审计）与业务约束
 *   （规则引擎中的 role 变量），保证两个层面的权限判断同源一致；
 * - 会话令牌：演示级 UUID 会话（生产替换为 Supabase Auth JWT，DEV_LOG 记录取舍）；
 * - 密码：Node 内置 scrypt 加盐哈希，不存明文。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { getSupabaseAdmin } from "./supabase";

export type UserRole = "intern" | "junior" | "senior" | "lead" | "director";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  tenantId: string;
}

// ---------- 密码哈希 ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}

// ---------- 会话 ----------

export async function login(email: string, password: string): Promise<{ user: AuthUser; token: string } | { error: string }> {
  const db = getSupabaseAdmin();
  const { data: row } = await db
    .from("users")
    .select("*")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();
  if (!row) return { error: "邮箱或密码错误" };
  if (!verifyPassword(password, row.password_hash)) return { error: "邮箱或密码错误" };

  const { data: session } = await db
    .from("auth_sessions")
    .insert({ user_id: row.id })
    .select()
    .single();
  if (!session) return { error: "会话创建失败" };

  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role as UserRole,
      tenantId: row.tenant_id,
    },
    token: session.token,
  };
}

export async function logout(token: string): Promise<void> {
  const db = getSupabaseAdmin();
  await db.from("auth_sessions").delete().eq("token", token);
}

/** 从请求解析认证用户；未登录返回 null */
export async function getAuthUser(request: Request): Promise<AuthUser | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const db = getSupabaseAdmin();
  const { data: session } = await db
    .from("auth_sessions")
    .select("user_id, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) return null;

  const { data: row } = await db.from("users").select("*").eq("id", session.user_id).maybeSingle();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as UserRole,
    tenantId: row.tenant_id,
  };
}

// ---------- RBAC 判定（单一事实来源） ----------

export const canExecute = (_u: AuthUser) => true; // 所有角色可发起任务（业务约束在规则引擎拦截）
export const canViewAllExecutions = (u: AuthUser) => u.role === "lead" || u.role === "director";
export const canManageRules = (u: AuthUser) => u.role === "director";
export const canDecide = (u: AuthUser) => u.role === "director";
