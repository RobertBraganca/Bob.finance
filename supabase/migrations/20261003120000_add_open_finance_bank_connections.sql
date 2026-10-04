-- Open Finance via Meu Pluggy (docs/specs/open-finance-sync, decisions/0038).
-- Só acrescenta: valor novo de enum, duas colunas opcionais e uma tabela nova.

alter type txn_source add value if not exists 'open_finance';

alter table staged_transactions add column if not exists external_id text;
alter table transactions add column if not exists external_id text;

create unique index if not exists txn_external_id_uq
  on transactions (external_id)
  where external_id is not null;

create table if not exists bank_connections (
  id bigint generated always as identity primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  provider text not null default 'pluggy',
  provider_item_id text not null,
  provider_account_id text not null,
  provider_account_label text not null default '',
  sync_from text not null,
  last_synced_at text,
  last_sync_count bigint,
  last_error text,
  created_at text not null default now_iso()
);

create unique index if not exists bank_connections_provider_account_uq
  on bank_connections (provider, provider_account_id);
create index if not exists bank_connections_account_idx on bank_connections (account_id);

alter table bank_connections enable row level security;
