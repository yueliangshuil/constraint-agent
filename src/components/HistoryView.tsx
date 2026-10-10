"use client";

import { useCallback, useEffect, useState } from "react";
import { authHeaders } from "@/lib/client-auth";
import Markdown from "./Markdown";

interface ExecutionRow {
  id: string;
  task: string;
  status: string;
  created_at: string;
  steps: Record<string, unknown>[];
  plan: { conclusion?: string } | null;
}

const STATUS_LABELS: Record<string, string> = {
  running: "🔄 运行中",
  completed: "✅ 完成",
  blocked: "🚫 拦截",
  conflict: "⚠️ 冲突待裁决",
  cancelled: "⏹ 已取消",
  resolved: "✅ 已裁决",
};

export default function HistoryView({
  refreshTick,
  user,
}: {
  refreshTick: number;
  user: { role: string; name: string };
}) {
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [selected, setSelected] = useState<ExecutionRow | null>(null);
  const [decisions, setDecisions] = useState<
    { decision: string; decided_by: string | null; created_at: string }[]
  >([]);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 总监在历史中对冲突记录直接裁决（跨用户裁决入口） */
  const decide = async (executionId: string, decision: "allow" | "block") => {
    if (deciding) return;
    setDeciding(true);
    try {
      const res = await fetch(`/api/executions/${executionId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "裁决失败");
      }
      await load();
      // 刷新详情
      const ex = selected;
      if (ex) {
        setSelected({ ...ex, status: "resolved" });
        const dres = await fetch(`/api/executions/${executionId}`, {
          headers: authHeaders(),
        });
        if (dres.ok) {
          const ddata = await dres.json();
          setDecisions(ddata.decisions ?? []);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "裁决失败");
    } finally {
      setDeciding(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/executions", { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setExecutions(data.executions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshTick]);

  /** 选中执行：拉取详情（含裁决记录，审计回放完整闭环） */
  const selectExecution = async (ex: ExecutionRow) => {
    if (selected?.id === ex.id) {
      setSelected(null);
      setDecisions([]);
      return;
    }
    setSelected(ex);
    setDecisions([]);
    try {
      const res = await fetch(`/api/executions/${ex.id}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setDecisions(data.decisions ?? []);
      }
    } catch {
      /* 详情拉取失败不阻塞 */
    }
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-3 text-sm font-semibold">执行历史（审计可追溯）</h2>
          {error && (
            <p className="mb-3 rounded-lg bg-red-50 px-4 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-400 dark:border-zinc-800 dark:bg-zinc-800/60">
                <tr>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">任务</th>
                  <th className="px-4 py-2.5 font-medium">步骤数</th>
                  <th className="px-4 py-2.5 font-medium">执行时间</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((ex) => (
                  <tr
                    key={ex.id}
                    onClick={() => selectExecution(ex)}
                    className={`cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50 ${
                      selected?.id === ex.id ? "bg-zinc-50 dark:bg-zinc-800/60" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5">{STATUS_LABELS[ex.status] ?? ex.status}</td>
                    <td className="max-w-md truncate px-4 py-2.5">{ex.task}</td>
                    <td className="px-4 py-2.5 text-zinc-500">{ex.steps?.length ?? 0}</td>
                    <td className="px-4 py-2.5 text-xs text-zinc-400">
                      {new Date(ex.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {executions.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-xs text-zinc-400">
                      暂无执行记录——去执行台跑一个任务
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 详情抽屉 */}
      {selected && (
        <div className="w-[420px] shrink-0 overflow-y-auto border-l border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">执行详情</h3>
            <button onClick={() => setSelected(null)} className="text-xs text-zinc-400 hover:text-zinc-600">
              关闭
            </button>
          </div>
          <p className="mb-1 text-xs text-zinc-400">{new Date(selected.created_at).toLocaleString()}</p>
          <p className="mb-4 text-sm">{selected.task}</p>
          <div className="space-y-2">
            {(selected.steps ?? []).map((s, i) => (
              <div key={i} className="rounded-lg bg-zinc-50 p-2.5 text-xs dark:bg-zinc-800/60">
                {s.kind === "audit" ? (
                  <p className="text-zinc-500">
                    📝 审计[{String(s.result)}] {String(s.action)}：{String(s.detail).slice(0, 100)}
                  </p>
                ) : s.kind === "conflict" ? (
                  <div>
                    <p className="mb-1 font-medium text-amber-600">⚠ 冲突（工具：{String(s.tool)}）</p>
                    {(s.blockers as { ruleName: string }[] | undefined)?.map((b, j) => (
                      <p key={j} className="text-red-500">禁止侧：「{b.ruleName}」</p>
                    ))}
                    {(s.exemptions as { ruleName: string }[] | undefined)?.map((e, j) => (
                      <p key={j} className="text-green-600">豁免侧：「{e.ruleName}」</p>
                    ))}
                  </div>
                ) : (
                  <p>
                    🔧 {String(s.tool)} →{" "}
                    <span className={s.verdict === "pass" ? "text-green-600" : "text-red-600"}>
                      {String(s.verdict)}
                    </span>
                    {s.verdict === "block" && s.violated != null && (
                      <span className="text-zinc-400">（{String(s.violated)}）</span>
                    )}
                  </p>
                )}
              </div>
            ))}
          </div>
          {selected.plan?.conclusion && (
            <div className="mt-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="mb-2 text-xs font-medium text-zinc-400">最终结论</p>
              <Markdown content={selected.plan.conclusion} />
            </div>
          )}
          {selected.status === "conflict" && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
              {user.role === "director" ? (
                <>
                  <p className="mb-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                    ⚖️ 人工裁决（当前身份：{user.name} · 总监）
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => decide(selected.id, "allow")}
                      disabled={deciding}
                      className="flex-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                    >
                      放行（allow）
                    </button>
                    <button
                      onClick={() => decide(selected.id, "block")}
                      disabled={deciding}
                      className="flex-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                    >
                      拦截（block）
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  ⚠️ 该记录存在同优先级约束冲突，仅总监角色可执行人工裁决
                </p>
              )}
            </div>
          )}
          {decisions.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
              <p className="mb-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                ⚖️ 人工裁决记录
              </p>
              {decisions.map((d, i) => (
                <div key={i} className="mb-2 text-xs last:mb-0">
                  <p className="font-medium">
                    裁决结果：{d.decision === "allow" ? "✅ 放行" : "🚫 拦截"}
                    <span className="ml-2 font-normal text-zinc-400">
                      裁决人：{d.decided_by ?? "未署名"}
                    </span>
                  </p>
                  <p className="text-zinc-400">
                    时间：{new Date(d.created_at).toLocaleString()}
                    <span className="ml-2">裁决案例已回写知识库形成先例</span>
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
