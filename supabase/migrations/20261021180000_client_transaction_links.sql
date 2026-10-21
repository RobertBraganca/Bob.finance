-- Lançamentos escolhidos à mão para um cliente (docs/specs/clientes-e-negocios).
-- Um lançamento pertence a no máximo um cliente; o vínculo escolhido vale mais
-- que o orçamento de origem e que o nome do pagador. Não mexe em `transactions`.

create table if not exists client_transaction_links (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients (id) on delete cascade,
  transaction_id bigint not null references transactions (id) on delete cascade,
  created_at text not null default now_iso()
);
create unique index if not exists client_transaction_links_tx_uq on client_transaction_links (transaction_id);
create index if not exists client_transaction_links_client_idx on client_transaction_links (client_id);

alter table client_transaction_links enable row level security;
