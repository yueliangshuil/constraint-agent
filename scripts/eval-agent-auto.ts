/**
 * Agent 自动化评测（P9）：基于执行轨迹的业务任务测试集
 *
 * 覆盖五类：工具选择 / 参数校验（全局断言）/ 规则拦截与冲突 / 权限拦截 / 异常恢复
 * 断言对象：最终业务状态 + 执行轨迹（steps 中的审计、判定、时间戳）
 * 指标：任务成功率、规则拦截准确率（漏拦/误拦）、异常恢复成功率
 *
 * 运行：pnpm tsx scripts/eval-agent-auto.ts（需 3000/3001 服务运行）
 * 输出：docs/eval-agent-auto-results.md
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:3001";

// ---------- 场景定义 ----------

interface TraceExpectation {
  /** 至少执行过的动作（audit result=executed） */
  executedAtLeast?: string[];
  /** 不得执行的动作 */
  neverExecuted?: string[];
  /** 至少拦截次数（audit result=block） */
  blockedAtLeast?: number;
  /** 宽松子序列：executed 中按此顺序出现 */
  executedSequence?: string[];
  /** 异常恢复：paused→resume 后 completed，且 executed 无重复 */
  recovered?: boolean;
}

interface AutoScenario {
  id: string;
  name: string;
  category: "tool_selection" | "rule_interception" | "permission" | "rule_conflict" | "intent_reject" | "recovery";
  loginRole: "senior" | "intern";
  body: Record<string, unknown>;
  expectedStatus: "completed" | "blocked" | "conflict" | "rejected";
  trace: TraceExpectation;
}

const SCENARIOS: AutoScenario[] = [
  {
    id: "A01", name: "合规发布（模型自主规划并执行核心动作）", category: "tool_selection", loginRole: "senior",
    expectedStatus: "completed",
    body: { task: "将 auto-svc v1.0.0 发布到生产环境", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 0, hourOverride: 14, expectedAction: "deploy_service" },
    trace: { executedAtLeast: ["deploy_service"] },
  },
  {
    id: "A02", name: "查询配额任务（工具裁剪：物理不可见其他工具）", category: "tool_selection", loginRole: "senior",
    expectedStatus: "completed",
    body: { task: "查询 auto-svc 今日发布配额使用情况", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 0, hourOverride: 10, expectedAction: "query_quota" },
    trace: { executedAtLeast: ["query_quota"], neverExecuted: ["deploy_service", "create_change_ticket"] },
  },
  {
    id: "A03", name: "无工单发布（违规反馈后自主补齐前置条件）", category: "tool_selection", loginRole: "senior",
    expectedStatus: "completed",
    body: { task: "将 auto-svc v2.0.0 发布到生产环境", env: "prod", isEmergency: false, hasTicket: false, approvedByDirector: false, quotaUsed: 0, hourOverride: 14, expectedAction: "deploy_service" },
    trace: { executedSequence: ["create_change_ticket", "deploy_service"] },
  },
  {
    id: "A04", name: "时间违规（夜间发布被规则拦截）", category: "rule_interception", loginRole: "senior",
    expectedStatus: "blocked",
    body: { task: "将 auto-svc v3.0.0 发布到生产环境", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 0, hourOverride: 23, expectedAction: "deploy_service" },
    trace: { blockedAtLeast: 1, neverExecuted: ["deploy_service"] },
  },
  {
    id: "A05", name: "配额违规（当日已达上限被拦截）", category: "rule_interception", loginRole: "senior",
    expectedStatus: "blocked",
    body: { task: "将 auto-svc v4.0.0 发布到生产环境", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 3, hourOverride: 14, expectedAction: "deploy_service" },
    trace: { blockedAtLeast: 1, neverExecuted: ["deploy_service"] },
  },
  {
    id: "A06", name: "权限拦截（intern 发生产，身份来自登录）", category: "permission", loginRole: "intern",
    expectedStatus: "blocked",
    body: { task: "将 auto-svc v5.0.0 发布到生产环境", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 0, hourOverride: 14, expectedAction: "deploy_service" },
    trace: { blockedAtLeast: 1, neverExecuted: ["deploy_service"] },
  },
  {
    id: "A07", name: "规则冲突（夜间紧急未审批→人工裁决）", category: "rule_conflict", loginRole: "senior",
    expectedStatus: "conflict",
    body: { task: "将 auto-svc v6.0.0 发布到生产环境", env: "prod", isEmergency: true, hasTicket: true, approvedByDirector: false, quotaUsed: 0, hourOverride: 23, expectedAction: "deploy_service" },
    trace: { neverExecuted: ["deploy_service"] },
  },
  {
    id: "A08", name: "无关任务（意图识别 fail-closed 拒绝）", category: "intent_reject", loginRole: "senior",
    expectedStatus: "rejected",
    body: { task: "查询明天成都的天气情况", env: "prod", isEmergency: false, hasTicket: true, approvedByDirector: false, quotaUsed: 0, hourOverride: 14 },
    trace: {},
  },
];

