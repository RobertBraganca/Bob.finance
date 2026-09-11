-- Investimento planejado manual: sem isso o destino "Investimento" do
-- Motor financeiro só soma o aporte mensal das metas ativas, que pode
-- ficar bem acima do que sobra de fato no mês (achado do usuário,
-- 10/09/2026). Nulo (padrão) mantém o comportamento derivado de hoje.
alter table financial_engine_settings
  add column if not exists investment_planned_cents integer;
