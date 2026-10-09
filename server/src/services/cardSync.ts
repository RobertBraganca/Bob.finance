import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { cardBills, cardConnections, cardMonths, creditCardSnapshots, creditCards } from '../db/schema'
import { billChargesCents, summarizeCard, type BillCycle, type CardTxn } from '../core/cardSummary'
import * as pluggy from './pluggy'

/**
 * Resumo dos cartões pelo Meu Pluggy (specs/card-summary-sync,
 * decisions/0044): limite, saldo, faturas fechadas e o resumo por mês.
 * Nenhuma compra vira lançamento do app.
 */

const saoPauloDate = (iso: string | Date): string =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
const cents = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 100))
const shiftMonths = (isoDate: string, n: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}

function labelOf(account: pluggy.PluggyAccount): string {
  const ending = (account.number ?? '').replace(/\D/g, '').slice(-4)
  return `Cartão ${account.marketingName || account.name}${ending ? ` · final ${ending}` : ''}`
}

export async function listCardConnections() {
  return db
    .select({
      id: cardConnections.id,
      creditCardId: cardConnections.creditCardId,
      cardName: creditCards.name,
      providerItemId: cardConnections.providerItemId,
      providerAccountId: cardConnections.providerAccountId,
      providerAccountLabel: cardConnections.providerAccountLabel,
      balanceCents: cardConnections.balanceCents,
      availableCents: cardConnections.availableCents,
      lastSyncedAt: cardConnections.lastSyncedAt,
      lastError: cardConnections.lastError,
    })
    .from(cardConnections)
    .innerJoin(creditCards, eq(creditCards.id, cardConnections.creditCardId))
    .orderBy(creditCards.name)
}

/** Liga a conta de cartão da Pluggy a um cartão do app (um para um). */
export async function createCardConnection(input: { creditCardId: number; providerItemId: string; providerAccountId: string }) {
  const card = (await db.select().from(creditCards).where(eq(creditCards.id, input.creditCardId)))[0]
  if (!card) throw new Error('cartão do app não encontrado')
  const account = (await pluggy.listAccounts(input.providerItemId)).find((a) => a.id === input.providerAccountId)
  if (!account) throw new Error('essa conta não pertence à conexão informada na Pluggy')
  if (account.type !== 'CREDIT') throw new Error('essa conta da Pluggy não é um cartão de crédito')
  return (
    await db
      .insert(cardConnections)
      .values({ creditCardId: input.creditCardId, providerItemId: input.providerItemId, providerAccountId: input.providerAccountId, providerAccountLabel: labelOf(account) })
      .returning()
  )[0]!
}

export async function deleteCardConnection(id: number) {
  await db.delete(cardConnections).where(eq(cardConnections.id, id))
  return { deleted: true }
}

/**
 * Lê a conta, as faturas fechadas e 12 meses de lançamentos do cartão, e
 * grava o resumo. O disponível só vira medição quando o banco informa um
 * valor positivo (alguns mandam 0 com limite livre).
 */
