import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { cashFlowForecasts, debtPayments, debts, reconciliationDismissals, skippedOccurrences, transactions } from '../db/schema'
import { addMonths, daysInMonth, monthsBetween, todayIso } from '../core/dates'
import { dedupeHash, directionOf, normalizeDescription } from '../core/normalize'
import { closeDebtIfFullyPaid, paymentStats } from './debt'

/**
 * A recurring retainer or an already-agreed installment deal, unified
 * with the real ledger: the template here materializes real rows into
 * `transactions` (pending = true) rather than a side preview. Every
 * totals query filters pending out by default, so this can never
 * inflate a closed period's real numbers — it only feeds the pending
 * widgets until the bank statement actually confirms it (see
 * `reconciliationCandidates` below).
 */

/**
 * 24 meses (decisions/0028): o usuário quer lançar receitas fixas
 * recorrentes (ex. salário) e acompanhar realizado x pendente até 2028
 * — dois anos à frente, não só o que está prestes a vencer. Cada
 * ocorrência vira uma linha real e congelada em `transactions` no
 * valor de HOJE; se o valor do modelo mudar depois (um reajuste), só
 * as ocorrências ainda não materializadas herdam o novo valor — as já
 * materializadas exigem edição manual, mesmo risco que já existia com
 * 6 meses, só que numa janela maior.
 */
const MATERIALIZE_HORIZON_MONTHS = 24

export type ForecastRow = typeof cashFlowForecasts.$inferSelect
type ForecastKind = ForecastRow['kind']

export async function listForecasts(): Promise<Array<ForecastRow & { nextOccurrencePeriod: string | null }>> {
  const rows = await db
    .select()
    .from(cashFlowForecasts)
    .where(eq(cashFlowForecasts.active, true))
    .orderBy(cashFlowForecasts.description)
  return Promise.all(rows.map(async (row) => ({ ...row, nextOccurrencePeriod: await nextOccurrencePeriod(row) })))
}

/** One (forecast, period) occurrence not yet materialized as a transaction row. */
function pendingOccurrences(forecast: ForecastRow, throughPeriod: string): string[] {
  const currentPeriod = todayIso().slice(0, 7)
  const periods: string[] = []

  if (forecast.kind === 'installment') {
    const total = forecast.installmentCount ?? 0
    for (let i = forecast.installmentsRealized; i < total; i++) {
      const period = addMonths(forecast.startPeriod, i)
      if (period <= throughPeriod) periods.push(period)
    }
    return periods
  }

  // Pontual: exactly one occurrence in its own period, never repeats —
  // falling through to the recurring loop below would materialize it
  // every month forever.
  if (forecast.kind === 'single') {
    if (forecast.startPeriod <= throughPeriod) periods.push(forecast.startPeriod)
    return periods
  }

  let period = forecast.startPeriod > currentPeriod ? forecast.startPeriod : currentPeriod
  while (period <= throughPeriod && (!forecast.endPeriod || period <= forecast.endPeriod)) {
    periods.push(period)
    period = addMonths(period, 1)
  }
  return periods
}

/**
 * The first occurrence of this template, even when it falls beyond
 * `MATERIALIZE_HORIZON_MONTHS` — `pendingOccurrences` already computes this
 * correctly for any kind, it just needs a horizon far enough out that a
 * legitimately distant start date (ex. a salary raise starting after a
 * 5-parcela contract ends) isn't cut off. `null` means the template has no
 * occurrence left at all (ex. an installment already fully realized).
 *
 * A template with nothing materialized yet because its first occurrence is
 * this far out used to be indistinguishable from "never saved" — see
 * decisions/0020.
 */
const FAR_FUTURE_HORIZON_MONTHS = 60

async function nextOccurrencePeriod(forecast: ForecastRow): Promise<string | null> {
  const horizon = addMonths(todayIso().slice(0, 7), FAR_FUTURE_HORIZON_MONTHS)
  const skipped = new Set(
    (
      await db.select({ period: skippedOccurrences.period }).from(skippedOccurrences).where(eq(skippedOccurrences.forecastId, forecast.id))
    ).map((r) => r.period),
  )
  const next = pendingOccurrences(forecast, horizon).find((p) => !skipped.has(p))
  return next ?? null
}

