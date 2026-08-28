-- ============================================================
-- Corrige asset_class_kind: faltavam 'treasury' e 'etf_intl'.
--
-- Bug real, encontrado migrando os dados reais (Fase 2): a migração
-- inicial (20260828001941) copiou a lista de valores do comentário em
-- schema.ts (`assets.assetClass`), mas essa lista estava incompleta —
-- a fonte de verdade real é `ASSET_CLASSES` em
-- `server/src/services/investments.ts`, que tem 10 valores, não 8.
-- Sem isso, qualquer ativo de Tesouro Direto ou ETF Internacional
-- falhava ao inserir (e por causa disso, tudo que referenciava um
-- ativo de Tesouro em `assets`/`criteria`/`target_allocations` também
-- falhava em cascata).
-- ============================================================

alter type asset_class_kind add value if not exists 'treasury';
alter type asset_class_kind add value if not exists 'etf_intl';
