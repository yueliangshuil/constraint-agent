-- 003_auth_and_rbac.sql
-- 用户权限管理（RBAC）+ 数据归属：
-- - users：单一角色字段同时驱动「平台权限」与「业务约束校验」（身份事实来源）
-- - auth_sessions：演示级会话令牌（生产替换为 Supabase Auth JWT，见 DEV_LOG）
-- - executions/decisions/deploy_records 增加 user_id/tenant_id 归属
-- 注：服务端使用 service_role key（绕过 RLS），数据隔离在应用层按 tenant_id/user_id 过滤；
--     RLS 策略保留为纵深防御兜底。

create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  name       text not null,
  role       text not null check (role in ('intern', 'junior', 'senior', 'lead', 'director')),
  password_hash text not null,
  tenant_id  text not null default 'demo-tenant',
  created_at timestamptz not null default now()
);

create table if not exists auth_sessions (
  token      uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now()
);
create index if not exists idx_auth_sessions_user on auth_sessions(user_id);

alter table executions add column if not exists user_id uuid references users(id);
alter table executions add column if not exists tenant_id text not null default 'demo-tenant';
alter table decisions  add column if not exists user_id uuid references users(id);
alter table decisions  add column if not exists tenant_id text not null default 'demo-tenant';
alter table deploy_records add column if not exists user_id uuid references users(id);
alter table deploy_records add column if not exists tenant_id text not null default 'demo-tenant';

create index if not exists idx_executions_tenant on executions(tenant_id, created_at desc);
create index if not exists idx_executions_user on executions(user_id, created_at desc);

-- RLS 兜底（服务端走 service_role，实际隔离在应用层；此策略防未来误用 anon）
alter table users enable row level security;
alter table auth_sessions enable row level security;
create policy "service_role_full" on users for all to service_role using (true) with check (true);
create policy "service_role_full" on auth_sessions for all to service_role using (true) with check (true);
