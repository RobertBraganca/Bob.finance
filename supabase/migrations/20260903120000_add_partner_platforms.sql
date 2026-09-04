-- Receita de parceiros: comissões de plataformas (Wbuy, Hostinger,
-- Nuvemshop, Adobe...) que acumulam saldo interno até bater um mínimo de
-- saque, e só então viram dinheiro numa conta real.
--
-- Duas tabelas de domínio e UMA coluna nova em transactions. Nenhuma delas
-- é um ledger paralelo, e nenhum saldo é gravado:
--
--   partner_platforms    cadastro (nome + mínimo de saque). Só configuração,
--                        igual a credit_cards: nenhum valor de saldo aqui.
--
--   partner_commissions  log de competência: o que a plataforma passou a
--                        DEVER, com data e valor. Não é um lançamento — esse
--                        dinheiro não está em conta nenhuma ainda. Mesma
--                        relação que project_quotes tem com transactions:
--                        acumula no domínio, e a realização (o saque, como a
--                        aprovação da cotação) é que escreve no ledger.
--
--   transactions.partner_platform_id
--                        a linha REAL gerada pelo saque, na conta de destino
--                        escolhida pelo usuário. Mesma forma de
--                        source_quote_id / debt_id / forecast_id: uma FK
--                        anulável que diz qual objeto de domínio produziu a
--                        linha, invisível na tela de Lançamentos.
--
-- O saldo de uma plataforma é sempre derivado (decisions/0018 e
-- "Derivação em vez de saldo guardado" em architecture.md):
--   sum(partner_commissions.amount_cents)
--     - sum(transactions.amount_cents where partner_platform_id = p.id)
-- Nunca uma coluna balance_cents, que seria a única do sistema.

create table partner_platforms (
  id bigint generated always as identity primary key,
  name text not null,
  -- Mínimo de saque da plataforma. Editável a qualquer momento (é uma
  -- regra do parceiro, não um dado histórico): 0 significa "sem mínimo",
  -- e aí a barra de progresso não tem o que medir.
  min_withdrawal_cents bigint not null default 0,
  notes text,
  active boolean not null default true,
  created_at text not null default now_iso(),
  constraint partner_platforms_min_non_negative check (min_withdrawal_cents >= 0)
);
-- Nome único sem depender de caixa: "Wbuy" e "wbuy" são a mesma plataforma,
-- e duas linhas para ela dividiriam o saldo em duas barras de progresso.
create unique index partner_platforms_name_uq on partner_platforms (lower(name));

create table partner_commissions (
  id bigint generated always as identity primary key,
  platform_id bigint not null references partner_platforms (id) on delete cascade,
  /** ISO date YYYY-MM-DD — ordena cronologicamente como texto, igual posted_on */
  earned_on text not null,
  amount_cents bigint not null,
  notes text,
  created_at text not null default now_iso(),
  -- Comissão é sempre entrada. Um valor negativo aqui seria um estorno, que
  -- ainda não tem caso de uso e passaria batido no saldo derivado.
  constraint partner_commissions_amount_positive check (amount_cents > 0)
);
create index partner_commissions_platform_idx on partner_commissions (platform_id, earned_on);
create index partner_commissions_earned_idx on partner_commissions (earned_on);

alter table transactions
  add column partner_platform_id bigint references partner_platforms (id) on delete set null;

-- Parcial: só as linhas de saque têm a coluna preenchida, e é só por elas
-- que o saldo derivado procura.
create index txn_partner_platform_idx on transactions (partner_platform_id)
  where partner_platform_id is not null;
