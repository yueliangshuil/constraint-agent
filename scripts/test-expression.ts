/**
 * 表达式引擎 + 规则引擎单元测试（P4，评审意见 3）
 * 覆盖：正常值 / 边界值 / 缺失变量 / 类型错误 / 非法表达式 / 优先级回归 / 短路求值 / 白名单 / 引擎三分支
 * 运行：pnpm tsx scripts/test-expression.ts
 */
import { evaluateExpr, extractIdentifiers, parseExpression } from "../src/lib/expression";
import { constraintSchema, evaluateConstraints, validateExpression } from "../src/lib/rule-engine";
import type { Constraint, ExecContext } from "../src/types/constraint";

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

/** 合法表达式解析（失败直接抛错，用于期望合法的用例） */
function mustParse(expr: string) {
  const r = parseExpression(expr);
  if (!r.ok) throw new Error(`解析失败: ${expr} → ${r.error}`);
  return r.node;
}

/** 期望抛错：返回错误信息，未抛错返回 null */
function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ---------- 语法与求值（正常值 / 边界值 / 优先级回归 / 短路） ----------

check(
  evaluateExpr(mustParse("hour >= 22 || hour < 6"), { hour: 14 }) === false,
  "优先级回归：hour=14 时「hour >= 22 || hour < 6」为 false（expr-eval bug 场景）"
);
check(
  evaluateExpr(mustParse("hour >= 22 || hour < 6"), { hour: 23 }) === true,
  "边界值：hour=23 命中夜间窗口"
);
check(
  evaluateExpr(mustParse("hour >= 22 || hour < 6"), { hour: 5 }) === true,
  "边界值：hour=5 命中凌晨窗口"
);
check(
  evaluateExpr(mustParse("hour >= 22 || hour < 6"), { hour: 6 }) === false,
  "边界值：hour=6 整点不在窗口内（< 6 不含 6）"
);
check(
  evaluateExpr(mustParse("hour >= 22 || hour < 6"), { hour: 22 }) === true,
  "边界值：hour=22 整点命中（>= 22 含 22）"
);
check(
  evaluateExpr(mustParse("env == 'prod' && (hour >= 22 || hour < 6)"), { env: "prod", hour: 14 }) === false,
  "括号分组：白天为 false"
);
check(
  evaluateExpr(mustParse("!(hour < 6)"), { hour: 5 }) === false,
  "一元取反：!(hour < 6) 在 hour=5 为 false"
);
check(
  evaluateExpr(mustParse("true"), {}) === true && evaluateExpr(mustParse("false"), {}) === false,
  "布尔字面量：true/false"
);
check(
  evaluateExpr(mustParse("env != 'staging'"), { env: "prod" }) === true,
  "字符串比较：env != 'staging'"
);
check(
  evaluateExpr(mustParse("quotaUsed >= quotaLimit"), { quotaUsed: 2, quotaLimit: 3 }) === false,
  "边界值：配额 2/3 未触发"
);
check(
  evaluateExpr(mustParse("quotaUsed >= quotaLimit"), { quotaUsed: 3, quotaLimit: 3 }) === true,
  "边界值：配额 3/3 触发"
);
check(
  evaluateExpr(mustParse("false && hasTiket == true"), {}) === false,
  "短路求值：false && 未知变量 → 不求右值直接 false"
);
check(
  evaluateExpr(mustParse("true || hasTiket == true"), {}) === true,
  "短路求值：true || 未知变量 → 不求右值直接 true"
);

// ---------- 缺失变量 / 类型错误 ----------

check(
  throws(() => evaluateExpr(mustParse("hasTiket == true"), {}))?.includes("未声明的变量") ?? false,
  "缺失变量：hasTiket 未声明 → 求值抛错（fail-closed 前置）"
);
check(
  throws(() => evaluateExpr(mustParse("hour > '22'"), { hour: 14 }))?.includes("比较运算需要数字") ?? false,
  "类型错误：数字与字符串比较 → 抛错"
);
check(
  throws(() => evaluateExpr(mustParse("quotaUsed"), { quotaUsed: 1 }))?.includes("不是布尔值") ?? false,
  "类型错误：裸标识符结果非布尔 → 抛错"
);
check(
  !parseExpression("quotaUsed + quotaLimit").ok,
  "语法沙箱：+ 算术运算符不存在于语法中 → 词法阶段拒绝（注入风险为零）"
);
check(
  throws(() => evaluateExpr(mustParse("1 && true"), {}))?.includes("左侧不是布尔值") ?? false,
  "类型错误：&& 左侧非布尔 → 抛错"
);

// ---------- 非法表达式 ----------

