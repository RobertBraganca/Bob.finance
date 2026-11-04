-- Detalhe da tarefa: comentários e o histórico de etapas de cada ocorrência.
-- Liga pela chave da ocorrência (a mesma de task_completions), então vale também
-- para as automáticas (fatura, DAS, pendência). Nas manuais, task_id junta as
-- ocorrências da mesma tarefa, para ver o que foi anotado no mês passado, e
-- some junto quando a tarefa é excluída.
create table if not exists task_notes (
  id bigint generated always as identity primary key,
  task_key text not null,
  task_id bigint references tasks (id) on delete cascade,
  -- 'comment': escrito por você; 'stage': a mudança de etapa, gravada sozinha
  kind text not null default 'comment' check (kind in ('comment', 'stage')),
  -- o comentário, ou o motivo opcional ao pausar ou encerrar
  body text,
  from_stage text,
  to_stage text,
  created_at text not null default now_iso()
);
create index if not exists task_notes_key_idx on task_notes (task_key, created_at);
create index if not exists task_notes_task_idx on task_notes (task_id) where task_id is not null;

alter table task_notes enable row level security;
