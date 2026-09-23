import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "./env";

/** 服务端 Supabase 客户端（service_role key），仅服务端使用 */
let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
  }
  return client;
}
