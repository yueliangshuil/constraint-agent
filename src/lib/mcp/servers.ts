/**
 * MCP 工具层：三个 MCP Server（业务工具 / 规则检索 / 审计日志）
 *
 * - 开发期使用 InMemoryTransport（真实走 MCP 协议帧，无子进程管理），
 *   部署期升级 Streamable HTTP（DEV_LOG #4）；
 * - 业务工具为 mock 实现（演示自洽），规则检索调用 RAG 项目的 /api/retrieval
 *   （项目联动：RAG=检索服务，Agent=编排服务）；
 * - 所有业务操作的约束校验在 Agent 层完成（引擎判定 pass 才允许调用）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEnv } from "@/lib/env";

// ---------- 工具参数 Schema（Zod） ----------

export const deployServiceSchema = z.object({
  service: z.string().min(1),
  env: z.enum(["prod", "staging"]),
  version: z.string().min(1),
});

export const createTicketSchema = z.object({
  service: z.string().min(1),
  reason: z.string().min(1),
  severity: z.enum(["normal", "urgent"]),
});

export const queryQuotaSchema = z.object({
  service: z.string().min(1),
});

export const searchRulesSchema = z.object({
  query: z.string().min(1),
});

export const recordAuditSchema = z.object({
  action: z.string().min(1),
  detail: z.string().min(1),
  result: z.enum(["pass", "block", "conflict", "executed"]),
});

// ---------- MCP Server 构建 ----------

/** 发布工具 MCP：业务操作（mock 实现，演示自洽） */
export function createDeployServer(): McpServer {
  const server = new McpServer({ name: "deploy-tools", version: "1.0.0" });

  server.registerTool(
    "deploy_service",
    { description: "发布服务到指定环境（生产/预发）", inputSchema: { service: z.string(), env: z.string(), version: z.string() } },
    async ({ service, env, version }) => {
      // mock：真实系统中此处对接发布平台 API
      return {
        content: [{ type: "text" as const, text: `已发布 ${service}@${version} 到 ${env} 环境（模拟执行成功）` }],
      };
    }
  );

  server.registerTool(
    "create_change_ticket",
    { description: "创建变更工单", inputSchema: { service: z.string(), reason: z.string(), severity: z.string() } },
    async ({ service, reason, severity }) => {
      return {
        content: [{ type: "text" as const, text: `已创建变更工单（服务: ${service}，级别: ${severity}，原因: ${reason}）工单号 CHG-${Date.now()}` }],
      };
    }
  );

  server.registerTool(
    "query_quota",
    { description: "查询服务当日发布配额使用情况", inputSchema: { service: z.string() } },
    async ({ service }) => {
      return {
        content: [{ type: "text" as const, text: `${service} 当日已发布 1 次，配额 3 次，剩余 2 次` }],
      };
    }
  );

  return server;
}

/** 规则检索 MCP：调用 RAG 项目的检索服务（项目联动） */
export function createRuleSearchServer(): McpServer {
  const server = new McpServer({ name: "rule-search", version: "1.0.0" });

  server.registerTool(
    "search_rules",
    { description: "从业务约束知识库检索与任务相关的规则文档", inputSchema: { query: z.string() } },
    async ({ query }) => {
      const base = getEnv("RAG_API_BASE");
      const res = await fetch(
        `${base}/api/retrieval?query=${encodeURIComponent(query)}&topK=10`,
        { signal: AbortSignal.timeout(20_000) }
      );
      if (!res.ok) {
        throw new Error(`规则检索失败: HTTP ${res.status}`);
      }
      const data = (await res.json()) as { chunks?: { content: string; filename: string; similarity: number }[] };
      const text = (data.chunks ?? [])
        .map((c, i) => `[${i + 1}] (来自《${c.filename}》 相似度 ${c.similarity.toFixed(3)})\n${c.content}`)
        .join("\n\n");
      // 结构化返回：文本协议内嵌 JSON，供 Agent 层解析相似度做 fail-closed 判定
      const payload = JSON.stringify({
        chunks: data.chunks ?? [],
        text: text || "未检索到相关规则",
      });
      return {
        content: [{ type: "text" as const, text: payload }],
      };
    }
  );

  return server;
}

/** 审计日志 MCP：执行记录查询 */
export function createAuditServer(onRecord: (record: { action: string; detail: string; result: string }) => Promise<void>): McpServer {
  const server = new McpServer({ name: "audit-log", version: "1.0.0" });

  server.registerTool(
    "record_audit",
    { description: "记录一次操作审计（供 Agent 在每次工具执行后调用）", inputSchema: { action: z.string(), detail: z.string(), result: z.string() } },
    async (args) => {
      await onRecord(args);
      return { content: [{ type: "text" as const, text: "审计已记录" }] };
    }
  );

  return server;
}

/** 汇总：注册所有 MCP Server */
export function createAllServers(onRecord: (record: { action: string; detail: string; result: string }) => Promise<void>) {
  return {
    deploy: createDeployServer(),
    ruleSearch: createRuleSearchServer(),
    audit: createAuditServer(onRecord),
  };
}
