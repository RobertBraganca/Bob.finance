-- ============================================================
-- Corrige a estratégia de PK das 4 tabelas singleton
-- (emergency_reserve_settings, financial_health_settings,
-- financial_engine_settings, pricing_settings).
--
-- Bug real, encontrado testando a migração anterior: `generated always
-- as identity` usa uma sequence, e o avanço de uma sequence NUNCA é
-- desfeito por rollback de transação (comportamento padrão do
-- Postgres, para não travar em serialização). A primeira tentativa de
-- insert que falhar por qualquer motivo (conexão, retry) já empurra a
-- sequence para 2, 3... e a `check (id = 1)` trava QUALQUER insert
-- daquele momento em diante — a tabela singleton fica permanentemente
-- impossível de inicializar sem intervenção manual.
--
-- Correção: sem sequence nenhuma. `default 1` é uma constante, nunca
-- avança — exatamente o que uma tabela de uma linha só precisa.
-- ============================================================

alter table pricing_settings alter column id drop identity if exists;
alter table pricing_settings alter column id set default 1;

alter table emergency_reserve_settings alter column id drop identity if exists;
alter table emergency_reserve_settings alter column id set default 1;

alter table financial_health_settings alter column id drop identity if exists;
alter table financial_health_settings alter column id set default 1;

alter table financial_engine_settings alter column id drop identity if exists;
alter table financial_engine_settings alter column id set default 1;
