-- 004_ticket_records.sql
-- 变更工单记录：hasTicket 约束的真实状态来源
-- （与 deploy_records 同源设计：工具执行成功落库，引擎校验时查询真实记录）

create table if not exists ticket_records (
  id           uuid primary key default gen_random_uuid(),
  service      text not null,
  env          text not null check (env in ('prod', 'staging')),
  reason       text,
  severity     text check (severity in ('normal', 'urgent')),
  execution_id uuid,
  user_id      uuid references users(id),
  tenant_id    text not null default 'demo-tenant',
  created_at   timestamptz not null default now()
);
create index if not exists idx_ticket_records_count on ticket_records(service, env, created_at);

alter table ticket_records enable row level security;
create policy "anon_all_ticket_records" on ticket_records for all using (true) with check (true);
