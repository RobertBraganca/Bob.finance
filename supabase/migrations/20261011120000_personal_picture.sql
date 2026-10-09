-- Saúde, Diário e Patrimônio lendo as telas donas (decisions/0045,
-- specs/personal-picture).
--
-- 1. `debts.paid_via_card_id`: a dívida é paga dentro da fatura de um cartão
--    (conta uma vez no Endividamento e não gera pendência na conta).
-- 2. `monthly_snapshots`: a foto do mês (score e patrimônio), gravada pela
--    rotina diária; a última gravação do mês é a foto dele.
--
-- Só coluna e tabela novas: nenhuma linha existente muda. RLS ligado e sem
-- política, como as demais tabelas.

alter table debts add column if not exists paid_via_card_id bigint references credit_cards (id) on delete set null;

create table if not exists monthly_snapshots (
  id bigint generated always as identity primary key,
  period text not null,
  score_bps integer,
  net_worth_cents bigint not null,
  company_cents bigint not null default 0,
  debt_cents bigint not null default 0,
  details jsonb not null default '{}'::jsonb,
  taken_at text not null default now_iso()
);
create unique index if not exists monthly_snapshot_period_uq on monthly_snapshots (period);
alter table monthly_snapshots enable row level security;
