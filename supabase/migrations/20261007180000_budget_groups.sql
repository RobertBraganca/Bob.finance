-- Orçamento por grupos de % da renda (decisions/0042, specs/budget-groups).
--
-- Só um tipo, duas tabelas novas e duas colunas nulas/default em
-- categories: nenhuma linha existente muda de valor. Os seis grupos do
-- método nascem na primeira leitura do serviço, não aqui. RLS ligado e sem
-- política, como as demais tabelas.

do $$ begin
  create type budget_group_source as enum ('categories', 'goal_contributions', 'other_contributions');
exception when duplicate_object then null;
end $$;

create table if not exists budget_groups (
  id bigint generated always as identity primary key,
  name text not null,
  color text not null,
  sort_order bigint not null default 0,
  source budget_group_source not null default 'categories',
  archived boolean not null default false,
  created_at text not null default now_iso()
);

create table if not exists budget_plans (
  id bigint generated always as identity primary key,
  effective_period text not null,
  allocations jsonb not null,
  updated_at text not null default now_iso()
);
create unique index if not exists budget_plans_period_uq on budget_plans (effective_period);

alter table categories add column if not exists budget_group_id bigint references budget_groups (id) on delete set null;
alter table categories add column if not exists budget_excluded boolean not null default false;
create index if not exists categories_budget_group_idx on categories (budget_group_id);

alter table budget_groups enable row level security;
alter table budget_plans enable row level security;
