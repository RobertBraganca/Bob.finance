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
import { addDays } from '../core/dates'
import { loadCategorizer } from './categorization'

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

  const { batchId, duplicateCount } = await stageRows({
    accountId: input.accountId,
    profileId: profile.id,
    filename: input.filename,
    rowCount: parsed.rowCount,
    parsedCount: parsed.parsedCount,
    errorCount: parsed.errorCount,
    rows: parsed.rows,
  })

  return {
    batchId,
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

/** Uma linha pronta para a fila de revisão, venha de CSV ou de Open Finance. */
export type StageRow = {
  rowIndex: number
  postedOn: string | null
  description: string
  descriptionNorm: string
  signature: string
  amountCents: number | null
  rawCategory: string | null
  dedupeHash: string | null
  parseError: string | null
  rawLine: string | null
  /** Id no provedor de Open Finance; nulo em CSV. */
  externalId?: string | null
  /** TAG já decidida pela origem (ex. caixinha do Open Finance), que vence o categorizador. */
  presetCategory?: { categoryId: number; detail: string } | null
}

/**
 * O caminho único para a fila de revisão: CSV e Open Finance passam pela
 * mesma checagem de duplicado, de lançamento manual equivalente e pela
 * mesma sugestão de TAG, e caem no mesmo lote revisável (decisions/0038).
 */
export async function stageRows(input: {
  accountId: number
  profileId: number | null
  filename: string
  rowCount: number
  parsedCount: number
  errorCount: number
  rows: StageRow[]
  /**
   * Open Finance: também marca como provável duplicado uma linha com a
   * mesma data e o mesmo valor de um lançamento já confirmado da conta. A
   * descrição do provedor nunca bate com a do CSV do mesmo banco, então o
   * hash sozinho não pega o dia que os dois cobrem.
   */
  matchByDateAndAmount?: boolean
}): Promise<{ batchId: number; duplicateCount: number }> {
  const categorizer = await loadCategorizer()

  // In-ledger duplicates: every hash this account already holds. Uma linha
  // de Open Finance só compara com o que veio sem id externo (CSV, manual):
  // contra outra linha do provedor, o id já decide, e dois eventos reais
  // iguais no mesmo dia (dois resgates de R$ 50) têm o mesmo hash.
  const existing = new Map<string, number>()
  const existingWithoutExternalId = new Map<string, number>()
  for (const row of await db
    .select({ id: transactions.id, dedupeHash: transactions.dedupeHash, externalId: transactions.externalId })
    .from(transactions)
    .where(eq(transactions.accountId, input.accountId))) {
    if (!existing.has(row.dedupeHash)) existing.set(row.dedupeHash, row.id)
    if (row.externalId === null && !existingWithoutExternalId.has(row.dedupeHash)) {
      existingWithoutExternalId.set(row.dedupeHash, row.id)
    }
  }

  // Data+valor -> ids ainda não usados como par. Cada lançamento do ledger
  // casa com no máximo uma linha nova: dois cafés de R$ 5 no mesmo dia são
  // dois eventos.
  const byDateAmount = new Map<string, number[]>()
  if (input.matchByDateAndAmount) {
    const dates = input.rows.map((r) => r.postedOn).filter((d): d is string => d !== null)
    if (dates.length > 0) {
      const earliest = dates.reduce((a, b) => (a < b ? a : b))
      for (const row of await db
        .select({ id: transactions.id, postedOn: transactions.postedOn, amountCents: transactions.amountCents })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, input.accountId),
            eq(transactions.pending, false),
            inArray(transactions.source, ['csv', 'open_finance']),
            sql`${transactions.postedOn} >= ${earliest}`,
          ),
        )) {
        const key = `${row.postedOn}|${row.amountCents}`
        byDateAmount.set(key, [...(byDateAmount.get(key) ?? []), row.id])
      }
    }
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
        profileId: input.profileId,
        accountId: input.accountId,
        filename: input.filename,
        rowCount: input.rowCount,
        parsedCount: input.parsedCount,
        errorCount: input.errorCount,
        status: 'staged',
      })
      .returning()
  )[0]!

  await db.transaction(async (tx) => {
    for (const row of input.rows) {
      let duplicateOf: 'none' | 'in_batch' | 'in_ledger' = 'none'
      let duplicateTxnId: number | null = null

      if (row.dedupeHash) {
        const ledgerHit = (row.externalId ? existingWithoutExternalId : existing).get(row.dedupeHash)
        if (ledgerHit !== undefined) {
          duplicateOf = 'in_ledger'
          duplicateTxnId = ledgerHit
        } else if (!row.externalId && seenInBatch.has(row.dedupeHash)) {
          duplicateOf = 'in_batch'
        }
        seenInBatch.add(row.dedupeHash)
      }
      if (duplicateOf === 'none' && input.matchByDateAndAmount && row.postedOn && row.amountCents !== null) {
        const key = `${row.postedOn}|${row.amountCents}`
        const candidates = byDateAmount.get(key)
        if (candidates && candidates.length > 0) {
          duplicateOf = 'in_ledger'
          duplicateTxnId = candidates.shift()!
        }
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

      const suggestion = row.presetCategory
        ? { categoryId: row.presetCategory.categoryId, source: 'raw_category' as const, detail: row.presetCategory.detail }
        : row.parseError === null && row.amountCents !== null
          ? categorizer.suggest({
              descriptionNorm: row.descriptionNorm,
              signature: row.signature,
              amountCents: row.amountCents,
              rawCategory: row.rawCategory,
              accountId: input.accountId,
            })
          : { categoryId: null, source: 'none' as const, detail: null }

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
        externalId: row.externalId ?? null,
      })
    }

    await tx.update(importBatches).set({ duplicateCount }).where(eq(importBatches.id, batch.id))
  })

  return { batchId: batch.id, duplicateCount }
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
        source: row.externalId ? 'open_finance' : 'csv',
        externalId: row.externalId,
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
