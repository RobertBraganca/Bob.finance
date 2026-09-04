import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { accounts, debtPayments, debtSnapshots, debts, skippedOccurrences, transactions } from '../db/schema'
import { addMonths, daysInMonth, periodBounds, todayIso } from '../core/dates'
import { dedupeHash, directionOf, normalizeDescription } from '../core/normalize'
import { totals } from './analytics'

/**
 * Debt is modelled as a set of balances with rates, plus an optional history
 * of measured balances. Projections are computed, never stored, so changing a
 * rate or a payment immediately changes every chart.
 */

const MAX_MONTHS = 600 // 50 years — the guard against a never-amortizing loan

type DebtKind = (typeof debts.$inferSelect)['kind']
type DebtPaymentKind = (typeof debtPayments.$inferSelect)['kind']

export type DebtRow = {
  id: number
  name: string
  kind: string
  institution: string | null
  accountId: number | null
  accountName: string | null
  balanceCents: number
  aprBps: number
  minimumPaymentCents: number
  scheduledPaymentCents: number
  dueDay: number
  /** interest accruing this month at the current balance */
  monthlyInterestCents: number
  shareBps: number
  /** total parcelas in the contract — null for revolving debt that has none */
  installmentCount: number | null
  /** parcelas already logged in `debt_payments` (kind = 'payment') */
  installmentsPaid: number
  /** installmentCount - installmentsPaid — null whenever installmentCount is null */
  installmentsRemaining: number | null
  lastPaymentOn: string | null
}

/** Latest measured balance if there is one, otherwise the opening principal. */
async function currentBalance(debt: typeof debts.$inferSelect): Promise<number> {
  const snapshot = (
    await db
      .select()
      .from(debtSnapshots)
      .where(eq(debtSnapshots.debtId, debt.id))
      .orderBy(desc(debtSnapshots.asOf))
      .limit(1)
  )[0]
  return snapshot?.balanceCents ?? debt.principalCents
}

/** Parcelas pagas + the most recent payment date, from the payment ledger. */
export async function paymentStats(debtId: number): Promise<{ count: number; lastPaidOn: string | null }> {
  const rows = await db.execute<{ count: number; lastPaidOn: string | null }>(sql`
    select count(*) as count, max(paid_on) as "lastPaidOn"
    from debt_payments
    where debt_id = ${debtId} and kind = 'payment'
  `)
  const row = rows[0]
  return { count: row?.count ?? 0, lastPaidOn: row?.lastPaidOn ?? null }
}

export async function listDebts(): Promise<DebtRow[]> {
  const rows = await db
    .select({ debt: debts, accountName: accounts.name })
    .from(debts)
    .leftJoin(accounts, eq(accounts.id, debts.accountId))
    .where(eq(debts.active, true))
  const withBalance = await Promise.all(
    rows.map(async ({ debt: d, accountName }) => {
      const balanceCents = await currentBalance(d)
      const { count: installmentsPaid, lastPaidOn } = await paymentStats(d.id)
      return {
        id: d.id,
        name: d.name,
        kind: d.kind,
        institution: d.institution,
        accountId: d.accountId,
        accountName: accountName ?? null,
        balanceCents,
        aprBps: d.aprBps,
        minimumPaymentCents: d.minimumPaymentCents,
        scheduledPaymentCents: d.scheduledPaymentCents || d.minimumPaymentCents,
        dueDay: d.dueDay,
        monthlyInterestCents: Math.round(balanceCents * monthlyRate(d.aprBps)),
        shareBps: 0,
        installmentCount: d.installmentCount,
        installmentsPaid,
        installmentsRemaining: d.installmentCount === null ? null : Math.max(0, d.installmentCount - installmentsPaid),
        lastPaymentOn: lastPaidOn,
      }
    }),
  )
  const total = withBalance.reduce((sum, d) => sum + d.balanceCents, 0)
  return withBalance
    .map((d) => ({ ...d, shareBps: total > 0 ? Math.round((d.balanceCents / total) * 10_000) : 0 }))
    .sort((a, b) => b.balanceCents - a.balanceCents)
}

