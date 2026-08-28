import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { categories, categoryMemory, categoryRules, transactions } from '../db/schema'
import { AUTO_PROMOTE_AT, Categorizer, type MemoryRow, type RuleRow } from '../categorize/engine'
import { merchantSignature, normalizeDescription } from '../core/normalize'

export function loadCategorizer(): Categorizer {
  const rules = db
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
    .all() as RuleRow[]

  const memory = db
    .select({
      signature: categoryMemory.signature,
      categoryId: categoryMemory.categoryId,
      hits: categoryMemory.hits,
      lastSeenAt: categoryMemory.lastSeenAt,
    })
    .from(categoryMemory)
    .all() as MemoryRow[]

  const cats = db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.archived, false))
    .all()

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
export function learnCorrection(description: string, categoryId: number): LearnResult | null {
  const signature = merchantSignature(description)
  if (!signature) return null

  const existing = db
    .select()
    .from(categoryMemory)
    .where(and(eq(categoryMemory.signature, signature), eq(categoryMemory.categoryId, categoryId)))
    .get()

  let hits: number
  let promotedRuleId: number | null

  if (existing) {
    hits = existing.hits + 1
    promotedRuleId = existing.promotedRuleId
    db.update(categoryMemory)
      .set({ hits, lastSeenAt: sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))` })
      .where(eq(categoryMemory.id, existing.id))
      .run()
  } else {
    hits = 1
    promotedRuleId = null
    db.insert(categoryMemory).values({ signature, categoryId, hits }).run()
  }

  // A correction that contradicts a previous one for the same merchant loses
  // weight, so the memory converges on the user's latest intent.
  db.update(categoryMemory)
    .set({ hits: sql`max(1, ${categoryMemory.hits} - 1)` })
    .where(and(eq(categoryMemory.signature, signature), sql`${categoryMemory.categoryId} <> ${categoryId}`))
    .run()

  let promoted = false
  if (hits >= AUTO_PROMOTE_AT && promotedRuleId === null) {
    const rule = promoteToRule(signature, categoryId)
    if (rule) {
      promotedRuleId = rule
      promoted = true
      db.update(categoryMemory)
        .set({ promotedRuleId: rule })
        .where(and(eq(categoryMemory.signature, signature), eq(categoryMemory.categoryId, categoryId)))
        .run()
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
export function promoteToRule(signature: string, categoryId: number): number | null {
  const pattern = normalizeDescription(signature)
  if (!pattern) return null

  const existing = db
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
    .get()

  if (existing) {
    if (existing.categoryId !== categoryId) {
      db.update(categoryRules).set({ categoryId }).where(eq(categoryRules.id, existing.id)).run()
    }
    return existing.id
  }

  const inserted = db
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
    .get()

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
export function recategorize(scope: RecategorizeScope = {}): { scanned: number; updated: number } {
  const categorizer = loadCategorizer()
  const onlyUncategorized = scope.onlyUncategorized ?? true

  const conditions = []
  if (scope.ids && scope.ids.length > 0) conditions.push(inArray(transactions.id, scope.ids))
  if (onlyUncategorized) conditions.push(isNull(transactions.categoryId))
  else conditions.push(sql`${transactions.categorizedBy} <> 'manual'`)

  const rows = db
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
    .all()

  let updated = 0
  const bumpRule = new Map<number, number>()

  db.transaction((tx) => {
    for (const row of rows) {
      const suggestion = categorizer.suggest({
        descriptionNorm: row.descriptionNorm,
        signature: merchantSignature(row.description),
        amountCents: row.amountCents,
        rawCategory: row.rawCategory,
        accountId: row.accountId,
      })

      if (suggestion.categoryId === null || suggestion.categoryId === row.categoryId) continue

      tx.update(transactions)
        .set({
          categoryId: suggestion.categoryId,
          categorizedBy: suggestion.source,
          ruleId: suggestion.ruleId,
          updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
        })
        .where(eq(transactions.id, row.id))
        .run()

      if (suggestion.ruleId !== null) {
        bumpRule.set(suggestion.ruleId, (bumpRule.get(suggestion.ruleId) ?? 0) + 1)
      }
      updated++
    }

    for (const [ruleId, hits] of bumpRule) {
      tx.update(categoryRules)
        .set({ hitCount: sql`${categoryRules.hitCount} + ${hits}` })
        .where(eq(categoryRules.id, ruleId))
        .run()
    }
  })

  return { scanned: rows.length, updated }
}
