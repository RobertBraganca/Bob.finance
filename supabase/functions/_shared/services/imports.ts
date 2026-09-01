import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  categories,
  categoryRules,
  importBatches,
  parserProfiles,
  stagedTransactions,
  transactions,
} from '../db/schema.ts'
import { detectProfile } from '../csv/detect.ts'
import { parseCsvWithProfile } from '../csv/parse.ts'
import { decodeBuffer, sniffEncoding, type ResolvedProfile } from '../csv/profile.ts'
import { directionOf } from '../core/normalize.ts'
import { addDays } from '../core/dates.ts'
import { loadCategorizer } from './categorization.ts'

/* ------------------------------------------------------------------ *
 * Profile access
 * ------------------------------------------------------------------ */
export async function listProfiles(): Promise<ResolvedProfile[]> {
  return (await db.select().from(parserProfiles)).map(toResolved)
}

export async function getProfile(id: number): Promise<ResolvedProfile | null> {
  const row = (await db.select().from(parserProfiles).where(eq(parserProfiles.id, id)))[0]
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
export async function detect(buffer: Buffer) {
  const profiles = (await listProfiles()).filter((p) => p.active)
  // Sniff the encoding first: a latin1 file decoded as UTF-8 loses every
  // accented header character, which makes signature matching fail.
  const encoding = sniffEncoding(buffer)
  const preview = decodeBuffer(buffer, encoding)
  const detection = detectProfile(preview, profiles)
  const profile = detection.profileId ? await getProfile(detection.profileId) : null
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

export async function stageImport(input: StageInput) {
  const profile = await getProfile(input.profileId)
  if (!profile) throw new Error(`perfil ${input.profileId} não encontrado`)

  const text = decodeBuffer(input.buffer, profile.encoding)
  const parsed = parseCsvWithProfile(text, profile, { accountId: input.accountId })
  const categorizer = await loadCategorizer()

  // In-ledger duplicates: every hash this account already holds.
  const existing = new Map<string, number>()
  for (const row of await db
    .select({ id: transactions.id, dedupeHash: transactions.dedupeHash })
    .from(transactions)
    .where(eq(transactions.accountId, input.accountId))) {
    if (!existing.has(row.dedupeHash)) existing.set(row.dedupeHash, row.id)
  }

  const seenInBatch = new Set<string>()
  let duplicateCount = 0

  // Candidatos a "mesmo evento, lançado manualmente antes do CSV chegar" —
  // estudo de viabilidade #15. Nunca compara descrição (texto livre do
  // usuário nunca bate com o texto do banco): mesma janela de conta+valor
  // exato+±15 dias que `reconciliationCandidates` já usa em cashFlow.ts,
  // só que aqui o lado "confirmado" é o de origem manual/Diário, não uma
  // pendência.
  const manualCandidates = await db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      description: transactions.description,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, input.accountId),
        eq(transactions.pending, false),
        inArray(transactions.source, ['manual', 'daily']),
      ),
    )

  const batch = (
    await db
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
  )[0]!

  await db.transaction(async (tx) => {
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

      // Só procura match manual quando não é já um duplicado certo — a
      // mesma linha nunca precisa dos dois avisos.
      let possibleManualMatchId: number | null = null
      if (duplicateOf === 'none' && row.postedOn && row.amountCents !== null) {
        const windowStart = addDays(row.postedOn, -15)
        const windowEnd = addDays(row.postedOn, 15)
        const hit = manualCandidates.find(
          (m) => m.amountCents === row.amountCents && m.postedOn >= windowStart && m.postedOn <= windowEnd,
        )
        if (hit) possibleManualMatchId = hit.id
      }

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

      await tx.insert(stagedTransactions).values({
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
        possibleManualMatchId,
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
    }

    await tx.update(importBatches).set({ duplicateCount }).where(eq(importBatches.id, batch.id))
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
export async function getBatch(batchId: number) {
  const batch = (await db.select().from(importBatches).where(eq(importBatches.id, batchId)))[0]
  if (!batch) return null

  const rows = await db
    .select({
      id: stagedTransactions.id,
      rowIndex: stagedTransactions.rowIndex,
      postedOn: stagedTransactions.postedOn,
      description: stagedTransactions.description,
      amountCents: stagedTransactions.amountCents,
      rawCategory: stagedTransactions.rawCategory,
      duplicateOf: stagedTransactions.duplicateOf,
      duplicateTxnId: stagedTransactions.duplicateTxnId,
      possibleManualMatchId: stagedTransactions.possibleManualMatchId,
      replaceManualMatch: stagedTransactions.replaceManualMatch,
      manualMatchDescription: transactions.description,
      manualMatchPostedOn: transactions.postedOn,
      suggestedCategoryId: stagedTransactions.suggestedCategoryId,
      suggestionSource: stagedTransactions.suggestionSource,
      suggestionDetail: stagedTransactions.suggestionDetail,
      categoryId: stagedTransactions.categoryId,
      include: stagedTransactions.include,
      parseError: stagedTransactions.parseError,
      rawLine: stagedTransactions.rawLine,
    })
    .from(stagedTransactions)
    .leftJoin(transactions, eq(transactions.id, stagedTransactions.possibleManualMatchId))
    .where(eq(stagedTransactions.batchId, batchId))
    .orderBy(stagedTransactions.rowIndex)

  const profile = batch.profileId ? await getProfile(batch.profileId) : null

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
  /** confirma a sugestão de match manual (estudo #15): este CSV substitui o lançamento manual apontado por `possibleManualMatchId`, que é excluído no commit. Nunca automático — só muda se o usuário marcar. */
  replaceManualMatch?: boolean
}

export async function patchStagedRows(batchId: number, patches: StagedPatch[]) {
  await db.transaction(async (tx) => {
    for (const patch of patches) {
      const set: Record<string, unknown> = {}
      if (patch.categoryId !== undefined) set.categoryId = patch.categoryId
      if (patch.include !== undefined) set.include = patch.include
      if (patch.replaceManualMatch !== undefined) set.replaceManualMatch = patch.replaceManualMatch
      if (Object.keys(set).length === 0) continue
      await tx
        .update(stagedTransactions)
        .set(set as Partial<typeof stagedTransactions.$inferInsert>)
        .where(and(eq(stagedTransactions.id, patch.id), eq(stagedTransactions.batchId, batchId)))
    }
  })
  return getBatch(batchId)
}

/* ------------------------------------------------------------------ *
 * Commit — the only path from staging into the ledger.
 * ------------------------------------------------------------------ */
export async function commitImport(batchId: number) {
  const batch = (await db.select().from(importBatches).where(eq(importBatches.id, batchId)))[0]
  if (!batch) throw new Error(`lote ${batchId} não encontrado`)
  if (batch.status === 'committed') throw new Error(`lote ${batchId} já foi importado`)

  const rows = await db.select().from(stagedTransactions).where(eq(stagedTransactions.batchId, batchId))

  const committable = rows.filter(
    (r) => r.include && r.parseError === null && r.postedOn !== null && r.amountCents !== null,
  )

  const validCategoryIds = new Set((await db.select({ id: categories.id }).from(categories)).map((c) => c.id))

  let committed = 0
  const ruleHits = new Map<number, number>()

  await db.transaction(async (tx) => {
    for (const row of committable) {
      const categoryId =
        row.categoryId !== null && validCategoryIds.has(row.categoryId) ? row.categoryId : null

      // How this row ended up in its category, tracked so the UI can explain
      // itself and so re-categorization knows what it may overwrite.
      let categorizedBy: (typeof transactions.$inferInsert)['categorizedBy'] = 'none'
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

      await tx.insert(transactions).values({
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

      if (ruleId !== null) ruleHits.set(ruleId, (ruleHits.get(ruleId) ?? 0) + 1)
      committed++

      // Usuário confirmou (estudo #15): este CSV é o mesmo evento de um
      // lançamento manual já no ledger — a real vem do banco, então o
      // manual sai, não as duas ao mesmo tempo. Nunca acontece sem o
      // usuário ter marcado `replaceManualMatch` explicitamente na revisão.
      if (row.replaceManualMatch && row.possibleManualMatchId !== null) {
        await tx.delete(transactions).where(eq(transactions.id, row.possibleManualMatchId))
      }
    }

    for (const [ruleId, hits] of ruleHits) {
      await tx
        .update(categoryRules)
        .set({ hitCount: sql`${categoryRules.hitCount} + ${hits}` })
        .where(eq(categoryRules.id, ruleId))
    }

    await tx
      .update(importBatches)
      .set({ status: 'committed', committedCount: committed })
      .where(eq(importBatches.id, batchId))
  })

  return {
    batchId,
    committed,
    skipped: rows.length - committed,
    skippedDuplicates: rows.filter((r) => !r.include && r.duplicateOf !== 'none').length,
    skippedErrors: rows.filter((r) => r.parseError !== null).length,
  }
}

export async function discardImport(batchId: number) {
  await db.transaction(async (tx) => {
    await tx.delete(stagedTransactions).where(eq(stagedTransactions.batchId, batchId))
    await tx.update(importBatches).set({ status: 'discarded' }).where(eq(importBatches.id, batchId))
  })
  return { batchId, status: 'discarded' as const }
}

export async function listBatches(limit = 25) {
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
}

/** Removes an entire committed import from the ledger. */
export async function revertBatch(batchId: number) {
  const deleted = await db.delete(transactions).where(eq(transactions.importBatchId, batchId))
  await db
    .update(importBatches)
    .set({ status: 'discarded', committedCount: 0 })
    .where(eq(importBatches.id, batchId))
  return { batchId, removed: deleted.count }
}

export async function deleteStagedByIds(ids: number[]) {
  if (ids.length === 0) return { removed: 0 }
  const result = await db.delete(stagedTransactions).where(inArray(stagedTransactions.id, ids))
  return { removed: result.count }
}
