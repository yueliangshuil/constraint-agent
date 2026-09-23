/**
 * MCP 客户端连接器：通过 InMemoryTransport 连接本进程内的 MCP Server，
 * 并把 MCP 工具列表转换为 OpenAI Function Calling 格式供模型调用。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface McpConnection {
  client: Client;
  name: string;
}

export async function connectMcpServer(
  server: McpServer,
  name: string
): Promise<McpConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "constraint-agent", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, name };
}

/** 单个 MCP 工具的调用封装 */
export async function callMcpTool(
  conn: McpConnection,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await conn.client.callTool({ name: toolName, arguments: args });
  const content = (result.content ?? []) as { type: string; text?: string }[];
  const text = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  if (result.isError) {
    throw new Error(text || `工具 ${toolName} 执行失败`);
  }
  return text;
}

/** 把 MCP 工具列表转换为 OpenAI Function Calling 工具定义（LangChain bindTools 用） */
export async function toOpenAIToolDefs(connections: McpConnection[]) {
  const defs: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[] = [];
  for (const conn of connections) {
    const { tools } = await conn.client.listTools();
    for (const t of tools) {
      defs.push({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        },
      });
    }
  }
  return defs;
}