/**
 * Ensures every occurrence through the horizon has a materialized
 * pending transaction row. Idempotent — checks what already exists for
 * this forecast before inserting, so calling it repeatedly (every time
 * the forecast list loads) never duplicates a row.
 */
export async function materialize(forecastId: number): Promise<{ created: number }> {
  const forecast = (await db.select().from(cashFlowForecasts).where(eq(cashFlowForecasts.id, forecastId)))[0]
  if (!forecast || !forecast.accountId) return { created: 0 }

  const horizon = addMonths(todayIso().slice(0, 7), MATERIALIZE_HORIZON_MONTHS - 1)
  const wanted = pendingOccurrences(forecast, horizon)
  if (wanted.length === 0) return { created: 0 }

  const existing = new Set(
    (
      await db
        .select({ occurrencePeriod: transactions.occurrencePeriod, postedOn: transactions.postedOn })
        .from(transactions)
        .where(eq(transactions.forecastId, forecastId))
    )
      // Legacy rows materialized before occurrencePeriod existed fall back to
      // their postedOn's month — still correct as long as nobody has since
      // edited that date (see the column's own comment in schema.ts).
      .map((r) => r.occurrencePeriod ?? r.postedOn.slice(0, 7)),
  )

  // Periods the user explicitly deleted from a pending widget — never
  // recreate those, or a delete would silently undo itself on next load.
  const skipped = new Set(
    (
      await db.select({ period: skippedOccurrences.period }).from(skippedOccurrences).where(eq(skippedOccurrences.forecastId, forecastId))
    ).map((r) => r.period),
  )

  let created = 0
  for (const period of wanted) {
    if (existing.has(period) || skipped.has(period)) continue
    // Clamped so a due day of 31 doesn't overflow a 30-day (or shorter,
    // February) month into the next one.
    const [year, month] = period.split('-').map(Number) as [number, number]
    const day = Math.min(forecast.dueDay, daysInMonth(year, month))
    const postedOn = `${period}-${String(day).padStart(2, '0')}`
    const description = forecast.description
    const descriptionNorm = normalizeDescription(description)
    // onConflictDoNothing is the authoritative guard against the race two
    // concurrent materialize() calls for the same forecast can hit (both see
    // "period missing" before either INSERT commits) — the `existing` Set
    // above is just a cheap pre-filter, not the real guarantee.
    const inserted = await db
      .insert(transactions)
      .values({
        accountId: forecast.accountId,
        postedOn,
        description,
        descriptionNorm,
        amountCents: forecast.amountCents,
        direction: directionOf(forecast.amountCents),
        categoryId: forecast.categoryId,
        source: 'manual',
        categorizedBy: forecast.categoryId ? 'manual' : 'none',
        dedupeHash: dedupeHash({ accountId: forecast.accountId, postedOn, amountCents: forecast.amountCents, descriptionNorm }),
        pending: true,
        forecastId: forecast.id,
        occurrencePeriod: period,
        notes: forecast.notes,
      })
      .onConflictDoNothing({
        target: [transactions.forecastId, transactions.occurrencePeriod],
        where: sql`${transactions.forecastId} is not null`,
      })
      .returning({ id: transactions.id })
    if (inserted.length > 0) created++
  }
  return { created }
}

export type ForecastInput = {
  description: string
  kind?: string
  amountCents: number
  accountId: number
  categoryId?: number | null
  startPeriod: string
  dueDay?: number
  installmentCount?: number | null
  installmentsRealized?: number
  endPeriod?: string | null
  notes?: string | null
}

