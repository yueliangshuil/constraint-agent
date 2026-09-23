"use client";

import type { ReactNode } from "react";

export type ViewKey = "execute" | "rules" | "history";

const NAV_ITEMS: { key: ViewKey; label: string; icon: string }[] = [
  { key: "execute", label: "执行台", icon: "▶" },
  { key: "rules", label: "规则知识库", icon: "📜" },
  { key: "history", label: "执行历史", icon: "🗂" },
];

export default function AppShell({
  view,
  onViewChange,
  ragOnline,
  children,
}: {
  view: ViewKey;
  onViewChange: (v: ViewKey) => void;
  ragOnline: boolean | null;
  children: ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50 font-sans dark:bg-zinc-950">
      {/* 顶栏 */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold">约束感知规划 Agent</span>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            服务发布审批 · RAG 规则底座
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 ${
              ragOnline === null
                ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
                : ragOnline
                  ? "bg-green-50 text-green-600 dark:bg-green-950/40 dark:text-green-400"
                  : "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                ragOnline === null
                  ? "bg-zinc-400"
                  : ragOnline
                    ? "bg-green-500"
                    : "bg-red-500"
              }`}
            />
            {ragOnline === null ? "检测中" : ragOnline ? "RAG 检索服务在线" : "RAG 检索服务离线"}
          </span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧窄导航 */}
        <nav className="flex w-44 shrink-0 flex-col gap-1 border-r border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => onViewChange(item.key)}
              className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                view === item.key
                  ? "bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              <span>{item.icon}</span>
              {item.label}
            </button>
          ))}
          <div className="mt-auto rounded-lg bg-zinc-50 p-3 text-[11px] leading-relaxed text-zinc-400 dark:bg-zinc-800/60">
            规则托管于 RAG 知识库，工具调用前经确定性规则引擎校验。
          </div>
        </nav>

        {/* 主区 */}
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
