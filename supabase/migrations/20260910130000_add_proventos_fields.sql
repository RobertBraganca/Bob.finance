-- Proventos: dividendos/JSCP já existiam como asset_trades.kind='dividend',
-- mas sem os dois campos que só fazem sentido para esse kind. Tipo de
-- provento decide a tributacao (JSCP 15% retido na fonte, Dividendos
-- isento); Data Com e so informativa, opcional mesmo para provento.
create type "dividend_type" as enum ('dividendo', 'jscp');

alter table asset_trades
  add column if not exists dividend_type dividend_type,
  add column if not exists ex_date text;

-- Meta mensal de proventos, comparada contra o total pago dos ultimos 12
-- meses no resumo da nova aba. Null = sem meta configurada (mesma regra de
-- "meta ausente" ja usada em financial_engine_settings/emergency_reserve_settings).
create table if not exists passive_income_settings (
  id bigint primary key default 1,
  monthly_target_cents bigint,
  constraint passive_income_settings_singleton check (id = 1)
);

create trigger passive_income_settings_singleton before insert on passive_income_settings
  for each row execute function enforce_singleton();

alter table passive_income_settings enable row level security;
