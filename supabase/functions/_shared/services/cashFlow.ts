import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { accounts, cashFlowForecasts, categories, debtPayments, debts, reconciliationDismissals, skippedOccurrences, transactions } from '../db/schema.ts'
import { addDays, addMonths, daysInMonth, monthsBetween, todayIso } from '../core/dates.ts'
import { dedupeHash, directionOf, normalizeDescription } from '../core/normalize.ts'
import { closeDebtIfFullyPaid, linkedPaymentNote, materializeDebtInstallments, recordPaymentSnapshot, undoLinkedDebtPayment } from './debt.ts'

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

export type InstallmentRow = {
  id: number
  description: string
  direction: 'in' | 'out'
  installmentAmountCents: number
  installmentCount: number
  installmentsRealized: number
  totalCents: number
  paidCents: number
  remainingCents: number
  finished: boolean
  categoryId: number | null
  categoryName: string | null
  accountId: number | null
  accountName: string | null
  dueDay: number
  startPeriod: string
  active: boolean
}

/**
 * Uma compra parcelada inteira, agregada — total/pago/restante calculados
 * aqui (não no cliente) pelo mesmo motivo de sempre: o sinal de
 * `amountCents` já vive no servidor, então duplicar essa conta no front
 * arriscaria divergir dele. "Mostrar ocultos" aqui é `active = false`
 * (forecast desativado), não um campo novo — mais simples que o caso
 * equivalente de Lançamentos, porque este já existia.
 *
 * `cashFlowForecasts.installmentsRealized` NÃO é a fonte aqui — é só o
 * valor digitado na criação (ou editado manualmente), e nada no app o
 * avança quando uma parcela materializada é confirmada (`settlePending`/
 * `confirmReconciliation` nunca tocam essa coluna). Medido em 07/09/2026
 * contra dado real: uma previsão mostrava `stored: 1` com zero parcela de
 * fato confirmada, outra mostrava `stored: 0` com uma já confirmada —
 * divergente nos dois sentidos. A contagem real é o número de
 * `transactions` deste forecast com `pending = false` (mesma regra de
 * "derivação em vez de saldo guardado" do resto do projeto).
 */