export async function syncCard(id: number) {
  const conn = (await db.select().from(cardConnections).where(eq(cardConnections.id, id)))[0]
  if (!conn) throw new Error('conexão de cartão não encontrada')
  try {
    const today = saoPauloDate(new Date())
    const account = (await pluggy.listAccounts(conn.providerItemId)).find((a) => a.id === conn.providerAccountId)
    if (!account) throw new Error('o cartão não aparece mais nessa conexão da Pluggy')
    const credit = account.creditData ?? {}
    const limitCents = cents(credit.creditLimit)
    const rawAvailable = cents(credit.availableCreditLimit)
    const availableCents = rawAvailable !== null && rawAvailable > 0 ? rawAvailable : null

    if (limitCents !== null && limitCents > 0) {
      await db.update(creditCards).set({ creditLimitCents: limitCents }).where(eq(creditCards.id, conn.creditCardId))
    }
    // Mesma medição de "registrar disponível" da tela de Cartões (sem importar creditCards, que importa este arquivo).
    if (availableCents !== null) {
      await db
        .insert(creditCardSnapshots)
        .values({ cardId: conn.creditCardId, asOf: today, availableLimitCents: availableCents })
        .onConflictDoUpdate({ target: [creditCardSnapshots.cardId, creditCardSnapshots.asOf], set: { availableLimitCents: availableCents } })
    }

    const bills = await pluggy.listBills(conn.providerAccountId)
    for (const bill of bills) {
      const values = {
        creditCardId: conn.creditCardId,
        providerBillId: bill.id,
        dueDate: bill.dueDate.slice(0, 10),
        closingDate: bill.billClosingDate ? bill.billClosingDate.slice(0, 10) : null,
        totalCents: Math.round(bill.totalAmount * 100),
        minimumCents: cents(bill.minimumPaymentAmount),
        financeChargesCents: billChargesCents(bill.financeCharges),
        financeCharges: bill.financeCharges ?? [],
        syncedAt: new Date().toISOString(),
      }
      await db.insert(cardBills).values(values).onConflictDoUpdate({ target: cardBills.providerBillId, set: values })
    }

    const fetched = await pluggy.listTransactions(conn.providerAccountId, shiftMonths(today, -12), today)
    const txns: CardTxn[] = fetched.map((t) => ({
      date: saoPauloDate(t.date),
      amountCents: Math.round(t.amount * 100),
      description: t.description,
      billForecastDate: t.creditCardMetadata?.billForecastDate ?? null,
      purchaseDate: t.creditCardMetadata?.purchaseDate ?? null,
      installmentNumber: t.creditCardMetadata?.installmentNumber ?? null,
      totalInstallments: t.creditCardMetadata?.totalInstallments ?? null,
      feeInfo: t.creditCardMetadata?.feeTypeAdditionalInfo ?? null,
      category: t.category,
    }))
    // Ciclos pelo fechamento real das faturas fechadas, mais o ciclo aberto (um mês depois do último).
    const closed = bills
      .filter((b) => b.billClosingDate)
      .map((b) => ({ closing: b.billClosingDate!.slice(0, 10), period: b.dueDate.slice(0, 7) }))
      .sort((a, b) => a.closing.localeCompare(b.closing))
    const last = closed[closed.length - 1]
    const cycles: BillCycle[] = last
      ? [...closed, { closing: shiftMonths(last.closing, 1), period: shiftMonths(`${last.period}-01`, 1).slice(0, 7) }]
      : []
    const months = summarizeCard(txns, cycles)
    await db.transaction(async (tx) => {
      await tx.delete(cardMonths).where(eq(cardMonths.creditCardId, conn.creditCardId))
      if (months.length) await tx.insert(cardMonths).values(months.map((m) => ({ ...m, creditCardId: conn.creditCardId })))
    })

    await db
      .update(cardConnections)
      .set({
        balanceCents: cents(account.balance),
        availableCents,
        minimumPaymentCents: cents(credit.minimumPayment),
        dueDate: credit.balanceDueDate ? credit.balanceDueDate.slice(0, 10) : null,
        lastSyncedAt: new Date().toISOString(),
        lastError: null,
      })
      .where(eq(cardConnections.id, id))
    return { bills: bills.length, months: months.length, transactions: txns.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.update(cardConnections).set({ lastError: message }).where(eq(cardConnections.id, id))
    throw error
  }
}

/** Todos os cartões ligados, um de cada vez; erro em um não para os outros (fica em `lastError`). */
export async function syncAllCards() {
  const results: Array<{ cardConnectionId: number; ok: boolean; error?: string }> = []
  for (const conn of await db.select({ id: cardConnections.id }).from(cardConnections).orderBy(cardConnections.id)) {
    try {
      await syncCard(conn.id)
      results.push({ cardConnectionId: conn.id, ok: true })
    } catch (error) {
      results.push({ cardConnectionId: conn.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { results }
}

/** Resumo por cartão para Cartões e Endividamento: origem, saldo, meses de fatura e faturas fechadas. */
export async function cardSummaries(cardIds: number[]) {
  if (cardIds.length === 0) return new Map<number, never>()
  const [conns, months, bills] = await Promise.all([
    db.select().from(cardConnections),
    db.select().from(cardMonths),
    db.execute<{ creditCardId: number; dueDate: string; totalCents: number; financeChargesCents: number }>(sql`
      select credit_card_id as "creditCardId", due_date as "dueDate", total_cents as "totalCents", finance_charges_cents as "financeChargesCents"
      from card_bills order by due_date desc`),
  ])
  const out = new Map<
    number,
    {
      connection: typeof cardConnections.$inferSelect | null
      months: Array<typeof cardMonths.$inferSelect>
      bills: Array<{ dueDate: string; totalCents: number; financeChargesCents: number }>
    }
  >()
  for (const id of cardIds) {
    out.set(id, {
      connection: conns.find((c) => c.creditCardId === id) ?? null,
      months: months.filter((m) => m.creditCardId === id).sort((a, b) => a.period.localeCompare(b.period)),
      bills: bills.filter((b) => Number(b.creditCardId) === id).map((b) => ({ dueDate: b.dueDate, totalCents: Number(b.totalCents), financeChargesCents: Number(b.financeChargesCents) })),
    })
  }
  return out
}