export type ClosedDebtRow = {
  id: number
  name: string
  kind: string
  installmentCount: number | null
  closedOn: string | null
  totalPaidCents: number
  lastPaymentOn: string | null
}

/**
 * Dividas com active=false — a secao "Quitadas" que closeDebtIfFullyPaid
 * agora alimenta (e que o fechamento manual via deletePending scope='all'
 * ja alimentava, sem nenhum lugar na UI para mostra-lo). Antes desta
 * correcao (bug 2, 03/09/2026) nao havia nenhuma leitura de active=false
 * em lugar nenhum do app — uma divida fechada simplesmente desaparecia,
 * sem virar historico visivel em canto nenhum.
 */
export async function listClosedDebts(): Promise<ClosedDebtRow[]> {
  const rows = await db.select().from(debts).where(eq(debts.active, false))
  return Promise.all(
    rows.map(async (d) => {
      const stats = await db.execute<{ total: number; lastPaidOn: string | null }>(sql`
        select coalesce(sum(amount_cents), 0) as total, max(paid_on) as "lastPaidOn"
        from debt_payments where debt_id = ${d.id} and kind = 'payment'`)
      return {
        id: d.id,
        name: d.name,
        kind: d.kind,
        installmentCount: d.installmentCount,
        closedOn: d.closedOn,
        totalPaidCents: stats[0]?.total ?? 0,
        lastPaymentOn: stats[0]?.lastPaidOn ?? null,
      }
    }),
  )
}

/**
 * Materializes the debt's remaining parcelas as pending EXPENSE rows in
 * `transactions` — same mechanism cashFlow.ts uses for recurring/
 * installment income, so a debt's upcoming payments show up in
 * "Despesas pendentes" and in Lançamentos (editable, with a "previsto"
 * badge) without a separate UI. A revolving debt (no installmentCount —
 * cartão, cheque especial) materializes indefinitely within the same
 * horizon, mirroring a "recorrente" forecast; an installment debt only
 * generates periods `installmentsPaid..installmentCount-1` — exactly
 * cashFlow.ts's own `pendingOccurrences` shape for its 'installment'
 * kind, just counting from the debt_payments ledger instead of a
 * `installmentsRealized` column.
 */
// decisions/0028 raised this to 24 for cashFlow.ts's forecasts; this file
// was left at the old value (achado da revisão de 29/08/2026) — a debt
// installment/revolving charge should have the same rolling window as a
// recurring forecast, not a shorter one just because nobody updated it here.
const MATERIALIZE_HORIZON_MONTHS = 24

