alter table transactions
  add column credit_card_id integer references credit_cards(id) on delete set null;

create index txn_credit_card_idx on transactions (credit_card_id) where credit_card_id is not null;
