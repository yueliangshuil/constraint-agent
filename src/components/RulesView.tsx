"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 规则文档（RAG 知识库，经 /rag-api 代理） */
interface RuleDoc {
  id: string;
  filename: string;
  chunk_count: number;
  version: number;
  is_latest: boolean;
  created_at: string;
}

const TEMPLATE = `## 规则X：规则名称
- ruleType: time | permission | quota | precondition | exception
- priority: 1-5（越高越优先）
- forbidAction: deploy_service | create_change_ticket | query_quota
- expression: 布尔表达式（true = 约束触发）

规则的自然语言描述。

可用变量：hour、weekday、isWorkday、role、env、quotaUsed、quotaLimit、isEmergency、hasTicket、approvedByDirector
示例：env == "prod" && isWorkday && (hour >= 22 || hour < 6)`;

export default function RulesView() {
  const [docs, setDocs] = useState<RuleDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showTemplate, setShowTemplate] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/rag-api/api/documents");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDocs((data.documents ?? []).filter((d: RuleDoc) => d.filename.endsWith(".md")));
    } catch (e) {
      setError(e instanceof Error ? e.message : "规则文档加载失败");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/rag-api/api/documents", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "上传失败");
      if (data.duplicated) setNotice(`《${file.name}》内容未变化，已跳过`);
      else setNotice(`《${file.name}》入库成功（${data.chunkCount} 块，v${file.name} 新版已生效）`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string, filename: string) => {
    try {
      const res = await fetch(`/rag-api/api/documents/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotice(`已删除《${filename}》`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <h2 className="text-sm font-semibold">规则知识库</h2>
          <p className="mt-0.5 text-xs text-zinc-400">
            业务约束托管于此（RAG 混合检索召回）；修改规则重新上传同名文档即生效新版本，无需改代码
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTemplate((v) => !v)}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700"
          >
            规则文档模板
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="rounded-lg bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {uploading ? "解析入库中…" : "上传规则文档"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-5xl space-y-3">
          {showTemplate && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
              <p className="mb-2 text-xs font-medium text-blue-600 dark:text-blue-400">
                规则文档模板（半结构化定义文件，expression 由规则作者给出，引擎确定性执行）
              </p>
              <pre className="whitespace-pre-wrap text-xs text-blue-800 dark:text-blue-300">{TEMPLATE}</pre>
            </div>
          )}
          {notice && (
            <p className="rounded-lg bg-green-50 px-4 py-2 text-xs text-green-600 dark:bg-green-950/40 dark:text-green-400">
              {notice}
            </p>
          )}
          {error && (
            <p className="rounded-lg bg-red-50 px-4 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-400 dark:border-zinc-800 dark:bg-zinc-800/60">
                <tr>
                  <th className="px-4 py-2.5 font-medium">规则文档</th>
                  <th className="px-4 py-2.5 font-medium">版本</th>
                  <th className="px-4 py-2.5 font-medium">分块</th>
                  <th className="px-4 py-2.5 font-medium">更新时间</th>
                  <th className="px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr
                    key={d.id}
                    className={`border-b border-zinc-100 last:border-0 dark:border-zinc-800 ${
                      !d.is_latest ? "opacity-40" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5">{d.filename}</td>
                    <td className="px-4 py-2.5">
                      v{d.version}
                      {d.is_latest && (
                        <span className="ml-1.5 rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-600 dark:bg-green-950/40 dark:text-green-400">
                          生效中
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500">{d.chunk_count}</td>
                    <td className="px-4 py-2.5 text-xs text-zinc-400">
                      {new Date(d.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => remove(d.id, d.filename)}
                        className="text-xs text-zinc-400 hover:text-red-500"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
                {docs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-xs text-zinc-400">
                      暂无规则文档——上传 docs/rules 下的规则文档开始
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
