import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { assetCriteriaAnswers, assets, criteria } from '../db/schema'

/**
 * "Diagrama do Cerrado" resistance scoring.
 *
 * Each asset class has its own bank of yes/no questions (a stock's
 * questions — ROE, debt, dividend history — are not a FII's — vacancy,
 * P/VP). Every checked box is worth +1, every unchecked box -1; the sum
 * is the asset's resistance note, clamped to 0-10 so it can drive an
 * allocation weight (a negative or unbounded note has no meaning there).
 *
 * The note is never stored — it is always summed fresh from
 * `asset_criteria_answers` here, the same way every other number in
 * this app derives from source rows rather than a cached column that
 * could drift out of sync with the answers that produced it.
 *
 * A criterion the user has not answered yet contributes NOTHING (not
 * -1) — scoring an asset before its questionnaire is filled out would
 * unfairly veto it. The UI surfaces "answered / total" so an
 * incomplete score is visible, never silently treated as complete.
 */

export type CriterionRow = {
  id: number
  assetClass: string
  label: string
  sortOrder: number
  active: boolean
}

export function listCriteria(assetClass?: string): CriterionRow[] {
  return db
    .select()
    .from(criteria)
    .where(
      assetClass
        ? and(eq(criteria.assetClass, assetClass), eq(criteria.active, true))
        : eq(criteria.active, true),
    )
    .orderBy(criteria.sortOrder, criteria.id)
    .all()
}

export function createCriterion(input: { assetClass: string; label: string; sortOrder?: number }) {
  const count =
    db
      .select({ n: sql<number>`count(*)` })
      .from(criteria)
      .where(eq(criteria.assetClass, input.assetClass))
      .get()?.n ?? 0
  return db
    .insert(criteria)
    .values({ ...input, sortOrder: input.sortOrder ?? count })
    .returning()
    .get()
}

export function updateCriterion(id: number, patch: { label?: string; active?: boolean; sortOrder?: number }) {
  return db.update(criteria).set(patch).where(eq(criteria.id, id)).returning().get() ?? null
}

/** Hard-deletes the question; every answer to it cascades away with it. */
export function deleteCriterion(id: number) {
  return { removed: db.delete(criteria).where(eq(criteria.id, id)).run().changes }
}

export type NoteResult = {
  assetId: number
  /** raw sum: +1 per checked, -1 per unchecked, unanswered excluded */
  rawScore: number
  /**
   * rawScore clamped to 0-10 — what allocation math uses. NULL when
   * nothing has been answered yet: a note of exactly 0 is a real,
   * meaningful score (every criterion failed); "no data" is a
   * different fact and must not collapse into the same value, or an
   * asset nobody has scored would silently be treated as the worst
   * possible score instead of "not evaluated yet".
   */
  note: number | null
  answered: number
  total: number
  criteria: Array<{ id: number; label: string; checked: boolean | null }>
}

/**
 * The full questionnaire for one asset, joined with whatever the user
 * has already answered — every applicable question appears even if
 * unanswered, so the UI can render a complete checklist.
 */
export function getAssetNote(assetId: number): NoteResult | null {
  const asset = db.select({ assetClass: assets.assetClass }).from(assets).where(eq(assets.id, assetId)).get()
  if (!asset) return null

  const questions = listCriteria(asset.assetClass)
  const answers = db
    .select({ criteriaId: assetCriteriaAnswers.criteriaId, checked: assetCriteriaAnswers.checked })
    .from(assetCriteriaAnswers)
    .where(eq(assetCriteriaAnswers.assetId, assetId))
    .all()
  const answerMap = new Map(answers.map((a) => [a.criteriaId, a.checked] as const))

  let rawScore = 0
  let answered = 0
  const rows = questions.map((q) => {
    const checked = answerMap.get(q.id) ?? null
    if (checked !== null) {
      rawScore += checked ? 1 : -1
      answered++
    }
    return { id: q.id, label: q.label, checked }
  })

  return {
    assetId,
    rawScore,
    note: answered > 0 ? Math.max(0, Math.min(10, rawScore)) : null,
    answered,
    total: questions.length,
    criteria: rows,
  }
}

/**
 * Batch version for allocation/contribution math, which needs every
 * asset's note in one pass rather than N+1 queries per asset.
 */
export function notesForAssets(assetIds: number[]): Map<number, NoteResult> {
  const out = new Map<number, NoteResult>()
  if (assetIds.length === 0) return out

  const rows = db
    .select({ id: assets.id, assetClass: assets.assetClass })
    .from(assets)
    .where(inArray(assets.id, assetIds))
    .all()

  const classesNeeded = [...new Set(rows.map((r) => r.assetClass))]
  const questionsByClass = new Map(classesNeeded.map((c) => [c, listCriteria(c)] as const))

  const answers = db
    .select({
      assetId: assetCriteriaAnswers.assetId,
      criteriaId: assetCriteriaAnswers.criteriaId,
      checked: assetCriteriaAnswers.checked,
    })
    .from(assetCriteriaAnswers)
    .where(inArray(assetCriteriaAnswers.assetId, assetIds))
    .all()

  const answersByAsset = new Map<number, Map<number, boolean>>()
  for (const a of answers) {
    const bucket = answersByAsset.get(a.assetId) ?? new Map()
    bucket.set(a.criteriaId, a.checked)
    answersByAsset.set(a.assetId, bucket)
  }

  for (const row of rows) {
    const questions = questionsByClass.get(row.assetClass) ?? []
    const answerMap = answersByAsset.get(row.id) ?? new Map()
    let rawScore = 0
    let answered = 0
    const criteriaRows = questions.map((q) => {
      const checked = answerMap.get(q.id) ?? null
      if (checked !== null) {
        rawScore += checked ? 1 : -1
        answered++
      }
      return { id: q.id, label: q.label, checked }
    })
    out.set(row.id, {
      assetId: row.id,
      rawScore,
      note: answered > 0 ? Math.max(0, Math.min(10, rawScore)) : null,
      answered,
      total: questions.length,
      criteria: criteriaRows,
    })
  }

  return out
}

export function setAnswer(assetId: number, criteriaId: number, checked: boolean) {
  const existing = db
    .select()
    .from(assetCriteriaAnswers)
    .where(and(eq(assetCriteriaAnswers.assetId, assetId), eq(assetCriteriaAnswers.criteriaId, criteriaId)))
    .get()

  if (existing) {
    return db
      .update(assetCriteriaAnswers)
      .set({ checked, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))` })
      .where(eq(assetCriteriaAnswers.id, existing.id))
      .returning()
      .get()
  }
  return db.insert(assetCriteriaAnswers).values({ assetId, criteriaId, checked }).returning().get()
}

/** Clears one answer back to "unanswered" rather than forcing a false. */
export function clearAnswer(assetId: number, criteriaId: number) {
  const result = db
    .delete(assetCriteriaAnswers)
    .where(and(eq(assetCriteriaAnswers.assetId, assetId), eq(assetCriteriaAnswers.criteriaId, criteriaId)))
    .run()
  return { removed: result.changes }
}
