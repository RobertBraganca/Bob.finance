-- Clientes, catálogo de serviços e fluxo unificado (docs/specs/clientes-e-negocios).
--
-- Fase 2: `clients` (lead, empresa ou pessoa) e `client_contacts`; `client_id` nas cotações
-- e nos orçamentos. O texto livre `client_label` continua (é o nome que sai no documento).
-- Fase 3: `client_payer_aliases`, os nomes com que o cliente aparece no extrato (o Pix de
-- quem paga), para o LTV ler o dinheiro real; `service_catalog` e `service_id` nos itens.
-- Fase 4: o orçamento ganha os estágios "em negociação" e "pausado", para cotação e orçamento
-- falarem a mesma língua no fluxo unificado.
--
-- Só cria tabela, coluna e valor de enum. O único passo de dado cria um cliente para cada
-- nome de cliente já usado (sem repetir maiúsculas/minúsculas) e liga os documentos a ele;
-- nenhuma linha existente perde informação. RLS ligado e sem política, como nas outras
-- tabelas (a API REST pública não alcança; as funções acessam pelo Postgres). Idempotente.

do $$ begin
  create type client_kind as enum ('lead', 'company', 'person');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type client_status as enum ('active', 'inactive', 'archived');
exception when duplicate_object then null;
end $$;

create table if not exists clients (
  id bigint generated always as identity primary key,
  name text not null,
  kind client_kind not null default 'company',
  status client_status not null default 'active',
  segment text,
  email text,
  phone text,
  document text,
  website text,
  source text,
  description text,
  is_recurring boolean not null default false,
  created_at text not null default now_iso(),
  updated_at text not null default now_iso()
);
create unique index if not exists clients_name_uq on clients (lower(name));
create index if not exists clients_status_idx on clients (status);

create table if not exists client_contacts (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients (id) on delete cascade,
  name text not null,
  role text,
  email text,
  phone text,
  is_primary boolean not null default false,
  created_at text not null default now_iso()
);
create index if not exists client_contacts_client_idx on client_contacts (client_id);

-- Nome do pagador como aparece na descrição do extrato, já normalizado (minúsculas, sem acento).
create table if not exists client_payer_aliases (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients (id) on delete cascade,
  alias text not null,
  created_at text not null default now_iso()
);
create unique index if not exists client_payer_aliases_uq on client_payer_aliases (client_id, alias);

create table if not exists service_catalog (
  id bigint generated always as identity primary key,
  name text not null,
  description text,
  default_price_cents bigint not null default 0,
  active boolean not null default true,
  sort_order bigint not null default 0,
  created_at text not null default now_iso()
);
create unique index if not exists service_catalog_name_uq on service_catalog (lower(name));

alter table project_quotes add column if not exists client_id bigint references clients (id) on delete set null;
create index if not exists project_quotes_client_idx on project_quotes (client_id);
alter table service_proposals add column if not exists client_id bigint references clients (id) on delete set null;
create index if not exists service_proposals_client_idx on service_proposals (client_id);
alter table service_proposal_items add column if not exists service_id bigint references service_catalog (id) on delete set null;
create index if not exists service_proposal_items_service_idx on service_proposal_items (service_id);

alter type proposal_status add value if not exists 'negotiating';
alter type proposal_status add value if not exists 'paused';

-- Um cliente por nome usado nos ORÇAMENTOS (o primeiro jeito de escrever vence). As cotações
-- não criam cliente: lá o campo é "cliente ou projeto" ("[LUMNA] Migração de e-commerce"), e
-- virariam clientes falsos; elas só se ligam quando o nome bate, e o resto se liga pela tela.
insert into clients (name)
select distinct on (lower(btrim(client_label))) btrim(client_label)
from service_proposals
where btrim(client_label) <> ''
order by lower(btrim(client_label)), btrim(client_label)
on conflict do nothing;

update project_quotes q set client_id = c.id
from clients c
where q.client_id is null and lower(btrim(q.client_label)) = lower(c.name);

update service_proposals p set client_id = c.id
from clients c
where p.client_id is null and lower(btrim(p.client_label)) = lower(c.name);

alter table clients enable row level security;
alter table client_contacts enable row level security;
alter table client_payer_aliases enable row level security;
alter table service_catalog enable row level security;
