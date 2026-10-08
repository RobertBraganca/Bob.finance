-- Orçamentos de serviço (decisions/0040, specs/service-proposals).
--
-- Só tabelas, uma coluna e um bucket novos: nenhuma linha existente muda.
-- Mesmo padrão das outras tabelas: RLS ligado e sem política, então a API
-- REST pública não as alcança; as Edge Functions acessam pelo Postgres.

do $$ begin
  create type proposal_status as enum ('draft', 'sent', 'approved', 'rejected');
exception when duplicate_object then null;
end $$;

create sequence if not exists service_proposal_number_seq;

create table if not exists service_proposals (
  id bigint generated always as identity primary key,
  number bigint not null default nextval('service_proposal_number_seq'),
  title text not null,
  client_label text not null,
  status proposal_status not null default 'draft',
  discount_bps bigint not null default 0,
  validity_days bigint not null default 15,
  installments bigint not null default 1,
  payment_terms text,
  delivery_terms text,
  notes text,
  sent_at text,
  approved_amount_cents bigint,
  created_at text not null default now_iso(),
  updated_at text not null default now_iso()
);

create unique index if not exists service_proposals_number_uq on service_proposals (number);
create index if not exists service_proposals_status_idx on service_proposals (status);

create table if not exists service_proposal_items (
  id bigint generated always as identity primary key,
  proposal_id bigint not null references service_proposals (id) on delete cascade,
  title text not null,
  description text,
  unit_price_cents bigint not null,
  quantity double precision not null default 1,
  sort_order bigint not null default 0,
  source_quote_id bigint references project_quotes (id) on delete set null
);

create index if not exists service_proposal_items_proposal_idx on service_proposal_items (proposal_id);
create index if not exists service_proposal_items_quote_idx on service_proposal_items (source_quote_id);

create table if not exists proposal_issuer_settings (
  id bigint primary key default 1,
  business_name text,
  document text,
  email text,
  phone text,
  logo_path text,
  default_validity_days bigint not null default 15,
  constraint proposal_issuer_settings_singleton check (id = 1)
);

insert into proposal_issuer_settings (id) values (1) on conflict (id) do nothing;

alter table transactions
  add column if not exists source_proposal_id bigint references service_proposals (id) on delete set null;
create index if not exists txn_source_proposal_idx on transactions (source_proposal_id);

alter table service_proposals enable row level security;
alter table service_proposal_items enable row level security;
alter table proposal_issuer_settings enable row level security;

-- Logo do emissor: bucket privado, só PNG/JPG até 1 MB, acesso só do usuário
-- admin (o mesmo ADMIN_USER_ID de supabase/functions/_shared/auth.ts).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proposal-assets', 'proposal-assets', false, 1048576, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "proposal_assets_admin_select" on storage.objects;
drop policy if exists "proposal_assets_admin_insert" on storage.objects;
drop policy if exists "proposal_assets_admin_update" on storage.objects;
drop policy if exists "proposal_assets_admin_delete" on storage.objects;

create policy "proposal_assets_admin_select" on storage.objects for select to authenticated
  using (bucket_id = 'proposal-assets' and auth.uid() = '23d255ea-c812-4733-aaff-fdb3ef838117'::uuid);
create policy "proposal_assets_admin_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'proposal-assets' and auth.uid() = '23d255ea-c812-4733-aaff-fdb3ef838117'::uuid);
create policy "proposal_assets_admin_update" on storage.objects for update to authenticated
  using (bucket_id = 'proposal-assets' and auth.uid() = '23d255ea-c812-4733-aaff-fdb3ef838117'::uuid)
  with check (bucket_id = 'proposal-assets' and auth.uid() = '23d255ea-c812-4733-aaff-fdb3ef838117'::uuid);
create policy "proposal_assets_admin_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'proposal-assets' and auth.uid() = '23d255ea-c812-4733-aaff-fdb3ef838117'::uuid);
