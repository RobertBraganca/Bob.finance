import { desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { accounts, creditCardSnapshots, creditCards } from '../db/schema.ts'
import { addDays, daysInMonth, todayIso } from '../core/dates.ts'

import { cardSummaries } from './cardSync.ts'
/**
 * Cards are registered metadata (limit, cycle, linked account) plus a
 * measured available-limit history — the same "measured, not derived"
 * shape as `debts`/`debt_snapshots`. Per-purchase credit spend isn't
 * broken out from the checking ledger yet, so this is the foundation
 * the predictive-cost-reduction work will read from, not the full
 * transaction-level picture.
 */

const pad2 = (n: number) => String(n).padStart(2, '0')

/** The next date (today or later) whose day-of-month is `day`, clamped to real month lengths. */
function nextOccurrence(day: number, todayStr: string): string {
  const [y, m, d] = todayStr.split('-').map(Number) as [number, number, number]
  const thisMonthDay = Math.min(day, daysInMonth(y, m))
  if (d <= thisMonthDay) return `${y}-${pad2(m)}-${pad2(thisMonthDay)}`

  const total = y * 12 + (m - 1) + 1
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const nextMonthDay = Math.min(day, daysInMonth(ny, nm))
  return `${ny}-${pad2(nm)}-${pad2(nextMonthDay)}`
}

export type CardRow = {
  id: number
  name: string
  institution: string | null
  accountId: number | null
  accountName: string | null
  creditLimitCents: number
  availableLimitCents: number
  usedCents: number
  usedBps: number
  closingDay: number
  dueDay: number
  nextClosingOn: string
  nextDueOn: string
  lastMeasuredOn: string | null
  /** 'pluggy' quando ligado ao Meu Pluggy (specs/card-summary-sync); senão medido à mão */
  source: 'pluggy' | 'manual'
  lastSyncedAt: string | null
  syncError: string | null
  /** saldo informado pelo banco (em alguns bancos é a fatura, em outros o total usado) */
  balanceCents: number | null
  /**
   * Fatura aberta: o saldo do banco quando ele é a fatura; quando o banco
   * manda o total usado do cartão como saldo (Nubank PJ, PicPay), a soma dos
   * lançamentos e parcelas do ciclo aberto. Nulo no cartão medido à mão.
   */
  openBillCents: number | null
  minimumPaymentCents: number | null
  /** o banco mandou disponível 0 com limite livre: o usado segue a última medição do app */
  availableUnreported: boolean
  /** fatura do mês corrente e próximas: lançado + parcelas projetadas, por mês */
  upcoming: Array<{ period: string; postedCents: number; projectedCents: number }>
  /** encargos (juros, IOF, multa) por mês de fatura nos últimos 12 meses */
  charges12mCents: number
  lastBills: Array<{ dueDate: string; totalCents: number; financeChargesCents: number }>
}

async function latestAvailable(cardId: number, creditLimitCents: number): Promise<{ cents: number; asOf: string | null }> {
  const snapshot = (
    await db
      .select()
      .from(creditCardSnapshots)
      .where(eq(creditCardSnapshots.cardId, cardId))
      .orderBy(desc(creditCardSnapshots.asOf))
      .limit(1)
  )[0]
  // Never measured: assume the full limit is available rather than guessing usage.
  return { cents: snapshot?.availableLimitCents ?? creditLimitCents, asOf: snapshot?.asOf ?? null }
}

export async function listCards(): Promise<CardRow[]> {
  const today = todayIso()
  const rows = await db
    .select({
      id: creditCards.id,
      name: creditCards.name,
      institution: creditCards.institution,
      accountId: creditCards.accountId,
      accountName: accounts.name,
      creditLimitCents: creditCards.creditLimitCents,
      closingDay: creditCards.closingDay,
      dueDay: creditCards.dueDay,
    })
    .from(creditCards)
    .leftJoin(accounts, eq(accounts.id, creditCards.accountId))
    .where(eq(creditCards.active, true))

  const withAvailable = await Promise.all(
    rows.map(async (r) => {
      const { cents: availableLimitCents, asOf } = await latestAvailable(r.id, r.creditLimitCents)
      const usedCents = Math.max(0, r.creditLimitCents - availableLimitCents)
      return {
        ...r,
        availableLimitCents,
        usedCents,
        usedBps: r.creditLimitCents > 0 ? Math.round((usedCents / r.creditLimitCents) * 10_000) : 0,
        nextClosingOn: nextOccurrence(r.closingDay, today),
        nextDueOn: nextOccurrence(r.dueDay, today),
        lastMeasuredOn: asOf,
      }
    }),
  )

  const summaries = await cardSummaries(withAvailable.map((r) => r.id))
  const openBillOf = (balance: number | null, used: number, open: { postedCents: number; projectedCents: number } | null, linked: boolean) => {
    if (!linked) return null
    const cycle = open ? Math.max(0, open.postedCents + open.projectedCents) : 0
    if (balance === null) return cycle
    // Saldo igual ao limite usado (até R$ 1): é o total do cartão, não a fatura.
    return used > 0 && Math.abs(balance - used) <= 100 && cycle < balance ? cycle : Math.max(0, balance)
  }
  const currentPeriod = today.slice(0, 7)
  const yearAgo = `${Number(currentPeriod.slice(0, 4)) - 1}${currentPeriod.slice(4)}`
  const enriched: CardRow[] = withAvailable.map((r) => {
    const s = summaries.get(r.id)
    const conn = s?.connection ?? null
    const months = s?.months ?? []
    const fromBills = (s?.bills ?? []).filter((b) => b.dueDate.slice(0, 7) > yearAgo).reduce((sum, b) => sum + b.financeChargesCents, 0)
    const fromTxns = months.filter((m) => m.period > yearAgo && m.period <= currentPeriod).reduce((sum, m) => sum + m.chargesCents, 0)
    return {
      ...r,
      source: conn ? 'pluggy' : 'manual',
      lastSyncedAt: conn?.lastSyncedAt ?? null,
      syncError: conn?.lastError ?? null,
      balanceCents: conn?.balanceCents ?? null,
      openBillCents: openBillOf(conn?.balanceCents ?? null, r.usedCents, months.find((m) => m.period === currentPeriod) ?? null, !!conn),
      minimumPaymentCents: conn?.minimumPaymentCents ?? null,
      availableUnreported: !!conn && conn.availableCents === null,
      upcoming: months
        .filter((m) => m.period >= currentPeriod)
        .slice(0, 12)
        .map((m) => ({ period: m.period, postedCents: m.postedCents, projectedCents: m.projectedCents })),
      // Faturas fechadas e lançamentos medem o mesmo encargo por caminhos diferentes: vale o maior, nunca a soma.
      charges12mCents: Math.max(fromBills, fromTxns),
      lastBills: (s?.bills ?? []).slice(0, 3),
    }
  })
  return enriched.sort((a, b) => a.nextDueOn.localeCompare(b.nextDueOn))
}

export type CreditCardInput = {
  name: string
  institution?: string | null
  accountId?: number | null
  creditLimitCents: number
  closingDay?: number
  dueDay?: number
}

export async function createCard(input: CreditCardInput) {
  const row = (await db.insert(creditCards).values(input).returning())[0]!
  // The registered limit is also the first measured point — a freshly added
  // card starts fully available until the user records otherwise.
  await db
    .insert(creditCardSnapshots)
    .values({ cardId: row.id, asOf: todayIso(), availableLimitCents: input.creditLimitCents })
    .onConflictDoNothing()
  return row
}

export async function updateCard(id: number, patch: Partial<CreditCardInput> & { active?: boolean }) {
  return (await db.update(creditCards).set(patch).where(eq(creditCards.id, id)).returning())[0] ?? null
}

export async function deleteCard(id: number) {
  return { removed: (await db.delete(creditCards).where(eq(creditCards.id, id))).count }
}

export async function recordSnapshot(cardId: number, asOf: string, availableLimitCents: number) {
  const existing = (await db.select().from(creditCardSnapshots).where(eq(creditCardSnapshots.cardId, cardId))).find(
    (s) => s.asOf === asOf,
  )
  if (existing) {
    return (
      await db
        .update(creditCardSnapshots)
        .set({ availableLimitCents })
        .where(eq(creditCardSnapshots.id, existing.id))
        .returning()
    )[0]!
  }
  return (await db.insert(creditCardSnapshots).values({ cardId, asOf, availableLimitCents }).returning())[0]!
}

export type InvoiceCycle = { closingOn: string; dueOn: string; amountCents: number; transactionCount: number }

/**
 * Agrupa toda `transactions.credit_card_id = cardId` pelo ciclo de fatura
 * que a cobre — o mesmo `nextOccurrence` que calcula "próximo fechamento
 * a partir de hoje" (`listCards` acima) serve igual para "fechamento que
 * cobre esta data", só trocando o "hoje" pela data do lançamento.
 */
async function invoiceCycles(cardId: number, closingDay: number, dueDay: number): Promise<InvoiceCycle[]> {
  const rows = await db.execute<{ postedOn: string; amountCents: number }>(sql`
    select posted_on as "postedOn", amount_cents as "amountCents"
    from transactions
    where credit_card_id = ${cardId}
  `)

  const byClosing = new Map<string, { amountCents: number; transactionCount: number }>()
  for (const row of rows) {
    const closingOn = nextOccurrence(closingDay, row.postedOn)
    const bucket = byClosing.get(closingOn) ?? { amountCents: 0, transactionCount: 0 }
    // gasto no cartão é sempre saída (amountCents negativo na ficha do
    // lançamento) — a fatura mostra o valor gasto, não o sinal contábil.
    bucket.amountCents += Math.abs(row.amountCents)
    bucket.transactionCount += 1
    byClosing.set(closingOn, bucket)
  }

  return [...byClosing.entries()]
    .map(([closingOn, v]) => ({ closingOn, dueOn: nextOccurrence(dueDay, addDays(closingOn, 1)), ...v }))
    .sort((a, b) => a.closingOn.localeCompare(b.closingOn))
}

/**
 * "Fatura atual" (o ciclo cujo fechamento é o próximo a partir de hoje,
 * mesmo que ainda não tenha nenhum lançamento) + até 12 ciclos passados
 * fechados. Sem ligação nenhuma com Open Finance/sincronização bancária
 * (este app não tem isso — só importação de CSV, ver nota do backlog): o
 * atraso possível aqui é de IMPORTAÇÃO, não de sincronização ao vivo.
 */
export async function cardInvoices(cardId: number): Promise<{ current: InvoiceCycle; history: InvoiceCycle[] } | null> {
  const card = (await db.select().from(creditCards).where(eq(creditCards.id, cardId)))[0]
  if (!card) return null

  const currentClosingOn = nextOccurrence(card.closingDay, todayIso())
  const cycles = await invoiceCycles(cardId, card.closingDay, card.dueDay)
  // Tudo com fechamento igual ou depois de hoje entra na fatura atual — não
  // só o ciclo exato de `currentClosingOn`. Uma parcela materializada com
  // data no futuro (rara, mas possível) cairia num ciclo mais adiante ainda;
  // melhor somar ao "atual" do que sumir silenciosamente da tela.
  const openCycles = cycles.filter((c) => c.closingOn >= currentClosingOn)
  const current = openCycles.reduce<InvoiceCycle>(
    (sum, c) => ({ ...sum, amountCents: sum.amountCents + c.amountCents, transactionCount: sum.transactionCount + c.transactionCount }),
    {
      closingOn: currentClosingOn,
      dueOn: nextOccurrence(card.dueDay, addDays(currentClosingOn, 1)),
      amountCents: 0,
      transactionCount: 0,
    },
  )
  const history = cycles.filter((c) => c.closingOn < currentClosingOn).slice(-12)
  return { current, history }
}
