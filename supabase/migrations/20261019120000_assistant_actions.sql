-- Assistente em linguagem natural (docs/specs/assistente, seção C).
--
-- Só uma tabela e um tipo novos: nenhuma linha existente muda. Guarda a frase,
-- a proposta do modelo, o que o `apply` gravou (com antes/depois, de onde sai o
-- Desfazer) e o estado. A expiração (15 min) é calculada por `created_at`, sem
-- coluna própria. Mesmo padrão das outras tabelas: RLS ligado e sem política,
-- então a API REST pública não a alcança; as Edge Functions acessam pelo Postgres.
-- Idempotente.

do $$ begin
  create type assistant_action_status as enum ('proposed', 'applied', 'undone', 'expired');
exception when duplicate_object then null;
end $$;

create table if not exists assistant_actions (
  id bigint generated always as identity primary key,
  proposal_id uuid not null,
  conversation_id uuid,
  phrase text not null,
  proposal jsonb not null,
  applied jsonb,
  undo_token uuid,
  status assistant_action_status not null default 'proposed',
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  undone_at timestamptz
);

create unique index if not exists assistant_actions_proposal_uq on assistant_actions (proposal_id);
create unique index if not exists assistant_actions_undo_token_uq on assistant_actions (undo_token) where undo_token is not null;
create index if not exists assistant_actions_created_idx on assistant_actions (created_at);

alter table assistant_actions enable row level security;
