/**
 * 约束感知规划 Agent 核心类型
 * 设计文档：Desktop\简历\业务约束感知自适应规划Agent - 技术方案与开发难点.md
 */

/** 工具调用的执行上下文——表达式可引用的全部变量（白名单即本类型的键） */
export interface ExecContext {
  // 时间
  hour: number; // 0-23
  weekday: number; // 1-7
  isWorkday: boolean;
  // 主体
  role: "intern" | "junior" | "senior" | "lead" | "director";
  // 操作
  action: "deploy_service" | "create_change_ticket" | "query_quota";
  env: "prod" | "staging";
  // 配额
  quotaUsed: number;
  quotaLimit: number;
  // 属性
  isEmergency: boolean;
  hasTicket: boolean;
  approvedByDirector: boolean;
}

/** 表达式白名单：ExecContext 的全部键 */
export const CONTEXT_KEYS: (keyof ExecContext)[] = [
  "hour",
  "weekday",
  "isWorkday",
  "role",
  "action",
  "env",
  "quotaUsed",
  "quotaLimit",
  "isEmergency",
  "hasTicket",
  "approvedByDirector",
];

export type RuleType = "time" | "permission" | "quota" | "precondition" | "exception";

/** LLM 结构化抽取产出的约束结构 */
export interface Constraint {
  ruleName: string;
  ruleType: RuleType;
  priority: number; // 1-5，越高越优先
  forbidAction: string[]; // 适用的工具动作
  /** 布尔表达式：true = 约束触发（禁止/豁免生效），只能引用 CONTEXT_KEYS */
  expression: string;
  sourceDoc: string;
  sourceChunk: string;
}

/** 规则引擎判定结果 */
export type EngineDecision =
  | {
      verdict: "pass";
      evaluated: EvaluatedConstraint[];
    }
  | {
      verdict: "block";
      violated: EvaluatedConstraint[];
      evaluated: EvaluatedConstraint[];
    }
  | {
      verdict: "conflict";
      blockers: EvaluatedConstraint[];
      exemptions: EvaluatedConstraint[];
      evaluated: EvaluatedConstraint[];
    };

export interface EvaluatedConstraint {
  constraint: Constraint;
  /** expression 在当前上下文中的求值结果（true = 触发） */
  triggered: boolean;
}

/** 约束文档半结构化模板的标签段 */
export interface RuleDocMeta {
  ruleType: RuleType;
  priority: number;
  forbidAction: string[];
  tags: string[];
  content: string;
}
