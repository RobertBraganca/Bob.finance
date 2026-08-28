import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  categories,
  categoryRules,
  importBatches,
  parserProfiles,
  stagedTransactions,
  transactions,
} from '../db/schema'
import { detectProfile } from '../csv/detect'
import { parseCsvWithProfile } from '../csv/parse'
import { decodeBuffer, sniffEncoding, type ResolvedProfile } from '../csv/profile'
import { directionOf } from '../core/normalize'
import { loadCategorizer } from './categorization'

/* ------------------------------------------------------------------ *
 * Profile access
 * ------------------------------------------------------------------ */
export function listProfiles(): ResolvedProfile[] {
  return db
    .select()
    .from(parserProfiles)
    .all()
    .map(toResolved)
}

export function getProfile(id: number): ResolvedProfile | null {
  const row = db.select().from(parserProfiles).where(eq(parserProfiles.id, id)).get()
  return row ? toResolved(row) : null
}

function toResolved(row: typeof parserProfiles.$inferSelect): ResolvedProfile {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    delimiter: row.delimiter as ResolvedProfile['delimiter'],
    encoding: row.encoding as ResolvedProfile['encoding'],
    dateFormat: row.dateFormat as ResolvedProfile['dateFormat'],
    decimalSeparator: row.decimalSeparator as ResolvedProfile['decimalSeparator'],
    thousandsSeparator: row.thousandsSeparator as ResolvedProfile['thousandsSeparator'],
    signConvention: row.signConvention as ResolvedProfile['signConvention'],
    hasHeader: row.hasHeader,
    skipRows: row.skipRows,
    columnMap: row.columnMap as ResolvedProfile['columnMap'],
    headerSignature: (row.headerSignature ?? []) as string[],
    ignorePatterns: (row.ignorePatterns ?? []) as string[],
    defaultAccountId: row.defaultAccountId,
    active: row.active,
  }
}

/* ------------------------------------------------------------------ *
 * Detection — a hint for the upload screen; the user always confirms.
 * ------------------------------------------------------------------ */
export function detect(buffer: Buffer) {
  const profiles = listProfiles().filter((p) => p.active)
  // Sniff the encoding first: a latin1 file decoded as UTF-8 loses every
  // accented header character, which makes signature matching fail.
  const encoding = sniffEncoding(buffer)
  const preview = decodeBuffer(buffer, encoding)
  const detection = detectProfile(preview, profiles)
  const profile = detection.profileId ? getProfile(detection.profileId) : null
  return {
    ...detection,
    detectedEncoding: encoding,
    /** true when the file's bytes disagree with the profile's declared encoding */
    encodingMismatch:
      profile !== null && normalizeEncoding(profile.encoding) !== normalizeEncoding(encoding),
    suggestedAccountId: profile?.defaultAccountId ?? null,
  }
}

const normalizeEncoding = (value: string) => (value === 'latin1' ? 'windows-1252' : value)

/* ------------------------------------------------------------------ *
 * Staging
 * ------------------------------------------------------------------ */
export type StageInput = {
  buffer: Buffer
  filename: string
  profileId: number
  accountId: number
}