export async function materializeDebtInstallments(debtId: number): Promise<{ created: number }> {
  const debt = (await db.select().from(debts).where(eq(debts.id, debtId)))[0]
  if (!debt || !debt.accountId || !debt.active) return { created: 0 }

  const amountCents = debt.scheduledPaymentCents || debt.minimumPaymentCents
  if (amountCents <= 0) return { created: 0 }

  const { count: installmentsPaid } = await paymentStats(debtId)
  const currentPeriod = todayIso().slice(0, 7)
  const horizon = addMonths(currentPeriod, MATERIALIZE_HORIZON_MONTHS - 1)

  const existingRows = await db
    .select({ occurrencePeriod: transactions.occurrencePeriod, postedOn: transactions.postedOn })
    .from(transactions)
    .where(eq(transactions.debtId, debtId))
  const existingPeriods = new Set(existingRows.map((r) => r.occurrencePeriod ?? r.postedOn.slice(0, 7)))

  /**
   * Ancora da parcela 0, NAO "hoje" -- bug corrigido em 03/09/2026
   * (achado: toda divida parcelada ativa e nao paga tinha uma pendencia a
   * mais do que installmentCount, sempre no mes corrente).
   *
   * Antes, o laco abaixo recomputava o periodo de cada parcela como
   * addMonths(currentPeriod, i - installmentsPaid) -- ou seja, a parcela
   * "proxima a pagar" era sempre remapeada para o MES EM QUE A FUNCAO
   * RODA. Como materializeAllDebts() roda a cada carregamento do widget
   * de pendentes da Home (GET /cash-flow/pending), uma divida com 1
   * parcela criada em agosto e ainda nao paga ganhava uma SEGUNDA
   * pendencia em setembro na primeira visita a Home depois da virada do
   * mes -- sem nenhuma acao do usuario, e sem que a de agosto (ainda
   * pendente, agora isOverdue) fosse removida. Uma divida de N parcelas
   * acumulava uma pendencia extra a cada mes que passasse sem pagamento.
   *
   * A ancora certa e o periodo em que a parcela 0 ja foi (ou seria)
   * materializada, que e FIXO por contrato -- nunca muda com o relogio.
   * existingRows ja contem toda linha (pendente OU ja paga/confirmada)
   * ja materializada para esta divida, entao o menor periodo ali E essa
   * ancora. So cai de volta em currentPeriod quando nao existe nenhuma
   * linha ainda -- a primeira chamada, no momento da criacao da divida,
   * onde "agora" E de fato a ancora correta.
   */
  const anchorPeriod =
    existingRows.reduce<string | null>((min, r) => {
      const period = r.occurrencePeriod ?? r.postedOn.slice(0, 7)
      return min === null || period < min ? period : min
    }, null) ?? currentPeriod

  // Same rationale as cashFlow.ts's materialize(): a period the user
  // explicitly deleted from a pending widget must stay gone, not come
  // back on the next load.
  const skippedPeriods = new Set(
    (
      await db.select({ period: skippedOccurrences.period }).from(skippedOccurrences).where(eq(skippedOccurrences.debtId, debtId))
    ).map((r) => r.period),
  )

  const periods: string[] = []
  if (debt.installmentCount === null) {
    // Revolving (cartão, cheque especial): one occurrence per month,
    // indefinitely, same as a "recorrente" cash-flow forecast — except when
    // `endPeriod` is set (decisions/0020, a "esta e as futuras" delete on a
    // revolving debt bounds it the same way a recurring forecast's
    // endPeriod does; a revolving debt has no natural end otherwise).
    for (let i = 0; i < MATERIALIZE_HORIZON_MONTHS; i++) {
      const period = addMonths(currentPeriod, i)
      if (!debt.endPeriod || period <= debt.endPeriod) periods.push(period)
    }
  } else {
    for (let i = installmentsPaid; i < debt.installmentCount; i++) {
      const period = addMonths(anchorPeriod, i)
      if (period <= horizon) periods.push(period)
    }
  }

  let created = 0
  for (const period of periods) {
    if (existingPeriods.has(period) || skippedPeriods.has(period)) continue
    const [year, month] = period.split('-').map(Number) as [number, number]
    const day = Math.min(debt.dueDay, daysInMonth(year, month))
    const postedOn = `${period}-${String(day).padStart(2, '0')}`
    const description = debt.name
    const descriptionNorm = normalizeDescription(description)
    // onConflictDoNothing is the authoritative guard against the race two
    // concurrent materialization calls for the same debt can hit (both see
    // "period missing" before either INSERT commits) — `existingPeriods`
    // above is just a cheap pre-filter, not the real guarantee.
    const inserted = await db
      .insert(transactions)
      .values({
        accountId: debt.accountId,
        postedOn,
        description,
        descriptionNorm,
        amountCents: -Math.abs(amountCents),
        direction: directionOf(-Math.abs(amountCents)),
        source: 'manual',
        categorizedBy: 'none',
        dedupeHash: dedupeHash({
          accountId: debt.accountId,
          postedOn,
          amountCents: -Math.abs(amountCents),
          descriptionNorm,
        }),
        pending: true,
        debtId: debt.id,
        occurrencePeriod: period,
      })
      .onConflictDoNothing({
        target: [transactions.debtId, transactions.occurrencePeriod],
        where: sql`${transactions.debtId} is not null`,
      })
      .returning({ id: transactions.id })
    if (inserted.length > 0) created++
  }
  return { created }
}

