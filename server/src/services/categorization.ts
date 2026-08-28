import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { categories, categoryMemory, categoryRules, transactions } from '../db/schema'
import { AUTO_PROMOTE_AT, Categorizer, type MemoryRow, type RuleRow } from '../categorize/engine'
import { merchantSignature, normalizeDescription } from '../core/normalize'

export async function loadCategorizer(): Promise<Categorizer> {
  const rules: RuleRow[] = await db
    .select({
      id: categoryRules.id,
      categoryId: categoryRules.categoryId,
      field: categoryRules.field,
      matchType: categoryRules.matchType,
      pattern: categoryRules.pattern,
      direction: categoryRules.direction,
      amountMinCents: categoryRules.amountMinCents,
      amountMaxCents: categoryRules.amountMaxCents,
      accountId: categoryRules.accountId,
      priority: categoryRules.priority,
      active: categoryRules.active,
    })
    .from(categoryRules)

  const memory: MemoryRow[] = await db
    .select({
      signature: categoryMemory.signature,
      categoryId: categoryMemory.categoryId,
      hits: categoryMemory.hits,
      lastSeenAt: categoryMemory.lastSeenAt,
    })
    .from(categoryMemory)

  const cats = await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.archived, false))

  return new Categorizer(rules, memory, cats)
}

export type LearnResult = {
  signature: string
  hits: number
  promotedRuleId: number | null
  promoted: boolean
}

/**
 * Records a manual correction. The counter is the learning; promotion to a
 * real rule happens once the same correction has been confirmed
 * AUTO_PROMOTE_AT times, so one-off overrides never harden into rules.
 */
export async function learnCorrection(description: string, categoryId: number): Promise<LearnResult | null> {
  const signature = merchantSignature(description)
  if (!signature) return null

  const existing = (
    await db
      .select()
      .from(categoryMemory)
      .where(and(eq(categoryMemory.signature, signature), eq(categoryMemory.categoryId, categoryId)))
  )[0]

  let hits: number
  let promotedRuleId: number | null

  if (existing) {
    hits = existing.hits + 1
    promotedRuleId = existing.promotedRuleId
    await db
      .update(categoryMemory)
      .set({ hits, lastSeenAt: sql`now_iso()` })
      .where(eq(categoryMemory.id, existing.id))
  } else {
    hits = 1
    promotedRuleId = null
    await db.insert(categoryMemory).values({ signature, categoryId, hits })
  }

  // A correction that contradicts a previous one for the same merchant loses
  // weight, so the memory converges on the user's latest intent.
  await db
    .update(categoryMemory)
    .set({ hits: sql`greatest(1, ${categoryMemory.hits} - 1)` })
    .where(and(eq(categoryMemory.signature, signature), sql`${categoryMemory.categoryId} <> ${categoryId}`))

  let promoted = false
  if (hits >= AUTO_PROMOTE_AT && promotedRuleId === null) {
    const rule = await promoteToRule(signature, categoryId)
    if (rule) {
      promotedRuleId = rule
      promoted = true
      await db
        .update(categoryMemory)
        .set({ promotedRuleId: rule })
        .where(and(eq(categoryMemory.signature, signature), eq(categoryMemory.categoryId, categoryId)))
    }
  }

  return { signature, hits, promotedRuleId, promoted }
}

/**
 * Turns a learned signature into a real rule.
 *
 * Priority semantics (lower number is evaluated first and therefore wins) are
 * ordered by how much user intent the rule represents:
 *
 *   20   rule the user explicitly asked to save from a correction
 *   50   auto-promoted from repeated corrections  <-- this function
 *   80+  seeded defaults and generic patterns
 *
 * A learned rule has to outrank the seeded generics, otherwise correcting
 * "MERCADO LIVRE" would lose forever to the broad "mercado" default and the
 * learning would have no observable effect.
 */
export const LEARNED_RULE_PRIORITY = 50
export const EXPLICIT_RULE_PRIORITY = 20
export async function promoteToRule(signature: string, categoryId: number): Promise<number | null> {
  const pattern = normalizeDescription(signature)
  if (!pattern) return null

  const existing = (
    await db
      .select()
      .from(categoryRules)
      .where(
        and(
          eq(categoryRules.field, 'description'),
          eq(categoryRules.matchType, 'contains'),
          eq(categoryRules.pattern, pattern),
          eq(categoryRules.direction, 'any'),
        ),
      )
  )[0]

  if (existing) {
    if (existing.categoryId !== categoryId) {
      await db.update(categoryRules).set({ categoryId }).where(eq(categoryRules.id, existing.id))
    }
    return existing.id
  }

  const inserted = (
    await db
      .insert(categoryRules)
      .values({
        categoryId,
        field: 'description',
        matchType: 'contains',
        pattern,
        direction: 'any',
        priority: LEARNED_RULE_PRIORITY,
        origin: 'learned',
      })
      .returning({ id: categoryRules.id })
  )[0]!

  return inserted.id
}

export type RecategorizeScope = {
  /** only rows with no category yet (default) or every row */
  onlyUncategorized?: boolean
  /** restrict to these transaction ids */
  ids?: number[]
}

/**
 * Re-runs the engine over existing transactions. Manual assignments are
 * never overwritten unless the caller explicitly targets them by id.
 */
export async function recategorize(scope: RecategorizeScope = {}): Promise<{ scanned: number; updated: number }> {
  const categorizer = await loadCategorizer()
  const onlyUncategorized = scope.onlyUncategorized ?? true

  const conditions = []
  if (scope.ids && scope.ids.length > 0) conditions.push(inArray(transactions.id, scope.ids))
  if (onlyUncategorized) conditions.push(isNull(transactions.categoryId))
  else conditions.push(sql`${transactions.categorizedBy} <> 'manual'`)

  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      descriptionNorm: transactions.descriptionNorm,
      description: transactions.description,
      amountCents: transactions.amountCents,
      rawCategory: transactions.rawCategory,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)

  let updated = 0
  const bumpRule = new Map<number, number>()

  await db.transaction(async (tx) => {
    for (const row of rows) {
      const suggestion = categorizer.suggest({
        descriptionNorm: row.descriptionNorm,
        signature: merchantSignature(row.description),
        amountCents: row.amountCents,
        rawCategory: row.rawCategory,
        accountId: row.accountId,
      })

      if (suggestion.categoryId === null || suggestion.categoryId === row.categoryId) continue

      await tx
        .update(transactions)
        .set({
          categoryId: suggestion.categoryId,
          categorizedBy: suggestion.source,
          ruleId: suggestion.ruleId,
          updatedAt: sql`now_iso()`,
        })
        .where(eq(transactions.id, row.id))

      if (suggestion.ruleId !== null) {
        bumpRule.set(suggestion.ruleId, (bumpRule.get(suggestion.ruleId) ?? 0) + 1)
      }
      updated++
    }

    for (const [ruleId, hits] of bumpRule) {
      await tx
        .update(categoryRules)
        .set({ hitCount: sql`${categoryRules.hitCount} + ${hits}` })
        .where(eq(categoryRules.id, ruleId))
    }
  })

  return { scanned: rows.length, updated }
}
