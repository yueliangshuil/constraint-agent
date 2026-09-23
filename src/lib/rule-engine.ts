/**
 * 约束规则引擎：LLM 结构化产出 → Zod 校验 → 表达式白名单校验 → 自研解释器确定性判定
 *
 * 判定逻辑：
 * - expression 语义：true = 约束触发（禁止/豁免生效）
 * - 无触发约束 → pass；触发的 exception 优先级高于 blocker → 豁免放行；
 *   低于 → 拦截；同优先级 blocker 与 exception 同时触发 → conflict（人工裁决）
 * - 非法表达式（解析失败/未声明变量/结果非布尔）→ fail-closed 按触发处理（宁可误拦）
 */
import { z } from "zod";
import {
  evaluateExpr,
  extractIdentifiers as extractIdentifiersFromAst,
  parseExpression,
  type ExprNode,
} from "./expression";
import {
  CONTEXT_KEYS,
  type Constraint,
  type EngineDecision,
  type EvaluatedConstraint,
  type ExecContext,
} from "@/types/constraint";

// ---------- Zod 结构强校验 ----------

export const constraintSchema = z.object({
  ruleName: z.string().min(1, "规则名不能为空"),
  ruleType: z.enum(["time", "permission", "quota", "precondition", "exception"]),
  priority: z.number().int().min(1).max(5),
  forbidAction: z.array(z.string()).min(1, "至少指定一个适用动作"),
  expression: z.string().min(1, "表达式不能为空"),
  sourceDoc: z.string().min(1),
  sourceChunk: z.string().min(1),
});

/** 示例上下文：用于校验表达式求值结果是否为布尔 */
const SAMPLE_CONTEXT: ExecContext = {
  hour: 12,
  weekday: 3,
  isWorkday: true,
  role: "senior",
  action: "deploy_service",
  env: "prod",
  quotaUsed: 0,
  quotaLimit: 3,
  isEmergency: false,
  hasTicket: true,
  approvedByDirector: false,
};

// ---------- 表达式语义校验（AST 白名单） ----------

export interface ExpressionCheck {
  ok: boolean;
  identifiers: string[];
  error?: string;
}

/** 从表达式字符串提取标识符（解析失败返回空数组） */
export function extractIdentifiers(expression: string): string[] {
  const parsed = parseExpression(expression);
  return parsed.ok ? extractIdentifiersFromAst(parsed.node) : [];
}

/** 三道防线之二：解析 AST → 变量白名单比对 → 布尔结果校验 */
export function validateExpression(expression: string): ExpressionCheck {
  const parsed = parseExpression(expression);
  if (!parsed.ok) {
    return { ok: false, identifiers: [], error: parsed.error };
  }
  const identifiers = extractIdentifiersFromAst(parsed.node);
  const illegal = identifiers.filter((id) => !(CONTEXT_KEYS as string[]).includes(id));
  if (illegal.length > 0) {
    return { ok: false, identifiers, error: `未声明的变量: ${illegal.join(", ")}` };
  }
  try {
    const result = evaluateExpr(parsed.node, SAMPLE_CONTEXT as unknown as Record<string, unknown>);
    if (typeof result !== "boolean") {
      return { ok: false, identifiers, error: `表达式结果不是布尔值（${typeof result}）` };
    }
  } catch (err) {
    return {
      ok: false,
      identifiers,
      error: err instanceof Error ? err.message : "表达式求值失败",
    };
  }
  return { ok: true, identifiers };
}

// ---------- 规则判定 ----------

/** 求值单个表达式：任何异常都 fail-closed 按触发处理 */
function evaluateSingle(node: ExprNode | null, ctx: ExecContext): boolean {
  if (!node) return true;
  try {
    const result = evaluateExpr(node, ctx as unknown as Record<string, unknown>);
    return typeof result === "boolean" ? result : true;
  } catch {
    return true;
  }
}

export function evaluateConstraints(
  constraints: Constraint[],
  ctx: ExecContext
): EngineDecision {
  const applicable = constraints.filter(
    (c) => c.forbidAction.includes(ctx.action) || c.forbidAction.includes("*")
  );

  const evaluated: EvaluatedConstraint[] = applicable.map((constraint) => {
    const parsed = parseExpression(constraint.expression);
    const triggered = parsed.ok
      ? evaluateSingle(parsed.node, ctx)
      : true; // 解析失败 → fail-closed
    return { constraint, triggered };
  });

  const blockers = evaluated.filter(
    (e) => e.triggered && e.constraint.ruleType !== "exception"
  );
  const exemptions = evaluated.filter(
    (e) => e.triggered && e.constraint.ruleType === "exception"
  );

  if (blockers.length === 0) {
    return { verdict: "pass", evaluated };
  }

  const topBlockPriority = Math.max(...blockers.map((b) => b.constraint.priority));
  const highestBlockers = blockers.filter(
    (b) => b.constraint.priority === topBlockPriority
  );
  const topExemptPriority = exemptions.length
    ? Math.max(...exemptions.map((e) => e.constraint.priority))
    : 0;
  const highestExemptions = exemptions.filter(
    (e) => e.constraint.priority === topExemptPriority
  );

  // 同优先级：禁止与豁免同时生效 → 冲突，人工裁决
  if (topExemptPriority === topBlockPriority && highestExemptions.length > 0) {
    return {
      verdict: "conflict",
      blockers: highestBlockers,
      exemptions: highestExemptions,
      evaluated,
    };
  }
  // 高优豁免覆盖低优禁止
  if (topExemptPriority > topBlockPriority) {
    return { verdict: "pass", evaluated };
  }
  return { verdict: "block", violated: highestBlockers, evaluated };
}
