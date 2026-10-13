-- Índices que faltavam (revisão de banco de 10/10/2026, decisions/0045).
--
-- 1. staged_transactions: as três FKs (pending_match_id, possible_manual_match_id,
--    possible_payoff_debt_id) não tinham índice. Medido: um EXPLAIN por
--    possible_manual_match_id fazia Seq Scan de 27 mil linhas, e cada delete
--    de lançamento (desfazer uma importação) paga essa checagem por linha.
--    Parciais: quase todas as linhas têm essas colunas nulas.
-- 2. debts: category_id e paid_via_card_id (FKs novas, sem índice).
-- 3. Dois índices duplicados, sem nenhuma leitura medida, cobertos por índices únicos:
--    skipped_occurrences_forecast_idx e target_allocations_goal_idx.
--
-- Só aditivo, fora os dois drops de duplicados. Idempotente.

create index if not exists staged_pending_match_idx on staged_transactions (pending_match_id) where pending_match_id is not null;
create index if not exists staged_manual_match_idx on staged_transactions (possible_manual_match_id) where possible_manual_match_id is not null;
create index if not exists staged_payoff_debt_idx on staged_transactions (possible_payoff_debt_id) where possible_payoff_debt_id is not null;
create index if not exists debts_category_idx on debts (category_id);
create index if not exists debts_paid_via_card_idx on debts (paid_via_card_id);

drop index if exists skipped_occurrences_forecast_idx;
drop index if exists target_allocations_goal_idx;