export async function listInstallments(includeInactive = false): Promise<InstallmentRow[]> {
  const rows = await db
    .select({
      id: cashFlowForecasts.id,
      description: cashFlowForecasts.description,
      amountCents: cashFlowForecasts.amountCents,
      installmentCount: cashFlowForecasts.installmentCount,
      realizedCount: sql<number>`(
        select count(*)::int from ${transactions}
        where ${transactions.forecastId} = ${cashFlowForecasts.id} and ${transactions.pending} = false
      )`,
      // Soma o valor REAL das parcelas confirmadas, não
      // `installmentAmountCents * realizedCount` — uma parcela editada à
      // mão (ex. desconto negociado, `manuallyEdited`) tem um valor
      // diferente do modelo, e a multiplicação uniforme desalinhava
      // "Pago"/"Restante" da soma de verdade (achado da auditoria de
      // 07/09/2026).
      paidCentsRaw: sql<number>`coalesce((
        select sum(abs(${transactions.amountCents}))::int from ${transactions}
        where ${transactions.forecastId} = ${cashFlowForecasts.id} and ${transactions.pending} = false
      ), 0)`,
      categoryId: cashFlowForecasts.categoryId,
      categoryName: categories.name,
      accountId: cashFlowForecasts.accountId,
      accountName: accounts.name,
      dueDay: cashFlowForecasts.dueDay,
      startPeriod: cashFlowForecasts.startPeriod,
      active: cashFlowForecasts.active,
    })
    .from(cashFlowForecasts)
    .leftJoin(categories, eq(categories.id, cashFlowForecasts.categoryId))
    .leftJoin(accounts, eq(accounts.id, cashFlowForecasts.accountId))
    .where(
      includeInactive
        ? eq(cashFlowForecasts.kind, 'installment')
        : and(eq(cashFlowForecasts.kind, 'installment'), eq(cashFlowForecasts.active, true)),
    )
    .orderBy(desc(cashFlowForecasts.startPeriod))

  return rows.map((row) => {
    const installmentCount = row.installmentCount ?? 0
    const installmentAmountCents = Math.abs(row.amountCents)
    const totalCents = installmentAmountCents * installmentCount
    const paidCents = row.paidCentsRaw
    return {
      id: row.id,
      description: row.description,
      direction: directionOf(row.amountCents),
      installmentAmountCents,
      installmentCount,
      installmentsRealized: row.realizedCount,
      totalCents,
      paidCents,
      remainingCents: totalCents - paidCents,
      finished: row.realizedCount >= installmentCount,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      accountId: row.accountId,
      accountName: row.accountName,
      dueDay: row.dueDay,
      startPeriod: row.startPeriod,
      active: row.active,
    }
  })
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
  /** the approved quote this forecast was created from, if any (Precificação -> fatura recorrente) */
  sourceQuoteId?: number | null
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
/**
 * Execução em andamento, compartilhada. O Painel pede pendentes de receita,
 * pendentes de despesa e previsões ao mesmo tempo, e as três rotas chamavam
 * isto em paralelo: três passadas idênticas por todas as previsões, disputando
 * o mesmo pool de conexões (revisão beta de 30/09/2026). Só junta chamadas
 * SIMULTÂNEAS; a próxima carga roda de novo, então o horizonte continua
 * avançando com o tempo como antes.
 */
let materializeAllInFlight: Promise<{ created: number }> | null = null

export function materializeAll(): Promise<{ created: number }> {
  materializeAllInFlight ??= runMaterializeAll().finally(() => {
    materializeAllInFlight = null
  })
  return materializeAllInFlight
}

async function runMaterializeAll(): Promise<{ created: number }> {
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
        // Mesma âncora fixa que `materializeDebtInstallments` usa
        // (`debt.openedOn`, nunca "hoje" nem recomputada das linhas que
        // sobraram) — bug corrigido em 07/09/2026: a versão anterior
        // media a partir de `todayIso()` e ainda somava `installmentsPaid`
        // por cima, então apagar uma parcela atrasada (com o relógio já
        // alguns meses à frente do contrato) produzia um índice negativo,
        // e a próxima confirmação fechava a dívida sozinha
        // (`closeDebtIfFullyPaid` via `installmentsPaid < installmentCount`
        // virando `false` com um `installmentCount` negativo).
        const anchorPeriod = debt.openedOn?.slice(0, 7) ?? period
        const index = monthsBetween(anchorPeriod, period)
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
    // Mesmo saldo medido que Endividamento's "Registrar pagamento" grava
    // (debt.ts createPayment) -- as tres entradas do pagamento tem que
    // alimentar debt_snapshots do mesmo jeito, ou "Evolucao da divida"
    // (item 1 do backlog de 07/09/2026) fica rica so quando o pagamento
    // vem por uma porta e nao pela outra.
    await recordPaymentSnapshot(row.debtId, row.amountCents, 'payment')
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

  if (pendingRows.length === 0) return out

  // Uma consulta só para todos os pendentes. Antes era uma por pendente
  // (~130 idas ao banco, ~10s no Painel). Mesmos critérios: mesma conta,
  // mesmo valor, até 15 dias antes ou depois, no máximo 3 por pendente.
  const ids = sql.join(
    pendingRows.map((p) => sql`${p.id}`),
    sql`, `,
  )
  type MatchRow = { pendingId: number; id: number; postedOn: string; description: string; amountCents: number }
  const matches = await db.execute<MatchRow>(sql`
    select p.id as "pendingId", m.id, m.posted_on as "postedOn", m.description, m.amount_cents as "amountCents"
    from transactions p
    cross join lateral (
      select t.id, t.posted_on, t.description, t.amount_cents
      from transactions t
      where t.pending = false and t.ignored = false
        and t.account_id = p.account_id
        and t.amount_cents = p.amount_cents
        and t.posted_on between to_char(p.posted_on::date - 15, 'YYYY-MM-DD')
                            and to_char(p.posted_on::date + 15, 'YYYY-MM-DD')
      order by t.posted_on
      limit 3
    ) m
    where p.id in (${ids})
  `)
  const byPending = new Map<number, MatchRow[]>()
  for (const match of matches) {
    const list = byPending.get(Number(match.pendingId)) ?? []
    list.push(match)
    byPending.set(Number(match.pendingId), list)
  }

  for (const p of pendingRows) {
    for (const { pendingId: _pendingId, ...match } of byPending.get(p.id) ?? []) {
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
    const linked = await linkToSchedule(pendingId, matchId)
    if (linked) return { removed: 1 }
  }
  return deletePending(pendingId)
}

/**
 * Liga um lançamento real à parcela pendente (de previsão ou de dívida) que
 * ele paga: a pendência sai, o mês dela fica marcado como já atendido, e o
 * lançamento real passa a carregar a previsão/dívida e o MESMO mês
 * (`occurrencePeriod`). Numa dívida, também registra o pagamento, mede o
 * saldo e fecha a dívida se esta era a última parcela.
 *
 * Usado pela confirmação do Painel e pela importação, que liga sozinha
 * quando há uma candidata só (decisions/0039). Guardar o mês no lançamento
 * real é o que permite desfazer depois (`unlinkFromSchedule`): sem isso,
 * apagar o lançamento deixava a parcela sumida para sempre.
 *
 * Devolve `false` se a pendência já não existe (outra ação chegou antes).
 */
export async function linkToSchedule(pendingId: number, transactionId: number): Promise<boolean> {
  const pendingRow = (
    await db
      .select({
        forecastId: transactions.forecastId,
        debtId: transactions.debtId,
        occurrencePeriod: transactions.occurrencePeriod,
        postedOn: transactions.postedOn,
      })
      .from(transactions)
      .where(and(eq(transactions.id, pendingId), eq(transactions.pending, true)))
  )[0]
  if (!pendingRow || (!pendingRow.forecastId && !pendingRow.debtId)) return false

  const period = pendingRow.occurrencePeriod ?? pendingRow.postedOn.slice(0, 7)
  // Primeiro a pendência sai (e o mês vira "pulado", para não ser gerado de
  // novo); só depois o lançamento real assume o mês, senão os índices únicos
  // (previsão|dívida, mês) colidiriam com a própria pendência.
  await deletePending(pendingId, 'only')

  const taken = (
    await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          pendingRow.forecastId ? eq(transactions.forecastId, pendingRow.forecastId) : eq(transactions.debtId, pendingRow.debtId!),
          eq(transactions.occurrencePeriod, period),
        ),
      )
  )[0]
  await db
    .update(transactions)
    .set({ forecastId: pendingRow.forecastId, debtId: pendingRow.debtId, occurrencePeriod: taken ? null : period })
    .where(eq(transactions.id, transactionId))

  // Same debt-payments sync as settlePending: a bank-confirmed parcela
  // is the same "parcela paga" event Endividamento tracks, whichever
  // path confirmed it.
  if (pendingRow.debtId) {
    const match = (
      await db
        .select({ postedOn: transactions.postedOn, amountCents: transactions.amountCents })
        .from(transactions)
        .where(eq(transactions.id, transactionId))
    )[0]
    if (match) {
      await db.insert(debtPayments).values({
        debtId: pendingRow.debtId,
        kind: 'payment',
        paidOn: match.postedOn,
        amountCents: Math.abs(match.amountCents),
        notes: linkedPaymentNote(transactionId),
      })
      // Mesmo saldo medido de settlePending/createPayment.
      await recordPaymentSnapshot(pendingRow.debtId, match.amountCents, 'payment')
      // Mesma regra de fechamento de settlePending/createPayment.
      await closeDebtIfFullyPaid(pendingRow.debtId)
    }
  }
  return true
}

