/**
 * MCP 客户端连接器：
 * - 开发/演示：InMemoryTransport 连接本进程内的 MCP Server；
 * - 生产接入（P8）：Streamable HTTP 连接远程 MCP Server（Jira/Jenkins 官方或社区实现），
 *   上层 Agent 循环零改动——MCP 工具列表转换为 OpenAI Function Calling 格式供模型调用。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

/**
 * 连接远程 MCP Server（生产接入，P8）：
 * 配置 JENKINS_MCP_URL / JIRA_MCP_URL 后，deploy-tools 由远程真实工具提供；
 * 连接失败由调用方降级本地 mock（演示环境不因配置错误崩溃）。
 */
export async function connectRemoteMcpServer(url: string, name: string): Promise<McpConnection> {
  const client = new Client({ name: "constraint-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
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
