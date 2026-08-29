-- Pedido do usuário (29/08/2026): aprovar uma cotação pode registrar um
-- valor real fechado, diferente do recomendado calculado. Coluna nullable
-- (fica null enquanto a cotação não é aprovada); para cotações JÁ aprovadas
-- antes desta migração, o valor real É o recomendado, porque foi o que de
-- fato virou lançamento na época — backfill, não um novo cálculo.

alter table project_quotes
  add column actual_price_cents bigint;

update project_quotes
  set actual_price_cents = recommended_price_cents
  where status = 'approved' and actual_price_cents is null;