export async function materializeAllDebts(): Promise<{ created: number }> {
  const rows = await db.select({ id: debts.id }).from(debts).where(eq(debts.active, true))
  let created = 0
  for (const row of rows) created += (await materializeDebtInstallments(row.id)).created
  return { created }
}

/**
 * Same rationale as cashFlow.ts's syncMaterializedRows: editing a debt
 * (new scheduled payment, reassigned account, new due day) otherwise only
 * reached parcelas materialized AFTER the edit — every already-
 * materialized but still-unconfirmed row kept showing the stale numbers,
 * which looked exactly like the edit hadn't saved. Confirmed/settled rows
 * (pending=false) are real history by then and are left alone. A row the
 * user already edited by hand (`manuallyEdited`, see `decisions/0017`) is
 * also left alone — the template stops being authoritative over that one
 * occurrence the moment the user touches it.
 */
async function syncMaterializedRows(debt: typeof debts.$inferSelect): Promise<void> {
  if (!debt.accountId) return
  const amountCents = debt.scheduledPaymentCents || debt.minimumPaymentCents
  if (amountCents <= 0) return

  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.debtId, debt.id),
        eq(transactions.pending, true),
        eq(transactions.manuallyEdited, false),
      ),
    )

  const description = debt.name
  const descriptionNorm = normalizeDescription(description)

  for (const row of rows) {
    const period = row.occurrencePeriod ?? row.postedOn.slice(0, 7)
    const [year, month] = period.split('-').map(Number) as [number, number]
    const day = Math.min(debt.dueDay, daysInMonth(year, month))
    const postedOn = `${period}-${String(day).padStart(2, '0')}`
    await db
      .update(transactions)
      .set({
        postedOn,
        description,
        descriptionNorm,
        amountCents: -Math.abs(amountCents),
        direction: directionOf(-Math.abs(amountCents)),
        accountId: debt.accountId,
        dedupeHash: dedupeHash({
          accountId: debt.accountId,
          postedOn,
          amountCents: -Math.abs(amountCents),
          descriptionNorm,
        }),
      })
      .where(eq(transactions.id, row.id))
  }
}

/**
 * Nominal annual rate to an effective monthly rate. Brazilian consumer credit
 * is quoted monthly far more often than annually, but the schema stores one
 * canonical unit (annual bps) and converts here, in one place.
 */
export const monthlyRate = (aprBps: number) => Math.pow(1 + aprBps / 10_000, 1 / 12) - 1

/* ------------------------------------------------------------------ *
 * Composition + exposure + debt-to-income
 * ------------------------------------------------------------------ */
export async function debtOverview(options: { period?: string } = {}) {
  const rows = await listDebts()
  const totalCents = rows.reduce((sum, d) => sum + d.balanceCents, 0)
  const monthlyInterestCents = rows.reduce((sum, d) => sum + d.monthlyInterestCents, 0)
  const minimumCents = rows.reduce((sum, d) => sum + d.minimumPaymentCents, 0)
  const scheduledCents = rows.reduce((sum, d) => sum + d.scheduledPaymentCents, 0)

  // Balance-weighted average rate — a simple mean would understate the
  // damage a small, very expensive revolving balance does.
  const weightedAprBps =
    totalCents > 0
      ? Math.round(rows.reduce((sum, d) => sum + d.aprBps * d.balanceCents, 0) / totalCents)
      : 0

  // A single real month, not an average across several — "como estava a
  // situação em julho" is a different (and more decision-useful) question
  // than "qual foi a renda média dos últimos 3 meses", and averaging hides
  // exactly the month-to-month swings the user wants to see. Defaults to
  // the last fully closed month: the current month's income is still
  // arriving, so showing it as final would understate how comprometida a
  // renda really é.
  const period = options.period ?? addMonths(todayIso().slice(0, 7), -1)
  const { start: from, end: to } = periodBounds(period)
  const income = await totals({ from, to })
  const monthlyIncomeCents = income.incomeCents

  const byKind = new Map<string, number>()
  for (const d of rows) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + d.balanceCents)

  return {
    debts: rows,
    totalCents,
    monthlyInterestCents,
    minimumCents,
    scheduledCents,
    weightedAprBps,
    monthlyIncomeCents,
    /** committed debt service as a share of that month's real income */
    debtToIncomeBps:
      monthlyIncomeCents > 0 ? Math.round((scheduledCents / monthlyIncomeCents) * 10_000) : null,
    /** total balance as a share of annual income (that month's income x12) */
    debtToAnnualIncomeBps:
      monthlyIncomeCents > 0 ? Math.round((totalCents / (monthlyIncomeCents * 12)) * 10_000) : null,
    period,
    byKind: [...byKind.entries()]
      .map(([kind, amountCents]) => ({
        kind,
        amountCents,
        shareBps: totalCents > 0 ? Math.round((amountCents / totalCents) * 10_000) : 0,
      }))
      .sort((a, b) => b.amountCents - a.amountCents),
  }
}

