/**
 * 全链路 E2E 抽测（P3；P6 起 9 场景）
 * 场景走真实 /api/execute（含 RAG 召回 + LLM 结构化 + 引擎判定 + Agent 循环）
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
  /** 登录角色：身份来自认证会话（与线上语义一致，body 不接受 role 自述） */
  loginRole: "senior" | "intern";
  body: Record<string, unknown>;
  expected: "completed" | "blocked" | "conflict" | "rejected";
}

const SCENARIOS: E2eScenario[] = [
  { id: "E01", name: "合规发布（senior/白天/有工单）", loginRole: "senior", expected: "completed", body: { task: "将 payment-service v2.3.0 发布到生产环境", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 14, expectedAction: "deploy_service" } },
  { id: "E02", name: "合规：staging 夜间发布（时间约束仅限 prod）", loginRole: "senior", expected: "completed", body: { task: "将 cart-service v1.8.0 发布到预发环境", env: "staging", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 23, expectedAction: "deploy_service" } },
  { id: "E03", name: "合规：工作时间查询配额", loginRole: "senior", expected: "completed", body: { task: "查询 payment-service 今日发布配额使用情况", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 10, expectedAction: "query_quota" } },
  { id: "E04", name: "时间违规（夜间发布）", loginRole: "senior", expected: "blocked", body: { task: "将 payment-service v2.3.0 发布到生产环境", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 23, expectedAction: "deploy_service" } },
  { id: "E05", name: "权限违规（intern 发生产）", loginRole: "intern", expected: "blocked", body: { task: "将 payment-service v2.3.0 发布到生产环境", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 14, expectedAction: "deploy_service" } },
  { id: "E06", name: "配额违规（当日已 3 次）", loginRole: "senior", expected: "blocked", body: { task: "将 payment-service v2.3.0 发布到生产环境", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 3, hourOverride: 14, expectedAction: "deploy_service" } },
  { id: "E07", name: "同优先级冲突（夜间紧急未审批）", loginRole: "senior", expected: "conflict", body: { task: "将 payment-service v2.3.0 发布到生产环境", env: "prod", isEmergency: true, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 23, expectedAction: "deploy_service" } },
  // E08（P6 升级）：无关任务由意图识别 fail-closed 拒绝（400），不再进入 Agent 循环
  { id: "E08", name: "无关任务（意图识别 fail-closed 拒绝）", loginRole: "senior", expected: "rejected", body: { task: "查询明天成都的天气情况", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 1, hourOverride: 14 } },
  // E09（P6 新增）：未声明核心动作的发布任务——意图自动识别 deploy_service 后正常执行
  // 注：独立服务名隔离真实配额累积（DEV_LOG #24 教训：payment-service 当日真实部署数会耗尽配额）
  { id: "E09", name: "自动识别：未声明核心动作的发布任务", loginRole: "senior", expected: "completed", body: { task: "把 intent-svc-1021 的 v1.0.0 版本发布上线到生产环境", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 0, hourOverride: 14 } },
];

/** 登录拿 token（身份来自认证会话，与线上语义一致） */
async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "demo123456" }),
  });
  const data = (await res.json()) as { token?: string; error?: string };
  if (!res.ok) throw new Error(`登录失败: ${email} ${data.error ?? ""}`);
  return data.token!;
}

async function runScenario(sc: E2eScenario, token: string): Promise<{ actual: string; detail: string }> {
  const res = await fetch(`${BASE}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(sc.body),
  });
  if (!res.ok) {
    // P6 意图识别拒绝：400 + fail-closed 语义 → rejected（E08 期望此路径）
    if (res.status === 400) {
      try {
        const data = await res.json();
        if (String(data.error ?? "").includes("无法识别任务类型")) {
          return { actual: "rejected", detail: data.error };
        }
      } catch {
        /* 非 JSON */
      }
    }
    return { actual: "error", detail: `HTTP ${res.status}` };
  }
  if (!res.body) {
    return { actual: "error", detail: "无响应体" };
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
  const seniorToken = await login("senior@demo.com");
  const internToken = await login("intern@demo.com");
  const tokens: Record<string, string> = { senior: seniorToken, intern: internToken };

  // 每轮唯一服务名：隔离当日真实部署计数跨轮累积（DEV_LOG #24 教训——
  // 场景内真实执行会落 deploy_records，固定服务名跑多轮后配额/幂等会误伤合规场景）
  const svc = `e2e-svc-${Date.now()}`;
  for (const sc of SCENARIOS) {
    if (typeof sc.body.task === "string") {
      // 服务名与版本均动态化：服务名隔离配额累积，版本隔离幂等规则（当日同版本已发布）
      sc.body.task = sc.body.task
        .replace(/payment-service|cart-service|intent-svc-1021/g, svc)
        .replace(/v1\.0\.0/g, `v${Date.now() % 10000}`);
    }
  }

  const rows: { sc: E2eScenario; actual: string; correct: boolean; detail: string }[] = [];
  for (const sc of SCENARIOS) {
    const r = await runScenario(sc, tokens[sc.loginRole]);
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
