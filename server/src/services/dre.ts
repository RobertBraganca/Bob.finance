import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { merchantSignature } from '../core/normalize'
import * as analytics from './analytics'
import type { BreakdownSlice, Range, Totals } from './analytics'

/**
 * DRE (Demonstração de Resultado) per account: every income/expense leaf
 * category as its own line — never folded into an "Outras" bucket the way
 * the dashboard rings do — plus the uncategorized rows grouped by merchant
 * so the biggest unclassified chunks surface first.
 */
export type DreReport = {
  range: Range
  totals: Totals
  income: BreakdownSlice[]
  expense: BreakdownSlice[]
  uncategorized: {
    groups: UncategorizedGroup[]
    groupCount: number
    totalCount: number
    hasMore: boolean
  }
  /** Only present when the report is scoped to one account — see analytics.historicalServiceAverages. */
  serviceAverages: analytics.ServiceAverages | null
}

export type UncategorizedGroup = {
  signature: string
  sampleDescription: string
  count: number
  netCents: number
  ids: number[]
}

const GROUP_LIMIT = 30

async function uncategorizedGroups(range: Range): Promise<{ groups: UncategorizedGroup[]; groupCount: number; totalCount: number }> {
  const rows = await db.execute<{ id: number; description: string; amountCents: number }>(sql`
    select id, description, amount_cents as "amountCents"
    from transactions
    where posted_on between ${range.from} and ${range.to}
      and category_id is null
      and pending = false
      ${range.accountId ? sql`and account_id = ${range.accountId}` : sql``}
  `)

  const bySignature = new Map<string, UncategorizedGroup>()
  for (const row of rows) {
    const key = merchantSignature(row.description) || row.description.toLowerCase().slice(0, 40)
    const group = bySignature.get(key) ?? {
      signature: key,
      sampleDescription: row.description,
      count: 0,
      netCents: 0,
      ids: [],
    }
    group.count += 1
    group.netCents += row.amountCents
    group.ids.push(row.id)
    bySignature.set(key, group)
  }

  const groups = [...bySignature.values()].sort(
    (a, b) => Math.abs(b.netCents) - Math.abs(a.netCents),
  )

  return { groups, groupCount: groups.length, totalCount: rows.length }
}

/* ------------------------------------------------------------------ *
 * DRE formal (PJ) — specs/dre, "DRE PJ formal"
 *
 * Waterfall contábil de verdade (Receita Bruta -> Lucro Líquido), em vez
 * da lista simples de categorias que `dreReport` já mostra. Cada
 * categoria-mãe é classificada uma vez em `dreGroup`
 * (Categories.tsx) — sem classificação explícita, cai no balde padrão
 * (Receita Bruta pro lado de receita, Despesa Operacional pro lado de
 * despesa), nunca "some" do resultado. Mesma FLOW_KIND de analytics.ts
 * reimplementada aqui (não exportada de lá) — categoria sem `kind`
 * (nunca categorizada) cai pelo sinal do valor, igual o resto do app.
 * ------------------------------------------------------------------ */
export type FormalDre = {
  range: Range
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
}

export async function formalDre(range: Range): Promise<FormalDre> {
  const rows = await db.execute<{
    receitaBrutaCents: number
    deducoesCents: number
    custosCents: number
    despesasOperacionaisCents: number
    financeiroReceitaCents: number
    financeiroDespesaCents: number
    impostosCents: number
  }>(sql`
    select
      coalesce(sum(case when flow = 'income' and (dre_group is null or dre_group not in ('deduction', 'financial')) and amount_cents > 0 then amount_cents else 0 end), 0) as "receitaBrutaCents",
      coalesce(sum(case when dre_group = 'deduction' then abs(amount_cents) else 0 end), 0) as "deducoesCents",
      coalesce(sum(case when flow = 'expense' and dre_group = 'cost' then abs(amount_cents) else 0 end), 0) as "custosCents",
      coalesce(sum(case when flow = 'expense' and dre_group is null and amount_cents < 0 then -amount_cents else 0 end), 0) as "despesasOperacionaisCents",
      coalesce(sum(case when dre_group = 'financial' and flow = 'income' then amount_cents else 0 end), 0) as "financeiroReceitaCents",
      coalesce(sum(case when dre_group = 'financial' and flow = 'expense' then abs(amount_cents) else 0 end), 0) as "financeiroDespesaCents",
      coalesce(sum(case when flow = 'expense' and dre_group = 'tax' then abs(amount_cents) else 0 end), 0) as "impostosCents"
    from (
      select
        t.amount_cents,
        c.dre_group,
        case
          when c.kind is null then (case when t.amount_cents > 0 then 'income' else 'expense' end)
          else c.kind::text
        end as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.posted_on between ${range.from} and ${range.to}
        and t.pending = false
        ${range.accountId ? sql`and t.account_id = ${range.accountId}` : sql``}
    ) x
  `)
  const row = rows[0]

  const receitaBrutaCents = row?.receitaBrutaCents ?? 0
  const deducoesCents = row?.deducoesCents ?? 0
  const receitaLiquidaCents = receitaBrutaCents - deducoesCents
  const custosCents = row?.custosCents ?? 0
  const lucroBrutoCents = receitaLiquidaCents - custosCents
  const despesasOperacionaisCents = row?.despesasOperacionaisCents ?? 0
  const resultadoOperacionalCents = lucroBrutoCents - despesasOperacionaisCents
  const resultadoFinanceiroCents = (row?.financeiroReceitaCents ?? 0) - (row?.financeiroDespesaCents ?? 0)
  const impostosCents = row?.impostosCents ?? 0
  const lucroLiquidoCents = resultadoOperacionalCents + resultadoFinanceiroCents - impostosCents

  return {
    range,
    receitaBrutaCents,
    deducoesCents,
    receitaLiquidaCents,
    custosCents,
    lucroBrutoCents,
    despesasOperacionaisCents,
    resultadoOperacionalCents,
    resultadoFinanceiroCents,
    impostosCents,
    lucroLiquidoCents,
  }
}

export async function dreReport(range: Range): Promise<DreReport> {
  const [totals, income, expense, uncategorized, serviceAverages] = await Promise.all([
    analytics.totals(range),
    analytics.categoryBreakdown(range, { flow: 'income', level: 'leaf' }),
    analytics.categoryBreakdown(range, { flow: 'expense', level: 'leaf' }),
    uncategorizedGroups(range),
    range.accountId ? analytics.historicalServiceAverages(range.accountId) : Promise.resolve(null),
  ])
  const { groups, groupCount, totalCount } = uncategorized

  return {
    range,
    totals,
    income,
    expense,
    uncategorized: {
      groups: groups.slice(0, GROUP_LIMIT),
      groupCount,
      totalCount,
      hasMore: groupCount > GROUP_LIMIT,
    },
    serviceAverages,
  }
}