/* ------------------------------------------------------------------ *
 * Paydown projection
 * ------------------------------------------------------------------ */
export type ProjectionPoint = { month: number; period: string; balanceCents: number }

export type Scenario = {
  label: string
  extraMonthlyCents: number
  strategy: 'avalanche' | 'snowball'
  months: number | null
  totalInterestCents: number
  payoffPeriod: string | null
  series: ProjectionPoint[]
  perDebt: Array<{ debtId: number; name: string; months: number | null; interestCents: number }>
}

type SimDebt = {
  id: number
  name: string
  balance: number
  rate: number
  minimum: number
  scheduled: number
  interestPaid: number
  months: number | null
}

/**
 * Simulates month-by-month amortization.
 *
 * Each month: interest accrues, every debt gets its scheduled payment, and
 * the extra contribution plus anything freed up by a paid-off debt is thrown
 * at the single target debt (highest rate for avalanche, smallest balance for
 * snowball). This is the standard model and it is deliberately simple —
 * the point is comparing two strategies, not predicting to the centavo.
 */
export async function projectPaydown(options: {
  extraMonthlyCents?: number
  strategy?: 'avalanche' | 'snowball'
  label?: string
  startPeriod?: string
}): Promise<Scenario> {
  const extraMonthlyCents = Math.max(0, options.extraMonthlyCents ?? 0)
  const strategy = options.strategy ?? 'avalanche'
  const startPeriod = options.startPeriod ?? todayIso().slice(0, 7)

  const sim: SimDebt[] = (await listDebts()).map((d) => ({
    id: d.id,
    name: d.name,
    balance: d.balanceCents,
    rate: monthlyRate(d.aprBps),
    minimum: d.minimumPaymentCents,
    scheduled: Math.max(d.scheduledPaymentCents, d.minimumPaymentCents),
    interestPaid: 0,
    months: null,
  }))

  const series: ProjectionPoint[] = [
    { month: 0, period: startPeriod, balanceCents: sim.reduce((s, d) => s + d.balance, 0) },
  ]

  if (sim.length === 0) {
    return {
      label: options.label ?? 'Cenário',
      extraMonthlyCents,
      strategy,
      months: 0,
      totalInterestCents: 0,
      payoffPeriod: startPeriod,
      series,
      perDebt: [],
    }
  }

  let month = 0
  let stalled = false

  while (sim.some((d) => d.balance > 0) && month < MAX_MONTHS) {
    month++
    const startingTotal = sim.reduce((s, d) => s + d.balance, 0)

    // 1. Interest accrues on every open balance.
    for (const d of sim) {
      if (d.balance <= 0) continue
      const interest = d.balance * d.rate
      d.balance += interest
      d.interestPaid += interest
    }

    // 2. Scheduled payments, plus whatever closed debts freed up.
    let pool = extraMonthlyCents
    for (const d of sim) {
      if (d.balance <= 0) {
        pool += d.scheduled
        continue
      }
      const payment = Math.min(d.scheduled, d.balance)
      d.balance -= payment
      if (payment < d.scheduled) pool += d.scheduled - payment
    }

    // 3. The whole pool goes at one target until it is gone.
    const openDebts = sim.filter((d) => d.balance > 0)
    const ordered =
      strategy === 'avalanche'
        ? [...openDebts].sort((a, b) => b.rate - a.rate || a.balance - b.balance)
        : [...openDebts].sort((a, b) => a.balance - b.balance || b.rate - a.rate)

    for (const target of ordered) {
      if (pool <= 0) break
      const payment = Math.min(pool, target.balance)
      target.balance -= payment
      pool -= payment
    }

    for (const d of sim) {
      if (d.balance <= 0.5 && d.months === null) {
        d.balance = 0
        d.months = month
      }
    }

    const total = sim.reduce((s, d) => s + d.balance, 0)
    series.push({ month, period: addMonths(startPeriod, month), balanceCents: Math.round(total) })

    // Payments not even covering interest: the balance never falls. Report
    // it honestly instead of drawing a flat line for 50 years.
    if (total >= startingTotal - 0.5) {
      stalled = true
      break
    }
  }

  const cleared = sim.every((d) => d.balance <= 0)
  return {
    label: options.label ?? (extraMonthlyCents > 0 ? 'Acelerado' : 'Atual'),
    extraMonthlyCents,
    strategy,
    months: cleared ? month : null,
    totalInterestCents: Math.round(sim.reduce((s, d) => s + d.interestPaid, 0)),
    payoffPeriod: cleared ? addMonths(startPeriod, month) : null,
    series,
    perDebt: sim.map((d) => ({
      debtId: d.id,
      name: d.name,
      months: d.months,
      interestCents: Math.round(d.interestPaid),
    })),
    ...(stalled ? { stalled: true } : {}),
  } as Scenario & { stalled?: boolean }
}

