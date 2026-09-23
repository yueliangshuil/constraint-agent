/**
 * 全链路 E2E 抽测（P3）
 * 8 个场景走真实 /api/execute（含 RAG 召回 + LLM 结构化 + 引擎判定 + Agent 循环）
 * 运行前提：RAG 服务(3000) 与 Agent 服务(3001) 运行中，规则文档已入 RAG 知识库
 * 运行：pnpm tsx scripts/eval-agent-e2e.ts
 * 输出：docs/eval-e2e-results.md
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:3001";

interface E2eScenario {
  id: string;
  name: string;
  body: Record<string, unknown>;
  expected: "completed" | "blocked" | "conflict";
}

const SCENARIOS: E2eScenario[] = [
  { id: "E01", name: "合规发布（senior/白天/有工单）", expected: "completed", body: { task: "将 payment-service v2.3.0 发布到生产环境", role: "senior", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 14, expectedAction: "deploy_service" } },
  { id: "E02", name: "合规：staging 夜间发布（时间约束仅限 prod）", expected: "completed", body: { task: "将 cart-service v1.8.0 发布到预发环境", role: "senior", env: "staging", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 23, expectedAction: "deploy_service" } },
  { id: "E03", name: "合规：工作时间查询配额", expected: "completed", body: { task: "查询 payment-service 今日发布配额使用情况", role: "senior", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 10, expectedAction: "query_quota" } },
  { id: "E04", name: "时间违规（夜间发布）", expected: "blocked", body: { task: "将 payment-service v2.3.0 发布到生产环境", role: "senior", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 23, expectedAction: "deploy_service" } },
  { id: "E05", name: "权限违规（intern 发生产）", expected: "blocked", body: { task: "将 payment-service v2.3.0 发布到生产环境", role: "intern", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 14, expectedAction: "deploy_service" } },
  { id: "E06", name: "配额违规（当日已 3 次）", expected: "blocked", body: { task: "将 payment-service v2.3.0 发布到生产环境", role: "senior", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 3, hourOverride: 14, expectedAction: "deploy_service" } },
  { id: "E07", name: "同优先级冲突（夜间紧急未审批）", expected: "conflict", body: { task: "将 payment-service v2.3.0 发布到生产环境", role: "senior", env: "prod", isEmergency: true, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 23, expectedAction: "deploy_service" } },
  // E08 语义：与规则无关的任务，期望模型拒绝执行任何业务工具（无工具执行）
  // 注：fail-closed 相似度阈值在当前 3 份规则文档下难以触发（规则文本含"查询"等通用词，
  // 相似度基线高）——已在报告与 DEV_LOG 如实记录
  { id: "E08", name: "无关任务（应拒绝执行工具）", expected: "completed", body: { task: "查询明天成都的天气情况", role: "senior", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 14 } },
];

async function runScenario(sc: E2eScenario): Promise<{ actual: string; detail: string }> {
  const res = await fetch(`${BASE}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sc.body),
  });
  if (!res.ok || !res.body) {
    return { actual: "error", detail: `HTTP ${res.status}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let status = "unknown";
  let conclusion = "";
  let hadConflict = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) {
          try {
            const data = JSON.parse(line.slice(5).trim());
            if (event === "done") {
              status = String(data.status ?? "unknown");
              conclusion = String(data.conclusion ?? "");
            }
            if (event === "decision_request") hadConflict = true;
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  if (hadConflict) status = "conflict";
  return { actual: status, detail: conclusion.slice(0, 100) };
}

async function main() {
  const rows: { sc: E2eScenario; actual: string; correct: boolean; detail: string }[] = [];
  for (const sc of SCENARIOS) {
    const r = await runScenario(sc);
    rows.push({ sc, actual: r.actual, correct: r.actual === sc.expected, detail: r.detail });
    console.log(`[${r.actual === sc.expected ? "✓" : "✗"}] ${sc.id} ${sc.name} → ${r.actual}（预期 ${sc.expected}）`);
  }
  const n = rows.length;
  const ok = rows.filter((r) => r.correct).length;
  const lines = [
    "# 全链路 E2E 抽测报告（P3）",
    "",
    `> 生成时间：${new Date().toISOString()}`,
    "",
    `> **评测规模**：${n} 个场景，走完整链路（RAG 召回 + LLM 结构化 + 规则引擎 + Agent 循环）。`,
    "> **规模声明**：抽测验证端到端链路正确性；LLM 结构化存在随机性，若失败应重跑并统计稳定性。企业级需千级场景回归。",
    "",
    "## 汇总",
    "",
    `| 端到端准确率 | ${ok}/${n} |`,
    "",
    "## 明细",
    "",
    "| ID | 场景 | 预期 | 实际 | 结果 | 结论摘要 |",
    "|----|------|------|------|------|----------|",
    ...rows.map(
      (r) =>
        `| ${r.sc.id} | ${r.sc.name} | ${r.sc.expected} | ${r.actual} | ${r.correct ? "✓" : "✗"} | ${r.detail} |`
    ),
    "",
  ];
  mkdirSync("docs", { recursive: true });
  writeFileSync(join("docs", "eval-e2e-results.md"), lines.join("\n"), "utf-8");
  console.log(`\n端到端准确率: ${ok}/${n}，报告已写入 docs/eval-e2e-results.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
