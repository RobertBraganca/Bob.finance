import { sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { addDays, dayRange, periodBounds, todayIso } from '../core/dates.ts'
import { medianCents } from '../core/money.ts'
import { accountBalances, dailyStreak, receivable } from './analytics.ts'
import { monthSpendingVsCap } from './budget.ts'
import { debtOverviewV2 } from './debt.ts'
import { accountScope, idList } from './withdrawals.ts'

/**
 * Diário (specs/personal-picture, decisions/0045): o que vence nos próximos
 * dias, o saldo pessoal projetado e o gasto do mês contra o teto do
 * Orçamento. Escopo pessoal: a conta PJ e o cartão pago por ela ficam fora.
 * Observação, nunca recomendação (decisions/0010).
 */

/** `and t.account_id in (...)`; lista vazia não casa nada. */
const accountIdsFilter = (ids: number[]) => sql`and t.account_id in (${idList(ids)})`

/** Horizonte do "próximos dias" e o máximo até o próximo recebimento. */
export const UPCOMING_DAYS = 7
const MAX_HORIZON_DAYS = 45

export type UpcomingItem = { kind: 'expense' | 'income' | 'card'; label: string; amountCents: number; overdue?: boolean }
export type UpcomingDay = { day: string; items: UpcomingItem[]; outCents: number; inCents: number; balanceCents: number }

/** Gasto das contas pessoais por dia do mês (só realizado). */
async function personalDailySpend(from: string, to: string, personal: number[]) {
  const rows = await db.execute<{ day: string; expense: number; count: number }>(sql`
    select t.posted_on as day,
      coalesce(sum(-t.amount_cents), 0) as expense,
      count(*) as count
    from transactions t
    join categories c on c.id = t.category_id
    where c.kind = 'expense' and t.amount_cents < 0
      and t.pending = false and t.ignored = false
      and t.posted_on between ${from} and ${to}
      ${accountIdsFilter(personal)}
    group by 1`)
  const byDay = new Map(rows.map((r) => [r.day, r] as const))
  return dayRange(from, to).map((day) => ({
    day,
    expenseCents: Number(byDay.get(day)?.expense ?? 0),
    transactionCount: Number(byDay.get(day)?.count ?? 0),
  }))
}

/** Pendências (entradas e saídas) das contas pessoais até `to`, atrasadas inclusas. */
async function personalPending(to: string, personal: number[]) {
  const rows = await db.execute<{ postedOn: string; description: string; amountCents: number }>(sql`
    select t.posted_on as "postedOn", t.description, t.amount_cents as "amountCents"
    from transactions t
    where t.pending = true and t.ignored = false and t.posted_on <= ${to}
      ${accountIdsFilter(personal)}
    order by t.posted_on`)
  return rows.map((r) => ({ ...r, amountCents: Number(r.amountCents) }))
}

export async function dailyView(period: string) {
  const today = todayIso()
  const { start, end } = periodBounds(period)
  const isCurrent = today >= start && today <= end
  const scope = await accountScope()
  const personal = scope.personal

  // Em sequência pelo pooler das Edge Functions.
  const days = await personalDailySpend(start, end, personal)
  const spend = await monthSpendingVsCap(period)
  const balances = await accountBalances()
  const v2 = isCurrent ? await debtOverviewV2() : null

  const daysTotal = days.length
  const daysElapsed = isCurrent ? Number(today.slice(8, 10)) : today > end ? daysTotal : 0
  const remaining = Math.max(0, daysTotal - daysElapsed)
  const cap = spend.capCents
  const spentCents = spend.spentCents

  /* ---- próximos dias e saldo pessoal projetado (só no mês corrente) ---- */
  let upcoming: { days: UpcomingDay[]; startBalanceCents: number; nextIncome: { day: string; amountCents: number; label: string } | null; firstNegativeDay: string | null } | null = null
  let pendingRestOfMonthCents = 0
  if (isCurrent && v2) {
    const startBalanceCents = balances
      .filter((a) => a.kind !== 'investment' && personal.includes(Number(a.id)))
      .reduce((sum, a) => sum + Number(a.balanceCents), 0)
    const horizonMax = addDays(today, MAX_HORIZON_DAYS)
    const pending = await personalPending(horizonMax, personal)
    const nextIncomeRow = pending.find((p) => p.amountCents > 0 && p.postedOn >= today) ?? null
    const until = nextIncomeRow && nextIncomeRow.postedOn > addDays(today, UPCOMING_DAYS - 1) ? nextIncomeRow.postedOn : addDays(today, UPCOMING_DAYS - 1)

    const byDay = new Map<string, UpcomingItem[]>()
    const push = (day: string, item: UpcomingItem) => byDay.set(day, [...(byDay.get(day) ?? []), item])
    for (const p of pending) {
      const day = p.postedOn < today ? today : p.postedOn
      if (day > until) continue
      push(day, { kind: p.amountCents > 0 ? 'income' : 'expense', label: p.description, amountCents: p.amountCents, overdue: p.postedOn < today })
    }
    // Fatura aberta dos cartões pessoais no vencimento (a do cartão da PJ sai da empresa).
    for (const c of v2.cards) {
      if (c.accountId === scope.pjAccountId || c.openBillCents === null) continue
      const bill = c.byPeriod[v2.startPeriod] ?? 0
      if (bill > 0 && c.dueOn >= today && c.dueOn <= until) push(c.dueOn, { kind: 'card', label: `Fatura ${c.name}`, amountCents: -bill })
    }

    let balance = startBalanceCents
    let firstNegativeDay: string | null = null
    const out: UpcomingDay[] = []
    for (const day of dayRange(today, until)) {
      const items = byDay.get(day) ?? []
      const outCents = items.filter((i) => i.amountCents < 0).reduce((sum, i) => sum - i.amountCents, 0)
      const inCents = items.filter((i) => i.amountCents > 0).reduce((sum, i) => sum + i.amountCents, 0)
      balance += inCents - outCents
      if (balance < 0 && firstNegativeDay === null) firstNegativeDay = day
      out.push({ day, items, outCents, inCents, balanceCents: balance })
    }
    upcoming = {
      days: out,
      startBalanceCents,
      nextIncome: nextIncomeRow ? { day: nextIncomeRow.postedOn, amountCents: nextIncomeRow.amountCents, label: nextIncomeRow.description } : null,
      firstNegativeDay,
    }
    pendingRestOfMonthCents = pending
      .filter((p) => p.amountCents < 0 && p.postedOn <= end)
      .reduce((sum, p) => sum - p.amountCents, 0)
  }

  /*
   * Projeção do mês sem a distorção de um gasto único grande: realizado +
   * pendências conhecidas do mês + mediana do gasto por dia nos 90 dias
   * anteriores (dias sem gasto contam como zero) × dias que faltam. O aluguel
   * do dia 2 entra uma vez; poucos dias do mês não bastam para medir ritmo.
   */
  const rhythm = isCurrent ? await personalDailySpend(addDays(start, -90), addDays(start, -1), personal) : []
  const dailyMedianCents = medianCents(rhythm.map((d) => d.expenseCents))
  const projectedMonthCents = isCurrent ? spentCents + pendingRestOfMonthCents + dailyMedianCents * remaining : spentCents
  const state: 'no_target' | 'exceeded' | 'at_risk' | 'on_track' =
    cap === null ? 'no_target' : spentCents > cap ? 'exceeded' : projectedMonthCents > cap ? 'at_risk' : 'on_track'
  const paceCents = cap !== null && daysTotal > 0 ? Math.round(cap * (daysElapsed / daysTotal)) : null

  return {
    range: { from: start, to: end },
    period,
    days,
    pace: {
      daysElapsed,
      daysTotal,
      spentCents,
      capCents: cap,
      paceCents,
      aheadOfPaceCents: paceCents === null ? null : spentCents - paceCents,
      projectedMonthCents,
      pendingRestOfMonthCents,
      dailyMedianCents,
      /** o que sobra por dia até o teto, já tirando as pendências do mês */
      dailyAllowanceCents: cap !== null && remaining > 0 ? Math.max(0, Math.round((cap - spentCents - pendingRestOfMonthCents) / remaining)) : null,
      state,
    },
    upcoming,
    receivableCents: await receivable({ from: start, to: end }),
    streak: await dailyStreak(),
    assumptions: {
      gasto: 'gasto do mês nas contas pessoais, pelo Orçamento (sem as TAGs fora do orçamento)',
      teto: 'previsto dos grupos de gasto do plano do Orçamento (sem Metas e Liberdade Financeira)',
      projecao: 'realizado + pendências do mês nas contas pessoais + mediana do gasto por dia nos 90 dias anteriores × dias que faltam',
      proximosDias: 'pendências das contas pessoais (atrasadas entram hoje) e faturas abertas dos cartões pessoais no vencimento',
      saldoProjetado: 'saldo das contas pessoais hoje + entradas − saídas, dia a dia; a conta PJ e o cartão dela ficam fora',
    },
  }
}
