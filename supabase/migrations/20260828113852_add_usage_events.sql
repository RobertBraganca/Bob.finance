-- ------------------------------------------------------------------
-- Log de uso por feature — visão aberta, ação-chave feita, erro
-- exibido ao usuário. Base para melhoria contínua de UX/UI (não
-- rastreia clique a clique nem conteúdo financeiro, só o quê e onde).
-- ------------------------------------------------------------------
create type usage_event_kind as enum ('view', 'action', 'error');

create table usage_events (
  id bigint generated always as identity primary key,
  occurred_at text not null default now_iso(),
  session_id text not null,
  feature text not null,
  kind usage_event_kind not null,
  name text not null,
  detail jsonb,
  created_at text not null default now_iso()
);

create index usage_events_feature_idx on usage_events (feature);
create index usage_events_occurred_at_idx on usage_events (occurred_at);
create index usage_events_kind_idx on usage_events (kind);

-- Mesma postura do resto do schema: RLS ligada, sem policy nenhuma para
-- anon/authenticated — o acesso real é só via Edge Function, com a
-- conexão de serviço (drizzle/postgres-js), não via PostgREST.
alter table usage_events enable row level security;
