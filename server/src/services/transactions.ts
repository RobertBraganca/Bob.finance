import { and, desc, eq, gte, inArray, isNull, like, lte, ne, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client'
import { accounts, categories, categoryRules, cashFlowForecasts, debts, transactions } from '../db/schema'
import { dedupeHash, directionOf, merchantSignature, normalizeDescription } from '../core/normalize'
import { EXPLICIT_RULE_PRIORITY, learnCorrection } from './categorization'
import { deletePending, type PendingDeleteScope } from './cashFlow'

export type TransactionFilter = {
  from?: string
  to?: string
  accountId?: number
  categoryId?: number
  /** include children of this category */
  parentCategoryId?: number
  direction?: 'in' | 'out'
  /** filters by the category's own kind (income/expense/transfer/investment) — independent of direction, since a transfer moves either way */
  categoryKind?: string
  uncategorized?: boolean
  search?: string
  source?: string
  limit?: number
  offset?: number
}

const MONTH_NAMES = [
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]
const MONTH_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

/** decisions/0025: nome de categoria real (não `rawCategory`) — a
 * tabela é pequena o bastante para filtrar em JS a cada busca, então
 * não precisa de uma coluna normalizada dedicada só para isto. */
async function categoryIdsMatching(search: string): Promise<number[]> {
  const needle = normalizeDescription(search)
  if (!needle) return []
  return (await db.select({ id: categories.id, name: categories.name }).from(categories))
    .filter((c) => normalizeDescription(c.name).includes(needle))
    .map((c) => c.id)
}

/** decisions/0025: reconhece DD/MM/AAAA, DD/MM, AAAA-MM-DD, AAAA-MM, e
 * nome de mês (por extenso ou abreviado) com ou sem ano — nunca um
 * número solto, que combinaria com quase qualquer valor ou descrição. */
function parseSearchDate(search: string): SQL | null {
  const trimmed = search.trim()

  let m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return eq(transactions.postedOn, `${m[1]}-${m[2]}-${m[3]}`)

  m = trimmed.match(/^(\d{4})-(\d{2})$/)
  if (m) return like(transactions.postedOn, `${m[1]}-${m[2]}-%`)

  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) {
    const day = m[1]!.padStart(2, '0')
    const month = m[2]!.padStart(2, '0')
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null
    return eq(transactions.postedOn, `${year}-${month}-${day}`)
  }

  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/)
  if (m) {
    const day = m[1]!.padStart(2, '0')
    const month = m[2]!.padStart(2, '0')
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null
    return sql`to_char(${transactions.postedOn}::date, 'MM-DD') = ${`${month}-${day}`}`
  }

  const normalized = normalizeDescription(trimmed)
  const yearMatch = normalized.match(/\b(20\d{2})\b/)
  const withoutYear = normalized
    .replace(/\b20\d{2}\b/g, '')
    .replace(/\bde\b/g, '')
    .replace(/[/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const monthIndex = MONTH_NAMES.indexOf(withoutYear) !== -1 ? MONTH_NAMES.indexOf(withoutYear) : MONTH_ABBR.indexOf(withoutYear)
  if (monthIndex !== -1) {
    const month = String(monthIndex + 1).padStart(2, '0')
    if (yearMatch) return sql`to_char(${transactions.postedOn}::date, 'YYYY-MM') = ${`${yearMatch[1]}-${month}`}`
    return sql`to_char(${transactions.postedOn}::date, 'MM') = ${month}`
  }

  return null
}

export async function buildWhere(filter: TransactionFilter): Promise<SQL | undefined> {
  const parts: SQL[] = []
  if (filter.from) parts.push(gte(transactions.postedOn, filter.from))
  if (filter.to) parts.push(lte(transactions.postedOn, filter.to))
  if (filter.accountId) parts.push(eq(transactions.accountId, filter.accountId))
  if (filter.direction) parts.push(eq(transactions.direction, filter.direction))
  if (filter.source) parts.push(eq(transactions.source, filter.source as (typeof transactions.$inferSelect)['source']))
  if (filter.categoryKind) {
    parts.push(
      sql`${transactions.categoryId} IN (SELECT id FROM categories WHERE kind = ${filter.categoryKind})`,
    )
  }
  if (filter.uncategorized) parts.push(isNull(transactions.categoryId))
  if (filter.categoryId) parts.push(eq(transactions.categoryId, filter.categoryId))
  if (filter.parentCategoryId) {
    parts.push(
      sql`${transactions.categoryId} IN (SELECT id FROM categories WHERE id = ${filter.parentCategoryId} OR parent_id = ${filter.parentCategoryId})`,
    )
  }
  if (filter.search) {
    const needle = `%${normalizeDescription(filter.search)}%`
    const orParts: SQL[] = [like(transactions.descriptionNorm, needle), like(transactions.rawCategory, needle)]
    const matchingCategoryIds = await categoryIdsMatching(filter.search)
    if (matchingCategoryIds.length > 0) orParts.push(inArray(transactions.categoryId, matchingCategoryIds))
    const dateCondition = parseSearchDate(filter.search)
    if (dateCondition) orParts.push(dateCondition)
    parts.push(or(...orParts)!)
  }
  return parts.length > 0 ? and(...parts) : undefined
}

export async function listTransactions(filter: TransactionFilter) {
  const where = await buildWhere(filter)
  const limit = Math.min(filter.limit ?? 200, 2000)
  const offset = filter.offset ?? 0

  const [rows, totalsRow] = await Promise.all([
    db
      .select({
        id: transactions.id,
        postedOn: transactions.postedOn,
        description: transactions.description,
        amountCents: transactions.amountCents,
        direction: transactions.direction,
        categoryId: transactions.categoryId,
        categoryName: categories.name,
        categoryColor: categories.color,
        parentCategoryId: categories.parentId,
        rawCategory: transactions.rawCategory,
        source: transactions.source,
        categorizedBy: transactions.categorizedBy,
        accountId: transactions.accountId,
        accountName: accounts.name,
        notes: transactions.notes,
        duplicateAccepted: transactions.duplicateAccepted,
        pending: transactions.pending,
        forecastId: transactions.forecastId,
        debtId: transactions.debtId,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .leftJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(where)
      .orderBy(desc(transactions.postedOn), desc(transactions.id))
      .limit(limit)
      .offset(offset),
    // Confirmed and pending are summed separately — a materialized future
    // receipt (see cashFlow.ts) sits in this same table so it can be edited
    // and shows up where the user expects it, but it must never quietly
    // inflate "confirmed" totals for a period that hasn't actually happened
    // yet. The pending figures are still returned, just kept apart.
    db
      .select({
        count: sql<number>`count(*)`,
        inflowCents: sql<number>`coalesce(sum(case when amount_cents > 0 and pending = false then amount_cents else 0 end), 0)`,
        outflowCents: sql<number>`coalesce(sum(case when amount_cents < 0 and pending = false then -amount_cents else 0 end), 0)`,
        pendingInflowCents: sql<number>`coalesce(sum(case when amount_cents > 0 and pending = true then amount_cents else 0 end), 0)`,
        pendingOutflowCents: sql<number>`coalesce(sum(case when amount_cents < 0 and pending = true then -amount_cents else 0 end), 0)`,
      })
      .from(transactions)
      .where(where),
  ])
  const totals = totalsRow[0]

  return {
    rows,
    total: totals?.count ?? 0,
    inflowCents: totals?.inflowCents ?? 0,
    outflowCents: totals?.outflowCents ?? 0,
    pendingInflowCents: totals?.pendingInflowCents ?? 0,
    pendingOutflowCents: totals?.pendingOutflowCents ?? 0,
    limit,
    offset,
  }
}

/**
 * Assigns a category by hand. This is the moment the app learns: the
 * correction is recorded against the merchant signature, and after enough
 * confirmations it hardens into a real rule.
 */
export async function setCategory(
  ids: number[],
  categoryId: number | null,
  options: { learn?: boolean; saveAsRule?: boolean } = {},
) {
  if (ids.length === 0) return { updated: 0, learned: [], ruleId: null }

  const rows = await db
    .select({ id: transactions.id, description: transactions.description })
    .from(transactions)
    .where(inArray(transactions.id, ids))

  await db
    .update(transactions)
    .set({
      categoryId,
      categorizedBy: categoryId === null ? 'none' : 'manual',
      ruleId: null,
      updatedAt: sql`now_iso()`,
    })
    .where(inArray(transactions.id, ids))

  const learned: Array<{ signature: string; hits: number; promoted: boolean }> = []
  if (categoryId !== null && (options.learn ?? true)) {
    const seen = new Set<string>()
    for (const row of rows) {
      const signature = merchantSignature(row.description)
      if (!signature || seen.has(signature)) continue
      seen.add(signature)
      const result = await learnCorrection(row.description, categoryId)
      if (result) learned.push({ signature: result.signature, hits: result.hits, promoted: result.promoted })
    }
  }

  let ruleId: number | null = null
  if (categoryId !== null && options.saveAsRule && rows.length > 0) {
    const signature = merchantSignature(rows[0]!.description)
    if (signature) {
      const existing = (
        await db
          .select()
          .from(categoryRules)
          .where(
            and(
              eq(categoryRules.field, 'description'),
              eq(categoryRules.matchType, 'contains'),
              eq(categoryRules.pattern, signature),
            ),
          )
      )[0]
      ruleId =
        existing?.id ??
        (
          await db
            .insert(categoryRules)
            .values({
              categoryId,
              field: 'description',
              matchType: 'contains',
              pattern: signature,
              priority: EXPLICIT_RULE_PRIORITY,
              origin: 'user',
            })
            .returning({ id: categoryRules.id })
        )[0]!.id
    }
  }

  return { updated: rows.length, learned, ruleId }
}

export type ManualEntry = {
  accountId: number
  postedOn: string
  description: string
  amountCents: number
  categoryId?: number | null
  notes?: string | null
  source?: 'manual' | 'daily' | 'adjustment'
  /** the approved quote this revenue came from, if any */
  sourceQuoteId?: number | null
}

/** Quick-add path used by both the daily tracker and the manual entry form. */
export async function createTransaction(entry: ManualEntry) {
  const descriptionNorm = normalizeDescription(entry.description)
  const hash = dedupeHash({
    accountId: entry.accountId,
    postedOn: entry.postedOn,
    amountCents: entry.amountCents,
    descriptionNorm,
  })

  const inserted = (
    await db
      .insert(transactions)
      .values({
        accountId: entry.accountId,
        postedOn: entry.postedOn,
        description: entry.description,
        descriptionNorm,
        amountCents: entry.amountCents,
        direction: directionOf(entry.amountCents),
        categoryId: entry.categoryId ?? null,
        source: entry.source ?? 'manual',
        categorizedBy: entry.categoryId ? 'manual' : 'none',
        dedupeHash: hash,
        sourceQuoteId: entry.sourceQuoteId ?? null,
      })
      .returning()
  )[0]!

  if (entry.categoryId) await learnCorrection(entry.description, entry.categoryId)
  return inserted
}

/**
 * `scope` (decisions/0029, mesmos três valores de `PendingDeleteScope`):
 * "esta e as futuras" / "todas" propagam descrição/valor/conta ao MODELO
 * (a previsão ou a dívida) e às demais ocorrências ainda pendentes — nunca
 * a data (cada ocorrência tem o próprio dia) nem as notas (só desta). Sem
 * isso, um reajuste de salário só corrigiria este mês: o modelo continuaria
 * com o valor antigo e voltaria a produzir lançamentos errados quando o
 * horizonte de materialização avançasse (decisions/0028).
 */
export async function updateTransaction(
  id: number,
  patch: {
    postedOn?: string
    description?: string
    amountCents?: number
    accountId?: number
    notes?: string | null
  },
  scope: PendingDeleteScope = 'only',
) {
  const current = (await db.select().from(transactions).where(eq(transactions.id, id)))[0]
  if (!current) return null

  const description = patch.description ?? current.description
  const amountCents = patch.amountCents ?? current.amountCents
  const postedOn = patch.postedOn ?? current.postedOn
  const accountId = patch.accountId ?? current.accountId
  const descriptionNorm = normalizeDescription(description)

  // Editing the fields that syncMaterializedRows (debt.ts / cashFlow.ts)
  // would otherwise overwrite on the next template edit marks this specific
  // occurrence as the user's, not the template's — see `decisions/0017`.
  const editsMaterializedFields =
    patch.postedOn !== undefined || patch.description !== undefined || patch.amountCents !== undefined
  const manuallyEdited =
    current.manuallyEdited ||
    (editsMaterializedFields && current.pending && (current.forecastId !== null || current.debtId !== null))

  const updated = (
    await db
      .update(transactions)
      .set({
        postedOn,
        description,
        descriptionNorm,
        amountCents,
        accountId,
        direction: directionOf(amountCents),
        notes: patch.notes !== undefined ? patch.notes : current.notes,
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, descriptionNorm }),
        manuallyEdited,
        updatedAt: sql`now_iso()`,
      })
      .where(eq(transactions.id, id))
      .returning()
  )[0]!

  const cascadable: { description?: string; amountCents?: number; accountId?: number } = {}
  if (patch.description !== undefined) cascadable.description = description
  if (patch.amountCents !== undefined) cascadable.amountCents = amountCents
  if (patch.accountId !== undefined) cascadable.accountId = accountId

  if (scope !== 'only' && Object.keys(cascadable).length > 0 && (current.forecastId !== null || current.debtId !== null)) {
    await cascadeToTemplate(current, cascadable, scope)
  }

  return updated
}

async function cascadeToTemplate(
  current: typeof transactions.$inferSelect,
  cascadable: { description?: string; amountCents?: number; accountId?: number },
  scope: PendingDeleteScope,
) {
  if (current.forecastId !== null) {
    await db.update(cashFlowForecasts).set(cascadable).where(eq(cashFlowForecasts.id, current.forecastId))
  } else if (current.debtId !== null) {
    await db
      .update(debts)
      .set({
        ...(cascadable.description !== undefined ? { name: cascadable.description } : {}),
        ...(cascadable.amountCents !== undefined ? { scheduledPaymentCents: Math.abs(cascadable.amountCents) } : {}),
        ...(cascadable.accountId !== undefined ? { accountId: cascadable.accountId } : {}),
      })
      .where(eq(debts.id, current.debtId))
  }

  const period = current.occurrencePeriod ?? current.postedOn.slice(0, 7)
  const siblings = await db
    .select()
    .from(transactions)
    .where(
      and(
        current.forecastId !== null
          ? eq(transactions.forecastId, current.forecastId)
          : eq(transactions.debtId, current.debtId!),
        eq(transactions.pending, true),
        ne(transactions.id, current.id),
      ),
    )

  for (const s of siblings) {
    const sPeriod = s.occurrencePeriod ?? s.postedOn.slice(0, 7)
    if (scope === 'this_and_future' && sPeriod < period) continue
    const sDescription = cascadable.description ?? s.description
    const sAmountCents = cascadable.amountCents ?? s.amountCents
    const sAccountId = cascadable.accountId ?? s.accountId
    const sDescriptionNorm = normalizeDescription(sDescription)
    await db
      .update(transactions)
      .set({
        description: sDescription,
        descriptionNorm: sDescriptionNorm,
        amountCents: sAmountCents,
        accountId: sAccountId,
        direction: directionOf(sAmountCents),
        dedupeHash: dedupeHash({
          accountId: sAccountId,
          postedOn: s.postedOn,
          amountCents: sAmountCents,
          descriptionNorm: sDescriptionNorm,
        }),
        updatedAt: sql`now_iso()`,
      })
      .where(eq(transactions.id, s.id))
  }
}

/**
 * Excluding a plain transaction (CSV, diário, manual) is a direct row
 * delete. A pending row still tied to a forecast/debt template goes
 * through `cashFlowService.deletePending` instead (`decisions/0020`) — a
 * raw delete here would leave `skippedOccurrences` untouched, so the next
 * materialization pass would silently recreate exactly what the user just
 * removed. `scope` only matters for template-linked ids; a plain id
 * ignores it.
 */
export async function deleteTransactions(ids: number[], scope: PendingDeleteScope = 'only') {
  if (ids.length === 0) return { removed: 0 }

  const rows = await db
    .select({ id: transactions.id, pending: transactions.pending, forecastId: transactions.forecastId, debtId: transactions.debtId })
    .from(transactions)
    .where(inArray(transactions.id, ids))

  const templated = rows.filter((r) => r.pending && (r.forecastId || r.debtId)).map((r) => r.id)
  const plain = rows.filter((r) => !(r.pending && (r.forecastId || r.debtId))).map((r) => r.id)

  let removed = 0
  if (plain.length > 0) removed += (await db.delete(transactions).where(inArray(transactions.id, plain))).count
  for (const id of templated) removed += (await deletePending(id, scope)).removed

  return { removed }
}

/**
 * Earliest and latest posted date in the ledger — drives default date
 * ranges. Pending rows are excluded: a materialized future forecast
 * would otherwise push `max` into a month with no real data yet,
 * anchoring every "mês atual"/"máximo" preset on a blank period.
 */
export async function ledgerBounds() {
  const row = (
    await db
      .select({
        min: sql<string | null>`min(posted_on)`,
        max: sql<string | null>`max(posted_on)`,
        count: sql<number>`count(*)`,
      })
      .from(transactions)
      .where(eq(transactions.pending, false))
  )[0]
  return { min: row?.min ?? null, max: row?.max ?? null, count: row?.count ?? 0 }
}