export async function createForecast(input: ForecastInput) {
  const row = (
    await db
      .insert(cashFlowForecasts)
      .values({ ...input, kind: input.kind as ForecastKind | undefined })
      .returning()
  )[0]!
  await materialize(row.id)
  // Attached even when the first occurrence falls beyond the horizon and
  // `materialize` above produced zero rows — that used to look exactly
  // like the save had failed (decisions/0020).
  return { ...row, nextOccurrencePeriod: await nextOccurrencePeriod(row) }
}

export async function updateForecast(id: number, patch: Partial<ForecastInput> & { active?: boolean }) {
  const updated = (
    await db
      .update(cashFlowForecasts)
      .set({ ...patch, kind: patch.kind as ForecastKind | undefined })
      .where(eq(cashFlowForecasts.id, id))
      .returning()
  )[0]
  if (updated) {
    await syncMaterializedRows(updated)
    await materialize(id)
  }
  return updated ?? null
}

/**
 * A template edit (new amount, new dueDay, reassigned account/category)
 * otherwise only reached the NEXT occurrence `materialize()` creates —
 * every already-materialized but still-unconfirmed row silently kept
 * showing the old values, which looked exactly like "the edit didn't
 * save" from the pending widgets. Confirmed/settled rows (pending=false)
 * are real history by then and are left alone. A row the user already
 * edited by hand (`manuallyEdited`, see `decisions/0017`) is also left
 * alone — the template stops being authoritative over that one
 * occurrence the moment the user touches it.
 */
async function syncMaterializedRows(forecast: ForecastRow): Promise<void> {
  if (!forecast.accountId) return
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.forecastId, forecast.id),
        eq(transactions.pending, true),
        eq(transactions.manuallyEdited, false),
      ),
    )

  for (const row of rows) {
    const period = row.occurrencePeriod ?? row.postedOn.slice(0, 7)
    const [year, month] = period.split('-').map(Number) as [number, number]
    const day = Math.min(forecast.dueDay, daysInMonth(year, month))
    const postedOn = `${period}-${String(day).padStart(2, '0')}`
    const descriptionNorm = normalizeDescription(forecast.description)
    await db
      .update(transactions)
      .set({
        postedOn,
        description: forecast.description,
        descriptionNorm,
        amountCents: forecast.amountCents,
        direction: directionOf(forecast.amountCents),
        categoryId: forecast.categoryId,
        accountId: forecast.accountId,
        notes: forecast.notes,
        dedupeHash: dedupeHash({ accountId: forecast.accountId, postedOn, amountCents: forecast.amountCents, descriptionNorm }),
      })
      .where(eq(transactions.id, row.id))
  }
}

export async function deleteForecast(id: number) {
  // Still-pending materialized rows cascade with it (schema onDelete:
  // 'cascade'); any already reconciled real transaction has no
  // forecastId anymore by then, so it is untouched.
  return { removed: (await db.delete(cashFlowForecasts).where(eq(cashFlowForecasts.id, id))).count }
}

/** Re-materializes every active template — called opportunistically so the rolling horizon never runs dry. */
export async function materializeAll(): Promise<{ created: number }> {
  let created = 0
  for (const f of await listForecasts()) created += (await materialize(f.id)).created
  return { created }
}

export type PendingRow = {
  id: number
  accountId: number
  accountName: string
  postedOn: string
  description: string
  amountCents: number
  direction: string
  categoryId: number | null
  categoryName: string | null
  forecastId: number | null
  /** the debt this installment/revolving charge materializes from, if any — was missing here (only forecastId was), so editing a debt-linked pending row from the Painel never asked the this/future/all scope (decisions/0029) */
  debtId: number | null
  installmentLabel: string | null
  /** still pending from BEFORE the window's start — surfaced instead of dropped, so nothing gets silently forgotten across a month boundary */
  isOverdue: boolean
  /** user already edited this specific occurrence — the template no longer overwrites it, see `decisions/0017` */
  manuallyEdited: boolean
}

