import { sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { addDays, addMonths, dayRange, periodBounds, periodOf, periodRange, todayIso } from '../core/dates.ts'

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

/**
 * Dias seguidos com lançamento registrado no Diário — puramente derivado
 * (dias distintos de `transactions.source = 'daily'`, nenhuma tabela nova,
 * estudo de viabilidade #1 de 29/08/2026). Hoje ainda "conta" mesmo sem
 * lançamento — a sequência só quebra de fato à meia-noite, senão o
 * contador cairia pra zero toda manhã antes do usuário abrir o app.
 */
export async function dailyStreak(): Promise<{ days: number; lastEntryOn: string | null }> {
  const rows = await db.execute<{ day: string }>(sql`
    select distinct posted_on as day
    from transactions
    where source = 'daily'
    order by day desc
    limit 400
  `)
  const days = new Set(rows.map((r) => r.day))
  const today = todayIso()

  let cursor = today
  if (!days.has(cursor)) cursor = addDays(cursor, -1)

  let streak = 0
  while (days.has(cursor)) {
    streak++
    cursor = addDays(cursor, -1)
  }

  return { days: streak, lastEntryOn: rows[0]?.day ?? null }
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
 *
 * `includeFuture` (decisions/0030): "Período máximo" no seletor principal
 * é deliberadamente olhando só pra trás (`range.to` nunca passa de hoje —
 * ver o comentário do próprio `anchor` em `store.tsx`), então mesmo com o
 * horizonte de materialização de decisions/0028 em 24 meses, nenhum
 * preset normal via jeito de somar uma pendência com vencimento no
 * futuro. Só quando o próprio "Máximo" pede explicitamente é que o limite
 * superior de data cai — "máximo" deveria significar tudo o que ainda
 * falta receber, não só o que já venceu.
 */
export async function receivable(range: Range, opts: { includeFuture?: boolean } = {}): Promise<number> {
  const upperBound = opts.includeFuture ? sql`` : sql`and t.posted_on <= ${range.to}`
  const rows = await db.execute<{ amount: number }>(sql`
    select coalesce(sum(case when flow = 'income' and amount_cents > 0 then amount_cents else 0 end), 0) as amount
    from (
      select t.amount_cents, ${FLOW_KIND} as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.posted_on >= ${range.from}
        ${upperBound}
        and t.pending = true
        ${accountFilter(range.accountId)}
    ) x
  `)
  return rows[0]?.amount ?? 0
}

/* ------------------------------------------------------------------ *
 * Everything the dashboard needs, in one round trip.
 * ------------------------------------------------------------------ */
export async function dashboard(range: Range, opts: { includeFutureReceivables?: boolean } = {}) {
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
      receivable(range, { includeFuture: opts.includeFutureReceivables }),
      // O período anterior nunca olha pra frente, mesmo com includeFuture —
      // é só a base de comparação, e "quanto tinha a receber no futuro no
      // período anterior" não tem leitura útil nenhuma.
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
      // Comparar "tudo que ainda falta receber, sem limite de data" contra
      // o período anterior (que nunca olha pra frente) não tem leitura
      // útil — a diferença seria só o efeito de somar mais meses futuros,
      // não uma mudança real de comportamento.
      receivableBps: opts.includeFutureReceivables ? null : deltaBps(currentReceivableCents, previousReceivableCents),
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
/**
 * `asOfDate` opcional reconstitui o saldo como ele estava naquela data
 * (lançamentos depois dela não contam) — omitido, comportamento idêntico a
 * antes. Mesmo motivo de `investments.positions(asOfDate)`: série
 * histórica de patrimônio líquido, nunca uma segunda função paralela.
 */
export async function accountBalances(asOfDate?: string) {
  const cutoff = asOfDate ? sql`and t.posted_on <= ${asOfDate}` : sql``
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
    left join transactions t on t.account_id = a.id ${cutoff}
    where a.archived = false
    group by a.id
    order by a.name
  `)
}

/* ------------------------------------------------------------------ *
 * Projecao de fluxo de caixa — a unica serie do app que olha para
 * frente.
 * ------------------------------------------------------------------ */

export type ProjectionPoint = {
  period: string
  /** true quando o mes e anterior ou igual ao corrente */
  isPast: boolean
  /** `pending = false`: dinheiro que entrou e saiu de verdade */
  realizedIncomeCents: number
  realizedExpenseCents: number
  realizedInvestedCents: number
  /** `pending = true`: ocorrencia materializada e ainda nao confirmada */
  pendingIncomeCents: number
  pendingExpenseCents: number
  pendingInvestedCents: number
  /**
   * Entradas menos saidas menos aportes, realizado + pendente. Existe
   * para a linha de saldo; o grafico desenha as faixas separadas.
   */
  netCents: number
  /** saldo acumulado ao FIM deste mes, ancorado no saldo real de hoje */
  runningBalanceCents: number
}

export type CashFlowProjection = {
  points: ProjectionPoint[]
  /** o mes corrente, para o grafico marcar onde o passado termina */
  currentPeriod: string
  openingBalanceCents: number
  assumptions: Record<string, unknown>
}

/**
 * Realizado para tras, materializado para frente, na MESMA serie.
 *
 * Toda outra serie do app filtra `pending = false` (decisions/0003, para
 * que uma pendencia nunca contamine um total realizado). O efeito
 * colateral e que os 24 meses de pendencias que
 * `MATERIALIZE_HORIZON_MONTHS` cria (decisions/0028) ficavam invisiveis a
 * qualquer grafico: `receivable()` era a unica leitura para frente, e
 * devolve um escalar. Um sistema de previsibilidade sem serie futura foi
 * o que o usuario apontou em 02/09/2026.
 *
 * As duas faixas NUNCA sao somadas num numero so na saida. Um mes futuro
 * tem `realized*` em zero e `pending*` com valor; um mes passado tende ao
 * inverso, mas pode ter pendencia ATRASADA (vencida e nao confirmada), e
 * e esse caso que nao pode virar numero unico: "R$ 8.000 em setembro"
 * esconderia se o dinheiro entrou.
 *
 * Mesma classificacao de fluxo das outras series: `transfer` e pagamento
 * de fatura ficam fora dos dois lados, para o mesmo gasto nao contar duas
 * vezes, e `investment` e via propria, nao despesa. A consequencia disso
 * esta declarada em `assumptions`: com filtro de conta, a linha de saldo
 * ignora transferencia entre contas proprias.
 *
 * Isto e PROJECAO, nao simulacao (decisions/0010): entra so o que esta
 * cadastrado, nada e extrapolado de tendencia. Extrapolar e o simulador.
 */
export async function cashFlowProjection(opts: {
  monthsBack?: number
  monthsAhead?: number
  accountId?: number | null
}): Promise<CashFlowProjection> {
  const monthsBack = Math.min(Math.max(opts.monthsBack ?? 12, 0), 60)
  const monthsAhead = Math.min(Math.max(opts.monthsAhead ?? 12, 0), 60)
  const accountId = opts.accountId ?? null

  const current = todayIso().slice(0, 7)
  const firstPeriod = addMonths(current, -monthsBack)
  const lastPeriod = addMonths(current, monthsAhead)
  const { start: from } = periodBounds(firstPeriod)
  const { end: to } = periodBounds(lastPeriod)

  const rows = await db.execute<{
    period: string
    realized_income: number
    realized_expense: number
    realized_invested: number
    pending_income: number
    pending_expense: number
    pending_invested: number
  }>(sql`
    select
      period,
      coalesce(sum(case when not pending and flow = 'income'     and amount_cents > 0 then  amount_cents else 0 end), 0) as realized_income,
      coalesce(sum(case when not pending and flow = 'expense'    and amount_cents < 0 then -amount_cents else 0 end), 0) as realized_expense,
      coalesce(sum(case when not pending and flow = 'investment' and amount_cents < 0 then -amount_cents else 0 end), 0) as realized_invested,
      coalesce(sum(case when     pending and flow = 'income'     and amount_cents > 0 then  amount_cents else 0 end), 0) as pending_income,
      coalesce(sum(case when     pending and flow = 'expense'    and amount_cents < 0 then -amount_cents else 0 end), 0) as pending_expense,
      coalesce(sum(case when     pending and flow = 'investment' and amount_cents < 0 then -amount_cents else 0 end), 0) as pending_invested
    from (
      select substr(t.posted_on, 1, 7) as period, t.amount_cents, t.pending, ${FLOW_KIND} as flow
      from transactions t
      left join categories c on c.id = t.category_id
      where t.posted_on between ${from} and ${to}
      ${accountFilter(accountId)}
    ) x
    group by period
    order by period
  `)

  // Saldo confirmado ao FIM de cada mes da janela, direto do banco.
  //
  // A primeira versao disto reconstruia o passado para tras a partir do
  // saldo de hoje, descontando o net de cada mes. Estava errado: o net
  // exclui transferencia entre contas proprias (como toda serie do app),
  // entao a reconstrucao errava por exatamente o volume transferido, e
  // rodando contra o banco real ela mostrava saldo NEGATIVO em marco de
  // 2026 — um numero que o usuario leria como "estive no vermelho" sem ter
  // estado. O saldo real e um fato consultavel; nao ha por que inferi-lo
  // (02/09/2026).
  const saldoRows = await db.execute<{ period: string; balance: number }>(sql`
    with meses as (
      select generate_series(
        date_trunc('month', ${from}::date),
        date_trunc('month', ${to}::date),
        interval '1 month'
      ) as mes
    )
    select
      to_char(m.mes, 'YYYY-MM') as period,
      coalesce(sum(a.opening_balance_cents), 0)
        + coalesce((
          select sum(t.amount_cents)
          from transactions t
          where t.pending = false
            and t.posted_on <= to_char((m.mes + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD')
            and t.account_id in (select id from accounts where archived = false
              ${(accountId ? sql`and id = ${accountId}` : sql``)})
        ), 0) as balance
    from meses m
    cross join (select opening_balance_cents from accounts where archived = false
      ${(accountId ? sql`and id = ${accountId}` : sql``)}) a
    group by m.mes
    order by m.mes
  `)
  const saldoPorPeriodo = new Map(saldoRows.map((r) => [r.period, Number(r.balance)] as const))

  const balances = await accountBalances()
  const scoped = balances.filter((a) => accountId === null || a.id === accountId)
  const balanceNow = scoped.reduce((sum, a) => sum + a.balanceCents, 0)

  const byPeriod = new Map(rows.map((r) => [r.period, r] as const))

  const base = periodRange(firstPeriod, lastPeriod).map((period) => {
    const row = byPeriod.get(period)
    const realizedIncomeCents = row?.realized_income ?? 0
    const realizedExpenseCents = row?.realized_expense ?? 0
    const realizedInvestedCents = row?.realized_invested ?? 0
    const pendingIncomeCents = row?.pending_income ?? 0
    const pendingExpenseCents = row?.pending_expense ?? 0
    const pendingInvestedCents = row?.pending_invested ?? 0
    return {
      period,
      isPast: period <= current,
      realizedIncomeCents,
      realizedExpenseCents,
      realizedInvestedCents,
      pendingIncomeCents,
      pendingExpenseCents,
      pendingInvestedCents,
      netCents:
        realizedIncomeCents -
        realizedExpenseCents -
        realizedInvestedCents +
        pendingIncomeCents -
        pendingExpenseCents -
        pendingInvestedCents,
    }
  })

  /**
   * Passado CONSULTADO, futuro ACUMULADO, e o mes corrente e a dobra.
   *
   * Cada mes passado usa o saldo confirmado que o banco devolveu. Do mes
   * corrente para frente nao existe saldo a consultar, entao a linha
   * acumula: parte do saldo de hoje e soma o net de cada mes seguinte.
   * O mes corrente recebe o saldo de hoje, nao o do fim do mes — ele
   * ainda nao aconteceu, e a pendencia dele ja esta na faixa pendente.
   */
  const currentIndex = base.findIndex((p) => p.period === current)
  const running = new Array<number>(base.length).fill(balanceNow)
  for (let i = 0; i < base.length; i++) {
    const p = base[i]!
    if (p.period < current) {
      running[i] = saldoPorPeriodo.get(p.period) ?? balanceNow
    } else if (p.period === current) {
      running[i] = balanceNow
    } else {
      running[i] = running[i - 1]! + p.netCents
    }
  }
  void currentIndex

  const points: ProjectionPoint[] = base.map((p, i) => ({ ...p, runningBalanceCents: running[i]! }))
  const atrasadas = points.filter(
    (p) => p.isPast && (p.pendingIncomeCents > 0 || p.pendingExpenseCents > 0),
  )
  const futurosComDado = points.filter(
    (p) => !p.isPast && (p.pendingIncomeCents > 0 || p.pendingExpenseCents > 0),
  )
  const negativo = points.find((p) => !p.isPast && p.runningBalanceCents < 0)

  return {
    points,
    currentPeriod: current,
    openingBalanceCents: balanceNow,
    assumptions: {
      formula:
        'por mes, realizado (pending = false) e pendente (pending = true) somados em faixas separadas. A linha de saldo tem duas metades: mes passado usa o saldo CONFIRMADO consultado no banco, e do mes corrente para frente acumula o saldo de hoje mais o net de cada mes',
      janela: `${monthsBack} meses para tras e ${monthsAhead} para frente (${firstPeriod} a ${lastPeriod})`,
      saldoDeHojeCents: balanceNow,
      contasSomadas: scoped.length,
      mesesFuturosComPendencia: futurosComDado.length,
      mesesFuturosVazios: monthsAhead - futurosComDado.length,
      mesesPassadosComPendencia: atrasadas.length,
      notaSobreAtraso:
        atrasadas.length > 0
          ? 'ha pendencia com vencimento JA PASSADO e ainda nao confirmada; ela aparece na faixa pendente do proprio mes de vencimento, nunca deslocada para o mes atual'
          : 'nenhuma pendencia vencida e nao confirmada',
      primeiroMesNegativo: negativo?.period ?? null,
      classificacao:
        'mesma das outras series: transferencia entre contas proprias e pagamento de fatura ficam fora dos dois lados, e aporte e via propria, nao despesa',
      ressalvaDeConta:
        accountId === null
          ? 'visao consolidada: transferencia entre contas proprias se anula, entao a linha de saldo fecha'
          : 'com filtro de conta, a linha de saldo ignora transferencia entre contas proprias, que MOVE o saldo desta conta. O numero consolidado e o confiavel',
      origem:
        'linhas reais de transactions; as futuras foram materializadas de cash_flow_forecasts (decisions/0028), nao estimadas aqui',
      escopo:
        'PROJECAO, nao simulacao: entra somente o que esta cadastrado como recorrencia, parcela ou lancamento futuro. Nada e extrapolado de tendencia historica (decisions/0010)',
      limite:
        'o horizonte util termina onde a materializacao termina; alem dela um mes aparece vazio por falta de dado, nao por previsao de que nada aconteca',
    },
  }
}
