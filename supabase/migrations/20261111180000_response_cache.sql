-- Cache das leituras da função insights (perf, 11/11/2026).
--
-- data_version: um número que sobe a cada escrita em qualquer tabela do app
-- (trigger por comando, não por linha: uma importação de 500 linhas sobe uma
-- vez). Como é uma linha comum, a versão nova só fica visível quando a
-- transação que escreveu faz commit, junto com os dados.
--
-- api_cache: a resposta pronta de cada GET da insights, guardada com a versão
-- e o dia em que foi calculada. Vale enquanto a versão e o dia não mudam.
-- Também guarda a assinatura da materialização (chave '__materialization').
--
-- usage_events (telemetria) fica de fora: cada tela aberta grava ali, e isso
-- invalidaria o cache a cada navegação. Tabela nova precisa de
-- `select attach_data_version('nome')` na própria migração.

create table if not exists data_version (
  id smallint primary key default 1 check (id = 1),
  v bigint not null default 1
);
insert into data_version (id, v) values (1, 1) on conflict (id) do nothing;

create table if not exists api_cache (
  key text primary key,
  version bigint not null,
  day text not null,
  body text not null,
  stored_at timestamptz not null default now()
);

-- Só as funções (conexão direta ao Postgres) usam as duas tabelas.
alter table data_version enable row level security;
alter table api_cache enable row level security;

create or replace function bump_data_version() returns trigger
language plpgsql
set search_path = public
as $$
begin
  update data_version set v = v + 1 where id = 1;
  return null;
end;
$$;

create or replace function attach_data_version(target regclass) returns void
language plpgsql
set search_path = public
as $$
begin
  execute format('drop trigger if exists bump_data_version on %s', target);
  execute format(
    'create trigger bump_data_version after insert or update or delete or truncate on %s for each statement execute function bump_data_version()',
    target
  );
end;
$$;

do $$
declare
  t record;
begin
  for t in
    select c.oid::regclass as rel
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname not in ('usage_events', 'api_cache', 'data_version')
  loop
    perform attach_data_version(t.rel);
  end loop;
end;
$$;
