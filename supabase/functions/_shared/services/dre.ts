import { sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import type { Range } from './analytics.ts'
import { accountScope, pjWithdrawals } from './withdrawals.ts'

/* ------------------------------------------------------------------ *
 * DRE formal (PJ) — specs/dre, "DRE PJ formal"
 *
 * Waterfall contábil de verdade (Receita Bruta -> Lucro Líquido). Cada
 * categoria-mãe é classificada uma vez em `dreGroup` (Categories.tsx) —
 * sem classificação explícita, cai no balde padrão (Receita Bruta pro lado
 * de receita, Despesa Operacional pro lado de despesa), nunca "some" do
 * resultado. Mesma FLOW_KIND de analytics.ts reimplementada aqui (não
 * exportada de lá) — categoria sem `kind` (nunca categorizada) cai pelo
 * sinal do valor, igual o resto do app.
 *
 * Desde 11/11/2026 é a única DRE do app (a tela Minha empresa termina
 * nela): as colunas por conta e a reconciliação PJ ↔ PF saíram, e a
 * retirada para a pessoa física vem daqui, da mesma `pjWithdrawals` que
 * Minha empresa e o Orçamento usam.
 *
 * 12/11/2026 (margem, markup e DRE):
 * - Margens bruta, operacional e líquida, sempre sobre a receita líquida,
 *   e a mesma conta nos 6 meses anteriores ao período, para comparar.
 * - Gasto pessoal pago pela conta PJ (categoria de despesa do orçamento
 *   pessoal, sem grupo de DRE e não marcada "fora do orçamento" como o
 *   Negócio) sai da despesa operacional e vira retirada: dinheiro da
 *   empresa usado pela pessoa não é despesa da empresa.
 * - Custo, imposto e dedução somam pelo valor líquido: um estorno numa
 *   categoria de custo reduz o custo em vez de somar.
 * - Entrada (valor positivo) em categoria de despesa sem grupo não cabe em
 *   linha nenhuma; o total e a quantidade vêm à parte para a tela avisar.
 * ------------------------------------------------------------------ */
export type DreMargins = {
  /** lucro bruto / receita líquida, em bps; nulo sem receita líquida positiva */
  brutaBps: number | null
  operacionalBps: number | null
  liquidaBps: number | null
}

export type FormalDre = {
  range: Range
  /** a conta lida: a pedida, ou a PJ do Motor financeiro quando nenhuma veio */
  accountId: number | null
  receitaBrutaCents: number
  deducoesCents: number
  receitaLiquidaCents: number
  custosCents: number
  lucroBrutoCents: number
  despesasOperacionaisCents: number
  resultadoOperacionalCents: number
  /** positivo = mais receita financeira que despesa financeira */
  resultadoFinanceiroCents: number
  impostosCents: number
  lucroLiquidoCents: number
  margins: DreMargins
  /** as mesmas margens somando os 6 meses anteriores ao período (só os com receita) */
  previous: DreMargins & { months: number }
  /** repasse líquido da PJ para as contas pessoais no período; null fora da conta PJ */
  withdrawnToPfCents: number | null
  /** gasto de categoria pessoal pago pela conta PJ; null fora da conta PJ */
  personalPaidByPjCents: number | null
  /** lucro líquido menos o repasse e o gasto pessoal: o que ficou na empresa */
  keptCents: number | null
  /** entradas em categoria de despesa sem grupo de DRE, fora de todas as linhas */
  uncountedInflow: { cents: number; count: number }
}

type Sums = {
  receitaBrutaCents: number
  deducoesCents: number
  custosCents: number
  despesasOperacionaisCents: number
  financeiroCents: number
  impostosCents: number
  pessoalCents: number
  foraCents: number
  foraCount: number
}

const ZERO: Sums = {
  receitaBrutaCents: 0,
  deducoesCents: 0,
  custosCents: 0,
  despesasOperacionaisCents: 0,
  financeiroCents: 0,
  impostosCents: 0,
  pessoalCents: 0,
  foraCents: 0,
  foraCount: 0,
}

/** Somas das linhas do DRE por mês (YYYY-MM). `splitPersonal` só na conta PJ. */
async function sumsByMonth(from: string, to: string, accountId: number | null, splitPersonal: boolean): Promise<Map<string, Sums>> {
  const rows = await db.execute<Sums & { period: string }>(sql`
    select
      period,
      coalesce(sum(case when flow = 'income' and (dre_group is null or dre_group not in ('deduction', 'financial')) and amount_cents > 0 then amount_cents else 0 end), 0) as "receitaBrutaCents",
      coalesce(sum(case when dre_group = 'deduction' then -amount_cents else 0 end), 0) as "deducoesCents",
      coalesce(sum(case when flow = 'expense' and dre_group = 'cost' then -amount_cents else 0 end), 0) as "custosCents",
      coalesce(sum(case when flow = 'expense' and dre_group is null and amount_cents < 0 and not personal then -amount_cents else 0 end), 0) as "despesasOperacionaisCents",
      coalesce(sum(case when dre_group = 'financial' and flow in ('income', 'expense') then amount_cents else 0 end), 0) as "financeiroCents",
      coalesce(sum(case when flow = 'expense' and dre_group = 'tax' then -amount_cents else 0 end), 0) as "impostosCents",
      coalesce(sum(case when flow = 'expense' and dre_group is null and amount_cents < 0 and personal then -amount_cents else 0 end), 0) as "pessoalCents",
      coalesce(sum(case when flow = 'expense' and dre_group is null and amount_cents > 0 then amount_cents else 0 end), 0) as "foraCents",
      count(*) filter (where flow = 'expense' and dre_group is null and amount_cents > 0)::int as "foraCount"
    from (
      select
        left(t.posted_on::text, 7) as period,
        t.amount_cents,
        c.dre_group,
        -- Gasto pessoal: categoria de despesa do orçamento pessoal (nem ela nem
        -- a mãe "fora do orçamento", como o Negócio) e sem grupo de DRE.
        (${splitPersonal}::boolean and c.id is not null and c.dre_group is null
          and not c.budget_excluded and not coalesce(p.budget_excluded, false)) as personal,
        case
          -- Reajuste de saldo nunca é receita nem despesa (ver FLOW_KIND em analytics.ts).
          when t.ignored then 'ignored'
          when t.source = 'adjustment' then 'transfer'
          when c.kind is null then (case when t.amount_cents > 0 then 'income' else 'expense' end)
          else c.kind::text
        end as flow
      from transactions t
      left join categories c on c.id = t.category_id
      left join categories p on p.id = c.parent_id
      where t.posted_on between ${from} and ${to}
        and t.pending = false and t.ignored = false
        ${accountId ? sql`and t.account_id = ${accountId}` : sql``}
    ) x
    group by period
  `)
  return new Map(rows.map((r) => [r.period, { ...ZERO, ...r }]))
}

function add(a: Sums, b: Sums): Sums {
  return Object.fromEntries(Object.keys(ZERO).map((k) => [k, a[k as keyof Sums] + b[k as keyof Sums]])) as Sums
}

function waterfall(s: Sums) {
  const receitaLiquidaCents = s.receitaBrutaCents - s.deducoesCents
  const lucroBrutoCents = receitaLiquidaCents - s.custosCents
  const resultadoOperacionalCents = lucroBrutoCents - s.despesasOperacionaisCents
  const lucroLiquidoCents = resultadoOperacionalCents + s.financeiroCents - s.impostosCents
  const share = (cents: number) => (receitaLiquidaCents > 0 ? Math.round((cents / receitaLiquidaCents) * 10_000) : null)
  return {
    receitaLiquidaCents,
    lucroBrutoCents,
    resultadoOperacionalCents,
    lucroLiquidoCents,
    margins: { brutaBps: share(lucroBrutoCents), operacionalBps: share(resultadoOperacionalCents), liquidaBps: share(lucroLiquidoCents) },
  }
}

/** Primeiro e último dia dos `count` meses inteiros antes do mês de `date`. */
function monthsBefore(date: string, count: number): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number)
  const start = new Date(Date.UTC(y!, m! - 1 - count, 1))
  const end = new Date(Date.UTC(y!, m! - 1, 0))
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }
}