export function stageImport(input: StageInput) {
  const profile = getProfile(input.profileId)
  if (!profile) throw new Error(`perfil ${input.profileId} não encontrado`)

  const text = decodeBuffer(input.buffer, profile.encoding)
  const parsed = parseCsvWithProfile(text, profile, { accountId: input.accountId })
  const categorizer = loadCategorizer()

  // In-ledger duplicates: every hash this account already holds.
  const existing = new Map<string, number>()
  for (const row of db
    .select({ id: transactions.id, dedupeHash: transactions.dedupeHash })
    .from(transactions)
    .where(eq(transactions.accountId, input.accountId))
    .all()) {
    if (!existing.has(row.dedupeHash)) existing.set(row.dedupeHash, row.id)
  }

  const seenInBatch = new Set<string>()
  let duplicateCount = 0

  const batch = db
    .insert(importBatches)
    .values({
      profileId: profile.id,
      accountId: input.accountId,
      filename: input.filename,
      rowCount: parsed.rowCount,
      parsedCount: parsed.parsedCount,
      errorCount: parsed.errorCount,
      status: 'staged',
    })
    .returning()
    .get()

  db.transaction((tx) => {
    for (const row of parsed.rows) {
      let duplicateOf: 'none' | 'in_batch' | 'in_ledger' = 'none'
      let duplicateTxnId: number | null = null

      if (row.dedupeHash) {
        const ledgerHit = existing.get(row.dedupeHash)
        if (ledgerHit !== undefined) {
          duplicateOf = 'in_ledger'
          duplicateTxnId = ledgerHit
        } else if (seenInBatch.has(row.dedupeHash)) {
          duplicateOf = 'in_batch'
        }
        seenInBatch.add(row.dedupeHash)
      }
      if (duplicateOf !== 'none') duplicateCount++

      const suggestion =
        row.parseError === null && row.amountCents !== null
          ? categorizer.suggest({
              descriptionNorm: row.descriptionNorm,
              signature: row.signature,
              amountCents: row.amountCents,
              rawCategory: row.rawCategory,
              accountId: input.accountId,
            })
          : { categoryId: null, source: 'none' as const, detail: null, ruleId: null }

      tx.insert(stagedTransactions)
        .values({
          batchId: batch.id,
          rowIndex: row.rowIndex,
          postedOn: row.postedOn,
          description: row.description,
          descriptionNorm: row.descriptionNorm,
          amountCents: row.amountCents,
          rawCategory: row.rawCategory,
          dedupeHash: row.dedupeHash,
          duplicateOf,
          duplicateTxnId,
          suggestedCategoryId: suggestion.categoryId,
          suggestionSource: suggestion.source,
          suggestionDetail: suggestion.detail,
          categoryId: suggestion.categoryId,
          // Duplicates and unparseable rows arrive unchecked; everything else
          // is pre-selected so a clean import is one click.
          include: duplicateOf === 'none' && row.parseError === null,
          parseError: row.parseError,
          rawLine: row.rawLine,
        })
        .run()
    }

    tx.update(importBatches).set({ duplicateCount }).where(eq(importBatches.id, batch.id)).run()
  })

  return {
    batchId: batch.id,
    profile: { id: profile.id, name: profile.name },
    accountId: input.accountId,
    filename: input.filename,
    rowCount: parsed.rowCount,
    parsedCount: parsed.parsedCount,
    errorCount: parsed.errorCount,
    ignoredCount: parsed.ignoredCount,
    duplicateCount,
    headers: parsed.headers,
  }
}

/* ------------------------------------------------------------------ *
 * Review screen data
 * ------------------------------------------------------------------ */
