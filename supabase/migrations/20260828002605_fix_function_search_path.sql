-- ============================================================
-- Fixa search_path das 3 funções próprias, apontado pelo
-- `supabase db advisors` (function_search_path_mutable): sem
-- `search_path` fixo, a função resolve nomes não qualificados contra
-- o search_path de QUEM chama, não o de quem criou — alguém com
-- privilégio de criar objeto num schema anterior no search_path
-- poderia sombrear um nome e desviar a função. Nenhuma delas é
-- SECURITY DEFINER, então o risco já era baixo, mas fixar é a
-- correção recomendada mesmo assim.
--
-- search_path = '' em todas — o que exige qualificar todo nome que
-- antes dependia do search_path implícito: `set_updated_at` chama
-- `now_iso()` (vira `public.now_iso()`), e `enforce_singleton` monta
-- SQL dinâmico sobre `tg_table_name` (vira `public.%I`). Funções
-- embutidas (`now()`, `to_char()`, `format()`) continuam resolvendo:
-- pg_catalog está sempre implicitamente na busca, search_path vazio
-- ou não.
-- ============================================================

create or replace function now_iso() returns text
language sql
stable
set search_path = ''
as $$
  select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
$$;

create or replace function set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := public.now_iso();
  return new;
end;
$$;

create or replace function enforce_singleton() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  existing_count integer;
begin
  execute format('select count(*) from public.%I', tg_table_name) into existing_count;
  if existing_count > 0 then
    raise exception 'tabela % guarda só uma linha (id = 1) — já existe uma', tg_table_name;
  end if;
  return new;
end;
$$;
