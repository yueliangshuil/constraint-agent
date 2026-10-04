"use client";

/** 客户端会话管理：令牌存 localStorage，所有 API 请求携带 Bearer 头 */

const TOKEN_KEY = "agent_session_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface ClientUser {
  id: string;
  email: string;
  name: string;
  role: "intern" | "junior" | "senior" | "lead" | "director";
  tenantId: string;
}
