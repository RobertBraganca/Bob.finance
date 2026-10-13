import { sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { addDays, dayRange, periodBounds, todayIso } from '../core/dates.ts'
import { medianCents } from '../core/money.ts'
import { accountBalances, dailySeries, dailyStreak, receivable } from './analytics.ts'
import { budgetDailySpend, monthSpendingVsCap } from './budget.ts'
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

/** Gasto das contas pessoais por dia: a MESMA série da Visão geral (`analytics.dailySeries`), para o mesmo dia dar o mesmo número. */
const personalDailySpend = (from: string, to: string, personal: number[]) => dailySeries({ from, to, accountIds: personal })

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

export type SpendProjection = {
  daysElapsed: number
  daysTotal: number
  spentCents: number
  capCents: number | null
  pendingRestOfMonthCents: number
  dailyMedianCents: number
  projectedMonthCents: number
  state: 'no_target' | 'exceeded' | 'at_risk' | 'on_track'
}

/**
 * Gasto do mês contra o teto do Orçamento, com a projeção sem a distorção de
 * um gasto único grande: realizado + pendências conhecidas do mês + mediana
 * do gasto por dia nos 90 dias anteriores (dias sem gasto contam como zero)
 * × dias que faltam. Usada pelo Diário e pelos avisos do sino (uma régua só).
 */
export async function spendProjection(
  period: string,
  /** gasto e teto do mês já lidos por quem chama (evita recarregar o Orçamento) */
  knownSpend?: { spentCents: number; capCents: number | null; pendingCents: number },
): Promise<SpendProjection> {
  const today = todayIso()
  const { start, end } = periodBounds(period)
  const isCurrent = today >= start && today <= end
  const spend = knownSpend ?? (await monthSpendingVsCap(period))
  const daysTotal = dayRange(start, end).length
  const daysElapsed = isCurrent ? Number(today.slice(8, 10)) : today > end ? daysTotal : 0
  const remaining = Math.max(0, daysTotal - daysElapsed)

  let pendingRestOfMonthCents = 0
  let dailyMedianCents = 0
  if (isCurrent) {
    // O que ainda vai sair vem do Orçamento (mesma base do gasto e do teto): sem transferência,
    // investimento nem TAG fora do orçamento, e com as parcelas pagas no cartão.
    pendingRestOfMonthCents = spend.pendingCents
    // O ritmo vem da base do Orçamento (a mesma do teto), não da série do mapa de calor.
    dailyMedianCents = medianCents(await budgetDailySpend(addDays(start, -90), addDays(start, -1)))
  }
  const spentCents = spend.spentCents
  const cap = spend.capCents
  const projectedMonthCents = isCurrent ? spentCents + pendingRestOfMonthCents + dailyMedianCents * remaining : spentCents
  const state: SpendProjection['state'] =
    cap === null ? 'no_target' : spentCents > cap ? 'exceeded' : projectedMonthCents > cap ? 'at_risk' : 'on_track'
  return { daysElapsed, daysTotal, spentCents, capCents: cap, pendingRestOfMonthCents, dailyMedianCents, projectedMonthCents, state }
}

export async function dailyView(period: string) {
  const today = todayIso()
  const { start, end } = periodBounds(period)
  const isCurrent = today >= start && today <= end
  const scope = await accountScope()
  const personal = scope.personal

  // Em sequência pelo pooler das Edge Functions.
  const days = await personalDailySpend(start, end, personal)
  const projection = await spendProjection(period)
  const balances = await accountBalances()
  const v2 = isCurrent ? await debtOverviewV2() : null

  const { daysTotal, daysElapsed, spentCents, capCents: cap, pendingRestOfMonthCents, dailyMedianCents, projectedMonthCents, state } = projection
  const remaining = Math.max(0, daysTotal - daysElapsed)

  /* ---- próximos dias e saldo pessoal projetado (só no mês corrente) ---- */
  let upcoming: { days: UpcomingDay[]; startBalanceCents: number; nextIncome: { day: string; amountCents: number; label: string } | null; firstNegativeDay: string | null } | null = null
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
  }

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