/** Baseline vs accelerated, aligned on the same month axis for one chart. */
export async function paydownComparison(extraMonthlyCents: number, strategy: 'avalanche' | 'snowball' = 'avalanche') {
  const [baseline, accelerated] = await Promise.all([
    projectPaydown({ extraMonthlyCents: 0, strategy, label: 'Pagamento atual' }),
    projectPaydown({ extraMonthlyCents, strategy, label: 'Com aporte extra' }),
  ])

  const horizon = Math.max(baseline.series.length, accelerated.series.length)
  const merged = Array.from({ length: horizon }, (_, i) => ({
    month: i,
    period: baseline.series[i]?.period ?? accelerated.series[i]?.period ?? '',
    baselineCents: baseline.series[i]?.balanceCents ?? (baseline.months !== null ? 0 : null),
    acceleratedCents: accelerated.series[i]?.balanceCents ?? (accelerated.months !== null ? 0 : null),
  }))

  return {
    baseline,
    accelerated,
    merged,
    savings: {
      monthsSaved:
        baseline.months !== null && accelerated.months !== null
          ? baseline.months - accelerated.months
          : null,
      interestSavedCents: baseline.totalInterestCents - accelerated.totalInterestCents,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */
export type DebtInput = {
  name: string
  kind?: string
  institution?: string | null
  principalCents: number
  aprBps: number
  minimumPaymentCents?: number
  scheduledPaymentCents?: number
  dueDay?: number
  installmentCount?: number | null
  accountId?: number | null
}

export async function createDebt(input: DebtInput) {
  const row = (
    await db
      .insert(debts)
      .values({ ...input, kind: input.kind as DebtKind | undefined })
      .returning()
  )[0]!
  // The opening principal is also the first measured point on the trend.
  await db
    .insert(debtSnapshots)
    .values({ debtId: row.id, asOf: todayIso(), balanceCents: input.principalCents })
    .onConflictDoNothing()
  return row
}

export async function updateDebt(id: number, patch: Partial<DebtInput> & { active?: boolean }) {
  const updated =
    (
      await db
        .update(debts)
        .set({ ...patch, kind: patch.kind as DebtKind | undefined })
        .where(eq(debts.id, id))
        .returning()
    )[0] ?? null
  if (updated) await syncMaterializedRows(updated)
  return updated
}

export async function deleteDebt(id: number) {
  const result = await db.delete(debts).where(eq(debts.id, id))
  return { removed: result.count }
}

export async function recordSnapshot(debtId: number, asOf: string, balanceCents: number) {
  const existing = (
    await db
      .select()
      .from(debtSnapshots)
      .where(sql`${debtSnapshots.debtId} = ${debtId} and ${debtSnapshots.asOf} = ${asOf}`)
  )[0]
  if (existing) {
    return (
      await db.update(debtSnapshots).set({ balanceCents }).where(eq(debtSnapshots.id, existing.id)).returning()
    )[0]!
  }
  return (await db.insert(debtSnapshots).values({ debtId, asOf, balanceCents }).returning())[0]!
}

export type PaymentRow = {
  id: number
  debtId: number
  debtName: string
  kind: string
  paidOn: string
  amountCents: number
  notes: string | null
}

export async function listPayments(debtId?: number): Promise<PaymentRow[]> {
  const query = db
    .select({
      id: debtPayments.id,
      debtId: debtPayments.debtId,
      debtName: debts.name,
      kind: debtPayments.kind,
      paidOn: debtPayments.paidOn,
      amountCents: debtPayments.amountCents,
      notes: debtPayments.notes,
    })
    .from(debtPayments)
    .innerJoin(debts, eq(debts.id, debtPayments.debtId))
    .orderBy(desc(debtPayments.paidOn))
  return debtId ? query.where(eq(debtPayments.debtId, debtId)) : query
}

/**
 * A parcela materializada mais antiga ainda pendente desta divida, se
 * houver (ordenada por occurrencePeriod, com postedOn como desempate para
 * as poucas linhas historicas sem occurrencePeriod). E a mesma nocao de
 * "proxima parcela" que installmentsPaid usa para decidir o indice
 * seguinte em materializeDebtInstallments.
 */
async function oldestPendingInstallment(debtId: number) {
  return (
    await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.debtId, debtId), eq(transactions.pending, true)))
      .orderBy(sql`coalesce(occurrence_period, posted_on)`)
      .limit(1)
  )[0] ?? null
}

