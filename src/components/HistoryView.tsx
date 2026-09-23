"use client";

import { useCallback, useEffect, useState } from "react";

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
};

export default function HistoryView({ refreshTick }: { refreshTick: number }) {
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [selected, setSelected] = useState<ExecutionRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/executions");
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
                    onClick={() => setSelected(selected?.id === ex.id ? null : ex)}
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
              <p className="mb-1 text-xs font-medium text-zinc-400">最终结论</p>
              <pre className="whitespace-pre-wrap text-xs">{selected.plan.conclusion}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
