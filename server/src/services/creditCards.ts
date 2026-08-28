import { desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { accounts, creditCardSnapshots, creditCards } from '../db/schema'
import { daysInMonth, todayIso } from '../core/dates'

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

  return withAvailable.sort((a, b) => a.nextDueOn.localeCompare(b.nextDueOn))
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