/**
 * "Registrar pagamento" em Endividamento e o settle de uma pendencia vindo
 * da Home/Lancamentos (cashFlow.ts settlePending/confirmReconciliation)
 * sao o MESMO evento visto de duas telas -- gravar so em debt_payments
 * sem tocar a linha materializada deixava a parcela pendente ali para
 * sempre: Endividamento contava "1/1 pagas" mas a Home continuava
 * cobrando a mesma parcela em "Despesas pendentes" (bug 4, achado em
 * 03/09/2026, reproduzido nos dados reais: divida id 11, "Fatura do
 * cartao de credito", tinha installmentsPaid=1 e ainda assim 1 pendencia
 * aberta em 2026-08).
 *
 * So aplica a kind 'payment' -- um 'charge' (novo uso/saque) nao quita
 * nada, e nao ha pendencia nenhuma para ele assentar.
 */
async function settleOldestPendingInstallment(debtId: number): Promise<void> {
  const row = await oldestPendingInstallment(debtId)
  if (!row) return
  await db.update(transactions).set({ pending: false }).where(eq(transactions.id, row.id))
}

/**
 * Fecha a divida (active=false, closedOn=hoje) quando o numero de
 * parcelas pagas alcanca installmentCount -- o MESMO efeito que
 * deletePending's scope='all' ja produz ao fechar manualmente uma
 * pendencia pela Home, so que aqui e automatico, disparado pelo proprio
 * evento de pagamento (createPayment, settlePending,
 * confirmReconciliation: os tres lugares que gravam um debtPayments de
 * kind 'payment'), nao por uma acao separada do usuario.
 *
 * Sem isto uma divida totalmente paga nunca saia da lista ativa de
 * Endividamento (bug 2, achado em 03/09/2026: nenhum caminho do codigo
 * jamais gravava active=false por conta propria, e a UI nao tinha nenhum
 * botao "marcar como quitada" -- confirmado nos dados reais, dividas id
 * 11 e 13 estavam com installmentsPaid === installmentCount e ainda
 * assim active=true).
 *
 * Dividas revolventes (installmentCount null -- cartao, cheque especial)
 * nunca fecham aqui: elas nao tem um total de parcelas para esgotar, so
 * fecham pelo caminho manual existente (deletePending scope='all').
 *
 * Ao fechar, tambem remove qualquer pendencia que ainda reste ligada a
 * esta divida: uma vez quitada pelo proprio contador de parcelas, nenhuma
 * pendencia futura dela deveria existir -- se existe, e sobra do bug 5
 * (a mesma duplicacao que materializeDebtInstallments corrige daqui pra
 * frente), e uma divida "quitada" que ainda cobra em Despesas pendentes
 * seria o mesmo bug 4 outra vez, so que causado por dado velho em vez de
 * um caminho de codigo novo.
 */
