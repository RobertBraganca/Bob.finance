import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { cardBills, cardConnections, cardMonths, creditCardSnapshots, creditCards } from '../db/schema.ts'
import { billChargesCents, chargeCreditsByPeriod, summarizeCard, type BillCycle, type CardTxn } from '../core/cardSummary.ts'
import * as pluggy from './pluggy.ts'
import { addMonths, addMonthsToDate, saoPauloDate, todayIso } from '../core/dates.ts'
import { idList } from './withdrawals.ts'

/**
 * Resumo dos cartões pelo Meu Pluggy (specs/card-summary-sync,
 * decisions/0044): limite, saldo, faturas fechadas e o resumo por mês.
 * Nenhuma compra vira lançamento do app.
 */

const cents = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 100))

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

/** Desconectar apaga o resumo guardado do cartão (faturas e meses); a conexão no Meu Pluggy não é tocada. */
export async function deleteCardConnection(id: number) {
  const conn = (await db.select({ creditCardId: cardConnections.creditCardId }).from(cardConnections).where(eq(cardConnections.id, id)))[0]
  if (!conn) return { deleted: false }
  await db.transaction(async (tx) => {
    await tx.delete(cardMonths).where(eq(cardMonths.creditCardId, conn.creditCardId))
    await tx.delete(cardBills).where(eq(cardBills.creditCardId, conn.creditCardId))
    await tx.delete(cardConnections).where(eq(cardConnections.id, id))
  })
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
    const today = todayIso()
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

    const fetched = await pluggy.listTransactions(conn.providerAccountId, addMonthsToDate(today, -12), today)
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
      ? [...closed, { closing: addMonthsToDate(last.closing, 1), period: addMonths(last.period, 1) }]
      : []
    const months = summarizeCard(txns, cycles)

    // Encargo líquido de cada fatura: o bruto da lista do banco menos os
    // créditos de juros do mesmo ciclo (antecipação, estorno).
    const credits = chargeCreditsByPeriod(txns, cycles)
    const syncedAt = new Date().toISOString()
    // Um insert com a mesma fatura duas vezes falha ("cannot affect row a second time"): fica a última.
    const billRows = [...new Map(bills.map((bill) => [bill.id, bill] as const)).values()].map((bill) => {
      const due = bill.dueDate.slice(0, 10)
      return {
        creditCardId: conn.creditCardId,
        providerBillId: bill.id,
        dueDate: due,
        closingDate: bill.billClosingDate ? bill.billClosingDate.slice(0, 10) : null,
        totalCents: Math.round(bill.totalAmount * 100),
        minimumCents: cents(bill.minimumPaymentAmount),
        financeChargesCents: Math.max(0, billChargesCents(bill.financeCharges) - (credits.get(due.slice(0, 7)) ?? 0)),
        financeCharges: bill.financeCharges ?? [],
        syncedAt,
      }
    })
    // Faturas e meses mudam juntos: uma queda no meio não deixa fatura nova com mês antigo.
    await db.transaction(async (tx) => {
      if (billRows.length) {
        await tx
          .insert(cardBills)
          .values(billRows)
          .onConflictDoUpdate({
            target: cardBills.providerBillId,
            set: {
              creditCardId: sql`excluded.credit_card_id`,
              dueDate: sql`excluded.due_date`,
              closingDate: sql`excluded.closing_date`,
              totalCents: sql`excluded.total_cents`,
              minimumCents: sql`excluded.minimum_cents`,
              financeChargesCents: sql`excluded.finance_charges_cents`,
              financeCharges: sql`excluded.finance_charges`,
              syncedAt: sql`excluded.synced_at`,
            },
          })
      }
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
    db.select().from(cardConnections).where(inArray(cardConnections.creditCardId, cardIds)),
    db.select().from(cardMonths).where(inArray(cardMonths.creditCardId, cardIds)),
    db.execute<{ creditCardId: number; dueDate: string; totalCents: number; financeChargesCents: number }>(sql`
      select credit_card_id as "creditCardId", due_date as "dueDate", total_cents as "totalCents", finance_charges_cents as "financeChargesCents"
      from card_bills
      where credit_card_id in (${idList(cardIds)})
      order by due_date desc`),
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