/**
 * Every still-pending row, one flow at a time — the two "pendentes" home
 * widgets read straight from here. Only the window's END bounds it: a
 * pending row from an earlier, already-closed window is never excluded
 * just because a new period started — it keeps showing up (flagged
 * `isOverdue`) until it's confirmed, settled, or deleted, so a forgotten
 * expense can't quietly fall out of view when the month rolls over.
 */
export async function listPending(flow: 'income' | 'expense', range?: { from: string; to: string }): Promise<PendingRow[]> {
  const direction = flow === 'income' ? 'in' : 'out'
  const rangeFilter = range ? sql`and t.posted_on <= ${range.to}` : sql``
  const rows = await db.execute<{
    id: number
    accountId: number
    accountName: string
    postedOn: string
    description: string
    amountCents: number
    direction: string
    categoryId: number | null
    categoryName: string | null
    forecastId: number | null
    debtId: number | null
    forecastKind: string | null
    startPeriod: string | null
    installmentCount: number | null
    installmentsRealized: number | null
    manuallyEdited: boolean
  }>(sql`
    select
      t.id, t.account_id as "accountId", a.name as "accountName", t.posted_on as "postedOn",
      t.description, t.amount_cents as "amountCents", t.direction,
      t.category_id as "categoryId", c.name as "categoryName",
      t.forecast_id as "forecastId", t.debt_id as "debtId", f.kind as "forecastKind", f.start_period as "startPeriod",
      f.installment_count as "installmentCount", f.installments_realized as "installmentsRealized",
      t.manually_edited as "manuallyEdited"
    from transactions t
    join accounts a on a.id = t.account_id
    left join categories c on c.id = t.category_id
    left join cash_flow_forecasts f on f.id = t.forecast_id
    where t.pending = true and t.direction = ${direction} ${rangeFilter}
    order by t.posted_on
  `)

  return rows.map((r) => {
    let installmentLabel: string | null = null
    if (r.forecastKind === 'installment' && r.installmentCount !== null && r.startPeriod !== null) {
      const [y, m] = r.startPeriod.split('-').map(Number) as [number, number]
      const [py, pm] = r.postedOn.slice(0, 7).split('-').map(Number) as [number, number]
      const index = (py - y) * 12 + (pm - m)
      installmentLabel = `${index + 1}/${r.installmentCount}`
    }
    return {
      id: r.id,
      accountId: r.accountId,
      accountName: r.accountName,
      postedOn: r.postedOn,
      description: r.description,
      amountCents: r.amountCents,
      direction: r.direction,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      forecastId: r.forecastId,
      debtId: r.debtId,
      installmentLabel,
      isOverdue: range !== undefined && r.postedOn < range.from,
      manuallyEdited: r.manuallyEdited,
    }
  })
}

export type PendingDeleteScope = 'only' | 'this_and_future' | 'all'

async function markSkipped(forecastId: number | null, debtId: number | null, period: string) {
  await db.insert(skippedOccurrences).values({ forecastId, debtId, period }).onConflictDoNothing()
}

/**
 * Drops a pending row without ever having posted — the user decided it
 * just isn't happening. If it was materialized from a forecast/debt
 * template, that occurrence is also recorded as skipped — otherwise the
 * very next pending-widget load would materialize it right back, and the
 * delete would look like it silently failed.
 *
 * `scope` (decisions/0020) decides how much of the template's future goes
 * with it:
 * - `'only'` (default): just this occurrence, same as before.
 * - `'this_and_future'`: this occurrence and every later pending one of the
 *   same template, and the template stops generating anything from here on
 *   — a recurring forecast or revolving debt gets its `endPeriod` set to
 *   the month right before this occurrence; an installment forecast/debt
 *   gets `installmentCount` capped at this occurrence's index, since
 *   neither has an `endPeriod` concept that its own materialization loop
 *   checks.
 * - `'all'`: the whole template is deactivated (`active = false`), on top
 *   of everything `'this_and_future'` does. A debt also gets `closedOn`
 *   set, same as closing it from `specs/debt`.
 *
 * Neither wider scope ever touches a row with `pending = false` — that is
 * real, already-confirmed history, not the template's future.
 */
