/**
 * 规则引擎确定性评测（P3）
 * 22 个任务场景覆盖：合规发布/时间违规/权限违规/配额违规/工单前置/配额查询/同优先级冲突
 * 指标：漏拦率（应拦却放行，最严重）、误拦率（应放却拦）、冲突识别准确率
 * 运行：pnpm tsx scripts/eval-agent.ts
 * 输出：docs/eval-results.md（含规模声明）
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { evaluateConstraints } from "../src/lib/rule-engine";
import type { Constraint, ExecContext } from "../src/types/constraint";

// ---------- 金标准约束集（规则文档的正确结构化结果） ----------
const GOLD: Constraint[] = [
  {
    ruleName: "发布时间窗口", ruleType: "time", priority: 3,
    forbidAction: ["deploy_service"],
    expression: "env == 'prod' && isWorkday && (hour >= 22 || hour < 6)",
    sourceDoc: "生产环境发布规范.md", sourceChunk: "工作日 22:00 至次日 06:00 禁止生产环境发布。",
  },
  {
    ruleName: "发布权限", ruleType: "permission", priority: 4,
    forbidAction: ["deploy_service"],
    expression: "env == 'prod' && (role == 'intern' || role == 'junior')",
    sourceDoc: "生产环境发布规范.md", sourceChunk: "生产环境发布需要 senior 及以上角色。",
  },
  {
    ruleName: "发布配额", ruleType: "quota", priority: 3,
    forbidAction: ["deploy_service"],
    expression: "quotaUsed >= quotaLimit",
    sourceDoc: "生产环境发布规范.md", sourceChunk: "单个服务单日发布次数不超过 3 次。",
  },
  {
    ruleName: "变更工单", ruleType: "precondition", priority: 2,
    forbidAction: ["deploy_service"],
    expression: "env == 'prod' && !hasTicket",
    sourceDoc: "生产环境发布规范.md", sourceChunk: "生产环境发布必须关联变更工单。",
  },
  {
    ruleName: "紧急发布豁免", ruleType: "exception", priority: 4,
    forbidAction: ["deploy_service"],
    expression: "isEmergency && approvedByDirector",
    sourceDoc: "紧急发布管理规范.md", sourceChunk: "紧急发布经总监审批后不受发布时间窗口限制。",
  },
  {
    ruleName: "未经审批的紧急发布", ruleType: "exception", priority: 3,
    forbidAction: ["deploy_service"],
    expression: "isEmergency && !approvedByDirector",
    sourceDoc: "紧急发布管理规范.md", sourceChunk: "未获总监审批的紧急发布，与发布时间窗口规则冲突时需人工裁决。",
  },
  {
    ruleName: "紧急工单审批", ruleType: "precondition", priority: 3,
    forbidAction: ["create_change_ticket"],
    expression: "isEmergency && !approvedByDirector",
    sourceDoc: "工单与配额查询规范.md", sourceChunk: "创建紧急变更工单需总监审批。",
  },
  {
    ruleName: "配额查询时间", ruleType: "time", priority: 2,
    forbidAction: ["query_quota"],
    expression: "!isWorkday || hour < 9 || hour >= 18",
    sourceDoc: "工单与配额查询规范.md", sourceChunk: "配额查询仅限工作时间。",
  },
];

// ---------- 场景集 ----------
interface Scenario {
  id: string;
  name: string;
  category: "合规" | "时间违规" | "权限违规" | "配额违规" | "工单前置" | "配额查询" | "冲突";
  ctx: Partial<ExecContext> & { action: ExecContext["action"] };
  expected: "pass" | "block" | "conflict";
}

const BASE: ExecContext = {
  hour: 14, weekday: 3, isWorkday: true,
  role: "senior", action: "deploy_service", env: "prod",
  quotaUsed: 1, quotaLimit: 3,
  isEmergency: false, hasTicket: true, approvedByDirector: false,
};

function s(id: string, name: string, category: Scenario["category"], ctx: Partial<ExecContext> & { action: ExecContext["action"] }, expected: Scenario["expected"]): Scenario {
  return { id, name, category, ctx, expected };
}

const SCENARIOS: Scenario[] = [
  // 合规 ×6
  s("C01", "senior 工作日白天发布（全合规）", "合规", {}, "pass"),
  s("C02", "lead 工作日白天发布", "合规", { role: "lead" }, "pass"),
  s("C03", "staging 环境夜间发布（时间约束仅限 prod）", "合规", { hour: 23, env: "staging" }, "pass"),
  s("C04", "紧急发布已获总监审批（豁免 p4 覆盖时间 p3）", "合规", { hour: 23, isEmergency: true, approvedByDirector: true }, "pass"),
  s("C05", "intern 发布 staging（权限约束仅限 prod）", "合规", { role: "intern", env: "staging" }, "pass"),
  s("C06", "director 夜间紧急已审批发布", "合规", { role: "director", hour: 23, isEmergency: true, approvedByDirector: true }, "pass"),
  // 时间违规 ×3
  s("T01", "senior 夜间 23 点发布（无紧急）", "时间违规", { hour: 23 }, "block"),
  s("T02", "senior 凌晨 5 点发布", "时间违规", { hour: 5 }, "block"),
  s("T03", "senior 夜间发布且无工单（时间 p3 优先于工单 p2）", "时间违规", { hour: 23, hasTicket: false }, "block"),
  // 权限违规 ×3
  s("P01", "intern 发布生产环境", "权限违规", { role: "intern" }, "block"),
  s("P02", "junior 发布生产环境", "权限违规", { role: "junior" }, "block"),
  s("P03", "intern 夜间发布生产（权限 p4 优先于时间 p3）", "权限违规", { role: "intern", hour: 23 }, "block"),
  // 配额违规 ×3（含边界）
  s("Q01", "当日已发布 3 次再发布（达到上限）", "配额违规", { quotaUsed: 3 }, "block"),
  s("Q02", "当日已发布 2 次再发布（边界，未达上限）", "合规", { quotaUsed: 2 }, "pass"),
  s("Q03", "staging 发布达到配额（配额约束无环境限定）", "配额违规", { quotaUsed: 3, env: "staging" }, "block"),
  // 工单前置 ×2
  s("W01", "生产发布无变更工单", "工单前置", { hasTicket: false }, "block"),
  s("W02", "紧急工单未审批", "工单前置", { action: "create_change_ticket", isEmergency: true }, "block"),
  s("W03", "普通变更工单", "合规", { action: "create_change_ticket" }, "pass"),
  // 配额查询 ×2
  s("G01", "夜间查询配额", "配额查询", { action: "query_quota", hour: 23 }, "block"),
  s("G02", "工作时间查询配额", "合规", { action: "query_quota", hour: 10 }, "pass"),
  // 冲突 ×2
  s("F01", "夜间紧急发布未获审批（时间 p3 vs 紧急豁免 p3）", "冲突", { hour: 23, isEmergency: true, approvedByDirector: false }, "conflict"),
  s("F02", "夜间紧急未审批 + 配额用尽（双重禁止 vs 豁免）", "冲突", { hour: 23, isEmergency: true, approvedByDirector: false, quotaUsed: 3 }, "conflict"),
];

// ---------- 评测 ----------
interface Row {
  scenario: Scenario;
  verdict: "pass" | "block" | "conflict";
  correct: boolean;
}

function run(): { rows: Row[]; missed: Row[]; falsePositive: Row[]; conflictOk: number; conflictTotal: number } {
  const rows: Row[] = SCENARIOS.map((sc) => {
    const ctx: ExecContext = { ...BASE, ...sc.ctx };
    const decision = evaluateConstraints(GOLD, ctx);
    return { scenario: sc, verdict: decision.verdict, correct: decision.verdict === sc.expected };
  });
  // 漏拦：预期拦截/冲突却放行
  const missed = rows.filter((r) => !r.correct && r.verdict === "pass");
  // 误拦：预期放行却被拦/冲突
  const falsePositive = rows.filter((r) => !r.correct && r.verdict !== "pass");
  const conflictRows = rows.filter((r) => r.scenario.expected === "conflict");
  return {
    rows,
    missed,
    falsePositive,
    conflictOk: conflictRows.filter((r) => r.correct).length,
    conflictTotal: conflictRows.length,
  };
}

function main() {
  const { rows, missed, falsePositive, conflictOk, conflictTotal } = run();
  const n = rows.length;
  const lines = [
    "# 规则引擎确定性评测报告（P3）",
    "",
    `> 生成时间：${new Date().toISOString()}`,
    "",
    `> **评测规模**：${n} 个任务场景（金标准约束 8 条，来自 3 份规则文档的标准结构化结果）。`,
    "> **规模声明**：本评测验证确定性规则引擎的判定正确性；全链路（含 LLM 召回与结构化）见 eval-agent-e2e 报告。企业级合规系统需千级场景与真实变更数据回归，本报告为实习项目级别。",
    "",
    "## 汇总",
    "",
    "| 指标 | 结果 | 说明 |",
    "|------|------|------|",
    `| 判定准确率 | ${rows.filter((r) => r.correct).length}/${n} | 全部场景 |`,
    `| 漏拦率（应拦却放） | ${missed.length}/${rows.filter((r) => r.scenario.expected !== "pass").length} | 合规系统最严重指标 |`,
    `| 误拦率（应放却拦） | ${falsePositive.length}/${rows.filter((r) => r.scenario.expected === "pass").length} | |`,
    `| 冲突识别准确率 | ${conflictOk}/${conflictTotal} | |`,
    "",
    "## 逐场景明细",
    "",
    "| ID | 场景 | 类别 | 预期 | 实际 | 结果 |",
    "|----|------|------|------|------|------|",
    ...rows.map(
      (r) =>
        `| ${r.scenario.id} | ${r.scenario.name} | ${r.scenario.category} | ${r.scenario.expected} | ${r.verdict} | ${r.correct ? "✓" : "✗"} |`
    ),
    "",
    "## 已知局限（如实记录）",
    "",
    "1. exception 规则未建模作用域：引擎按优先级做通用豁免，无法区分「豁免仅针对时间窗口规则」等限定场景（如紧急豁免同时覆盖了工单前置约束）。规则文本中的限定语需要结构化字段（exempts 规则名列表）才能精确建模，当前为已知局限。",
  ];
  mkdirSync("docs", { recursive: true });
  writeFileSync(join("docs", "eval-results.md"), lines.join("\n"), "utf-8");
  console.log(`判定准确率: ${rows.filter((r) => r.correct).length}/${n}`);
  console.log(`漏拦: ${missed.length}，误拦: ${falsePositive.length}，冲突识别: ${conflictOk}/${conflictTotal}`);
  console.log("报告已写入 docs/eval-results.md");
}

main();
