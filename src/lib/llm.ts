/**
 * 手写 DeepSeek 模型客户端（OpenAI 兼容协议，原生 fetch）
 *
 * 背景（DEV_LOG #26）：LangChain 的 ChatOpenAI.bindTools 在 Next.js dev 运行时
 * 出现 generations 空数组的解析故障（API 请求与响应均正常，LangChain 响应映射层损坏）。
 * 排障结论：模型调用是项目关键路径，不依赖框架——手写客户端完全可控。
 */

import { getEnv } from "./env";

export interface PlainMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}

const API_BASE = "https://api.deepseek.com";
const TIMEOUT_MS = 60_000;

async function rawChat(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getEnv("DEEPSEEK_API_KEY")}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const apiMsg = (data.error as { message?: string } | undefined)?.message;
    throw new Error(`模型调用失败: ${apiMsg ?? `HTTP ${res.status}`}`);
  }
  return data;
}

/** 无工具对话（约束结构化用） */
export async function chatPlain(system: string, user: string): Promise<string> {
  const data = await rawChat({
    model: getEnv("CHAT_MODEL"),
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const choices = (data.choices ?? []) as { message?: { content?: string } }[];
  return choices[0]?.message?.content ?? "";
}

/** 带工具对话（Agent 循环用）：返回文本与工具调用 */
export async function chatWithTools(
  messages: PlainMessage[],
  tools: ToolDef[]
): Promise<{ content: string | null; toolCalls: ToolCallResult[] }> {
  const data = await rawChat({
    model: getEnv("CHAT_MODEL"),
    temperature: 0.2,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
    tools: tools.length > 0 ? tools : undefined,
  });
  const choices = (data.choices ?? []) as {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    };
  }[];
  const msg = choices[0]?.message ?? {};
  return {
    content: typeof msg.content === "string" ? msg.content : null,
    toolCalls: (msg.tool_calls ?? []).map((t) => ({
      id: t.id,
      name: t.function.name,
      arguments: t.function.arguments,
    })),
  };
}
