/**
 * 自研轻量布尔表达式解释器（词法分析 + 递归下降 + AST 求值）
 *
 * 背景（DEV_LOG #6）：原选型 expr-eval@2.0.2 存在 || 与比较运算符的优先级 bug
 * （"hour >= 22 || hour < 6" 在 hour=14 时求值为 true），且 AST 为扁平 token 流，
 * 无法可靠提取标识符做白名单校验。
 *
 * 自研理由：
 * 1. 只实现布尔逻辑所需的最小语法（&& || ! 比较 括号 字面量 标识符），
 *    函数调用/赋值/循环根本不存在于语法中 → 注入风险为零（语法层面沙箱）；
 * 2. AST 可控，标识符白名单校验直接遍历节点即可；
 * 3. 词法/语法错误全部显式抛出 → fail-closed 兜底。
 *
 * 语法（优先级从高到低）：! > 比较 > && > ||
 */

// ---------- AST ----------

export type ExprNode =
  | { kind: "literal"; value: number | boolean | string }
  | { kind: "identifier"; name: string }
  | { kind: "unary"; op: "!"; expr: ExprNode }
  | {
      kind: "binary";
      op: "&&" | "||" | "==" | "!=" | ">" | ">=" | "<" | "<=";
      left: ExprNode;
      right: ExprNode;
    };

// ---------- 词法分析 ----------

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ident"; name: string }
  | { kind: "op"; value: string }
  | { kind: "lparen" }
  | { kind: "rparen" };

const TWO_CHAR_OPS = ["&&", "||", "==", "!=", ">=", "<="];
const ONE_CHAR_OPS = [">", "<", "!"];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // 数字
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j++;
      const raw = input.slice(i, j);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`非法数字: ${raw}`);
      tokens.push({ kind: "num", value });
      i = j;
      continue;
    }
    // 字符串
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < input.length && input[j] !== ch) j++;
      if (j >= input.length) throw new Error("字符串未闭合");
      tokens.push({ kind: "str", value: input.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    // 标识符
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) j++;
      tokens.push({ kind: "ident", name: input.slice(i, j) });
      i = j;
      continue;
    }
    // 括号
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    // 运算符（先匹配双字符）
    const two = input.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    throw new Error(`非法字符: ${ch}`);
  }
  return tokens;
}

// ---------- 语法分析（递归下降） ----------

class ParserError extends Error {}

function parse(input: string): ExprNode {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token => {
    const t = tokens[pos];
    if (!t) throw new ParserError("表达式意外结束");
    pos++;
    return t;
  };
  const expectOp = (value: string): boolean => {
    const t = peek();
    return t?.kind === "op" && t.value === value;
  };

  // expr := orExpr
  function parseOr(): ExprNode {
    let left = parseAnd();
    while (expectOp("||")) {
      next();
      const right = parseAnd();
      left = { kind: "binary", op: "||", left, right };
    }
    return left;
  }
  // andExpr := unary ( '&&' unary )*
  function parseAnd(): ExprNode {
    let left = parseUnary();
    while (expectOp("&&")) {
      next();
      const right = parseUnary();
      left = { kind: "binary", op: "&&", left, right };
    }
    return left;
  }
  // unary := '!' unary | comparison
  function parseUnary(): ExprNode {
    if (expectOp("!")) {
      next();
      return { kind: "unary", op: "!", expr: parseUnary() };
    }
    return parseComparison();
  }
  // comparison := operand ( 比较运算符 operand )?
  function parseComparison(): ExprNode {
    const left = parsePrimary();
    const t = peek();
    if (t?.kind === "op" && ["==", "!=", ">", ">=", "<", "<="].includes(t.value)) {
      next();
      return { kind: "binary", op: t.value as never, left, right: parsePrimary() };
    }
    return left;
  }
  // primary := '(' expr ')' | 字面量 | 标识符
  function parsePrimary(): ExprNode {
    const t = next();
    if (t.kind === "num") return { kind: "literal", value: t.value };
    if (t.kind === "str") return { kind: "literal", value: t.value };
    if (t.kind === "ident") {
      if (t.name === "true") return { kind: "literal", value: true };
      if (t.name === "false") return { kind: "literal", value: false };
      return { kind: "identifier", name: t.name };
    }
    if (t.kind === "lparen") {
      const node = parseOr();
      const close = next();
      if (close.kind !== "rparen") throw new ParserError("缺少右括号");
      return node;
    }
    throw new ParserError(`意外的 token: ${JSON.stringify(t)}`);
  }

  const node = parseOr();
  if (pos < tokens.length) {
    throw new ParserError(`存在无法解析的内容: ${input.slice(pos)}`);
  }
  return node;
}

// ---------- 求值与工具 ----------

export type ParseResult = { ok: true; node: ExprNode } | { ok: false; error: string };

export function parseExpression(expression: string): ParseResult {
  try {
    return { ok: true, node: parse(expression) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "解析失败" };
  }
}

/** 求值：未知变量/类型不匹配/结果非布尔 → 抛错（调用方 fail-closed） */
export function evaluateExpr(node: ExprNode, ctx: Record<string, unknown>): boolean {
  const value = evalNode(node, ctx);
  if (typeof value !== "boolean") {
    throw new Error(`表达式结果不是布尔值（${typeof value}）`);
  }
  return value;
}

function evalNode(node: ExprNode, ctx: Record<string, unknown>): unknown {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "identifier": {
      if (!(node.name in ctx)) {
        throw new Error(`未声明的变量: ${node.name}`);
      }
      return ctx[node.name];
    }
    case "unary":
      return !evalNode(node.expr, ctx);
    case "binary": {
      // 短路求值
      if (node.op === "&&") {
        const l = evalNode(node.left, ctx);
        if (typeof l !== "boolean") throw new Error("&& 左侧不是布尔值");
        if (!l) return false;
        const r = evalNode(node.right, ctx);
        if (typeof r !== "boolean") throw new Error("&& 右侧不是布尔值");
        return r;
      }
      if (node.op === "||") {
        const l = evalNode(node.left, ctx);
        if (typeof l !== "boolean") throw new Error("|| 左侧不是布尔值");
        if (l) return true;
        const r = evalNode(node.right, ctx);
        if (typeof r !== "boolean") throw new Error("|| 右侧不是布尔值");
        return r;
      }
      const left = evalNode(node.left, ctx);
      const right = evalNode(node.right, ctx);
      switch (node.op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case ">":
          return asNumbers(left, right)[0] > asNumbers(left, right)[1];
        case ">=":
          return asNumbers(left, right)[0] >= asNumbers(left, right)[1];
        case "<":
          return asNumbers(left, right)[0] < asNumbers(left, right)[1];
        case "<=":
          return asNumbers(left, right)[0] <= asNumbers(left, right)[1];
      }
    }
  }
}

function asNumbers(a: unknown, b: unknown): [number, number] {
  if (typeof a !== "number" || typeof b !== "number") {
    throw new Error(`比较运算需要数字（${typeof a} vs ${typeof b}）`);
  }
  return [a, b];
}

/** 提取表达式中的全部标识符（白名单校验用） */
export function extractIdentifiers(node: ExprNode): string[] {
  const ids = new Set<string>();
  const walk = (n: ExprNode): void => {
    if (n.kind === "identifier") {
      ids.add(n.name);
    } else if (n.kind === "unary") {
      walk(n.expr);
    } else if (n.kind === "binary") {
      walk(n.left);
      walk(n.right);
    }
  };
  walk(node);
  return [...ids];
}
