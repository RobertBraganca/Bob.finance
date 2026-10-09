-- Endividamento v2 (decisions/0044, specs/debt-v2).
--
-- 1. A dívida ganha uma TAG padrão (`category_id`), herdada pelas parcelas
--    pendentes que ela materializa, para entrar no grupo certo do Orçamento.
-- 2. `closed_reason` diz por que uma dívida saiu da lista: quitada,
--    renegociada (virou um acordo) ou encerrada à mão. Nulo nas ativas e
--    nas encerradas antes desta coluna (motivo desconhecido).
-- 3. `debt_renegotiations` liga um acordo às dívidas que ele substituiu,
--    com o saldo de cada uma no dia do acordo.
--
-- Preenchimento: só dívidas ativas sem TAG recebem uma (a TAG mais usada nas
-- parcelas dela; sem nenhuma, "Financeiro › Empréstimos"), e só parcelas
-- PENDENTES SEM TAG dessas dívidas herdam. Nada já classificado muda.

do $$ begin
  create type debt_closed_reason as enum ('paid', 'renegotiated', 'manual');
exception when duplicate_object then null;
end $$;

alter table debts add column if not exists category_id bigint references categories (id) on delete set null;
alter table debts add column if not exists closed_reason debt_closed_reason;

create table if not exists debt_renegotiations (
  id bigint generated always as identity primary key,
  debt_id bigint not null references debts (id) on delete cascade,
  origin_debt_id bigint not null references debts (id) on delete cascade,
  origin_balance_cents bigint not null,
  agreed_on text not null,
  created_at text not null default now_iso()
);
create unique index if not exists debt_renegotiation_origin_uq on debt_renegotiations (origin_debt_id);
create index if not exists debt_renegotiation_debt_idx on debt_renegotiations (debt_id);
alter table debt_renegotiations enable row level security;

update debts d
set category_id = coalesce(
  (
    select t.category_id
    from transactions t
    where t.debt_id = d.id and t.category_id is not null
    group by t.category_id
    order by count(*) desc, t.category_id
    limit 1
  ),
  (
    select c.id
    from categories c
    join categories p on p.id = c.parent_id
    where c.name = 'Empréstimos' and p.name = 'Financeiro'
    limit 1
  )
)
where d.active and d.category_id is null;

update transactions t
set category_id = d.category_id
from debts d
where t.debt_id = d.id
  and d.active
  and t.pending
  and t.category_id is null
  and d.category_id is not null;