export async function formalDre(range: Range): Promise<FormalDre> {
  const scope = await accountScope()
  const accountId = range.accountId ?? scope.pjAccountId
  const isPj = accountId !== null && accountId === scope.pjAccountId
  const before = monthsBefore(range.from, 6)

  const [current, history] = await Promise.all([
    sumsByMonth(range.from, range.to, accountId, isPj),
    sumsByMonth(before.from, before.to, accountId, isPj),
  ])
  const s = [...current.values()].reduce(add, ZERO)
  const w = waterfall(s)
  const withRevenue = [...history.values()].filter((m) => m.receitaBrutaCents > 0)
  const previous = { ...waterfall(withRevenue.reduce(add, ZERO)).margins, months: withRevenue.length }

  let withdrawnToPfCents: number | null = null
  if (isPj) {
    const transfers = await pjWithdrawals(range.from.slice(0, 7), range.to.slice(0, 7), scope, { from: range.from, to: range.to })
    withdrawnToPfCents = 0
    for (const month of transfers.values()) withdrawnToPfCents += month.toPersonalCents - month.fromPersonalCents
  }
  const personalPaidByPjCents = isPj ? s.pessoalCents : null

  return {
    range,
    accountId,
    receitaBrutaCents: s.receitaBrutaCents,
    deducoesCents: s.deducoesCents,
    receitaLiquidaCents: w.receitaLiquidaCents,
    custosCents: s.custosCents,
    lucroBrutoCents: w.lucroBrutoCents,
    despesasOperacionaisCents: s.despesasOperacionaisCents,
    resultadoOperacionalCents: w.resultadoOperacionalCents,
    resultadoFinanceiroCents: s.financeiroCents,
    impostosCents: s.impostosCents,
    lucroLiquidoCents: w.lucroLiquidoCents,
    margins: w.margins,
    previous,
    withdrawnToPfCents,
    personalPaidByPjCents,
    keptCents: withdrawnToPfCents === null ? null : w.lucroLiquidoCents - withdrawnToPfCents - (personalPaidByPjCents ?? 0),
    uncountedInflow: { cents: s.foraCents, count: s.foraCount },
  }
}