check(!parseExpression("env == 'prod' &&").ok, "非法表达式：结尾残缺 → 解析失败");
check(!parseExpression("(hour >= 22").ok, "非法表达式：括号未闭合 → 解析失败");
check(!parseExpression("hour >= 22 &&& hour < 6").ok, "非法表达式：非法字符 & → 解析失败");
check(!parseExpression("env == 'prod").ok, "非法表达式：字符串未闭合 → 解析失败");

// ---------- Zod 结构与白名单 ----------

check(
  constraintSchema.safeParse({
    ruleName: "x", ruleType: "time", priority: 6,
    forbidAction: ["deploy_service"], expression: "true",
    sourceDoc: "t", sourceChunk: "t",
  }).success === false,
  "Zod：priority=6 超出 1-5 被拒"
);
check(
  constraintSchema.safeParse({
    ruleName: "x", ruleType: "time-window", priority: 3,
    forbidAction: ["deploy_service"], expression: "true",
    sourceDoc: "t", sourceChunk: "t",
  }).success === false,
  "Zod：ruleType 非法枚举被拒"
);
check(validateExpression("env == 'prod' && hour >= 22").ok, "白名单：合法表达式通过");
check(
  !validateExpression("env == 'prod' && isWeekend").ok,
  "白名单：未声明变量 isWeekend 被拒"
);
const ids = extractIdentifiers(mustParse("env == 'prod' && (hour >= 22 || hour < 6) && isWorkday"));
check(
  ["env", "hour", "isWorkday"].every((k) => ids.includes(k)) && ids.length === 3,
  "标识符提取：遍历 AST 收集全部变量"
);

// ---------- 引擎三分支（pass / block / conflict） ----------

const ctxBase: ExecContext = {
  hour: 23, weekday: 3, isWorkday: true, role: "senior", action: "deploy_service",
  env: "prod", quotaUsed: 0, quotaLimit: 3, isEmergency: false,
  hasTicket: true, approvedByDirector: false, hasVersionDeployed: false,
};
const C = (
  ruleName: string, ruleType: Constraint["ruleType"], priority: number,
  expression: string, forbidAction = ["deploy_service"]
): Constraint => ({
  ruleName, ruleType, priority, forbidAction, expression, sourceDoc: "test", sourceChunk: "test",
});

const timeRule = C("发布时间窗口", "time", 3, "env == 'prod' && (hour >= 22 || hour < 6)");
check(evaluateConstraints([timeRule], ctxBase).verdict === "block", "引擎：触发禁止 → block");
check(evaluateConstraints([timeRule], { ...ctxBase, hour: 14 }).verdict === "pass", "引擎：未触发 → pass");

const exemptHigh = C("紧急豁免", "exception", 5, "isEmergency && approvedByDirector");
check(
  evaluateConstraints([timeRule, exemptHigh], { ...ctxBase, isEmergency: true, approvedByDirector: true }).verdict === "pass",
  "引擎：高优豁免覆盖低优禁止 → pass"
);
check(
  evaluateConstraints([timeRule, exemptHigh], { ...ctxBase, isEmergency: true }).verdict === "block",
  "引擎：豁免未触发 → 仍 block"
);
check(
  evaluateConstraints([timeRule, C("低优豁免", "exception", 2, "isEmergency")], { ...ctxBase, isEmergency: true }).verdict === "block",
  "引擎：低优豁免不敌高优禁止 → block"
);
check(
  evaluateConstraints([timeRule, C("同级豁免", "exception", 3, "isEmergency")], { ...ctxBase, isEmergency: true }).verdict === "conflict",
  "引擎：同优先级禁止+豁免同时触发 → conflict（转人工裁决）"
);

const quota = C("发布配额", "quota", 3, "quotaUsed >= quotaLimit");
check(
  evaluateConstraints([quota], { ...ctxBase, quotaUsed: 2 }).verdict === "pass" &&
    evaluateConstraints([quota], { ...ctxBase, quotaUsed: 3 }).verdict === "block",
  "引擎边界：配额 2 次不拦、3 次拦"
);
check(
  evaluateConstraints([C("工单前置", "precondition", 3, "!hasTicket", ["create_change_ticket"])], ctxBase).verdict === "pass",
  "引擎：forbidAction 不匹配当前动作 → 不参与判定"
);
check(
  evaluateConstraints([C("坏规则", "time", 3, "hour >=")], ctxBase).verdict === "block",
  "引擎 fail-closed：表达式解析失败 → 按触发拦截（宁可误拦）"
);
check(
  evaluateConstraints([C("全局权限", "permission", 5, "role == 'intern'", ["*"])], { ...ctxBase, role: "intern", action: "query_quota" }).verdict === "block",
  "引擎：forbidAction 通配符 * 匹配任意动作"
);

// ---------- 汇总 ----------

console.log(`\n表达式/规则引擎单元测试：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
