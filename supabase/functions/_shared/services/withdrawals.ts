import { sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { accounts, financialEngineSettings } from '../db/schema.ts'
import { periodBounds } from '../core/dates.ts'

/**
 * Repasse entre a conta PJ e as contas pessoais (specs/company-mei,
 * decisions/0043): uma função só para "Minha empresa" e o Orçamento.
 *
 * Uma saída da PJ conta como retirada quando pareia (mesmo valor, até 1
 * dia) com uma entrada numa conta pessoal que **não** está lançada como
 * receita; lançada como receita, ela já é renda pessoal e não é somada de
 * novo. O caminho inverso (dinheiro pessoal colocado na PJ) é medido do
 * mesmo jeito, com a entrada na PJ que não é receita.
 */

export type AccountScope = { personal: number[]; pjAccountId: number | null }

/** Contas pessoais: todas menos a conta PJ configurada no Motor financeiro. */
export async function accountScope(): Promise<AccountScope> {
  const [settings, rows] = await Promise.all([
    db.select({ pj: financialEngineSettings.pjAccountId }).from(financialEngineSettings).limit(1),
    db.select({ id: accounts.id }).from(accounts),
  ])
  const pjAccountId = settings[0]?.pj ?? null
  return { personal: rows.map((r) => r.id).filter((id) => id !== pjAccountId), pjAccountId }
}

export const idList = (ids: number[]) => (ids.length ? sql.join(ids.map((id) => sql`${id}`), sql`, `) : sql`null`)

export type MonthlyTransfers = Map<string, { toPersonalCents: number; fromPersonalCents: number }>

export async function pjWithdrawals(fromPeriod: string, toPeriod: string, scope: AccountScope): Promise<MonthlyTransfers> {
  const out: MonthlyTransfers = new Map()
  if (scope.pjAccountId === null || scope.personal.length === 0) return out
  const from = periodBounds(fromPeriod).start
  const to = periodBounds(toPeriod).end
  const slot = (period: string) => {
    let s = out.get(period)
    if (!s) out.set(period, (s = { toPersonalCents: 0, fromPersonalCents: 0 }))
    return s
  }
  // Somado pelo lado que recebe: é ele que diz se o dinheiro virou receita.
  const [toPersonal, fromPersonal] = await Promise.all([
    db.execute<{ period: string; cents: number }>(sql`
      select substr(t.posted_on, 1, 7) as period, coalesce(sum(t.amount_cents), 0) as cents
      from transactions t
      left join categories c on c.id = t.category_id
      where t.amount_cents > 0 and t.pending = false and t.ignored = false
        and coalesce(c.kind::text, '') <> 'income'
        and t.account_id in (${idList(scope.personal)})
        and t.posted_on between ${from} and ${to}
        and exists (
          select 1 from transactions o
          where o.account_id = ${scope.pjAccountId} and o.amount_cents = -t.amount_cents
            and o.pending = false and o.ignored = false
            and abs(o.posted_on::date - t.posted_on::date) <= 1
        )
      group by 1`),
    db.execute<{ period: string; cents: number }>(sql`
      select substr(t.posted_on, 1, 7) as period, coalesce(sum(t.amount_cents), 0) as cents
      from transactions t
      left join categories c on c.id = t.category_id
      where t.amount_cents > 0 and t.pending = false and t.ignored = false
        and coalesce(c.kind::text, '') <> 'income'
        and t.account_id = ${scope.pjAccountId}
        and t.posted_on between ${from} and ${to}
        and exists (
          select 1 from transactions o
          where o.account_id in (${idList(scope.personal)}) and o.amount_cents = -t.amount_cents
            and o.pending = false and o.ignored = false
            and abs(o.posted_on::date - t.posted_on::date) <= 1
        )
      group by 1`),
  ])
  for (const row of toPersonal) slot(row.period).toPersonalCents += Number(row.cents)
  for (const row of fromPersonal) slot(row.period).fromPersonalCents += Number(row.cents)
  return out
}
