create table subscription_dismissals (
  signature text primary key,
  created_at text not null default now_iso()
);
