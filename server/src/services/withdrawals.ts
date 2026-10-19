import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { accounts, financialEngineSettings } from '../db/schema'
import { addDays, periodBounds } from '../core/dates'
import { memoPerRequest } from '../core/requestCache'

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
export function accountScope(): Promise<AccountScope> {
  return memoPerRequest('accountScope', computeAccountScope)
}

async function computeAccountScope(): Promise<AccountScope> {
  // Em sequência: o pooler de transação das Edge Functions trava com fan-out concorrente.
  const settings = await db.select({ pj: financialEngineSettings.pjAccountId }).from(financialEngineSettings).limit(1)
  const rows = await db.select({ id: accounts.id }).from(accounts)
  const pjAccountId = settings[0]?.pj ?? null
  return { personal: rows.map((r) => r.id).filter((id) => id !== pjAccountId), pjAccountId }
}

export const idList = (ids: number[]) => (ids.length ? sql.join(ids.map((id) => sql`${id}`), sql`, `) : sql`null`)

export type MonthlyTransfers = Map<string, { toPersonalCents: number; fromPersonalCents: number }>

export async function pjWithdrawals(
  fromPeriod: string,
  toPeriod: string,
  scope: AccountScope,
  /** recorta por dia dentro dos meses (mês corrente até hoje, intervalo personalizado) */
  bounds?: { from: string; to: string },
  /** analytics: positivo sem TAG já conta como receita pelo sinal; incluir aqui seria contar duas vezes */
  tagged = false,
): Promise<MonthlyTransfers> {
  const out: MonthlyTransfers = new Map()
  if (scope.pjAccountId === null || scope.personal.length === 0) return out
  const from = bounds && bounds.from > periodBounds(fromPeriod).start ? bounds.from : periodBounds(fromPeriod).start
  const to = bounds && bounds.to < periodBounds(toPeriod).end ? bounds.to : periodBounds(toPeriod).end
  // A outra perna pode cair um dia fora do recorte: a busca dela olha um dia para cada lado.
  const legFrom = addDays(from, -1)
  const legTo = addDays(to, 1)
  const slot = (period: string) => {
    let s = out.get(period)
    if (!s) out.set(period, (s = { toPersonalCents: 0, fromPersonalCents: 0 }))
    return s
  }
  // Somado pelo lado que recebe: é ele que diz se o dinheiro virou receita.
  // As duas consultas em sequência (pooler das Edge Functions); cada uma tem um EXISTS correlacionado.
  const toPersonal = await db.execute<{ period: string; cents: number }>(sql`
      select substr(t.posted_on, 1, 7) as period, coalesce(sum(t.amount_cents), 0) as cents
      from transactions t
      left join categories c on c.id = t.category_id
      where t.amount_cents > 0 and t.pending = false and t.ignored = false
        and coalesce(c.kind::text, '') <> 'income'
        ${tagged ? sql`and c.id is not null` : sql``}
        and t.account_id in (${idList(scope.personal)})
        and t.posted_on between ${from} and ${to}
        and exists (
          select 1 from transactions o
          where o.account_id = ${scope.pjAccountId} and o.amount_cents = -t.amount_cents
            and o.pending = false and o.ignored = false
            and o.posted_on between ${legFrom} and ${legTo}
            and abs(o.posted_on::date - t.posted_on::date) <= 1
        )
      group by 1`)
  const fromPersonal = await db.execute<{ period: string; cents: number }>(sql`
      select substr(t.posted_on, 1, 7) as period, coalesce(sum(t.amount_cents), 0) as cents
      from transactions t
      left join categories c on c.id = t.category_id
      where t.amount_cents > 0 and t.pending = false and t.ignored = false
        and coalesce(c.kind::text, '') <> 'income'
        ${tagged ? sql`and c.id is not null` : sql``}
        and t.account_id = ${scope.pjAccountId}
        and t.posted_on between ${from} and ${to}
        and exists (
          select 1 from transactions o
          where o.account_id in (${idList(scope.personal)}) and o.amount_cents = -t.amount_cents
            and o.pending = false and o.ignored = false
            and o.posted_on between ${legFrom} and ${legTo}
            and abs(o.posted_on::date - t.posted_on::date) <= 1
        )
      group by 1`)
  for (const row of toPersonal) slot(row.period).toPersonalCents += Number(row.cents)
  for (const row of fromPersonal) slot(row.period).fromPersonalCents += Number(row.cents)
  return out
}
