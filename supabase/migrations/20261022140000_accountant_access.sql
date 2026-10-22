-- Contador (docs/specs/tarefas-comercial-contador, fases 4 e 5).
-- 1) Pacote do mês: bucket privado; só o dono grava e apaga. O contador recebe
--    links assinados com validade, gerados pelo servidor ou pelo dono.
-- 2) Login do contador: quem foi convidado e com que papel. A função `accountant`
--    só aceita o dono ou um contador ativo daqui, e só tem leituras da parte PJ.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('accountant-packages', 'accountant-packages', false, 5242880, array['application/pdf', 'text/csv'])
on conflict (id) do nothing;

drop policy if exists "accountant_packages_admin_select" on storage.objects;
drop policy if exists "accountant_packages_admin_insert" on storage.objects;
drop policy if exists "accountant_packages_admin_delete" on storage.objects;

create policy "accountant_packages_admin_select" on storage.objects for select to authenticated
  using (bucket_id = 'accountant-packages' and auth.uid() = '23d255ea-c812-4733-aaff-fdb3ef838117'::uuid);
create policy "accountant_packages_admin_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'accountant-packages' and auth.uid() = '23d255ea-c812-4733-aaff-fdb3ef838117'::uuid);
create policy "accountant_packages_admin_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'accountant-packages' and auth.uid() = '23d255ea-c812-4733-aaff-fdb3ef838117'::uuid);

create table if not exists app_users (
  user_id uuid primary key,
  email text not null,
  role text not null default 'accountant' check (role in ('accountant')),
  invited_at text not null default now_iso(),
  revoked_at text
);
create unique index if not exists app_users_email_uq on app_users (lower(email));

alter table app_users enable row level security;
