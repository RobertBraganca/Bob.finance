-- Lista de compras / Mercado (docs/specs/lista-de-compras).
--
-- Catálogo de produtos, compras e itens. O preço de cada produto não é
-- guardado: o último preço, o histórico e o índice da cesta são derivados
-- dos itens das compras concluídas. A compra nunca cria lançamento; ela só
-- pode apontar para o lançamento real (Open Finance) por transaction_id.

do $$ begin
  create type grocery_unit as enum ('un', 'kg', 'L');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type grocery_trip_status as enum ('planning', 'shopping', 'done');
exception when duplicate_object then null;
end $$;

create table if not exists grocery_products (
  id bigint generated always as identity primary key,
  name text not null,
  -- nome normalizado (minúsculas, sem acento, espaços colapsados): evita duplicata
  name_key text not null unique,
  unit grocery_unit not null,
  default_qty numeric(10, 3) not null default 1 check (default_qty > 0),
  archived boolean not null default false,
  created_at text not null default now_iso(),
  updated_at text not null default now_iso()
);

create table if not exists grocery_trips (
  id bigint generated always as identity primary key,
  status grocery_trip_status not null default 'planning',
  started_at text,
  -- data da compra (YYYY-MM-DD), gravada ao concluir
  purchased_on text,
  transaction_id bigint unique references transactions (id) on delete set null,
  created_at text not null default now_iso(),
  updated_at text not null default now_iso(),
  check (status <> 'done' or purchased_on is not null)
);
-- No máximo uma compra ativa (montando a lista ou no mercado).
create unique index if not exists grocery_trips_one_active
  on grocery_trips ((true)) where status in ('planning', 'shopping');
create index if not exists grocery_trips_purchased_idx on grocery_trips (purchased_on) where status = 'done';

create table if not exists grocery_trip_items (
  id bigint generated always as identity primary key,
  trip_id bigint not null references grocery_trips (id) on delete cascade,
  product_id bigint not null references grocery_products (id),
  planned_qty numeric(10, 3) not null check (planned_qty > 0),
  qty numeric(10, 3) check (qty > 0),
  unit_price_cents bigint check (unit_price_cents >= 0),
  checked boolean not null default false,
  -- contador do cliente: escrita com client_rev menor ou igual ao gravado é ignorada
  client_rev bigint not null default 0,
  created_at text not null default now_iso(),
  updated_at text not null default now_iso(),
  unique (trip_id, product_id)
);
create index if not exists grocery_trip_items_product_idx on grocery_trip_items (product_id);

create table if not exists grocery_settings (
  id smallint primary key default 1 check (id = 1),
  -- categoria cujo teto (category_caps) e gasto valem como orçamento de mercado
  category_id bigint references categories (id) on delete set null,
  updated_at text not null default now_iso()
);

drop trigger if exists grocery_products_set_updated_at on grocery_products;
create trigger grocery_products_set_updated_at before update on grocery_products
  for each row execute function set_updated_at();
drop trigger if exists grocery_trips_set_updated_at on grocery_trips;
create trigger grocery_trips_set_updated_at before update on grocery_trips
  for each row execute function set_updated_at();
drop trigger if exists grocery_trip_items_set_updated_at on grocery_trip_items;
create trigger grocery_trip_items_set_updated_at before update on grocery_trip_items
  for each row execute function set_updated_at();
drop trigger if exists grocery_settings_set_updated_at on grocery_settings;
create trigger grocery_settings_set_updated_at before update on grocery_settings
  for each row execute function set_updated_at();

-- Só as funções (service_role) acessam; sem policy para anon/authenticated.
alter table grocery_products enable row level security;
alter table grocery_trips enable row level security;
alter table grocery_trip_items enable row level security;
alter table grocery_settings enable row level security;

select attach_data_version('grocery_products');
select attach_data_version('grocery_trips');
select attach_data_version('grocery_trip_items');
select attach_data_version('grocery_settings');
