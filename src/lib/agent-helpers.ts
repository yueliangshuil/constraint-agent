/**
 * Agent 循环的纯函数辅助（可单元测试）
 *
 * 系统参数绑定：关键上下文参数（env）由任务场景决定，模型不可自由指定——
 * 否则模型可通过传不同参数绕过约束（DEV_LOG #20 记录的真实漏洞：
 * 任务声称发布生产，模型调工具时传 env=staging 绕过时间窗口约束）。
 */
export interface BindResult {
  args: Record<string, unknown>;
  /** 模型参数越权时的违规说明（null = 无越权） */
  violation: string | null;
}

export function bindSystemArgs(
  toolName: string,
  args: Record<string, unknown>,
  scenarioEnv: "prod" | "staging"
): BindResult {
  if (toolName === "deploy_service") {
    const env = args.env;
    if (env !== undefined && env !== scenarioEnv) {
      return {
        args,
        violation: `env=${String(env)} 与任务场景环境 ${scenarioEnv} 不符，环境由系统绑定`,
      };
    }
    // 系统注入：即使模型不传 env，也强制为场景环境
    return { args: { ...args, env: scenarioEnv }, violation: null };
  }
  return { args, violation: null };
}

/**
 * Agent 最小权限（任务工具裁剪）：
 * 按任务核心动作预选工具子集——模型物理上拿不到任务范围外的工具，
 * 从源头防止"过度代理"（OWASP LLM Top 10）；规则引擎校验作为检测层兜底。
 * 未声明核心动作的任务不暴露任何业务工具（最小权限默认值）。
 */
export const TOOL_SCOPES: Record<string, string[]> = {
  deploy_service: ["deploy_service", "create_change_ticket", "query_quota"],
  create_change_ticket: ["create_change_ticket"],
  query_quota: ["query_quota"],
};

export function filterToolsForTask(
  toolDefs: { type: "function"; function: { name: string } }[],
  expectedAction: string | undefined
): { type: "function"; function: { name: string } }[] {
  const allowed = expectedAction ? TOOL_SCOPES[expectedAction] ?? [] : [];
  if (allowed.length === 0) return [];
  return toolDefs.filter((t) => allowed.includes(t.function.name));
}
