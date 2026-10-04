"use client";

import { useCallback, useEffect, useState } from "react";
import AppShell, { type ViewKey } from "@/components/AppShell";
import ExecuteView from "@/components/ExecuteView";
import RulesView from "@/components/RulesView";
import HistoryView from "@/components/HistoryView";
import {
  authHeaders,
  clearToken,
  getToken,
  setToken,
  type ClientUser,
} from "@/lib/client-auth";

export default function Home() {
  const [user, setUser] = useState<ClientUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState<ViewKey>("execute");
  const [ragOnline, setRagOnline] = useState<boolean | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // 会话恢复：页面刷新后用本地令牌换取用户信息
  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setAuthLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/auth/me", { headers: authHeaders() });
      const data = await res.json();
      setUser(data.user ?? null);
    } catch {
      setUser(null);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  // RAG 规则服务连通性探测（登录后，30s 周期）
  useEffect(() => {
    if (!user) return;
    const check = async () => {
      try {
        const res = await fetch("/api/rules", {
          headers: authHeaders(),
          signal: AbortSignal.timeout(5000),
        });
        setRagOnline(res.ok);
      } catch {
        setRagOnline(false);
      }
    };
    check();
    const timer = setInterval(check, 30_000);
    return () => clearInterval(timer);
  }, [user]);

  const logout = async () => {
    try {
      await fetch("/api/auth/me", { method: "POST", headers: authHeaders() });
    } catch {
      /* 忽略 */
    }
    clearToken();
    setUser(null);
    setView("execute");
  };

  if (authLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-zinc-400">
        加载中…
      </div>
    );
  }

  if (!user) {
    return <LoginView onLogin={(u) => setUser(u)} />;
  }

  return (
    <AppShell view={view} onViewChange={setView} ragOnline={ragOnline} user={user} onLogout={logout}>
      {view === "execute" && <ExecuteView user={user} onExecuted={() => setRefreshTick((t) => t + 1)} />}
      {view === "rules" && <RulesView user={user} />}
      {view === "history" && <HistoryView refreshTick={refreshTick} />}
    </AppShell>
  );
}

/** 登录视图（演示账号：director/senior/intern@demo.com，密码 demo123456） */
function LoginView({ onLogin }: { onLogin: (u: ClientUser) => void }) {
  const [email, setEmail] = useState("director@demo.com");
  const [password, setPassword] = useState("demo123456");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "登录失败");
      setToken(data.token);
      onLogin(data.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-zinc-950">
      <div className="w-96 rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="mb-1 text-lg font-semibold">约束感知规划 Agent</h1>
        <p className="mb-6 text-xs text-zinc-400">
          登录后角色由身份决定：业务约束与平台权限同源判定
        </p>
        <div className="space-y-3">
          <label className="flex flex-col gap-1 text-xs">
            邮箱
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              className="rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800"
            />
          </label>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            onClick={submit}
            disabled={loading}
            className="w-full rounded-lg bg-zinc-900 py-2.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {loading ? "登录中…" : "登录"}
          </button>
          <p className="text-center text-[11px] text-zinc-400">
            演示账号：director / senior / intern @demo.com（密码 demo123456）
          </p>
        </div>
      </div>
    </div>
  );
}
