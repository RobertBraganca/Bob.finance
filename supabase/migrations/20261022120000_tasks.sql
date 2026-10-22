-- Tarefas financeiras (docs/specs/tarefas-comercial-contador, fase 1).
-- As tarefas automáticas (pendências, faturas, DAS, fechamento, aportes, saques)
-- são calculadas na leitura, a partir das tabelas que já existem; aqui ficam só
-- as manuais (ex.: emitir nota fiscal todo mês) e as marcações de "feito".

do $$ begin
  create type task_kind as enum ('custom', 'nf');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type task_recurrence as enum ('once', 'monthly', 'yearly');
exception when duplicate_object then null;
end $$;

create table if not exists tasks (
  id bigint generated always as identity primary key,
  title text not null,
  kind task_kind not null default 'custom',
  client_id bigint references clients (id) on delete set null,
  amount_cents bigint,
  notes text,
  recurrence task_recurrence not null default 'once',
  -- 'once': a data; 'monthly': o dia do mês; 'yearly': mês e dia
  due_on text,
  due_day int check (due_day between 1 and 31),
  due_month int check (due_month between 1 and 12),
  -- a partir de quando a recorrência vale, e até quando (opcional)
  starts_on text,
  ends_on text,
  active boolean not null default true,
  created_at text not null default now_iso(),
  updated_at text not null default now_iso()
);
create index if not exists tasks_active_idx on tasks (active);
create index if not exists tasks_client_idx on tasks (client_id);

-- Uma linha por ocorrência resolvida, pela chave estável da ocorrência
-- (ex.: 'manual:12:2026-11-05', 'das:2026-11', 'card:3:2026-11-10').
create table if not exists task_completions (
  id bigint generated always as identity primary key,
  task_key text not null,
  status text not null default 'done' check (status in ('done', 'skipped')),
  -- número da nota fiscal, comprovante ou o que fizer sentido
  reference text,
  note text,
  done_at text not null default now_iso()
);
create unique index if not exists task_completions_key_uq on task_completions (task_key);

alter table tasks enable row level security;
alter table task_completions enable row level security;
