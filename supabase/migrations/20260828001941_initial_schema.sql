-- ============================================================
-- BOB Finanças — initial schema (decisions/0026, Fase 1: schema).
-- Tradução 1:1 de server/src/db/schema.ts (SQLite) para Postgres.
--
-- Convenções desta migração:
-- * Datas/timestamps continuam TEXT no mesmo formato ISO que o app já
--   grava hoje (YYYY-MM-DD / YYYY-MM-DDTHH:MM:SSZ) — não native
--   date/timestamptz. Isto é deliberado: a Fase 3 (decisions/0026) já
--   é uma reescrita grande (227 pontos síncronos -> assíncronos);
--   trocar o formato de data ao mesmo tempo multiplicaria o raio de
--   mudança sem necessidade nesta fase.
-- * Todo "kind"/"status"/enum de texto documentado em comentário no
--   schema.ts virou um Postgres ENUM nativo — validação no banco, não
--   só na aplicação.
-- * bigint generated always as identity para toda PK (não uuid v4,
--   não serial) — sequencial, sem fragmentação de índice.
-- * Toda coluna de FK tem um índice próprio.
-- * RLS habilitado em toda tabela, sem policy nenhuma para anon/
--   authenticated — este app não expõe a Data API (Fastify é o único
--   cliente, via service_role, que sempre contorna RLS). Defesa em
--   profundidade, não o modelo de acesso real.
-- ============================================================

-- ------------------------------------------------------------------
-- Enumerated types
-- ------------------------------------------------------------------
create type account_kind as enum ('checking', 'savings', 'credit_card', 'investment', 'loan', 'cash');
create type csv_delimiter as enum (',', ';', 'tab', 'auto');
create type csv_date_format as enum ('dd/MM/yyyy', 'yyyy-MM-dd', 'dd-MM-yyyy', 'dd/MM/yy');
create type csv_sign_convention as enum ('signed', 'signed_inverted', 'debit_credit', 'type_flag');
create type category_kind as enum ('income', 'expense', 'transfer', 'investment');
create type rule_field as enum ('description', 'raw_category');
create type rule_match_type as enum ('contains', 'starts_with', 'equals', 'regex');
create type rule_direction as enum ('any', 'in', 'out');
create type rule_origin as enum ('user', 'learned');
create type duplicate_status as enum ('none', 'in_batch', 'in_ledger');
create type suggestion_source as enum ('rule', 'memory', 'raw_category', 'none');
create type import_status as enum ('staged', 'committed', 'discarded');
create type txn_source as enum ('csv', 'manual', 'daily', 'adjustment');
create type categorized_by as enum ('rule', 'memory', 'manual', 'raw_category', 'none');
create type txn_direction as enum ('in', 'out');
create type debt_kind as enum ('credit_card', 'personal_loan', 'financing', 'overdraft', 'student', 'other');
create type debt_payment_kind as enum ('payment', 'charge');
create type asset_class_kind as enum ('stocks', 'fii', 'fixed_income', 'crypto', 'funds', 'cash', 'pension', 'other');
create type forecast_kind as enum ('recurring', 'installment', 'single');
create type trade_kind as enum ('buy', 'sell', 'dividend');
create type benchmark_code as enum ('CDI', 'IPCA', 'IBOV', 'IFIX', 'SMLL', 'IDIV', 'IVVB11');
create type benchmark_source as enum ('bcb', 'brapi_etf');
create type investment_goal_purpose as enum ('retirement', 'buy_property', 'financial_independence', 'children_education', 'travel');
create type pricing_dimension as enum ('complexity', 'urgency', 'client_size', 'usage_rights');
create type quote_status as enum ('draft', 'sent', 'in_review', 'needs_changes', 'rejected', 'approved');

-- ------------------------------------------------------------------
-- Functions
-- ------------------------------------------------------------------

-- Mesmo formato que o `now` do SQLite (strftime ISO 'Z') — texto, não
-- timestamptz, para não mudar o que o app já espera ler de volta.
create or replace function now_iso() returns text
language sql
stable
as $$
  select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
$$;

