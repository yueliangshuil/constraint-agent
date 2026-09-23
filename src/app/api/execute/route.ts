import { z } from "zod";
import { runAgent, type AgentEvent, type TaskInput } from "@/lib/agent";
import { encodeSSE } from "@/lib/sse";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const taskSchema = z.object({
  task: z.string().min(1, "任务描述不能为空"),
  role: z.enum(["intern", "junior", "senior", "lead", "director"]),
  env: z.enum(["prod", "staging"]),
  isEmergency: z.boolean(),
  hasTicket: z.boolean(),
  approvedByDirector: z.boolean(),
  quotaUsed: z.number().int().min(0).max(10),
  hourOverride: z.number().int().min(0).max(23).optional(),
  expectedAction: z
    .enum(["deploy_service", "create_change_ticket", "query_quota"])
    .optional(),
});

/**
 * 任务执行端点：SSE 流式推送 Agent 全链路事件
 * （plan/constraints/validation/tool_call/tool_result/decision_request/done）
 * 事件帧协议与 RAG 项目一致（encodeSSE 复用）。
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const parsed = taskSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 }
    );
  }
  const input = parsed.data as TaskInput;

  const encoder = new TextEncoder();
  let seq = 0;
  let doneSent = false;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => {
        if (closed) return;
        if (e.type === "done") doneSent = true;
        try {
          controller.enqueue(encoder.encode(encodeSSE(seq++, e.type, JSON.stringify(e.data))));
        } catch {
          closed = true; // 客户端断开后 enqueue 抛错，静默停止
        }
      };
      try {
        const result = await runAgent(input, emit, request.signal);
        if (!doneSent) {
          emit({ type: "done", data: { conclusion: result.conclusion, status: result.status } });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "执行异常";
        if (!doneSent) {
          emit({ type: "done", data: { conclusion: `执行异常：${message}` } });
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