export async function deletePending(id: number, scope: PendingDeleteScope = 'only') {
  const row = (
    await db
      .select({
        forecastId: transactions.forecastId,
        debtId: transactions.debtId,
        occurrencePeriod: transactions.occurrencePeriod,
        postedOn: transactions.postedOn,
      })
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.pending, true)))
  )[0]
  if (!row) return { removed: 0 }

  const period = row.occurrencePeriod ?? row.postedOn.slice(0, 7)

  if (scope === 'only' || (!row.forecastId && !row.debtId)) {
    const removed = (await db.delete(transactions).where(eq(transactions.id, id))).count
    if (removed > 0 && (row.forecastId || row.debtId)) await markSkipped(row.forecastId, row.debtId, period)
    return { removed }
  }

  // 'this_and_future' or 'all', template-linked: gather every other still-
  // pending occurrence of the same template so they can be removed (and
  // skipped) alongside this one.
  const siblings = await db
    .select({ id: transactions.id, occurrencePeriod: transactions.occurrencePeriod, postedOn: transactions.postedOn })
    .from(transactions)
    .where(
      and(
        row.forecastId ? eq(transactions.forecastId, row.forecastId) : eq(transactions.debtId, row.debtId!),
        eq(transactions.pending, true),
      ),
    )

  const toRemove =
    scope === 'all' ? siblings : siblings.filter((s) => (s.occurrencePeriod ?? s.postedOn.slice(0, 7)) >= period)

  let removed = 0
  for (const s of toRemove) {
    removed += (await db.delete(transactions).where(eq(transactions.id, s.id))).count
    await markSkipped(row.forecastId, row.debtId, s.occurrencePeriod ?? s.postedOn.slice(0, 7))
  }

  // Bound future materialization so it doesn't recreate what was just
  // removed once the rolling horizon moves forward — skippedOccurrences
  // alone only covers periods already enumerated above.
  if (row.forecastId) {
    const forecast = (await db.select().from(cashFlowForecasts).where(eq(cashFlowForecasts.id, row.forecastId)))[0]
    if (forecast) {
      if (scope === 'all') {
        await db.update(cashFlowForecasts).set({ active: false }).where(eq(cashFlowForecasts.id, forecast.id))
      } else if (forecast.kind === 'recurring') {
        await db
          .update(cashFlowForecasts)
          .set({ endPeriod: addMonths(period, -1) })
          .where(eq(cashFlowForecasts.id, forecast.id))
      } else if (forecast.kind === 'installment') {
        const index = monthsBetween(forecast.startPeriod, period)
        await db.update(cashFlowForecasts).set({ installmentCount: index }).where(eq(cashFlowForecasts.id, forecast.id))
      }
      // 'single' never has a later occurrence to bound — nothing to do.
    }
  } else if (row.debtId) {
    const debt = (await db.select().from(debts).where(eq(debts.id, row.debtId)))[0]
    if (debt) {
      if (scope === 'all') {
        await db.update(debts).set({ active: false, closedOn: todayIso() }).where(eq(debts.id, debt.id))
      } else if (debt.installmentCount === null) {
        await db.update(debts).set({ endPeriod: addMonths(period, -1) }).where(eq(debts.id, debt.id))
      } else {
        // Installment debt schedules are recomputed from "now" each call
        // (see materializeDebtInstallments), not from a fixed start period
        // — this occurrence's index is `installmentsPaid` at this moment
        // plus how many months out it falls.
        const { count: installmentsPaid } = await paymentStats(debt.id)
        const index = installmentsPaid + monthsBetween(todayIso().slice(0, 7), period)
        await db.update(debts).set({ installmentCount: index }).where(eq(debts.id, debt.id))
      }
    }
  }

  return { removed }
}

/**
 * The user says this already happened exactly as shown — settles it into a
 * real transaction without waiting for a bank-statement match. Distinct
 * from `confirmReconciliation`, which pairs a pending row against an
 * already-imported real one; this is for cash or otherwise unbanked
 * income/expenses that will never show up in a CSV import.
 */