export async function closeDebtIfFullyPaid(debtId: number): Promise<void> {
  const debt = (await db.select().from(debts).where(eq(debts.id, debtId)))[0]
  if (!debt || !debt.active || debt.installmentCount === null) return

  const { count: installmentsPaid } = await paymentStats(debtId)
  if (installmentsPaid < debt.installmentCount) return

  await db.update(debts).set({ active: false, closedOn: todayIso() }).where(eq(debts.id, debtId))
  await db
    .delete(transactions)
    .where(and(eq(transactions.debtId, debtId), eq(transactions.pending, true)))
}

export async function createPayment(input: {
  debtId: number
  kind?: string
  paidOn: string
  amountCents: number
  notes?: string | null
}) {
  const row = (
    await db
      .insert(debtPayments)
      .values({ ...input, kind: input.kind as DebtPaymentKind | undefined })
      .returning()
  )[0]!

  if (row.kind === 'payment') {
    await settleOldestPendingInstallment(input.debtId)
    await closeDebtIfFullyPaid(input.debtId)
  }

  return row
}

/**
 * Excluir um pagamento pode desfazer exatamente a condicao que
 * closeDebtIfFullyPaid checou: se a divida ja estava fechada por conta
 * daquele pagamento (installmentsPaid alcancou installmentCount), apagar
 * o registro derruba a contagem de volta abaixo do total, e a divida
 * precisa reabrir -- senao "excluir por engano um pagamento" deixaria a
 * divida presa como quitada para sempre, com a proxima parcela sem
 * nenhuma pendencia materializada.
 */
export async function deletePayment(id: number) {
  const row = (await db.select({ debtId: debtPayments.debtId }).from(debtPayments).where(eq(debtPayments.id, id)))[0]
  const result = await db.delete(debtPayments).where(eq(debtPayments.id, id))

  if (row) {
    const debt = (await db.select().from(debts).where(eq(debts.id, row.debtId)))[0]
    if (debt && !debt.active && debt.installmentCount !== null) {
      const { count: installmentsPaid } = await paymentStats(debt.id)
      if (installmentsPaid < debt.installmentCount) {
        await db.update(debts).set({ active: true, closedOn: null }).where(eq(debts.id, debt.id))
        await materializeDebtInstallments(debt.id)
      }
    }
  }

  return { removed: result.count }
}

/** Measured total debt over time — the actual trend, not a projection. */
export async function debtTrend() {
  return db.execute<{ asOf: string; balanceCents: number }>(sql`
    with points as (
      select distinct as_of from debt_snapshots
    )
    select
      p.as_of as "asOf",
      coalesce(sum(latest.balance_cents), 0) as "balanceCents"
    from points p
    left join debts d on d.active = true
    left join (
      select s1.debt_id, s1.as_of, s1.balance_cents
      from debt_snapshots s1
    ) latest on latest.debt_id = d.id
      and latest.as_of = (
        select max(s2.as_of) from debt_snapshots s2
        where s2.debt_id = d.id and s2.as_of <= p.as_of
      )
    group by p.as_of
    order by p.as_of
  `)
}