export function getBatch(batchId: number) {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get()
  if (!batch) return null

  const rows = db
    .select({
      id: stagedTransactions.id,
      rowIndex: stagedTransactions.rowIndex,
      postedOn: stagedTransactions.postedOn,
      description: stagedTransactions.description,
      amountCents: stagedTransactions.amountCents,
      rawCategory: stagedTransactions.rawCategory,
      duplicateOf: stagedTransactions.duplicateOf,
      duplicateTxnId: stagedTransactions.duplicateTxnId,
      suggestedCategoryId: stagedTransactions.suggestedCategoryId,
      suggestionSource: stagedTransactions.suggestionSource,
      suggestionDetail: stagedTransactions.suggestionDetail,
      categoryId: stagedTransactions.categoryId,
      include: stagedTransactions.include,
      parseError: stagedTransactions.parseError,
      rawLine: stagedTransactions.rawLine,
    })
    .from(stagedTransactions)
    .where(eq(stagedTransactions.batchId, batchId))
    .orderBy(stagedTransactions.rowIndex)
    .all()

  const profile = batch.profileId ? getProfile(batch.profileId) : null

  return {
    batch: { ...batch, profileName: profile?.name ?? null },
    rows,
    summary: {
      total: rows.length,
      includable: rows.filter((r) => r.include).length,
      duplicates: rows.filter((r) => r.duplicateOf !== 'none').length,
      errors: rows.filter((r) => r.parseError !== null).length,
      uncategorized: rows.filter((r) => r.categoryId === null && r.parseError === null).length,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Inline edits on the review screen
 * ------------------------------------------------------------------ */
export type StagedPatch = {
  id: number
  categoryId?: number | null
  include?: boolean
}

export function patchStagedRows(batchId: number, patches: StagedPatch[]) {
  db.transaction((tx) => {
    for (const patch of patches) {
      const set: Record<string, unknown> = {}
      if (patch.categoryId !== undefined) set.categoryId = patch.categoryId
      if (patch.include !== undefined) set.include = patch.include
      if (Object.keys(set).length === 0) continue
      tx.update(stagedTransactions)
        .set(set)
        .where(and(eq(stagedTransactions.id, patch.id), eq(stagedTransactions.batchId, batchId)))
        .run()
    }
  })
  return getBatch(batchId)
}

/* ------------------------------------------------------------------ *
 * Commit — the only path from staging into the ledger.
 * ------------------------------------------------------------------ */
export function commitImport(batchId: number) {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get()
  if (!batch) throw new Error(`lote ${batchId} não encontrado`)
  if (batch.status === 'committed') throw new Error(`lote ${batchId} já foi importado`)

  const rows = db
    .select()
    .from(stagedTransactions)
    .where(eq(stagedTransactions.batchId, batchId))
    .all()

  const committable = rows.filter(
    (r) => r.include && r.parseError === null && r.postedOn !== null && r.amountCents !== null,
  )

  const validCategoryIds = new Set(db.select({ id: categories.id }).from(categories).all().map((c) => c.id))

  let committed = 0
  const ruleHits = new Map<number, number>()

  db.transaction((tx) => {
    for (const row of committable) {
      const categoryId =
        row.categoryId !== null && validCategoryIds.has(row.categoryId) ? row.categoryId : null

      // How this row ended up in its category, tracked so the UI can explain
      // itself and so re-categorization knows what it may overwrite.
      let categorizedBy = 'none'
      let ruleId: number | null = null
      if (categoryId !== null) {
        if (row.suggestedCategoryId === categoryId && row.suggestionSource !== 'none') {
          categorizedBy = row.suggestionSource
          if (row.suggestionSource === 'rule') {
            const match = /regra #(\d+)/.exec(row.suggestionDetail ?? '')
            ruleId = match ? Number(match[1]) : null
          }
        } else {
          categorizedBy = 'manual'
        }
      }

      tx.insert(transactions)
        .values({
          accountId: batch.accountId,
          postedOn: row.postedOn!,
          description: row.description,
          descriptionNorm: row.descriptionNorm,
          amountCents: row.amountCents!,
          direction: directionOf(row.amountCents!),
          categoryId,
          rawCategory: row.rawCategory,
          source: 'csv',
          categorizedBy,
          ruleId,
          importBatchId: batch.id,
          dedupeHash: row.dedupeHash!,
          duplicateAccepted: row.duplicateOf !== 'none',
        })
        .run()

      if (ruleId !== null) ruleHits.set(ruleId, (ruleHits.get(ruleId) ?? 0) + 1)
      committed++
    }

    for (const [ruleId, hits] of ruleHits) {
      tx.update(categoryRules)
        .set({ hitCount: sql`${categoryRules.hitCount} + ${hits}` })
        .where(eq(categoryRules.id, ruleId))
        .run()
    }

    tx.update(importBatches)
      .set({ status: 'committed', committedCount: committed })
      .where(eq(importBatches.id, batchId))
      .run()
  })

  return {
    batchId,
    committed,
    skipped: rows.length - committed,
    skippedDuplicates: rows.filter((r) => !r.include && r.duplicateOf !== 'none').length,
    skippedErrors: rows.filter((r) => r.parseError !== null).length,
  }
}

export function discardImport(batchId: number) {
  db.transaction((tx) => {
    tx.delete(stagedTransactions).where(eq(stagedTransactions.batchId, batchId)).run()
    tx.update(importBatches).set({ status: 'discarded' }).where(eq(importBatches.id, batchId)).run()
  })
  return { batchId, status: 'discarded' as const }
}

export function listBatches(limit = 25) {
  return db
    .select({
      id: importBatches.id,
      filename: importBatches.filename,
      status: importBatches.status,
      rowCount: importBatches.rowCount,
      parsedCount: importBatches.parsedCount,
      duplicateCount: importBatches.duplicateCount,
      errorCount: importBatches.errorCount,
      committedCount: importBatches.committedCount,
      createdAt: importBatches.createdAt,
      accountId: importBatches.accountId,
      profileName: parserProfiles.name,
    })
    .from(importBatches)
    .leftJoin(parserProfiles, eq(parserProfiles.id, importBatches.profileId))
    .orderBy(sql`${importBatches.id} desc`)
    .limit(limit)
    .all()
}

/** Removes an entire committed import from the ledger. */
export function revertBatch(batchId: number) {
  const deleted = db.delete(transactions).where(eq(transactions.importBatchId, batchId)).run()
  db.update(importBatches)
    .set({ status: 'discarded', committedCount: 0 })
    .where(eq(importBatches.id, batchId))
    .run()
  return { batchId, removed: deleted.changes }
}

export function deleteStagedByIds(ids: number[]) {
  if (ids.length === 0) return { removed: 0 }
  const result = db.delete(stagedTransactions).where(inArray(stagedTransactions.id, ids)).run()
  return { removed: result.changes }
}
