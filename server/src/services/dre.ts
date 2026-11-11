import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import type { Range } from './analytics'
import { accountScope, pjWithdrawals } from './withdrawals'

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
 * ------------------------------------------------------------------ */
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
  /** repasse líquido da PJ para as contas pessoais no período; null fora da conta PJ */
  withdrawnToPfCents: number | null
  /** lucro líquido menos o repasse: o que ficou na empresa */
  keptCents: number | null
}

export async function formalDre(range: Range): Promise<FormalDre> {
  const scope = await accountScope()
  const accountId = range.accountId ?? scope.pjAccountId
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
          -- Reajuste de saldo nunca é receita nem despesa (ver FLOW_KIND em analytics.ts).
          when t.ignored then 'ignored'
          when t.source = 'adjustment' then 'transfer'
          when c.kind is null then (case when t.amount_cents > 0 then 'income' else 'expense' end)
          else c.kind::text
        end as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.posted_on between ${range.from} and ${range.to}
        and t.pending = false and t.ignored = false
        ${accountId ? sql`and t.account_id = ${accountId}` : sql``}
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

  let withdrawnToPfCents: number | null = null
  if (accountId !== null && accountId === scope.pjAccountId) {
    const transfers = await pjWithdrawals(range.from.slice(0, 7), range.to.slice(0, 7), scope, { from: range.from, to: range.to })
    withdrawnToPfCents = 0
    for (const month of transfers.values()) withdrawnToPfCents += month.toPersonalCents - month.fromPersonalCents
  }

  return {
    range,
    accountId,
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
    withdrawnToPfCents,
    keptCents: withdrawnToPfCents === null ? null : lucroLiquidoCents - withdrawnToPfCents,
  }
}