/**
 * O caminho inverso de `linkToSchedule`, para quando o lançamento real vai
 * ser apagado (desfazer uma importação): o mês volta a ficar em aberto, o
 * pagamento de dívida que a ligação gravou sai (reabrindo a dívida se ela
 * tinha fechado por causa dele) e a parcela é gerada de novo.
 */
export async function unlinkFromSchedule(transactionId: number): Promise<void> {
  const row = (
    await db
      .select({ forecastId: transactions.forecastId, debtId: transactions.debtId, occurrencePeriod: transactions.occurrencePeriod })
      .from(transactions)
      .where(eq(transactions.id, transactionId))
  )[0]
  if (!row || (!row.forecastId && !row.debtId)) return

  if (row.occurrencePeriod) {
    await db
      .delete(skippedOccurrences)
      .where(
        and(
          row.forecastId ? eq(skippedOccurrences.forecastId, row.forecastId) : eq(skippedOccurrences.debtId, row.debtId!),
          eq(skippedOccurrences.period, row.occurrencePeriod),
        ),
      )
  }
  if (row.debtId) await undoLinkedDebtPayment(row.debtId, transactionId)
  // Solta o lançamento antes de regerar, senão o mês dele ainda contaria como atendido.
  await db.update(transactions).set({ forecastId: null, debtId: null, occurrencePeriod: null }).where(eq(transactions.id, transactionId))
  if (row.forecastId) await materialize(row.forecastId)
  if (row.debtId) await materializeDebtInstallments(row.debtId)
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
      from transactions where debt_id is not null and pending = false and ignored = false group by debt_id
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
          .where(and(inArray(transactions.debtId, mismatchedIds), eq(transactions.pending, false), eq(transactions.ignored, false)))
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

/**
 * Parcelas pendentes (de previsão ou dívida) de uma conta que uma linha
 * importada pode estar pagando: mesmo valor, até 15 dias antes ou depois.
 * Mesmo critério de `reconciliationCandidates`, só que contra linhas que
 * ainda nem entraram no ledger. Uma consulta só para o lote inteiro.
 */
export async function pendingScheduleCandidates(
  accountId: number,
  rows: Array<{ postedOn: string | null; amountCents: number | null }>,
): Promise<Array<number[]>> {
  const dated = rows.filter((r): r is { postedOn: string; amountCents: number } => r.postedOn !== null && r.amountCents !== null)
  if (dated.length === 0) return rows.map(() => [])
  const earliest = addDays(dated.reduce((a, r) => (r.postedOn < a ? r.postedOn : a), dated[0]!.postedOn), -15)
  const latest = addDays(dated.reduce((a, r) => (r.postedOn > a ? r.postedOn : a), dated[0]!.postedOn), 15)

  const pending = await db
    .select({ id: transactions.id, postedOn: transactions.postedOn, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.pending, true),
        sql`(${transactions.forecastId} is not null or ${transactions.debtId} is not null)`,
        sql`${transactions.postedOn} between ${earliest} and ${latest}`,
      ),
    )

  return rows.map((r) => {
    if (r.postedOn === null || r.amountCents === null) return []
    const from = addDays(r.postedOn, -15)
    const to = addDays(r.postedOn, 15)
    return pending.filter((p) => p.amountCents === r.amountCents && p.postedOn >= from && p.postedOn <= to).map((p) => p.id)
  })
}