-- Trigger genérico: qualquer tabela com `updated_at` grava a hora da
-- escrita sozinha, mesmo se um caminho de código futuro esquecer de
-- setar o campo manualmente (defesa em profundidade sobre o que a
-- aplicação já faz hoje).
create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now_iso();
  return new;
end;
$$;

-- Trigger genérico para as tabelas singleton (settings, id sempre 1):
-- rejeita qualquer segunda linha, em vez de depender só da convenção
-- de aplicação "sempre leia/grave id=1".
create or replace function enforce_singleton() returns trigger
language plpgsql
as $$
declare
  existing_count integer;
begin
  execute format('select count(*) from %I', tg_table_name) into existing_count;
  if existing_count > 0 then
    raise exception 'tabela % guarda só uma linha (id = 1) — já existe uma', tg_table_name;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------------
-- Accounts
-- ------------------------------------------------------------------
create table accounts (
  id bigint generated always as identity primary key,
  name text not null,
  institution text not null,
  kind account_kind not null default 'checking',
  currency text not null default 'BRL',
  opening_balance_cents bigint not null default 0,
  archived boolean not null default false,
  created_at text not null default now_iso()
);

-- ------------------------------------------------------------------
-- Categories (self-referencing tree)
-- ------------------------------------------------------------------
create table categories (
  id bigint generated always as identity primary key,
  parent_id bigint references categories (id),
  name text not null,
  kind category_kind not null default 'expense',
  color text not null default '#2a78d6',
  icon text not null default 'tag',
  sort_order bigint not null default 0,
  archived boolean not null default false,
  created_at text not null default now_iso()
);
create index categories_parent_idx on categories (parent_id);
create unique index categories_parent_name_uq on categories (parent_id, name);

-- ------------------------------------------------------------------
-- Category rules
-- ------------------------------------------------------------------
create table category_rules (
  id bigint generated always as identity primary key,
  category_id bigint not null references categories (id) on delete cascade,
  field rule_field not null default 'description',
  match_type rule_match_type not null default 'contains',
  pattern text not null,
  direction rule_direction not null default 'any',
  amount_min_cents bigint,
  amount_max_cents bigint,
  account_id bigint references accounts (id),
  priority bigint not null default 100,
  origin rule_origin not null default 'user',
  hit_count bigint not null default 0,
  active boolean not null default true,
  created_at text not null default now_iso()
);
create index category_rules_category_idx on category_rules (category_id);
create index category_rules_account_idx on category_rules (account_id);
create index category_rules_priority_idx on category_rules (priority);
create unique index category_rules_uq on category_rules (field, match_type, pattern, direction);

-- ------------------------------------------------------------------
-- Category memory (learned corrections)
-- ------------------------------------------------------------------
create table category_memory (
  id bigint generated always as identity primary key,
  signature text not null,
  category_id bigint not null references categories (id) on delete cascade,
  hits bigint not null default 1,
  promoted_rule_id bigint references category_rules (id) on delete set null,
  last_seen_at text not null default now_iso()
);
create index category_memory_category_idx on category_memory (category_id);
create index category_memory_promoted_rule_idx on category_memory (promoted_rule_id);
create unique index category_memory_uq on category_memory (signature, category_id);

-- ------------------------------------------------------------------
-- Parser profiles
-- ------------------------------------------------------------------
create table parser_profiles (
  id bigint generated always as identity primary key,
  name text not null,
  institution text not null,
  delimiter csv_delimiter not null default ';',
  encoding text not null default 'utf-8',
  date_format csv_date_format not null default 'dd/MM/yyyy',
  decimal_separator text not null default ',',
  thousands_separator text not null default '.',
  sign_convention csv_sign_convention not null default 'signed',
  has_header boolean not null default true,
  skip_rows bigint not null default 0,
  column_map jsonb not null,
  header_signature jsonb not null,
  ignore_patterns jsonb not null,
  default_account_id bigint references accounts (id),
  active boolean not null default true,
  created_at text not null default now_iso()
);
create index parser_profiles_default_account_idx on parser_profiles (default_account_id);
create unique index parser_profiles_name_uq on parser_profiles (name);

