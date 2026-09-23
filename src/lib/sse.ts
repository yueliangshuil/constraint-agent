/**
 * SSE 事件解析器（fetch 流式读取用）
 *
 * 为什么不用原生 EventSource：EventSource 不支持自定义请求头、
 * 无法主动 abort（切换问题/刷新页面时不能精准取消），且浏览器对
 * 同域名连接数有限制。fetch + ReadableStream 手动解析 SSE，
 * 配合 AbortController 实现精准管控（对应简历 AbortController 条目）。
 *
 * 协议约定：
 * - id: <累计字符长度> —— 客户端断线重连时用 Last-Event-ID 语义回传，
 *   服务端按字符偏移补发，天然去重，不依赖 chunk 序号（防抖落库后
 *   缓冲区可能已被回收，字符偏移在 done 后仍可从完整文本切片）。
 * - event: delta | done | interrupted | ping | stage
 *   stage 事件（data 为阶段名）用于流式期间的体验反馈：
 *   thinking（检索完成，模型开始推理）→ 客户端展示"正在思考…"；
 *   模型卡顿（长时间无 delta）时由客户端计时器提示"响应较慢"，ping 心跳保活连接。
 */

export interface SSEEvent {
  id: number;
  event: string;
  data: string;
}

export function parseSSEBlock(block: string): SSEEvent | null {
  let id = 0;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) {
      const n = Number(line.slice(3).trim());
      if (!Number.isNaN(n)) id = n;
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      // SSE 规范：data: 后若有一个空格则为字段分隔符，仅去掉这一个；
      // 内容本身的前导空格（如 Markdown 列表缩进）必须保留
      let value = line.slice(5);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) return null;
  return { id, event, data: dataLines.join("\n") };
}

/** 把 SSE 事件序列化为符合协议的消息帧（data 内换行逐行加 data: 前缀，避免内容丢失） */
export function encodeSSE(id: number, event: string, data: string): string {
  const dataLines = data.split("\n").map((line) => `data: ${line}`);
  return `id: ${id}\nevent: ${event}\n${dataLines.join("\n")}\n\n`;
}
