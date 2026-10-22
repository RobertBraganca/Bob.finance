-- Google Agenda (docs/specs/tarefas-comercial-contador, fase 3): a conta Google
-- conectada (uma só, do dono do app) e o evento criado para cada tarefa.
-- O token de atualização só é lido pelo servidor (RLS ligado, sem política).

create table if not exists google_calendar_connection (
  id int primary key default 1 check (id = 1),
  email text,
  refresh_token text not null,
  calendar_id text not null default 'primary',
  connected_at text not null default now_iso(),
  last_sync_at text,
  last_error text
);

create table if not exists google_calendar_events (
  id bigint generated always as identity primary key,
  task_key text not null,
  event_id text not null,
  -- resumo do que foi enviado, para só atualizar o evento quando a tarefa mudar
  signature text not null,
  synced_at text not null default now_iso()
);
create unique index if not exists google_calendar_events_key_uq on google_calendar_events (task_key);

alter table google_calendar_connection enable row level security;
alter table google_calendar_events enable row level security;
