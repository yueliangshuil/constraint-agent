import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpr, extractIdentifiers, parseExpression } from "./expression";

function evalStr(expr: string, ctx: Record<string, unknown>): boolean {
  const parsed = parseExpression(expr);
  assert.equal(parsed.ok, true, `解析失败: ${parsed.ok ? "" : parsed.error}`);
  if (!parsed.ok) throw new Error("unreachable");
  return evaluateExpr(parsed.node, ctx);
}

test("优先级：|| 低于 &&，比较高于两者", () => {
  const ctx = { a: true, b: false, c: true };
  assert.equal(evalStr("a || b && c", ctx), true); // a || (b && c)
  assert.equal(evalStr("false || false && true", {}), false);
});

test("一元取反与括号", () => {
  assert.equal(evalStr("!(1 > 2)", {}), true);
  assert.equal(evalStr("!(true && false)", {}), true);
});

test("字符串比较（env 判断）", () => {
  assert.equal(evalStr('env == "prod"', { env: "prod" }), true);
  assert.equal(evalStr('env != "prod"', { env: "staging" }), true);
});

test("数字比较链", () => {
  assert.equal(evalStr("quotaUsed >= quotaLimit", { quotaUsed: 3, quotaLimit: 3 }), true);
  assert.equal(evalStr("hour >= 22 || hour < 6", { hour: 14 }), false);
  assert.equal(evalStr("hour >= 22 || hour < 6", { hour: 23 }), true);
});

test("短路求值：右侧未声明变量不报错（|| 左侧为 true）", () => {
  assert.equal(evalStr("true || undeclaredVar > 1", {}), true);
  assert.equal(evalStr("false && undeclaredVar > 1", {}), false);
});

test("布尔字面量 true/false", () => {
  assert.equal(evalStr("isEmergency && true", { isEmergency: true }), true);
  assert.equal(evalStr("isEmergency && false", { isEmergency: true }), false);
});

test("未声明变量抛错（调用方 fail-closed）", () => {
  const parsed = parseExpression("undeclaredVar > 5");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.throws(() => evaluateExpr(parsed.node, {}), /未声明的变量/);
  }
});

test("词法错误：非法字符与未闭合字符串", () => {
  assert.equal(parseExpression("hour + 1").ok, false);
  assert.equal(parseExpression('env == "prod').ok, false);
});

test("语法错误：缺少右括号、悬空运算符", () => {
  assert.equal(parseExpression("(hour > 5").ok, false);
  assert.equal(parseExpression("hour >").ok, false);
});

test("extractIdentifiers：AST 遍历提取全部变量", () => {
  const parsed = parseExpression("hour >= 22 || (isEmergency && approvedByDirector)");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(
      [...extractIdentifiers(parsed.node)].sort(),
      ["approvedByDirector", "hour", "isEmergency"]
    );
  }
});