export async function settlePending(id: number) {
  const row = (
    await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.pending, true)))
  )[0]
  if (!row) return null

  const updated = (
    await db.update(transactions).set({ pending: false }).where(eq(transactions.id, id)).returning()
  )[0]!

  // A debt-linked parcela settling here is the same event Endividamento's
  // "Registrar pagamento" logs manually — without this, marking it paid
  // from the pending widgets would never advance installmentsPaid there,
  // so the two screens would silently disagree about the same debt.
  if (row.debtId) {
    await db
      .insert(debtPayments)
      .values({ debtId: row.debtId, kind: 'payment', paidOn: row.postedOn, amountCents: Math.abs(row.amountCents) })
    // Mesma regra de fechamento que Endividamento's "Registrar pagamento"
    // aplica (debt.ts createPayment) -- as duas telas tem que fechar a
    // divida pelo mesmo criterio, ou reabrimos o bug 2 por um caminho
    // diferente (achado em 03/09/2026).
    await closeDebtIfFullyPaid(row.debtId)
  }

  return updated
}

export type ReconciliationCandidate = {
  pending: PendingRow
  match: { id: number; postedOn: string; description: string; amountCents: number }
}

/**
 * Suggests, never auto-applies: a real (non-pending) transaction in the
 * same account with the exact same amount, posted within +/- 15 days
 * of the pending row's placeholder date. The user confirms each pair
 * by hand (see `confirmReconciliation`) — an amount match alone is not
 * proof, just a plausible candidate.
 */
export async function reconciliationCandidates(): Promise<ReconciliationCandidate[]> {
  const pendingRows = [...(await listPending('income')), ...(await listPending('expense'))]
  const dismissed = new Set(
    (await db.select({ pendingId: reconciliationDismissals.pendingId, matchId: reconciliationDismissals.matchId }).from(reconciliationDismissals)).map(
      (d) => `${d.pendingId}-${d.matchId}`,
    ),
  )
  const out: ReconciliationCandidate[] = []

  for (const p of pendingRows) {
    const windowStart = addDays(p.postedOn, -15)
    const windowEnd = addDays(p.postedOn, 15)
    const matches = await db.execute<{ id: number; postedOn: string; description: string; amountCents: number }>(sql`
      select id, posted_on as "postedOn", description, amount_cents as "amountCents"
      from transactions
      where pending = false
        and account_id = ${p.accountId}
        and amount_cents = ${p.amountCents}
        and posted_on between ${windowStart} and ${windowEnd}
      order by posted_on
      limit 3
    `)
    for (const match of matches) {
      if (dismissed.has(`${p.id}-${match.id}`)) continue
      out.push({ pending: p, match })
    }
  }

  return out
}

/** The user said this suggested pair is NOT the same event — stop suggesting it. */
export async function dismissReconciliation(pendingId: number, matchId: number) {
  await db.insert(reconciliationDismissals).values({ pendingId, matchId }).onConflictDoNothing()
  return { dismissed: true }
}

/**
 * The user confirmed a suggested pair really is the same event: the
 * pending placeholder is superseded, so it goes. Before deleting it,
 * its forecast/debt link transfers to the REAL transaction — otherwise
 * `materialize()`'s "does a row already exist for this period" check
 * (keyed on that same link) finds nothing once the placeholder is gone
 * and recreates it on the very next load, which made a confirmed match
 * reappear as if nothing had happened.
 */
