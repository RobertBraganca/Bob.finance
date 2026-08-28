import { sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { addMonths, dayRange, periodBounds, periodOf, periodRange } from '../core/dates.ts'

/**
 * Every number on every dashboard is produced here, by aggregating the
 * `transactions` table. There is no reporting table, no cached rollup, and
 * no duplicated transaction data anywhere in this file.
 *
 * FLOW CLASSIFICATION is the one piece of real domain logic:
 *
 *   income     money in, from a category of kind 'income'
 *   expense    money out, from a category of kind 'expense'
 *   transfer   moves between the user's own accounts, INCLUDING credit-card
 *              bill payments — excluded from both sides, because counting a
 *              card bill as spending double-counts every card purchase
 *   investment contributions and redemptions — excluded from expenses and
 *              counted as savings instead
 *
 * Uncategorized rows fall back to their sign, so spending is never
 * understated just because the user has not finished categorizing.
 */
// c.kind is the category_kind enum; cast to text so both CASE branches
// resolve to the same type (Postgres, unlike SQLite, won't implicitly
// coerce an enum column against a text literal in the other branch).
const FLOW_KIND = sql`
  case
    when c.kind is null then (case when t.amount_cents > 0 then 'income' else 'expense' end)
    else c.kind::text
  end`

export type Range = { from: string; to: string; accountId?: number | null }

const accountFilter = (accountId?: number | null) =>
  accountId ? sql`and t.account_id = ${accountId}` : sql``

/* ------------------------------------------------------------------ *
 * Headline numbers for a range, plus the same numbers for the
 * equivalent previous range so the UI can show a real delta.
 * ------------------------------------------------------------------ */
export type Totals = {
  incomeCents: number
  expenseCents: number
  netCents: number
  /** NET contributions: aportes minus resgates. See note in `totals`. */
  investedCents: number
  investedGrossCents: number
  redeemedCents: number
  transferCents: number
  savingsRateBps: number
  transactionCount: number
  uncategorizedCount: number
}

export async function totals(range: Range): Promise<Totals> {
  const rows = await db.execute<{
    income: number
    expense: number
    invested: number
    redeemed: number
    transfer: number
    count: number
    uncategorized: number
  }>(sql`
      select
        coalesce(sum(case when flow = 'income'     and amount_cents > 0 then amount_cents else 0 end), 0) as income,
        coalesce(sum(case when flow = 'expense'    and amount_cents < 0 then -amount_cents else 0 end), 0) as expense,
        coalesce(sum(case when flow = 'investment' and amount_cents < 0 then -amount_cents else 0 end), 0) as invested,
        coalesce(sum(case when flow = 'investment' and amount_cents > 0 then amount_cents else 0 end), 0) as redeemed,
        coalesce(sum(case when flow = 'transfer' then abs(amount_cents) else 0 end), 0) as transfer,
        count(*) as count,
        coalesce(sum(case when category_id is null then 1 else 0 end), 0) as uncategorized
      from (
        select t.amount_cents, t.category_id, ${FLOW_KIND} as flow
        from transactions t
        left join categories c on c.id = t.category_id
        where t.posted_on between ${range.from} and ${range.to}
          and t.pending = false
        ${accountFilter(range.accountId)}
      ) x
    `)
  const row = rows[0]

  const incomeCents = row?.income ?? 0
  const expenseCents = row?.expense ?? 0
  const netCents = incomeCents - expenseCents

  /**
   * Investing is reported NET, because Brazilian accounts sweep idle balance
   * in and out of an in-house product constantly: this ledger holds 176
   * "Aplicação RDB" against 429 "Resgate RDB". Summing only the outflows
   * reported R$ 87.722 invested when the money actually parked was R$ 12.475.
   * Both gross sides stay available so nothing is hidden.
   */
  const investedGrossCents = row?.invested ?? 0
  const redeemedCents = row?.redeemed ?? 0

  return {
    incomeCents,
    expenseCents,
    netCents,
    investedCents: investedGrossCents - redeemedCents,
    investedGrossCents,
    redeemedCents,
    transferCents: row?.transfer ?? 0,
    // Net already includes what was invested, since investment outflows are
    // not expenses — so net/income is "share of income not consumed".
    savingsRateBps: incomeCents > 0 ? Math.round((netCents / incomeCents) * 10_000) : 0,
    transactionCount: row?.count ?? 0,
    uncategorizedCount: row?.uncategorized ?? 0,
  }
}

export type ServiceAverages = {
  avgRevenuePerTransactionCents: number
  avgExpensePerTransactionCents: number
  revenueTransactionCount: number
  expenseTransactionCount: number
}

/**
 * "Preço médio de serviço" / "Custo médio de serviço" — deliberately NOT
 * scoped to whatever period the DRE is showing. A PJ account's per-service
 * price and per-expense cost are read as a stable baseline (what does a
 * typical invoice/expense look like, historically), so they average over
 * every posted transaction the account has ever had, ignoring `range`
 * entirely except for which account.
 */
export async function historicalServiceAverages(accountId: number): Promise<ServiceAverages> {
  const rows = await db.execute<{ income: number; expense: number; incomeCount: number; expenseCount: number }>(sql`
    select
      coalesce(sum(case when flow = 'income'  and amount_cents > 0 then amount_cents else 0 end), 0) as income,
      coalesce(sum(case when flow = 'expense' and amount_cents < 0 then -amount_cents else 0 end), 0) as expense,
      coalesce(sum(case when flow = 'income'  and amount_cents > 0 then 1 else 0 end), 0) as "incomeCount",
      coalesce(sum(case when flow = 'expense' and amount_cents < 0 then 1 else 0 end), 0) as "expenseCount"
    from (
      select t.amount_cents, ${FLOW_KIND} as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.pending = false and t.account_id = ${accountId}
    ) x
  `)
  const row = rows[0]

  const revenueTransactionCount = row?.incomeCount ?? 0
  const expenseTransactionCount = row?.expenseCount ?? 0

  return {
    avgRevenuePerTransactionCents: revenueTransactionCount > 0 ? Math.round((row?.income ?? 0) / revenueTransactionCount) : 0,
    avgExpensePerTransactionCents: expenseTransactionCount > 0 ? Math.round((row?.expense ?? 0) / expenseTransactionCount) : 0,
    revenueTransactionCount,
    expenseTransactionCount,
  }
}

/* ------------------------------------------------------------------ *
 * Income vs expense per month — the main dashboard chart.
 * Months with no data are filled with zeros so the axis has no gaps.
 * ------------------------------------------------------------------ */
export type MonthlyPoint = {
  period: string
  incomeCents: number
  expenseCents: number
  netCents: number
  investedCents: number
}

export async function monthlySeries(range: Range): Promise<MonthlyPoint[]> {
  const rows = await db.execute<{
    period: string
    income: number
    expense: number
    invested: number
  }>(sql`
    select
      period,
      coalesce(sum(case when flow = 'income'     and amount_cents > 0 then amount_cents else 0 end), 0) as income,
      coalesce(sum(case when flow = 'expense'    and amount_cents < 0 then -amount_cents else 0 end), 0) as expense,
      coalesce(sum(case when flow = 'investment' and amount_cents < 0 then -amount_cents else 0 end), 0) as invested
    from (
      select substr(t.posted_on, 1, 7) as period, t.amount_cents, ${FLOW_KIND} as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.posted_on between ${range.from} and ${range.to}
        and t.pending = false
      ${accountFilter(range.accountId)}
    ) x
    group by period
    order by period
  `)

  const byPeriod = new Map(rows.map((r) => [r.period, r] as const))
  return periodRange(periodOf(range.from), periodOf(range.to)).map((period) => {
    const row = byPeriod.get(period)
    const incomeCents = row?.income ?? 0
    const expenseCents = row?.expense ?? 0
    return {
      period,
      incomeCents,
      expenseCents,
      netCents: incomeCents - expenseCents,
      investedCents: row?.invested ?? 0,
    }
  })
}

/**
 * Same shape as `monthlySeries`, grouped by day instead of month — feeds
 * the dashboard's Entradas/Saídas chart when the selected period is short
 * enough that a bar per day is more useful than a single bar for the
 * whole month (the caller decides the cutoff; this just computes it).
 */
export async function dailyIncomeExpenseSeries(range: Range): Promise<MonthlyPoint[]> {
  const rows = await db.execute<{ day: string; income: number; expense: number; invested: number }>(sql`
    select
      day,
      coalesce(sum(case when flow = 'income'     and amount_cents > 0 then amount_cents else 0 end), 0) as income,
      coalesce(sum(case when flow = 'expense'    and amount_cents < 0 then -amount_cents else 0 end), 0) as expense,
      coalesce(sum(case when flow = 'investment' and amount_cents < 0 then -amount_cents else 0 end), 0) as invested
    from (
      select t.posted_on as day, t.amount_cents, ${FLOW_KIND} as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.posted_on between ${range.from} and ${range.to}
        and t.pending = false
      ${accountFilter(range.accountId)}
    ) x
    group by day
    order by day
  `)

  const byDay = new Map(rows.map((r) => [r.day, r] as const))
  return dayRange(range.from, range.to).map((day) => {
    const row = byDay.get(day)
    const incomeCents = row?.income ?? 0
    const expenseCents = row?.expense ?? 0
    return {
      period: day,
      incomeCents,
      expenseCents,
      netCents: incomeCents - expenseCents,
      investedCents: row?.invested ?? 0,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Category breakdown. Grouped at the PARENT level by default, because
 * a ring chart stops being readable past a handful of segments; the
 * caller asks for leaf level when it wants the full ranked list.
 * ------------------------------------------------------------------ */
export type BreakdownSlice = {
  categoryId: number | null
  /** null at `level: 'parent'` (the row already IS the parent); at `level: 'leaf'`, the parent to fold this row under — same id as `categoryId` itself when a transaction is tagged directly on a parent category, with no child */
  parentCategoryId: number | null
  name: string
  color: string
  amountCents: number
  transactionCount: number
  shareBps: number
}

export async function categoryBreakdown(
  range: Range,
  options: { flow?: 'expense' | 'income' | 'investment'; level?: 'parent' | 'leaf' } = {},
): Promise<BreakdownSlice[]> {
  const flow = options.flow ?? 'expense'
  const level = options.level ?? 'parent'
  const sign = flow === 'income' ? sql`amount_cents > 0` : sql`amount_cents < 0`

  const groupId = level === 'parent' ? sql`coalesce(c.parent_id, c.id)` : sql`c.id`

  const rows = await db.execute<{
    categoryId: number | null
    parentCategoryId: number | null
    name: string | null
    color: string | null
    amount: number
    count: number
  }>(sql`
    select
      g.id as "categoryId",
      g.parent_id as "parentCategoryId",
      g.name as name,
      g.color as color,
      coalesce(sum(abs(x.amount_cents)), 0) as amount,
      count(*) as count
    from (
      select t.amount_cents, ${groupId} as group_id, ${FLOW_KIND} as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.posted_on between ${range.from} and ${range.to}
        and t.pending = false
      ${accountFilter(range.accountId)}
    ) x
    left join categories g on g.id = x.group_id
    where x.flow = ${flow} and ${sign}
    group by x.group_id, g.id, g.parent_id, g.name, g.color
    order by amount desc
  `)

  const total = rows.reduce((sum, r) => sum + r.amount, 0)
  return rows.map((r) => ({
    categoryId: r.categoryId,
    parentCategoryId: r.parentCategoryId,
    name: r.name ?? 'Sem categoria',
    color: r.color ?? '#71717a',
    amountCents: r.amount,
    transactionCount: r.count,
    shareBps: total > 0 ? Math.round((r.amount / total) * 10_000) : 0,
  }))
}

/* ------------------------------------------------------------------ *
 * Daily spend — feeds the calendar heatmap and the pace comparison.
 * ------------------------------------------------------------------ */
export type DailyPoint = { day: string; expenseCents: number; transactionCount: number }

export async function dailySeries(range: Range): Promise<DailyPoint[]> {
  const rows = await db.execute<{ day: string; expense: number; count: number }>(sql`
    select
      day,
      coalesce(sum(case when flow = 'expense' and amount_cents < 0 then -amount_cents else 0 end), 0) as expense,
      coalesce(sum(case when flow = 'expense' and amount_cents < 0 then 1 else 0 end), 0) as count
    from (
      select t.posted_on as day, t.amount_cents, ${FLOW_KIND} as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.posted_on between ${range.from} and ${range.to}
        and t.pending = false
      ${accountFilter(range.accountId)}
    ) x
    group by day
    order by day
  `)

  const byDay = new Map(rows.map((r) => [r.day, r] as const))
  return dayRange(range.from, range.to).map((day) => ({
    day,
    expenseCents: byDay.get(day)?.expense ?? 0,
    transactionCount: byDay.get(day)?.count ?? 0,
  }))
}

/* ------------------------------------------------------------------ *
 * Balance trajectory — running net position over the range.
 * ------------------------------------------------------------------ */
export async function netFlowSeries(range: Range) {
  const months = await monthlySeries(range)
  let running = 0
  return months.map((m) => {
    running += m.netCents
    return { period: m.period, netCents: m.netCents, cumulativeCents: running }
  })
}

/**
 * "A receber": receita ainda pendente (não confirmada pelo banco/pix) com
 * vencimento dentro do período — o lado complementar de `totals()`, que
 * sempre exclui `pending`. Mesma classificação de fluxo (kind da categoria,
 * caindo para o sinal quando sem categoria) e mesmo filtro de conta.
 */
export async function receivable(range: Range): Promise<number> {
  const rows = await db.execute<{ amount: number }>(sql`
    select coalesce(sum(case when flow = 'income' and amount_cents > 0 then amount_cents else 0 end), 0) as amount
    from (
      select t.amount_cents, ${FLOW_KIND} as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.posted_on between ${range.from} and ${range.to}
        and t.pending = true
        ${accountFilter(range.accountId)}
    ) x
  `)
  return rows[0]?.amount ?? 0
}

/* ------------------------------------------------------------------ *
 * Everything the dashboard needs, in one round trip.
 * ------------------------------------------------------------------ */
export async function dashboard(range: Range) {
  const current = await totals(range)

  // The comparable previous window: same number of months, immediately before.
  const months = periodRange(periodOf(range.from), periodOf(range.to)).length
  const previousRange: Range = {
    from: periodBounds(addMonths(periodOf(range.from), -months)).start,
    to: periodBounds(addMonths(periodOf(range.to), -months)).end,
    accountId: range.accountId ?? null,
  }
  const [previous, currentReceivableCents, previousReceivableCents, monthly, byCategory, byCategoryLeaf, incomeByCategory, incomeByCategoryLeaf, netFlow, topMerchantsList] =
    await Promise.all([
      totals(previousRange),
      receivable(range),
      receivable(previousRange),
      monthlySeries(range),
      categoryBreakdown(range, { flow: 'expense', level: 'parent' }),
      categoryBreakdown(range, { flow: 'expense', level: 'leaf' }),
      categoryBreakdown(range, { flow: 'income', level: 'parent' }),
      categoryBreakdown(range, { flow: 'income', level: 'leaf' }),
      netFlowSeries(range),
      topMerchants(range, 8),
    ])

  // A bar per day only makes sense for a short window — for anything
  // longer than a month of days, the chart falls back to `monthly` on
  // the client, so there is no reason to compute this at all.
  const daily = dayRange(range.from, range.to).length <= 31 ? await dailyIncomeExpenseSeries(range) : []

  return {
    range,
    totals: { ...current, receivableCents: currentReceivableCents },
    previous,
    deltas: {
      incomeBps: deltaBps(current.incomeCents, previous.incomeCents),
      expenseBps: deltaBps(current.expenseCents, previous.expenseCents),
      netBps: deltaBps(current.netCents, previous.netCents),
      receivableBps: deltaBps(currentReceivableCents, previousReceivableCents),
    },
    monthly,
    daily,
    byCategory,
    byCategoryLeaf,
    incomeByCategory,
    incomeByCategoryLeaf,
    netFlow,
    topMerchants: topMerchantsList,
  }
}

/** Signed relative change in basis points; null when there is no base. */
export function deltaBps(current: number, previous: number): number | null {
  if (previous === 0) return null
  return Math.round(((current - previous) / Math.abs(previous)) * 10_000)
}

export async function topMerchants(range: Range, limit = 8) {
  return db.execute<{ signature: string; amount: number; count: number }>(sql`
    select
      min(description) as signature,
      coalesce(sum(-amount_cents), 0) as amount,
      count(*) as count
    from (
      select t.description, t.amount_cents, ${FLOW_KIND} as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.posted_on between ${range.from} and ${range.to}
        and t.pending = false
      ${accountFilter(range.accountId)}
    ) x
    where flow = 'expense' and amount_cents < 0
    group by lower(description)
    order by amount desc
    limit ${limit}
  `)
}

/* ------------------------------------------------------------------ *
 * Account balances, derived from the opening balance plus every
 * transaction — never stored, so it can never drift.
 * ------------------------------------------------------------------ */
export async function accountBalances() {
  return db.execute<{
    id: number
    name: string
    institution: string
    kind: string
    balanceCents: number
    transactionCount: number
    lastPostedOn: string | null
  }>(sql`
    select
      a.id,
      a.name,
      a.institution,
      a.kind,
      a.opening_balance_cents + coalesce(sum(case when t.pending = false then t.amount_cents else 0 end), 0) as "balanceCents",
      count(case when t.pending = false then t.id else null end) as "transactionCount",
      max(case when t.pending = false then t.posted_on else null end) as "lastPostedOn"
    from accounts a
    left join transactions t on t.account_id = a.id
    where a.archived = false
    group by a.id
    order by a.name
  `)
}
