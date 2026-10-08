"use client";

import { useRef, useState } from "react";
import { parseSSEBlock } from "@/lib/sse";
import { authHeaders, type ClientUser } from "@/lib/client-auth";
import Markdown from "./Markdown";

const ROLE_LABELS: Record<string, string> = {
  intern: "实习生",
  junior: "初级工程师",
  senior: "高级工程师",
  lead: "技术主管",
  director: "总监",
};

interface ScenarioInput {
  task: string;
  env: "prod" | "staging";
  isEmergency: boolean;
  hasTicket: boolean;
  approvedByDirector: boolean;
  quotaUsed: number;
  hourOverride?: number;
  weekdayOverride?: number;
  expectedAction?: "deploy_service" | "create_change_ticket" | "query_quota";
}

interface TraceEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

interface ConflictInfo {
  executionId: string;
  blockers: { ruleName: string; sourceChunk: string }[];
  exemptions: { ruleName: string; sourceChunk: string }[];
}

export default function ExecuteView({
  user,
  onExecuted,
}: {
  user: ClientUser;
  onExecuted: () => void;
}) {
  const [input, setInput] = useState<ScenarioInput>({
    task: "将 payment-service v2.3.0 发布到生产环境",
    env: "prod",
    isEmergency: false,
    hasTicket: true,
    approvedByDirector: false,
    quotaUsed: 1,
    expectedAction: "deploy_service",
  });
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [deciding, setDeciding] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const execIdRef = useRef<string | null>(null);

  const execute = async () => {
    if (running || !input.task.trim()) return;
    setRunning(true);
    setError(null);
    setEvents([]);
    setConflict(null);
    execIdRef.current = null;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
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
          const data = safeParse(ev.data);
          if (ev.event === "execution") execIdRef.current = String(data.id ?? "");
          else if (ev.event === "decision_request") {
            setConflict({
              executionId: execIdRef.current ?? "",
              blockers: (data.blockers ?? []) as ConflictInfo["blockers"],
              exemptions: (data.exemptions ?? []) as ConflictInfo["exemptions"],
            });
          }
          setEvents((prev) => [...prev, { id: ev.id, type: ev.event, data }]);
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : "执行失败");
      }
    } finally {
      setRunning(false);
      onExecuted();
    }
  };

  const cancel = () => ctrlRef.current?.abort();

  const decide = async (decision: "allow" | "block") => {
    if (!conflict || deciding) return;
    setDeciding(true);
    try {
      const res = await fetch(`/api/executions/${conflict.executionId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "裁决提交失败");
      }
      setConflict(null);
      onExecuted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "裁决提交失败");
    } finally {
      setDeciding(false);
    }
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* 左：场景配置 */}
      <div className="w-96 shrink-0 overflow-y-auto border-r border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-4 text-sm font-semibold">任务场景配置</h2>
        <div className="space-y-4">
          <label className="flex flex-col gap-1 text-xs">
            任务描述
            <textarea
              value={input.task}
              onChange={(e) => setInput({ ...input, task: e.target.value })}
              rows={3}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            任务核心动作
            <select
              value={input.expectedAction ?? ""}
              onChange={(e) =>
                setInput({
                  ...input,
                  expectedAction: (e.target.value || undefined) as ScenarioInput["expectedAction"],
                })
              }
              className="rounded-lg border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800"
            >
              <option value="deploy_service">发布服务</option>
              <option value="create_change_ticket">创建变更工单</option>
              <option value="query_quota">查询配额</option>
              <option value="">其他</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="flex flex-col gap-1">
              <span>当前角色（登录身份）</span>
              <div className="rounded-lg border border-blue-200 bg-blue-50 px-2 py-1.5 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
                {ROLE_LABELS[user.role] ?? user.role}
              </div>
            </div>
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
              模拟时间（留空=真实）
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
            <label className="flex flex-col gap-1">
              模拟星期（留空=真实）
              <select
                value={input.weekdayOverride ?? ""}
                onChange={(e) =>
                  setInput({
                    ...input,
                    weekdayOverride: e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
                className="rounded-lg border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800"
              >
                <option value="">跟随真实时钟</option>
                {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((d, i) => (
                  <option key={i} value={i + 1}>{d}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-col gap-2 text-xs">
            {(
              [
                ["isEmergency", "紧急发布"],
                ["hasTicket", "已关联变更工单"],
                // 总监身份即审批人：审批状态由系统绑定，不提供自述复选框
                ...(user.role !== "director"
                  ? ([["approvedByDirector", "已获总监审批"]] as const)
                  : []),
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
            {user.role === "director" && (
              <p className="text-[11px] text-blue-500">总监身份登录：审批状态由身份直接决定（视为已审批）</p>
            )}
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
          <p className="text-[11px] leading-relaxed text-zinc-400">
            演示推荐：夜间 23 点 + 紧急 + 未审批 → 触发同优先级冲突，弹出人工裁决。
          </p>
        </div>
      </div>

      {/* 右：链路可视化（主区） */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl space-y-3">
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
      </div>

      {/* 冲突裁决弹窗 */}
      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-zinc-900">
            <h2 className="mb-1 text-base font-semibold text-amber-600">⚠ 约束冲突 · 人工裁决</h2>
            <p className="mb-4 text-xs text-zinc-400">同优先级约束结论相反，系统不自动裁决（工程取舍）</p>
            <div className="mb-4 space-y-3 text-sm">
              <div className="rounded-lg bg-red-50 p-3 dark:bg-red-950/30">
                <p className="mb-1 text-xs font-medium text-red-600">禁止侧</p>
                {conflict.blockers.map((b, i) => (
                  <p key={i} className="text-xs">「{b.ruleName}」{b.sourceChunk}</p>
                ))}
              </div>
              <div className="rounded-lg bg-green-50 p-3 dark:bg-green-950/30">
                <p className="mb-1 text-xs font-medium text-green-600">豁免侧</p>
                {conflict.exemptions.map((e, i) => (
                  <p key={i} className="text-xs">「{e.ruleName}」{e.sourceChunk}</p>
                ))}
              </div>
            </div>
            <p className="mb-4 text-xs text-zinc-400">
              裁决人将记录为当前登录身份：{user.name}（{ROLE_LABELS[user.role] ?? user.role}）
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => decide("allow")}
                disabled={deciding}
                className="flex-1 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                放行（allow）
              </button>
              <button
                onClick={() => decide("block")}
                disabled={deciding}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                拦截（block）
              </button>
            </div>
          </div>
        </div>
      )}
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
        <p className="font-medium text-amber-600">同优先级约束冲突，暂停执行，请在弹窗中裁决</p>
        {(data.blockers as { ruleName: string }[] | undefined)?.map((b, i) => (
          <p key={`b${i}`} className="text-xs">禁止侧：「{b.ruleName}」</p>
        ))}
        {(data.exemptions as { ruleName: string }[] | undefined)?.map((e, i) => (
          <p key={`e${i}`} className="text-xs">豁免侧：「{e.ruleName}」</p>
        ))}
      </div>
    );
  }
  if (type === "done") {
    return <Markdown content={String(data.conclusion ?? "")} />;
  }
  return <pre className="whitespace-pre-wrap text-xs text-zinc-500">{JSON.stringify(data, null, 2)}</pre>;
}
