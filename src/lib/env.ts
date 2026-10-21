/** 服务端环境变量读取与校验 */
export function getEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(`缺少环境变量 ${key}，请在 .env.local 中配置（参考 .env.example）`);
  }
  return value.trim();
}

/**
 * 远程 MCP 工具接入配置（P8）：可选——
 * JENKINS_MCP_URL / JIRA_MCP_URL 为真实 Jira/Jenkins MCP Server 的 Streamable HTTP 地址；
 * 未配置时 deploy-tools 使用本地 mock 实现（演示自洽），配置后接入远程真实工具。
 */
export function getRemoteMcpConfig(): { jenkinsUrl: string | null; jiraUrl: string | null } {
  return {
    jenkinsUrl: process.env.JENKINS_MCP_URL?.trim() || null,
    jiraUrl: process.env.JIRA_MCP_URL?.trim() || null,
  };
}
