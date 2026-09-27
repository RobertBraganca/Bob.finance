-- ============================================================
-- Perfil do usuário (revisão de UX de 26/09/2026): nome de exibição pra
-- saudação da Home, e "tipo de uso" (pessoal | freelancer) que passa a
-- travar, na UI, telas pensadas só pra quem fatura como PJ/freelancer.
--
-- Mesmo padrão exato das outras 4 tabelas singleton (emergency_reserve_
-- settings, financial_health_settings, financial_engine_settings,
-- pricing_settings): `default 1`, nunca uma sequence (ver
-- 20260828002409_fix_singleton_id_default.sql pro porquê).
-- ============================================================

create type account_type as enum ('personal', 'freelancer');

create table profile_settings (
  id bigint primary key default 1,
  display_name text,
  account_type account_type not null default 'freelancer',
  constraint profile_settings_singleton check (id = 1)
);

create trigger profile_settings_singleton before insert on profile_settings
  for each row execute function enforce_singleton();

alter table profile_settings enable row level security;
