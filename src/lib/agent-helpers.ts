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