export async function confirmReconciliation(pendingId: number, matchId?: number) {
  if (matchId) {
    const pendingRow = (
      await db
        .select({ forecastId: transactions.forecastId, debtId: transactions.debtId })
        .from(transactions)
        .where(and(eq(transactions.id, pendingId), eq(transactions.pending, true)))
    )[0]
    if (pendingRow && (pendingRow.forecastId || pendingRow.debtId)) {
      await db
        .update(transactions)
        .set({ forecastId: pendingRow.forecastId, debtId: pendingRow.debtId })
        .where(eq(transactions.id, matchId))

      // Same debt-payments sync as settlePending: a bank-confirmed parcela
      // is the same "parcela paga" event Endividamento tracks, whichever
      // path confirmed it.
      if (pendingRow.debtId) {
        const match = (
          await db
            .select({ postedOn: transactions.postedOn, amountCents: transactions.amountCents })
            .from(transactions)
            .where(eq(transactions.id, matchId))
        )[0]
        if (match) {
          await db
            .insert(debtPayments)
            .values({ debtId: pendingRow.debtId, kind: 'payment', paidOn: match.postedOn, amountCents: Math.abs(match.amountCents) })
          // Mesma regra de fechamento de settlePending/createPayment.
          await closeDebtIfFullyPaid(pendingRow.debtId)
        }
      }
    }
  }
  return deletePending(pendingId)
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}


/* ------------------------------------------------------------------ *
 * Fila de conciliacao de Endividamento (specs/debt, decisions/0037-ish
 * "fila de conciliacao" -- ver docs/specs/debt-reconciliation)
 * ------------------------------------------------------------------ */
export type DebtValueMismatch = {
  debtId: number
  debtName: string
  /** soma de debt_payments (kind='payment') -- o que Endividamento registrou como pago */
  registeredAmountCents: number
  /** soma de transactions confirmadas (pending=false) com este debt_id -- o que o extrato mostra */
  confirmedAmountCents: number
  diffCents: number
  paymentCount: number
  confirmedTransactionCount: number
  /** os dois lados que "Ver detalhes" mostra lado a lado, ate 20 cada */
  payments: Array<{ id: number; paidOn: string; amountCents: number; notes: string | null }>
  confirmedTransactions: Array<{ id: number; postedOn: string; description: string; amountCents: number }>
}

export type DebtSuggestedMatch = ReconciliationCandidate & { debtId: number; debtName: string }

export type DebtReconciliationQueue = {
  suggestedMatches: DebtSuggestedMatch[]
  valueMismatches: DebtValueMismatch[]
  assumptions: Record<string, unknown>
}

/**
 * A fila de conciliacao de Endividamento: dois tipos de item, nenhum
 * motor de matching novo.
 *
 * "Match sugerido" e reconciliationCandidates() -- a MESMA funcao que ja
 * alimenta o card "Possiveis conciliacoes" do Painel -- filtrada as
 * pendencias ligadas a uma divida (pending.debtId != null). Confirmar ou
 * rejeitar aqui usa as MESMAS rotas que o Painel ja usa
 * (confirmReconciliation / dismissReconciliation): nenhuma escrita nova,
 * so uma leitura filtrada e reaproveitada.
 *
 * "Divergencia de valor" e novo, mas nao e um matcher: compara os DOIS
 * lados que hoje registram "isso foi pago" -- debt_payments (o log manual
 * que installmentsPaid le, o que "Registrar pagamento" em Endividamento
 * grava) contra transactions confirmadas (pending=false) com este
 * debt_id (o que o extrato realmente mostra, o que a Home/Lancamentos
 * leem). Comparado em SOMA por divida, nunca pareado pagamento a
 * pagamento: debt_payments nao guarda o id da transacao que liquidou
 * (so debtId/kind/paidOn/amountCents), entao casar um pagamento
 * especifico com uma linha especifica seria adivinhar uma correspondencia
 * que o dado nao registra. A soma e o unico numero que os dois lados
 * derivam de forma comparavel -- e foi assim, comparando somas, que a
 * revisao de 03/09/2026 achou a divida 8 com um lancamento confirmado sem
 * nenhum debt_payments correspondente.
 */
