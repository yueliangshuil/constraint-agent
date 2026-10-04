/**
 * 种子演示账号（密码统一 demo123456）：
 *   director@demo.com（总监：执行/裁决/管规则/看全部审计）
 *   senior@demo.com（高级工程师：执行/看全部审计）
 *   intern@demo.com（实习生：仅执行，业务约束会拦截其违规操作）
 * 运行：pnpm tsx scripts/seed-users.ts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { hashPassword } from "../src/lib/auth";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0 && !line.trim().startsWith("#")) {
      env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  Object.assign(process.env, env);
  return env;
}

const SEEDS = [
  { email: "director@demo.com", name: "王总监", role: "director" },
  { email: "senior@demo.com", name: "李高级", role: "senior" },
  { email: "intern@demo.com", name: "张实习", role: "intern" },
] as const;

async function main() {
  loadEnv();
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  for (const s of SEEDS) {
    const { data: existing } = await db.from("users").select("id").eq("email", s.email).maybeSingle();
    if (existing) {
      console.log(`跳过（已存在）: ${s.email}`);
      continue;
    }
    const { error } = await db.from("users").insert({
      email: s.email,
      name: s.name,
      role: s.role,
      password_hash: hashPassword("demo123456"),
    });
    if (error) console.error(`创建失败 ${s.email}:`, error.message);
    else console.log(`已创建: ${s.email}（${s.role}）`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