/** 异常恢复场景（单独执行，走 paused→resume 路径） */
const RECOVERY: { id: string; name: string; loginRole: "senior"; body: Record<string, unknown>; attempts: number } = {
  id: "A09", name: "异常恢复（中断→暂停→恢复→完成，steps 追加无重复执行）", loginRole: "senior",
  body: { task: "将 auto-svc v7.0.0 发布到生产环境", env: "prod", isEmergency: false, hasTicket: false, approvedByDirector: false, quotaUsed: 0, hourOverride:14, expectedAction: "deploy_service" },
  attempts: 2,
};

// ---------- 基础设施 ----------

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

interface StepDetail {
  status: string;
  steps: Record<string, unknown>[];
  created_at: string;
  finished_at: string | null;
}

async function fetchDetail(executionId: string, token: string): Promise<StepDetail> {
  const res = await fetch(`${BASE}/api/executions/${executionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as { execution?: StepDetail };
  return (data.execution ?? data) as StepDetail;
}

/** 执行一个场景：SSE 流收终态 + 拉详情分析轨迹 */
async function runScenario(
  sc: AutoScenario,
  token: string
): Promise<{ status: string; detail: StepDetail | null; conclusion: string }> {
  const res = await fetch(`${BASE}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(sc.body),
  });
  // 意图识别拒绝：400 + fail-closed 语义
  if (res.status === 400) {
    try {
      const data = await res.json();
      if (String(data.error ?? "").includes("无法识别任务类型")) {
        return { status: "rejected", detail: null, conclusion: data.error as string };
      }
    } catch { /* 非 JSON */ }
    return { status: "error", detail: null, conclusion: `HTTP ${res.status}` };
  }
  if (!res.ok || !res.body) {
    return { status: "error", detail: null, conclusion: `HTTP ${res.status}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let status = "unknown";
  let conclusion = "";
  let executionId = "";
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
            if (event === "execution") executionId = String(data.id ?? executionId);
            if (event === "done") {
              status = String(data.status ?? status);
              conclusion = String(data.conclusion ?? "");
            }
            if (event === "decision_request") hadConflict = true;
          } catch { /* ignore */ }
        }
      }
    }
  }
  if (hadConflict) status = "conflict";
  const detail = executionId ? await fetchDetail(executionId, token) : null;
  return { status, detail, conclusion };
}

/** 异常恢复：发起 → 立即断开 → 等 paused → resume → 断言 */
async function runRecovery(
  token: string,
  attempt: number,
  svcSuffix: string
): Promise<{ ok: boolean; checks: string[] }> {
  const body = {
    ...RECOVERY.body,
    task: `将 auto-svc v7.${attempt}.0-${svcSuffix} 发布到生产环境`,
  };
  const controller = new AbortController();
  const res = await fetch(`${BASE}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (!res.ok || !res.body) return { ok: false, checks: [`发起失败 HTTP ${res.status}`] };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let executionId = "";
  // 收到 execution 事件后立即断开（模拟执行中途网络断连）
  while (executionId === "") {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            const data = JSON.parse(line.slice(5).trim());
            if (data.id) executionId = String(data.id);
          } catch { /* ignore */ }
        }
      }
    }
  }
  controller.abort(); // 断开 SSE → 服务端 signal aborted → paused
  if (!executionId) return { ok: false, checks: ["未拿到 executionId"] };

  // 轮询等 paused（最多 30s）
  let detail: StepDetail | null = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    detail = await fetchDetail(executionId, token);
    if (detail.status === "paused") break;
  }
  if (!detail || detail.status !== "paused") {
    return { ok: false, checks: [`未进入 paused（实际 ${detail?.status ?? "?"}）`] };
  }
  const pausedSteps = detail.steps.length;

  // resume
  const resumeRes = await fetch(`${BASE}/api/executions/${executionId}/resume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const resumeData = (await resumeRes.json()) as { status?: string };
  if (!resumeRes.ok) {
    return { ok: false, checks: [`恢复失败 HTTP ${resumeRes.status}`] };
  }
  detail = await fetchDetail(executionId, token);
  const checks: string[] = [];
  checks.push(`恢复后终态 ${detail.status}${detail.status === "completed" ? " ✓" : " ✗"}`);
  checks.push(`steps ${pausedSteps} → ${detail.steps.length}（追加 ${detail.steps.length >= pausedSteps ? "✓" : "✗"}）`);
  const executed = (detail.steps ?? [])
    .filter((s) => s.kind === "audit" && s.result === "executed")
    .map((s) => String(s.action));
  const unique = new Set(executed);
  checks.push(`执行动作 ${executed.join("→") || "无"}（无重复 ${executed.length === unique.size ? "✓" : "✗"}）`);
  const ok =
    detail.status === "completed" &&
    detail.steps.length >= pausedSteps &&
    executed.length === unique.size &&
    executed.includes("deploy_service");
  checks.push(executed.includes("deploy_service") ? "核心动作已执行 ✓" : "核心动作未执行 ✗");
  return { ok, checks };
}

// ---------- 轨迹断言 ----------

function assertTrace(sc: AutoScenario, detail: StepDetail | null): { ok: boolean; detail: string } {
  const fails: string[] = [];
  const passes: string[] = [];
  if (!detail) return { ok: false, detail: "无执行详情" };
  const steps = detail.steps ?? [];
  const executed = steps
    .filter((s) => s.kind === "audit" && s.result === "executed")
    .map((s) => String(s.action));
  const blockCount = steps.filter((s) => s.kind === "audit" && s.result === "block").length;

  // 全局断言一：env 系统绑定一致性（参数校验）——所有 pass 步骤的 args.env 必须等于场景 env
  const scenarioEnv = sc.body.env;
  const passSteps = steps.filter((s) => s.verdict === "pass" && typeof s === "object" && s !== null);
  const envViolations = passSteps.filter((s) => {
    const args = (s as Record<string, unknown>).args as Record<string, unknown> | undefined;
    return args && typeof args.env === "string" && args.env !== scenarioEnv;
  });
  if (envViolations.length > 0) {
    fails.push(`env 绑定违规 ${envViolations.length} 处`);
  } else if (passSteps.length > 0) {
    passes.push(`env 绑定一致（${passSteps.length} 个 pass 步骤）`);
  }

  // 全局断言二：审计完整性——每条步骤带时间戳
  const missingTs = steps.filter((s) => typeof (s as Record<string, unknown>).timestamp !== "string").length;
  if (missingTs > 0) {
    fails.push(`${missingTs} 条步骤缺时间戳`);
  } else {
    passes.push(`时间戳完整（${steps.length} 步）`);
  }

  // 场景轨迹断言
  if (sc.trace.executedAtLeast) {
    for (const a of sc.trace.executedAtLeast) {
      if (executed.includes(a)) passes.push(`已执行 ${a}`);
      else fails.push(`应执行 ${a}（实际 ${executed.join("、") || "无"}）`);
    }
  }
  if (sc.trace.neverExecuted) {
    for (const a of sc.trace.neverExecuted) {
      if (!executed.includes(a)) passes.push(`未执行 ${a}`);
      else fails.push(`不应执行 ${a}`);
    }
  }
  if (sc.trace.blockedAtLeast !== undefined) {
    if (blockCount >= sc.trace.blockedAtLeast) passes.push(`拦截 ${blockCount} 次`);
    else fails.push(`拦截次数不足（${blockCount} < ${sc.trace.blockedAtLeast}）`);
  }
  if (sc.trace.executedSequence) {
    const idxs = sc.trace.executedSequence.map((a) => executed.indexOf(a));
    if (idxs.every((i) => i >= 0) && idxs.every((v, i) => i === 0 || v > idxs[i - 1])) {
      passes.push(`动作序列 ${sc.trace.executedSequence.join("→")}`);
    } else {
      fails.push(`序列应为 ${sc.trace.executedSequence.join("→")}（实际 ${executed.join("→") || "无"}）`);
    }
  }
  return {
    ok: fails.length === 0,
    detail: [...passes.map((p) => `✓ ${p}`), ...fails.map((f) => `✗ ${f}`)].join("；"),
  };
}

// ---------- 主流程 ----------

/**
 * 环境健康检查（DEV_LOG #46 教训）：检索链路依赖 RAG 服务 + Embedding API，
 * 任一故障时所有场景会因 fail-closed 整单拦截——拦截类场景会假阳性通过。
 * 评测前先探测，故障则中止并提示，避免把"环境故障"统计成"评测通过"。
 */
async function preflight(): Promise<string | null> {
  const probe = await fetch(
    `http://localhost:3000/api/retrieval?query=${encodeURIComponent("发布到生产环境")}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!probe.ok) {
    const body = await probe.text().catch(() => "");
    return `RAG 检索端点不健康（HTTP ${probe.status}）：${body.slice(0, 200)}——请检查 RAG 服务与 Embedding API（如 SiliconFlow 余额）`;
  }
  return null;
}

