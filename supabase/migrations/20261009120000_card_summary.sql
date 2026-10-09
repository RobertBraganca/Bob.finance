-- Resumo dos cartões pelo Open Finance (decisions/0044,
-- specs/card-summary-sync).
--
-- Só tabelas novas: nenhuma linha existente muda. Nenhuma compra de cartão
-- vira lançamento. RLS ligado e sem política, como as demais tabelas.

create table if not exists card_connections (
  id bigint generated always as identity primary key,
  credit_card_id bigint not null references credit_cards (id) on delete cascade,
  provider_item_id text not null,
  provider_account_id text not null,
  provider_account_label text not null default '',
  balance_cents bigint,
  available_cents bigint,
  minimum_payment_cents bigint,
  due_date text,
  last_synced_at text,
  last_error text,
  created_at text not null default now_iso()
);
create unique index if not exists card_connections_provider_account_uq on card_connections (provider_account_id);
create unique index if not exists card_connections_card_uq on card_connections (credit_card_id);

create table if not exists card_bills (
  id bigint generated always as identity primary key,
  credit_card_id bigint not null references credit_cards (id) on delete cascade,
  provider_bill_id text not null,
  due_date text not null,
  closing_date text,
  total_cents bigint not null,
  minimum_cents bigint,
  finance_charges_cents bigint not null default 0,
  finance_charges jsonb,
  synced_at text not null default now_iso()
);
create unique index if not exists card_bills_provider_uq on card_bills (provider_bill_id);
create index if not exists card_bills_card_idx on card_bills (credit_card_id);

create table if not exists card_months (
  id bigint generated always as identity primary key,
  credit_card_id bigint not null references credit_cards (id) on delete cascade,
  period text not null,
  posted_cents bigint not null default 0,
  projected_cents bigint not null default 0,
  charges_cents bigint not null default 0,
  installment_purchases bigint not null default 0
);
create unique index if not exists card_months_uq on card_months (credit_card_id, period);

alter table card_connections enable row level security;
alter table card_bills enable row level security;
alter table card_months enable row level security;
