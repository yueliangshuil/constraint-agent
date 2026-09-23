/** 服务端环境变量读取与校验 */
export function getEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(`缺少环境变量 ${key}，请在 .env.local 中配置（参考 .env.example）`);
  }
  return value.trim();
}
