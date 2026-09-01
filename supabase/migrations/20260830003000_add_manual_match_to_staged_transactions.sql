-- Sugestão (nunca certeza) de que uma linha em staging de importação é o
-- mesmo evento de uma transação manual/Diário já confirmada no ledger —
-- estudo de viabilidade #15, 29/08/2026. FK de verdade (diferente de
-- duplicate_txn_id) porque só aponta pra transação já commitada.
alter table "staged_transactions"
  add column "possible_manual_match_id" integer references "transactions"("id") on delete set null;

alter table "staged_transactions"
  add column "replace_manual_match" boolean not null default false;
