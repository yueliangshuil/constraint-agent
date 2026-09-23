-- 001_agent_tables.sql
-- 约束感知规划 Agent 数据表（复用 RAG 项目的本地 Supabase 栈）
-- 设计文档：Desktop\简历\业务约束感知自适应规划Agent - 技术方案与开发难点.md

create extension if not exists vector;

-- ============ 1. 规则文档（版本化：version + is_latest，审计可追溯） ============
create table if not exists agent_documents (
  id           uuid primary key default gen_random_uuid(),
  filename     text not null,
  content_hash text not null,
  version      integer not null default 1,
  is_latest    boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists idx_agent_docs_filename on agent_documents(filename, is_latest);

-- ============ 2. 规则分块（复用 RAG 项目检索结构：embedding + bigram tsvector） ============
create table if not exists agent_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references agent_documents(id) on delete cascade,
  content     text not null,
  chunk_index integer not null,
  rule_tags   text[] not null default '{}',
  embedding   vector(1024),
  bigrams     text,
  tokens      tsvector generated always as (to_tsvector('simple', bigrams)) stored,
  created_at  timestamptz not null default now()
);
create index if not exists idx_agent_chunks_doc on agent_chunks(document_id);
create index if not exists idx_agent_chunks_tokens on agent_chunks using gin (tokens);
create index if not exists idx_agent_chunks_tags on agent_chunks using gin (rule_tags);

-- ============ 3. 检索函数（RRF 混合检索，向量 1.0 / BM25 0.5——沿用 RAG 项目调优结论） ============

create or replace function agent_match_chunks (
  query_embedding vector(1024),
  match_count int default 6
) returns table (id uuid, document_id uuid, content text, rule_tags text[], similarity float)
language sql
as $$
  select c.id, c.document_id, c.content, c.rule_tags, 1 - (c.embedding <=> query_embedding) as similarity
  from agent_chunks c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function agent_hybrid_search (
  query_embedding vector(1024),
  query_tsquery tsquery,
  match_count int default 8,
  k int default 60,
  vec_weight float default 1.0,
  bm25_weight float default 0.5
) returns table (
  id uuid, document_id uuid, content text, rule_tags text[], similarity float, rrf_score float
)
language sql
as $$
  with vec_ranked as (
    select id, row_number() over (order by embedding <=> query_embedding) as rnk
    from agent_chunks where embedding is not null
  ),
  bm25_ranked as (
    select id, row_number() over (order by ts_rank(tokens, query_tsquery) desc) as rnk
    from agent_chunks where tokens @@ query_tsquery
  )
  select
    c.id, c.document_id, c.content, c.rule_tags,
    1 - (c.embedding <=> query_embedding) as similarity,
    coalesce(1.0 / (k + v.rnk), 0) * vec_weight + coalesce(1.0 / (k + b.rnk), 0) * bm25_weight as rrf_score
  from agent_chunks c
  left join vec_ranked v on v.id = c.id
  left join bm25_ranked b on b.id = c.id
  where v.rnk is not null or b.rnk is not null
  order by rrf_score desc
  limit match_count;
$$;

-- ============ 4. 执行审计 ============
create table if not exists executions (
  id          uuid primary key default gen_random_uuid(),
  task        text not null,
  context     jsonb not null,
  plan        jsonb,
  status      text not null default 'running'
              check (status in ('running', 'completed', 'blocked', 'conflict', 'cancelled')),
  steps       jsonb not null default '[]',
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);

-- ============ 5. 人工裁决记录（冲突场景） ============
create table if not exists decisions (
  id                uuid primary key default gen_random_uuid(),
  execution_id      uuid references executions(id) on delete cascade,
  conflicting_rules jsonb not null,
  decision          text not null check (decision in ('allow', 'block')),
  decided_by        text,
  created_at        timestamptz not null default now()
);

-- RLS：demo 阶段数据访问全部走服务端 API Route + service_role key，anon 兜底全开放
alter table agent_documents enable row level security;
alter table agent_chunks    enable row level security;
alter table executions      enable row level security;
alter table decisions       enable row level security;

create policy "anon_all_agent_documents" on agent_documents for all using (true) with check (true);
create policy "anon_all_agent_chunks"    on agent_chunks    for all using (true) with check (true);
create policy "anon_all_executions"      on executions      for all using (true) with check (true);
create policy "anon_all_decisions"       on decisions       for all using (true) with check (true);
