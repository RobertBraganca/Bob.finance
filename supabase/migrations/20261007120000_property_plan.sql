-- Plano de compra de imóvel e dívida amortizada (decisions/0041,
-- specs/property-plan).
--
-- Só tipos, colunas nulas ou com default e uma tabela nova: nenhuma linha
-- existente muda de valor. Toda dívida atual fica com amortization nulo
-- (comportamento antigo) e todo ativo com goal_id nulo (meta mede a
-- carteira inteira, como hoje). RLS ligado e sem política, como as demais.

do $$ begin
  create type amortization_system as enum ('sac', 'price');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type property_plan_status as enum ('planning', 'purchased');
exception when duplicate_object then null;
end $$;

alter table debts add column if not exists amortization amortization_system;
alter table debts add column if not exists monthly_fees_cents bigint not null default 0;

alter table assets add column if not exists goal_id bigint references investment_goals (id) on delete set null;
create index if not exists assets_goal_idx on assets (goal_id);

create table if not exists property_plans (
  id bigint generated always as identity primary key,
  goal_id bigint not null references investment_goals (id) on delete cascade,
  price_cents bigint not null,
  appreciation_bps bigint not null default 400,
  down_payment_bps bigint not null default 2000,
  costs jsonb not null,
  other_resources_cents bigint not null default 0,
  financing_rate_bps bigint not null default 1100,
  term_months bigint not null default 360,
  system amortization_system not null default 'sac',
  monthly_fees_cents bigint not null default 0,
  income_override_cents bigint,
  income_limit_bps bigint not null default 3000,
  expense_relief_cents bigint not null default 0,
  status property_plan_status not null default 'planning',
  debt_id bigint references debts (id) on delete set null,
  asset_id bigint references assets (id) on delete set null,
  purchased_on text,
  created_at text not null default now_iso(),
  updated_at text not null default now_iso()
);

create unique index if not exists property_plans_goal_uq on property_plans (goal_id);

alter table property_plans enable row level security;
