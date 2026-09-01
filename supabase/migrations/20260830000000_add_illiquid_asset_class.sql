-- Ativos ilíquidos/imobilizado (imóvel, veículo, joia): sem cotação de
-- mercado, valor sempre declarado manualmente. Já era o caminho padrão de
-- asset_valuations pra qualquer classe fora de stocks/fii (estudo de
-- viabilidade #12, 29/08/2026) — só falta o valor de enum pra ganhar linha
-- própria em alocação/Meus ativos, mesmo motivo de treasury ter saído de
-- fixed_income.
alter type "asset_class_kind" add value if not exists 'illiquid';