-- ------------------------------------------------------------------
-- Import staging
-- ------------------------------------------------------------------
create table import_batches (
  id bigint generated always as identity primary key,
  profile_id bigint references parser_profiles (id),
  account_id bigint not null references accounts (id),
  filename text not null,
  row_count bigint not null default 0,
  parsed_count bigint not null default 0,
  duplicate_count bigint not null default 0,
  error_count bigint not null default 0,
  committed_count bigint not null default 0,
  status import_status not null default 'staged',
  created_at text not null default now_iso()
);
create index import_batches_profile_idx on import_batches (profile_id);
create index import_batches_account_idx on import_batches (account_id);

create table staged_transactions (
  id bigint generated always as identity primary key,
  batch_id bigint not null references import_batches (id) on delete cascade,
  row_index bigint not null,
  posted_on text,
  description text not null default '',
  description_norm text not null default '',
  amount_cents bigint,
  raw_category text,
  dedupe_hash text,
  duplicate_of duplicate_status not null default 'none',
  -- Sem FK de propósito (igual ao schema.ts original): uma linha em
  -- staging pode apontar para uma transaction que ainda nem existe na
  -- hora de detectar duplicata dentro do próprio lote.
  duplicate_txn_id bigint,
  suggested_category_id bigint references categories (id),
  suggestion_source suggestion_source not null default 'none',
  suggestion_detail text,
  category_id bigint references categories (id),
  include boolean not null default true,
  parse_error text,
  raw_line text
);
create index staged_batch_idx on staged_transactions (batch_id);
create index staged_suggested_category_idx on staged_transactions (suggested_category_id);
create index staged_category_idx on staged_transactions (category_id);

-- ------------------------------------------------------------------
-- Debts (antes de transactions, que referencia debts)
-- ------------------------------------------------------------------
create table debts (
  id bigint generated always as identity primary key,
  name text not null,
  kind debt_kind not null default 'credit_card',
  institution text,
  principal_cents bigint not null default 0,
  apr_bps bigint not null default 0,
  minimum_payment_cents bigint not null default 0,
  scheduled_payment_cents bigint not null default 0,
  due_day bigint not null default 10,
  installment_count bigint,
  end_period text,
  account_id bigint references accounts (id),
  opened_on text,
  closed_on text,
  active boolean not null default true,
  created_at text not null default now_iso()
);
create index debts_account_idx on debts (account_id);

-- ------------------------------------------------------------------
-- Cash-flow forecasts (antes de transactions, que referencia forecasts)
-- ------------------------------------------------------------------
create table cash_flow_forecasts (
  id bigint generated always as identity primary key,
  description text not null,
  kind forecast_kind not null default 'recurring',
  amount_cents bigint not null,
  account_id bigint references accounts (id),
  category_id bigint references categories (id) on delete set null,
  start_period text not null,
  due_day bigint not null default 1,
  installment_count bigint,
  installments_realized bigint not null default 0,
  end_period text,
  notes text,
  active boolean not null default true,
  created_at text not null default now_iso()
);
create index cash_flow_forecasts_account_idx on cash_flow_forecasts (account_id);
create index cash_flow_forecasts_category_idx on cash_flow_forecasts (category_id);

-- ------------------------------------------------------------------
-- Transactions — a fonte real
-- ------------------------------------------------------------------
create table transactions (
  id bigint generated always as identity primary key,
  account_id bigint not null references accounts (id),
  posted_on text not null,
  description text not null,
  description_norm text not null default '',
  amount_cents bigint not null,
  direction txn_direction not null,
  category_id bigint references categories (id) on delete set null,
  raw_category text,
  source txn_source not null default 'csv',
  categorized_by categorized_by not null default 'none',
  rule_id bigint references category_rules (id) on delete set null,
  import_batch_id bigint references import_batches (id) on delete set null,
  dedupe_hash text not null,
  duplicate_accepted boolean not null default false,
  notes text,
  pending boolean not null default false,
  forecast_id bigint references cash_flow_forecasts (id) on delete cascade,
  debt_id bigint references debts (id) on delete cascade,
  occurrence_period text,
  manually_edited boolean not null default false,
  created_at text not null default now_iso(),
  updated_at text not null default now_iso()
);
create index txn_posted_idx on transactions (posted_on);
create index txn_account_posted_idx on transactions (account_id, posted_on);
create index txn_category_idx on transactions (category_id);
create index txn_dedupe_idx on transactions (account_id, dedupe_hash);
create index txn_pending_idx on transactions (pending);
create index txn_rule_idx on transactions (rule_id);
create index txn_import_batch_idx on transactions (import_batch_id);
create index txn_forecast_idx on transactions (forecast_id);
create index txn_debt_idx on transactions (debt_id);
create trigger transactions_set_updated_at before update on transactions
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------
-- Debt snapshots + payments
-- ------------------------------------------------------------------
create table debt_snapshots (
  id bigint generated always as identity primary key,
  debt_id bigint not null references debts (id) on delete cascade,
  as_of text not null,
  balance_cents bigint not null
);
create unique index debt_snapshot_uq on debt_snapshots (debt_id, as_of);

