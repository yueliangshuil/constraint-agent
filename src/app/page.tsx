"use client";

import { useRef, useState } from "react";
import { parseSSEBlock } from "@/lib/sse";

/** 任务场景输入（含上下文：角色/环境/紧急标记等——表达式变量来源之一） */
interface ScenarioInput {
  task: string;
  role: "intern" | "junior" | "senior" | "lead" | "director";
  env: "prod" | "staging";
  isEmergency: boolean;
  hasTicket: boolean;
  approvedByDirector: boolean;
  quotaUsed: number;
  hourOverride?: number;
}

interface TraceEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

export default function Home() {
  const [input, setInput] = useState<ScenarioInput>({
    task: "",
    role: "senior",
    env: "prod",
    isEmergency: false,
    hasTicket: true,
    approvedByDirector: false,
    quotaUsed: 1,
  });
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const execute = async () => {
    if (running || !input.task.trim()) return;
    setRunning(true);
    setError(null);
    setEvents([]);
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `请求失败: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const ev = parseSSEBlock(block);
          if (!ev) continue;
          setEvents((prev) => [
            ...prev,
            { id: ev.id, type: ev.event, data: safeParse(ev.data) },
          ]);
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : "执行失败");
      }
    } finally {
      setRunning(false);
    }
  };

  const cancel = () => ctrlRef.current?.abort();

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50 font-sans dark:bg-zinc-950">
      {/* 左侧：场景输入 */}
      <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-r border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-sm font-semibold">约束感知规划 Agent</h1>
        <p className="text-xs text-zinc-400">
          业务规则托管于 RAG 知识库（上传规则文档到 RAG 项目），工具调用前经规则引擎校验。
        </p>

        <label className="flex flex-col gap-1 text-xs">
          任务描述
          <textarea
            value={input.task}
            onChange={(e) => setInput({ ...input, task: e.target.value })}
            rows={4}
            placeholder="例：将 payment-service v2.3.0 发布到生产环境"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
        </label>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <label className="flex flex-col gap-1">
            执行角色
            <select
              value={input.role}
              onChange={(e) => setInput({ ...input, role: e.target.value as ScenarioInput["role"] })}
              className="rounded-lg border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800"
            >
              {["intern", "junior", "senior", "lead", "director"].map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            目标环境
            <select
              value={input.env}
              onChange={(e) => setInput({ ...input, env: e.target.value as "prod" | "staging" })}
              className="rounded-lg border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800"
            >
              <option value="prod">prod</option>
              <option value="staging">staging</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            当日已发布次数
            <input
              type="number"
              min={0}
              max={10}
              value={input.quotaUsed}
              onChange={(e) => setInput({ ...input, quotaUsed: Number(e.target.value) || 0 })}
              className="rounded-lg border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800"
            />
          </label>
          <label className="flex flex-col gap-1">
            模拟时间（时，留空=真实时钟）
            <input
              type="number"
              min={0}
              max={23}
              placeholder="如 23"
              value={input.hourOverride ?? ""}
              onChange={(e) =>
                setInput({
                  ...input,
                  hourOverride: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              className="rounded-lg border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800"
            />
          </label>
        </div>

        <div className="flex flex-col gap-2 text-xs">
          {(
            [
              ["isEmergency", "紧急发布"],
              ["hasTicket", "已关联变更工单"],
              ["approvedByDirector", "已获总监审批"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={input[key]}
                onChange={(e) => setInput({ ...input, [key]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={execute}
            disabled={running || !input.task.trim()}
            className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {running ? "执行中…" : "执行任务"}
          </button>
          {running && (
            <button onClick={cancel} className="rounded-lg border border-zinc-300 px-3 text-sm">
              取消
            </button>
          )}
        </div>

        <p className="text-xs text-zinc-400">
          规则文档上传：打开 RAG 项目（localhost:3000）上传 docs/rules 下的规则文档。
        </p>
      </aside>

      {/* 右侧：链路可视化 */}
      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-3">
          {events.length === 0 && !running && (
            <div className="pt-24 text-center text-sm text-zinc-400">
              配置左侧场景后点击「执行任务」，这里将实时展示 Agent 全链路
            </div>
          )}
          {events.map((ev) => (
            <TraceCard key={ev.id} event={ev} />
          ))}
          {running && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-400" />
              执行中…
            </div>
          )}
          {error && (
            <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

const TYPE_LABELS: Record<string, string> = {
  plan: "📋 任务规划",
  stage: "🔄 阶段",
  constraints: "📜 约束召回与结构化",
  validation: "⚖️ 规则校验",
  tool_call: "🔧 工具调用",
  tool_result: "📝 执行结果",
  decision_request: "⚠️ 冲突待裁决",
  done: "✅ 最终结论",
};

function TraceCard({ event }: { event: TraceEvent }) {
  const label = TYPE_LABELS[event.type] ?? event.type;
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">{label}</p>
      <EventBody type={event.type} data={event.data} />
    </div>
  );
}

function EventBody({ type, data }: { type: string; data: Record<string, unknown> }) {
  if (type === "plan") {
    return <p className="text-sm">{String(data.task ?? "")}</p>;
  }
  if (type === "stage") {
    const stage = String(data.stage ?? "");
    const map: Record<string, string> = {
      retrieving: "正在检索业务约束…",
      structuring: "正在结构化规则…",
      planning: "Agent 规划中…",
    };
    return <p className="text-sm text-zinc-500">{map[stage] ?? stage}</p>;
  }
  if (type === "constraints") {
    const constraints = (data.constraints ?? []) as { ruleName: string; expression: string }[];
    const invalid = (data.invalid ?? []) as { ruleName: string; error: string }[];
    return (
      <div className="space-y-1 text-sm">
        {constraints.map((c, i) => (
          <p key={i}>
            · 「{c.ruleName}」 <code className="text-xs">{c.expression}</code>
          </p>
        ))}
        {invalid.map((v, i) => (
          <p key={`inv-${i}`} className="text-red-500">
            ✗ {v.ruleName}：{v.error}
          </p>
        ))}
      </div>
    );
  }
  if (type === "validation") {
    const verdict = String(data.verdict ?? "");
    const color =
      verdict === "pass" ? "text-green-600" : verdict === "block" ? "text-red-600" : "text-amber-600";
    return (
      <p className={`text-sm font-medium ${color}`}>
        {String(data.tool ?? "")}：{verdict === "pass" ? "✓ 校验通过" : verdict === "block" ? "✗ 拦截" : "⚠ 冲突"}
        {verdict === "block" && (
          <span className="text-zinc-400">（违规：{String((data.violated as string[] | undefined)?.join("、") ?? "")}）</span>
        )}
      </p>
    );
  }
  if (type === "tool_call") {
    return (
      <p className="text-sm">
        {String(data.name ?? "")}({JSON.stringify(data.args ?? {})})
      </p>
    );
  }
  if (type === "tool_result") {
    if (data.kind === "audit") {
      return <p className="text-xs text-zinc-400">审计：{String(data.detail ?? "")}</p>;
    }
    return <p className="text-sm">{String(data.detail ?? "")}</p>;
  }
  if (type === "decision_request") {
    return (
      <div className="text-sm">
        <p className="font-medium text-amber-600">同优先级约束冲突，暂停执行，等待人工裁决：</p>
        {(data.blockers as { ruleName: string; sourceChunk: string }[] | undefined)?.map((b, i) => (
          <p key={`b${i}`} className="text-xs">禁止侧：「{b.ruleName}」{b.sourceChunk}</p>
        ))}
        {(data.exemptions as { ruleName: string; sourceChunk: string }[] | undefined)?.map((e, i) => (
          <p key={`e${i}`} className="text-xs">豁免侧：「{e.ruleName}」{e.sourceChunk}</p>
        ))}
      </div>
    );
  }
  if (type === "done") {
    return <pre className="whitespace-pre-wrap text-sm">{String(data.conclusion ?? "")}</pre>;
  }
  return <pre className="whitespace-pre-wrap text-xs text-zinc-500">{JSON.stringify(data, null, 2)}</pre>;
}
