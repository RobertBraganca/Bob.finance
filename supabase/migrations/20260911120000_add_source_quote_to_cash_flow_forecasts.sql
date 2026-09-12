-- Fatura recorrente a partir de cotacao aprovada: quando o usuario aprova
-- uma cotacao como "recorrente" (em vez de pagamento unico/parcelado), a
-- aprovacao cria um cash_flow_forecasts em vez de transacoes avulsas.
-- Mesmo padrao ja usado em transactions.source_quote_id (txn_source_quote_idx).
alter table cash_flow_forecasts
  add column if not exists source_quote_id bigint references project_quotes(id) on delete set null;

create index if not exists cash_flow_forecasts_source_quote_idx
  on cash_flow_forecasts (source_quote_id);
