/**
 * 权限管理 E2E：认证、RBAC、身份绑定、Agent 最小权限（任务工具裁剪）
 * 运行：pnpm tsx scripts/test-rbac.ts（需 3000/3001 服务运行）
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BASE = "http://localhost:3001";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0 && !line.trim().startsWith("#")) {
      env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return env;
}

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else {
    failed++;
    console.log(`✗ ${msg}`);
  }
}

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* 流式响应 */
  }
  return { status: res.status, data, res };
}

async function login(email: string): Promise<{ token: string; user: { id: string; name: string; role: string } }> {
  const r = await api("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "demo123456" }),
  });
  if (r.status !== 200) throw new Error(`登录失败: ${email}`);
  const d = r.data as { token: string; user: { id: string; name: string; role: string } };
  return d;
}

async function execute(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let execId = "";
  let finalStatus = "";
  const scopedTools: string[] = [];
  const verdicts: { tool: string; verdict: string }[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "";
      let data: Record<string, unknown> = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          try {
            data = JSON.parse(line.slice(5).trim());
          } catch {
            /* ignore */
          }
        }
      }
      if (event === "execution") execId = String(data.id ?? "");
      if (event === "stage" && Array.isArray(data.scopedTools)) {
        scopedTools.push(...(data.scopedTools as string[]));
      }
      if (event === "validation" && data.tool && data.verdict) {
        verdicts.push({ tool: String(data.tool), verdict: String(data.verdict) });
      }
      if (event === "done" && data.status) finalStatus = String(data.status);
    }
  }
  return { execId, finalStatus, scopedTools, verdicts };
}

async function main() {
  const env = loadEnv();
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  console.log("=== 1. 未登录拒绝 ===");
  const noAuth = await api("/api/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "测试" }),
  });
  check(noAuth.status === 401, `未登录调用 execute → 401（实际 ${noAuth.status}）`);

  const intern = await login("intern@demo.com");
  const senior = await login("senior@demo.com");
  const director = await login("director@demo.com");

  console.log("\n=== 2. 身份绑定：角色来自登录身份，不接受表单自述 ===");
  const svc = `rbac-svc-${Date.now()}`; // 唯一服务名：避免与前几轮测试的真实部署记录撞配额
  const deployBody = {
    task: `将 ${svc} v2.3.0 发布到生产环境`,
    env: "prod",
    isEmergency: false,
    hasTicket: true,
    approvedByDirector: false,
    quotaUsed: 0,
    hourOverride: 14,
    expectedAction: "deploy_service",
  };
  const internRun = await execute(intern.token, deployBody);
  check(internRun.finalStatus === "blocked", `intern 发布终态 blocked（身份判定，无表单 role 字段）`);
  check(
    !internRun.verdicts.some((v) => v.tool === "deploy_service" && v.verdict === "pass"),
    "intern 全程无 deploy 放行（权限约束由登录身份触发）"
  );

  console.log("\n=== 3. 最小权限：任务工具裁剪 ===");
  const quotaRun = await execute(senior.token, {
    task: "查询 payment-service 今日发布配额使用情况",
    env: "prod",
    isEmergency: false,
    hasTicket: true,
    approvedByDirector: false,
    quotaUsed: 0,
    hourOverride: 10,
    expectedAction: "query_quota",
  });
  const scoped = [...new Set(quotaRun.scopedTools)];
  check(
    scoped.length === 1 && scoped[0] === "query_quota",
    `查询配额任务仅暴露 query_quota 工具（实际: ${scoped.join(",") || "无"}）`
  );
  check(
    !quotaRun.verdicts.some((v) => v.tool === "deploy_service"),
    "查询任务全程无 deploy 工具调用（物理不可见，非引擎拦截）"
  );

  const seniorRun = await execute(senior.token, { ...deployBody, task: `将 ${svc} v2.4.0 发布到生产环境` });
  check(seniorRun.finalStatus === "completed", `senior 合规发布完成（实际 ${seniorRun.finalStatus}）`);

  console.log("\n=== 4. 裁决 RBAC ===");
  // 构造冲突执行（夜间紧急未审批，senior 触发）；模型路径随机，最多重试 3 次
  let conflictRun = { execId: "", finalStatus: "" };
  for (let attempt = 0; attempt < 3; attempt++) {
    conflictRun = await execute(senior.token, {
      ...deployBody,
      task: `将 ${svc} v2.${5 + attempt}.0 发布到生产环境`,
      hourOverride: 23,
      isEmergency: true,
    });
    if (conflictRun.finalStatus === "conflict") break;
  }
  check(conflictRun.finalStatus === "conflict", `冲突场景就绪（实际 ${conflictRun.finalStatus}）`);

  const internDecide = await api(`/api/executions/${conflictRun.execId}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${intern.token}` },
    body: JSON.stringify({ decision: "allow" }),
  });
  check(internDecide.status === 403, `非总监裁决 → 403（实际 ${internDecide.status}）`);

  const directorDecide = await api(`/api/executions/${conflictRun.execId}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${director.token}` },
    body: JSON.stringify({ decision: "allow" }),
  });
  check(directorDecide.status === 201, `总监裁决 → 201（实际 ${directorDecide.status}）`);
  const { data: decision } = await db
    .from("decisions")
    .select("decided_by")
    .eq("execution_id", conflictRun.execId)
    .maybeSingle();
  check(decision?.decided_by === "王总监", `裁决人来自认证身份（实际: ${decision?.decided_by}）`);

  console.log("\n=== 5. 数据隔离：执行历史按角色过滤 ===");
  const internHistory = await api("/api/executions", {
    headers: { Authorization: `Bearer ${intern.token}` },
  });
  const directorHistory = await api("/api/executions", {
    headers: { Authorization: `Bearer ${director.token}` },
  });
  const internRows = ((internHistory.data as { executions: { user_id: string }[] })?.executions ?? []);
  const directorCount = ((directorHistory.data as { executions: unknown[] })?.executions ?? []).length;
  check(
    internRows.length > 0 && internRows.every((r) => r.user_id === intern.user.id),
    `intern 仅见本人记录（${internRows.length} 条全部归属本人）`
  );
  check(directorCount >= 3, `director 见全部记录（${directorCount} 条）`);

  console.log("\n=== 6. 规则管理 RBAC ===");
  const internRules = await api("/api/rules", {
    method: "POST",
    headers: { Authorization: `Bearer ${intern.token}` },
    body: new FormData(),
  });
  check(internRules.status === 403, `非总监管理规则 → 403（实际 ${internRules.status}）`);
  const directorRules = await api("/api/rules", {
    headers: { Authorization: `Bearer ${director.token}` },
  });
  check(directorRules.status === 200, `director 读取规则列表 → 200`);

  console.log(`\n${passed === passed + failed - failed && failed === 0 ? "✅ 全部通过" : "⚠ 有失败"}：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