create table debt_payments (
  id bigint generated always as identity primary key,
  debt_id bigint not null references debts (id) on delete cascade,
  kind debt_payment_kind not null default 'payment',
  paid_on text not null,
  amount_cents bigint not null,
  notes text,
  created_at text not null default now_iso()
);
create index debt_payments_debt_idx on debt_payments (debt_id, paid_on);

-- ------------------------------------------------------------------
-- Credit cards
-- ------------------------------------------------------------------
create table credit_cards (
  id bigint generated always as identity primary key,
  name text not null,
  institution text,
  account_id bigint references accounts (id),
  credit_limit_cents bigint not null default 0,
  closing_day bigint not null default 1,
  due_day bigint not null default 10,
  active boolean not null default true,
  created_at text not null default now_iso()
);
create index credit_cards_account_idx on credit_cards (account_id);

create table credit_card_snapshots (
  id bigint generated always as identity primary key,
  card_id bigint not null references credit_cards (id) on delete cascade,
  as_of text not null,
  available_limit_cents bigint not null
);
create unique index credit_card_snapshot_uq on credit_card_snapshots (card_id, as_of);

-- ------------------------------------------------------------------
-- Monthly goals + category caps
-- ------------------------------------------------------------------
create table monthly_goals (
  id bigint generated always as identity primary key,
  period text not null,
  income_target_cents bigint,
  spend_cap_cents bigint,
  savings_rate_target_bps bigint,
  note text,
  created_at text not null default now_iso(),
  updated_at text not null default now_iso()
);
create unique index monthly_goals_period_uq on monthly_goals (period);
create trigger monthly_goals_set_updated_at before update on monthly_goals
  for each row execute function set_updated_at();

create table category_caps (
  id bigint generated always as identity primary key,
  period text not null,
  category_id bigint not null references categories (id) on delete cascade,
  cap_cents bigint not null
);
create index category_caps_category_idx on category_caps (category_id);
create unique index category_caps_uq on category_caps (period, category_id);

-- ------------------------------------------------------------------
-- Investments
-- ------------------------------------------------------------------
create table assets (
  id bigint generated always as identity primary key,
  name text not null,
  ticker text,
  asset_class asset_class_kind not null default 'stocks',
  sector text,
  currency text not null default 'BRL',
  account_id bigint references accounts (id),
  counts_toward_reserve boolean not null default false,
  archived boolean not null default false,
  created_at text not null default now_iso()
);
create index assets_account_idx on assets (account_id);
create unique index assets_name_uq on assets (name);

create table emergency_reserve_settings (
  id bigint generated always as identity primary key,
  multiple bigint not null default 6,
  lookback_months bigint not null default 3,
  manual_living_cost_cents bigint,
  constraint emergency_reserve_settings_singleton check (id = 1)
);
create trigger emergency_reserve_settings_singleton before insert on emergency_reserve_settings
  for each row execute function enforce_singleton();

create table reconciliation_dismissals (
  id bigint generated always as identity primary key,
  -- Sem FK de propósito (igual ao original): referencia a linha
  -- `pending` genérica (transaction OU forecast), não uma tabela só.
  pending_id bigint not null,
  match_id bigint not null,
  created_at text not null default now_iso()
);
create unique index reconciliation_dismissals_uq on reconciliation_dismissals (pending_id, match_id);