async function main() {
  const healthError = await preflight();
  if (healthError) {
    console.error(`✗ 环境健康检查失败，评测中止：${healthError}`);
    process.exit(2);
  }
  console.log("✓ 环境健康检查通过（RAG 检索端点正常）");

  const seniorToken = await login("senior@demo.com");
  const internToken = await login("intern@demo.com");
  const tokens: Record<string, string> = { senior: seniorToken, intern: internToken };

  // 每轮唯一服务名/版本：隔离真实状态累积（DEV_LOG #24/41 教训）
  const svc = `auto-svc-${Date.now()}`;
  for (const sc of SCENARIOS) {
    if (typeof sc.body.task === "string") {
      sc.body.task = sc.body.task.replace(/auto-svc/g, svc).replace(/v1\.0\.0/g, `v${Date.now() % 1000}.1`);
    }
  }

  interface Row { sc: AutoScenario; status: string; statusOk: boolean; traceOk: boolean; traceDetail: string; conclusion: string; }
  const rows: Row[] = [];
  for (const sc of SCENARIOS) {
    const r = await runScenario(sc, tokens[sc.loginRole]);
    const statusOk = r.status === sc.expectedStatus;
    const traceRes = r.detail ? assertTrace(sc, r.detail) : { ok: true, detail: "（无轨迹：400 拒绝路径）" };
    rows.push({ sc, status: r.status, statusOk, traceOk: traceRes.ok, traceDetail: traceRes.detail, conclusion: r.conclusion.slice(0, 80) });
    const overall = statusOk && traceRes.ok;
    console.log(`[${overall ? "✓" : "✗"}] ${sc.id} ${sc.name} → ${r.status}（预期 ${sc.expectedStatus}）`);
    console.log(`    轨迹: ${traceRes.detail}`);
  }

  // 异常恢复场景
  const recoveryRows: { attempt: number; ok: boolean; checks: string[] }[] = [];
  for (let a = 0; a < RECOVERY.attempts; a++) {
    const r = await runRecovery(seniorToken, a, String(Date.now() % 10000));
    recoveryRows.push({ attempt: a + 1, ok: r.ok, checks: r.checks });
    console.log(`[${r.ok ? "✓" : "✗"}] ${RECOVERY.id} 第${a + 1}次 ${RECOVERY.name}`);
    for (const c of r.checks) console.log(`    ${c}`);
  }

  // ---------- 指标统计 ----------
  const total = rows.length;
  const statusPassed = rows.filter((r) => r.statusOk).length;
  const taskSuccessRate = total > 0 ? (statusPassed / total) * 100 : 0;

  // 规则拦截准确率：拦截类（blocked/conflict 预期）与合规类（completed 预期）分开统计
  const interception = rows.filter((r) => r.sc.expectedStatus === "blocked" || r.sc.expectedStatus === "conflict");
  const compliance = rows.filter((r) => r.sc.expectedStatus === "completed");
  const missCount = interception.filter((r) => r.status === "completed").length; // 漏拦
  const falseAlarm = compliance.filter((r) => r.status === "blocked" || r.status === "conflict").length; // 误拦
  const interceptionTotal = interception.length + compliance.length;
  const interceptionAccuracy = interceptionTotal > 0
    ? ((interceptionTotal - missCount - falseAlarm) / interceptionTotal) * 100 : 0;

  const recoveryPassed = recoveryRows.filter((r) => r.ok).length;
  const recoveryRate = recoveryRows.length > 0 ? (recoveryPassed / recoveryRows.length) * 100 : 0;

  // ---------- 报告 ----------
  const lines = [
    "# Agent 自动化评测报告（P9：基于执行轨迹的业务任务测试集）",
    "",
    `> 生成时间：${new Date().toISOString()}`,
    "",
    "> **评测方式**：真实 /api/execute 全链路执行（RAG 召回 + 结构化 + 规则引擎 + Agent 循环），断言对象为最终业务状态 + 执行轨迹（steps 中的审计记录、判定结果、时间戳、env 绑定）。",
    "> **规模声明**：覆盖工具选择 / 参数校验（全局断言）/ 规则拦截与冲突 / 权限拦截 / 意图拒绝 / 异常恢复六类场景；LLM 路径存在随机性，失败场景应重跑并统计稳定性。企业级需百级场景与真实业务数据回归。",
    "",
    "## 指标汇总",
    "",
    `| 指标 | 结果 |`,
    `|------|------|`,
    `| 任务成功率 | ${statusPassed}/${total}（${taskSuccessRate.toFixed(1)}%） |`,
    `| 规则拦截准确率 | 漏拦 ${missCount}、误拦 ${falseAlarm}（${interceptionAccuracy.toFixed(1)}%） |`,
    `| 异常恢复成功率 | ${recoveryPassed}/${recoveryRows.length}（${recoveryRate.toFixed(1)}%） |`,
    "",
    "## 场景明细",
    "",
    "| ID | 场景 | 预期 | 实际 | 终态 | 轨迹 | 结论摘要 |",
    "|----|------|------|------|------|------|----------|",
    ...rows.map(
      (r) =>
        `| ${r.sc.id} | ${r.sc.name} | ${r.sc.expectedStatus} | ${r.status} | ${r.statusOk ? "✓" : "✗"} | ${r.traceOk ? "✓" : "✗"} | ${r.conclusion} |`
    ),
    "",
    "## 异常恢复明细",
    "",
    ...recoveryRows.map(
      (r) => `- 第${r.attempt}次：${r.ok ? "✓" : "✗"} ${r.checks.join("；")}`
    ),
    "",
  ];
  mkdirSync("docs", { recursive: true });
  writeFileSync(join("docs", "eval-agent-auto-results.md"), lines.join("\n"), "utf-8");
  console.log(`\n任务成功率: ${statusPassed}/${total}；拦截准确率: 漏拦 ${missCount} 误拦 ${falseAlarm}；恢复成功率: ${recoveryPassed}/${recoveryRows.length}`);
  console.log("报告已写入 docs/eval-agent-auto-results.md");
  if (statusPassed < total || recoveryPassed < recoveryRows.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
