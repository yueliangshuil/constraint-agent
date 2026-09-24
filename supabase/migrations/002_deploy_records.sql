-- 002_deploy_records.sql
-- 部署执行记录：配额约束的真实状态来源
-- quotaUsed = 当日该服务 deploy_records 计数 + 表单预置值（评测/演示用）

create table if not exists deploy_records (
  id           uuid primary key default gen_random_uuid(),
  service      text not null,
  env          text not null check (env in ('prod', 'staging')),
  version      text not null,
  execution_id uuid,
  created_at   timestamptz not null default now()
);
create index if not exists idx_deploy_records_count
  on deploy_records(service, env, created_at);

alter table deploy_records enable row level security;
create policy "anon_all_deploy_records" on deploy_records for all using (true) with check (true);
