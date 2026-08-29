-- Follow-up to the 2026-08-28 project review:
-- 1) transactions.source_quote_id links an approved quote's revenue
--    transaction back to the project_quotes row that produced it. Nullable,
--    additive — every existing row gets null, nothing else changes.
-- 2) Two partial unique indexes close a real race in materialize()/
--    materializeDebtInstallments(): two concurrent calls for the same
--    forecast/debt could both see "period missing" before either INSERT
--    committed, double-inserting the same pending occurrence. Verified
--    against the live data before this migration: zero existing rows
--    violate either constraint.

alter table transactions
  add column source_quote_id bigint references project_quotes (id) on delete set null;

create index txn_source_quote_idx on transactions (source_quote_id);

create unique index txn_forecast_occurrence_uq on transactions (forecast_id, occurrence_period)
  where forecast_id is not null;

create unique index txn_debt_occurrence_uq on transactions (debt_id, occurrence_period)
  where debt_id is not null;