create table skipped_occurrences (
  id bigint generated always as identity primary key,
  forecast_id bigint references cash_flow_forecasts (id) on delete cascade,
  debt_id bigint references debts (id) on delete cascade,
  period text not null,
  created_at text not null default now_iso()
);
create index skipped_occurrences_forecast_idx on skipped_occurrences (forecast_id);
create index skipped_occurrences_debt_idx on skipped_occurrences (debt_id);
create unique index skipped_occurrences_uq on skipped_occurrences (forecast_id, debt_id, period);

create table asset_trades (
  id bigint generated always as identity primary key,
  asset_id bigint not null references assets (id) on delete cascade,
  kind trade_kind not null default 'buy',
  traded_on text not null,
  quantity double precision not null default 0,
  unit_price_cents bigint not null default 0,
  fees_cents bigint not null default 0,
  created_at text not null default now_iso()
);
create index asset_trades_asset_idx on asset_trades (asset_id, traded_on);

create table asset_valuations (
  id bigint generated always as identity primary key,
  asset_id bigint not null references assets (id) on delete cascade,
  as_of text not null,
  unit_price_cents bigint not null
);
create unique index asset_valuations_uq on asset_valuations (asset_id, as_of);

create table benchmark_returns (
  id bigint generated always as identity primary key,
  code benchmark_code not null,
  period text not null,
  return_bps bigint not null,
  source benchmark_source not null,
  created_at text not null default now_iso()
);
create unique index benchmark_returns_uq on benchmark_returns (code, period);

create table investment_goals (
  id bigint generated always as identity primary key,
  name text not null,
  target_value_cents bigint not null default 0,
  target_date text,
  monthly_contribution_cents bigint not null default 0,
  expected_return_bps bigint not null default 800,
  purpose investment_goal_purpose,
  active boolean not null default true,
  created_at text not null default now_iso()
);

create table target_allocations (
  id bigint generated always as identity primary key,
  goal_id bigint references investment_goals (id) on delete cascade,
  asset_class asset_class_kind not null,
  target_bps bigint not null
);
create index target_allocations_goal_idx on target_allocations (goal_id);
create unique index target_alloc_uq on target_allocations (goal_id, asset_class);

-- ------------------------------------------------------------------
-- "Diagrama do Cerrado" — critérios de resistência
-- ------------------------------------------------------------------
create table criteria (
  id bigint generated always as identity primary key,
  asset_class asset_class_kind not null,
  label text not null,
  sort_order bigint not null default 0,
  active boolean not null default true,
  created_at text not null default now_iso()
);
create index criteria_class_idx on criteria (asset_class);

create table asset_criteria_answers (
  id bigint generated always as identity primary key,
  asset_id bigint not null references assets (id) on delete cascade,
  criteria_id bigint not null references criteria (id) on delete cascade,
  checked boolean not null,
  updated_at text not null default now_iso()
);
create index asset_criteria_answers_asset_idx on asset_criteria_answers (asset_id);
create index asset_criteria_answers_criteria_idx on asset_criteria_answers (criteria_id);
create unique index asset_criteria_uq on asset_criteria_answers (asset_id, criteria_id);
create trigger asset_criteria_answers_set_updated_at before update on asset_criteria_answers
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------
-- Motor financeiro / saúde financeira — parâmetros (singleton)
-- ------------------------------------------------------------------
create table financial_health_settings (
  id bigint generated always as identity primary key,
  weight_liquidity bigint not null default 20,
  weight_debt bigint not null default 20,
  weight_spending bigint not null default 20,
  weight_reserve bigint not null default 20,
  weight_allocation bigint not null default 20,
  cost_lookback_months bigint not null default 3,
  risk_card_share_bps bigint not null default 3500,
  risk_reserve_coverage_bps bigint not null default 10000,
  risk_allocation_drift_bps bigint not null default 1000,
  risk_spending_cap_bps bigint not null default 10000,
  risk_debt_to_income_bps bigint not null default 3000,
  risk_positive_margin_bps bigint not null default 2000,
  constraint financial_health_settings_singleton check (id = 1)
);
create trigger financial_health_settings_singleton before insert on financial_health_settings
  for each row execute function enforce_singleton();

