-- Item 4 do backlog de 07/09/2026: "Mostrar ocultos" no filtro de
-- Lancamentos precisa de um conceito por LANCAMENTO, distinto de
-- accounts.archived (que oculta a conta inteira). Nunca entra em nenhuma
-- agregacao (totals/dailySeries/etc ja nao filtram por isto porque nunca
-- filtraram por padrao nenhum alem de pending); so a listagem de
-- Lancamentos passa a filtrar por padrao.
alter table transactions
  add column hidden boolean not null default false;

create index txn_hidden_idx on transactions (hidden) where hidden = true;
