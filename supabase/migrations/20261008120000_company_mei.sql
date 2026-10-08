-- Minha empresa (MEI), decisions/0043, specs/company-mei.
--
-- Só colunas nulas ou com default no singleton financial_engine_settings:
-- nenhuma linha existente muda de valor.

alter table financial_engine_settings add column if not exists das_monthly_cents bigint;
alter table financial_engine_settings add column if not exists pj_cushion_months double precision not null default 2;
alter table financial_engine_settings add column if not exists mei_annual_limit_cents bigint not null default 8100000;
alter table financial_engine_settings add column if not exists das_category_ids jsonb;