create table financial_engine_settings (
  id bigint generated always as identity primary key,
  pj_account_id bigint references accounts (id) on delete set null,
  pf_account_id bigint references accounts (id) on delete set null,
  pro_labore_cents bigint,
  tax_rate_bps bigint not null default 0,
  reserve_planned_cents bigint not null default 0,
  margin_cents bigint not null default 0,
  constraint financial_engine_settings_singleton check (id = 1)
);
create index financial_engine_settings_pj_account_idx on financial_engine_settings (pj_account_id);
create index financial_engine_settings_pf_account_idx on financial_engine_settings (pf_account_id);
create trigger financial_engine_settings_singleton before insert on financial_engine_settings
  for each row execute function enforce_singleton();

-- ------------------------------------------------------------------
-- Precificação de projetos
-- ------------------------------------------------------------------
create table pricing_settings (
  id bigint generated always as identity primary key,
  available_hours_per_month bigint not null default 176,
  billable_percentage_bps bigint not null default 6000,
  constraint pricing_settings_singleton check (id = 1)
);
create trigger pricing_settings_singleton before insert on pricing_settings
  for each row execute function enforce_singleton();

create table pricing_multiplier_options (
  id bigint generated always as identity primary key,
  dimension pricing_dimension not null,
  label text not null,
  description text,
  multiplier_bps bigint not null,
  sort_order bigint not null default 0,
  active boolean not null default true
);
create index pricing_multiplier_dimension_idx on pricing_multiplier_options (dimension);

create table project_quotes (
  id bigint generated always as identity primary key,
  client_label text not null,
  estimated_hours double precision not null,
  direct_costs jsonb not null default '[]'::jsonb,
  complexity_option_id bigint references pricing_multiplier_options (id) on delete set null,
  urgency_option_id bigint references pricing_multiplier_options (id) on delete set null,
  client_size_option_id bigint references pricing_multiplier_options (id) on delete set null,
  usage_rights_option_id bigint references pricing_multiplier_options (id) on delete set null,
  extra_margin_bps bigint not null default 0,
  hourly_base_cents bigint not null,
  minimum_price_cents bigint not null,
  recommended_price_cents bigint not null,
  status quote_status not null default 'draft',
  created_at text not null default now_iso(),
  updated_at text not null default now_iso()
);
create index project_quotes_complexity_idx on project_quotes (complexity_option_id);
create index project_quotes_urgency_idx on project_quotes (urgency_option_id);
create index project_quotes_client_size_idx on project_quotes (client_size_option_id);
create index project_quotes_usage_rights_idx on project_quotes (usage_rights_option_id);
create trigger project_quotes_set_updated_at before update on project_quotes
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------
-- Row Level Security — habilitada em toda tabela, sem policy nenhuma
-- para anon/authenticated. Este app não expõe a Data API: o Fastify é
-- o único cliente, conectando via service_role (que sempre contorna
-- RLS por padrão no Supabase). Isto é defesa em profundidade — se a
-- Data API for exposta por engano no futuro, nenhuma linha vaza sem
-- uma policy explícita sendo escrita primeiro.
-- ------------------------------------------------------------------
alter table accounts enable row level security;
alter table categories enable row level security;
alter table category_rules enable row level security;
alter table category_memory enable row level security;
alter table parser_profiles enable row level security;
alter table import_batches enable row level security;
alter table staged_transactions enable row level security;
alter table debts enable row level security;
alter table cash_flow_forecasts enable row level security;
alter table transactions enable row level security;
alter table debt_snapshots enable row level security;
alter table debt_payments enable row level security;
alter table credit_cards enable row level security;
alter table credit_card_snapshots enable row level security;
alter table monthly_goals enable row level security;
alter table category_caps enable row level security;
alter table assets enable row level security;
alter table emergency_reserve_settings enable row level security;
alter table reconciliation_dismissals enable row level security;
alter table skipped_occurrences enable row level security;
alter table asset_trades enable row level security;
alter table asset_valuations enable row level security;
alter table benchmark_returns enable row level security;
alter table investment_goals enable row level security;
alter table target_allocations enable row level security;
alter table criteria enable row level security;
alter table asset_criteria_answers enable row level security;
alter table financial_health_settings enable row level security;
alter table financial_engine_settings enable row level security;
alter table pricing_settings enable row level security;
alter table pricing_multiplier_options enable row level security;
alter table project_quotes enable row level security;
