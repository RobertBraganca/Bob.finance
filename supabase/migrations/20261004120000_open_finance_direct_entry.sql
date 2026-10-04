-- Open Finance com entrada direta (decisions/0039).
--
-- 1. transactions.needs_review: o que entrou sozinho, sem passar pela fila,
--    até o usuário marcar como conferido.
-- 2. staged_transactions: a parcela pendente que a linha paga (quando há
--    exatamente uma candidata) e a sugestão de quitação de dívida.
--
-- Só colunas novas com default: nenhuma linha existente muda de valor.

alter table transactions
  add column if not exists needs_review boolean not null default false;

create index if not exists txn_needs_review_idx
  on transactions (needs_review)
  where needs_review;

alter table staged_transactions
  add column if not exists pending_match_id bigint references transactions (id) on delete set null,
  add column if not exists pending_match_count integer not null default 0,
  add column if not exists possible_payoff_debt_id bigint references debts (id) on delete set null,
  add column if not exists settle_payoff boolean not null default false;
