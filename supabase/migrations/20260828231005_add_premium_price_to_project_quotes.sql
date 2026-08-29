-- Terceiro ponto de ancoragem na Precificação de projetos (recomendado × 1,3),
-- avaliado a partir do BOB.OS (calculadora-freelas): a mesma ideia já existe
-- lá (layer3.ts, `premium = recommended × 1.3`). Puramente informativo — a
-- aprovação de cotação continua gerando o lançamento no valor recomendado,
-- nunca no premium (services/pricing.ts não mudou essa regra).

alter table project_quotes
  add column premium_price_cents bigint;

-- Backfill determinístico: para toda cotação já existente, o premium é uma
-- função pura do recomendado já congelado, não um novo cálculo.
update project_quotes
  set premium_price_cents = round(recommended_price_cents * 1.3)
  where premium_price_cents is null;

alter table project_quotes
  alter column premium_price_cents set not null;