export async function debtReconciliationQueue(): Promise<DebtReconciliationQueue> {
  const candidates = await reconciliationCandidates()
  const debtCandidates = candidates.filter(
    (c): c is ReconciliationCandidate & { pending: { debtId: number } } => c.pending.debtId !== null,
  )

  const debtIds = [...new Set(debtCandidates.map((c) => c.pending.debtId))]
  const debtNames = debtIds.length
    ? new Map(
        (await db.select({ id: debts.id, name: debts.name }).from(debts).where(inArray(debts.id, debtIds))).map(
          (d) => [d.id, d.name] as const,
        ),
      )
    : new Map<number, string>()

  const suggestedMatches: DebtSuggestedMatch[] = debtCandidates.map((c) => ({
    ...c,
    debtId: c.pending.debtId,
    debtName: debtNames.get(c.pending.debtId) ?? c.pending.description,
  }))

  const rows = await db.execute<{
    debtId: number
    debtName: string
    registeredAmountCents: number
    confirmedAmountCents: number
    paymentCount: number
    confirmedTransactionCount: number
  }>(sql`
    select
      d.id as "debtId",
      d.name as "debtName",
      coalesce(p.total, 0) as "registeredAmountCents",
      coalesce(t.total, 0) as "confirmedAmountCents",
      coalesce(p.count, 0) as "paymentCount",
      coalesce(t.count, 0) as "confirmedTransactionCount"
    from debts d
    left join (
      select debt_id, sum(amount_cents) as total, count(*) as count
      from debt_payments where kind = 'payment' group by debt_id
    ) p on p.debt_id = d.id
    left join (
      select debt_id, sum(abs(amount_cents)) as total, count(*) as count
      from transactions where debt_id is not null and pending = false group by debt_id
    ) t on t.debt_id = d.id
    where coalesce(p.total, 0) > 0 or coalesce(t.total, 0) > 0
  `)

  const mismatchedIds = rows
    .filter((r) => r.registeredAmountCents !== r.confirmedAmountCents)
    .map((r) => r.debtId)

  const [paymentRows, transactionRows] = mismatchedIds.length
    ? await Promise.all([
        db
          .select({
            debtId: debtPayments.debtId,
            id: debtPayments.id,
            paidOn: debtPayments.paidOn,
            amountCents: debtPayments.amountCents,
            notes: debtPayments.notes,
          })
          .from(debtPayments)
          .where(and(inArray(debtPayments.debtId, mismatchedIds), eq(debtPayments.kind, 'payment')))
          .orderBy(desc(debtPayments.paidOn)),
        db
          .select({
            debtId: transactions.debtId,
            id: transactions.id,
            postedOn: transactions.postedOn,
            description: transactions.description,
            amountCents: transactions.amountCents,
          })
          .from(transactions)
          .where(and(inArray(transactions.debtId, mismatchedIds), eq(transactions.pending, false)))
          .orderBy(desc(transactions.postedOn)),
      ])
    : [[], []]

  const valueMismatches: DebtValueMismatch[] = rows
    .filter((r) => r.registeredAmountCents !== r.confirmedAmountCents)
    .map((r) => ({
      ...r,
      diffCents: r.confirmedAmountCents - r.registeredAmountCents,
      payments: paymentRows.filter((p) => p.debtId === r.debtId).map(({ debtId: _debtId, ...rest }) => rest),
      confirmedTransactions: transactionRows
        .filter((t) => t.debtId === r.debtId)
        .map(({ debtId: _debtId, ...rest }) => rest),
    }))

  return {
    suggestedMatches,
    valueMismatches,
    assumptions: {
      matchSugerido:
        'mesma engrenagem do card "Possiveis conciliacoes" do Painel (reconciliationCandidates), filtrada as pendencias ligadas a uma divida',
      divergenciaDeValor:
        'compara a soma de debt_payments (o que Endividamento registrou como pago) contra a soma de transactions confirmadas com este debt_id (o que o extrato realmente mostra) -- nunca pareado pagamento a pagamento, porque debt_payments nao guarda o id da transacao que liquidou',
      nenhumaAcaoAutomatica: 'nenhuma divida muda de status por uma sugestao nao confirmada -- so confirm-match/dismiss, os mesmos usados pelo Painel',
    },
  }
}
