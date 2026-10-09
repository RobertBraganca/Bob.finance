import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { accounts, parserProfiles, transactions } from '../db/schema'
import { profileConfigSchema, validateProfileShape } from '../csv/profile'
import * as categoriesService from '../services/categories'
import * as categorization from '../services/categorization'
import * as importsService from '../services/imports'
import * as bankConnections from '../services/bankConnections'
import { writeMonthlySnapshot } from '../services/financialHealth'
import * as cardSync from '../services/cardSync'
import * as txnService from '../services/transactions'
import * as budgetService from '../services/budget'

const idParam = z.object({ id: z.coerce.number().int().positive() })

export async function ledgerRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- *
   * Accounts
   * ---------------------------------------------------------------- */
  app.get('/accounts', async () => ({
    accounts: await db.select().from(accounts).where(eq(accounts.archived, false)),
  }))

  app.post('/accounts', async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        institution: z.string().min(1),
        kind: z.string().default('checking'),
        openingBalanceCents: z.number().int().default(0),
      })
      .parse(req.body)
    return (
      await db
        .insert(accounts)
        .values({ ...body, kind: body.kind as (typeof accounts.$inferInsert)['kind'] })
        .returning()
    )[0]!
  })

  app.patch('/accounts/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        name: z.string().min(1).optional(),
        institution: z.string().min(1).optional(),
        kind: z.string().optional(),
        openingBalanceCents: z.number().int().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body)

    return (
      (
        await db
          .update(accounts)
          .set({ ...body, kind: body.kind as (typeof accounts.$inferInsert)['kind'] | undefined })
          .where(eq(accounts.id, id))
          .returning()
      )[0] ?? null
    )
  })

  /**
   * Archives the account if it has transactions (or is a parser profile's
   * default target) — deleting it outright would either violate the
   * foreign key or silently orphan history. Hard-deletes only when truly
   * unused, same convention as removeCategory.
   */
  app.delete('/accounts/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)

    const used =
      (await db.select({ n: sql<number>`count(*)` }).from(transactions).where(eq(transactions.accountId, id)))[0]
        ?.n ?? 0
    const referencedByProfile =
      (
        await db
          .select({ n: sql<number>`count(*)` })
          .from(parserProfiles)
          .where(eq(parserProfiles.defaultAccountId, id))
      )[0]?.n ?? 0

    if (used > 0 || referencedByProfile > 0) {
      await db.update(accounts).set({ archived: true }).where(eq(accounts.id, id))
      return { archived: true, deleted: false, affected: used }
    }

    const account = (await db.select().from(accounts).where(eq(accounts.id, id)))[0]
    if (!account) return reply.code(404).send({ error: 'conta não encontrada' })

    await db.delete(accounts).where(eq(accounts.id, id))
    return { archived: false, deleted: true, affected: 0 }
  })

  /* ---------------------------------------------------------------- *
   * Parser profiles — a bank dialect is a row, editable from the UI.
   * ---------------------------------------------------------------- */
  app.get('/profiles', async () => ({ profiles: await importsService.listProfiles() }))

  app.post('/profiles', async (req, reply) => {
    const config = profileConfigSchema.parse(req.body)
    const problems = validateProfileShape(config)
    if (problems.length > 0) return reply.code(400).send({ error: 'perfil inválido', problems })
    return (
      await db
        .insert(parserProfiles)
        .values(config as typeof parserProfiles.$inferInsert)
        .returning()
    )[0]!
  })

  app.patch('/profiles/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const current = await importsService.getProfile(id)
    if (!current) return reply.code(404).send({ error: 'perfil não encontrado' })
    const merged = profileConfigSchema.parse({ ...current, ...(req.body as object) })
    const problems = validateProfileShape(merged)
    if (problems.length > 0) return reply.code(400).send({ error: 'perfil inválido', problems })
    return (
      await db
        .update(parserProfiles)
        .set(merged as typeof parserProfiles.$inferInsert)
        .where(eq(parserProfiles.id, id))
        .returning()
    )[0]!
  })

  app.delete('/profiles/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return { removed: (await db.delete(parserProfiles).where(eq(parserProfiles.id, id))).count }
  })

  /* ---------------------------------------------------------------- *
   * Import: detect -> stage -> review -> commit
   * ---------------------------------------------------------------- */
  app.post('/imports/detect', async (req, reply) => {
    const body = z.object({ filename: z.string(), contentBase64: z.string() }).parse(req.body)
    const buffer = Buffer.from(body.contentBase64, 'base64')
    if (buffer.length === 0) return reply.code(400).send({ error: 'arquivo vazio' })
    return { filename: body.filename, ...(await importsService.detect(buffer)) }
  })

  app.post('/imports/stage', async (req, reply) => {
    const body = z
      .object({
        filename: z.string(),
        contentBase64: z.string(),
        profileId: z.number().int().positive(),
        accountId: z.number().int().positive(),
      })
      .parse(req.body)
    const buffer = Buffer.from(body.contentBase64, 'base64')
    if (buffer.length === 0) return reply.code(400).send({ error: 'arquivo vazio' })
    try {
      return await importsService.stageImport({
        buffer,
        filename: body.filename,
        profileId: body.profileId,
        accountId: body.accountId,
      })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /* -------------------------------------------------------------- *
   * Open Finance (Meu Pluggy) — decisions/0038. Só produz lotes de
   * importação revisáveis; nada daqui grava direto no ledger.
   * -------------------------------------------------------------- */
  const withError = async <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, run: () => Promise<T>) => {
    try {
      return await run()
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  app.get('/bank-connections', async () => ({
    connections: await bankConnections.listConnections(),
    pendingBatches: await bankConnections.pendingBatches(),
  }))

  app.get('/bank-connections/discover', async (req, reply) => {
    const { itemId } = z.object({ itemId: z.string().uuid() }).parse(req.query)
    return withError(reply, async () => ({ accounts: await bankConnections.discover(itemId) }))
  })

  app.post('/bank-connections', async (req, reply) => {
    const body = z
      .object({
        accountId: z.number().int().positive(),
        providerItemId: z.string().uuid(),
        providerAccountId: z.string().uuid(),
      })
      .parse(req.body)
    return withError(reply, () => bankConnections.createConnection(body))
  })

  app.delete('/bank-connections/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return bankConnections.deleteConnection(id)
  })

  app.post('/bank-connections/:id/sync', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    return withError(reply, () => bankConnections.syncConnection(id))
  })

  app.post('/bank-connections/sync-all', async () => bankConnections.syncAll())

  /* Resumo dos cartões pelo Meu Pluggy (specs/card-summary-sync). */
  app.get('/card-connections', async () => ({ connections: await cardSync.listCardConnections() }))

  app.post('/card-connections', async (req, reply) => {
    const body = z
      .object({
        creditCardId: z.number().int().positive(),
        providerItemId: z.string().uuid(),
        providerAccountId: z.string().uuid(),
      })
      .parse(req.body)
    return withError(reply, () => cardSync.createCardConnection(body))
  })

  app.delete('/card-connections/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return cardSync.deleteCardConnection(id)
  })

  app.post('/card-connections/:id/sync', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    return withError(reply, () => cardSync.syncCard(id))
  })

  // Rotina diária (decisions/0039). Na Edge Function ela entra sem sessão de
  // usuário, só com o segredo; aqui, no servidor local, vale o mesmo segredo.
  app.post('/cron/bank-sync', async (req, reply) => {
    const secret = process.env.BANK_SYNC_CRON_SECRET
    if (!secret || req.headers['x-cron-secret'] !== secret) return reply.code(401).send({ error: 'não autorizado' })
    const sync = await bankConnections.syncAll()
    // Depois da sincronização, a foto do mês (decisions/0045); falhar aqui não desfaz a sincronização.
    const snapshot = await writeMonthlySnapshot().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
    return { ...sync, snapshot }
  })

  app.get('/imports', async () => ({ batches: await importsService.listBatches() }))

  app.get('/imports/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const batch = await importsService.getBatch(id)
    if (!batch) return reply.code(404).send({ error: 'lote não encontrado' })
    return batch
  })

  app.patch('/imports/:id/rows', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        patches: z.array(
          z.object({
            id: z.number().int().positive(),
            categoryId: z.number().int().positive().nullable().optional(),
            include: z.boolean().optional(),
            replaceManualMatch: z.boolean().optional(),
            settlePayoff: z.boolean().optional(),
          }),
        ),
      })
      .parse(req.body)
    const result = await importsService.patchStagedRows(id, body.patches)
    if (!result) return reply.code(404).send({ error: 'lote não encontrado' })
    return result
  })

  app.post('/imports/:id/commit', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    try {
      return await importsService.commitImport(id)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/imports/:id/discard', async (req) => {
    const { id } = idParam.parse(req.params)
    return importsService.discardImport(id)
  })

  app.post('/imports/:id/revert', async (req) => {
    const { id } = idParam.parse(req.params)
    return importsService.revertBatch(id)
  })

  /* ---------------------------------------------------------------- *
   * Categories, rules, learned memory
   * ---------------------------------------------------------------- */
  app.get('/categories', async () => {
    const [tree, options] = await Promise.all([categoriesService.categoryTree(), categoriesService.categoryOptions()])
    return { tree, options }
  })

  app.post('/categories', async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1),
        parentId: z.number().int().positive().nullable().optional(),
        kind: z.enum(['income', 'expense', 'transfer', 'investment']).optional(),
        color: z.string().optional(),
        icon: z.string().optional(),
        dreGroup: z.enum(['deduction', 'cost', 'financial', 'tax']).nullable().optional(),
      })
      .parse(req.body)
    try {
      return await categoriesService.createCategory(body)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.patch('/categories/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        name: z.string().min(1).optional(),
        color: z.string().optional(),
        icon: z.string().optional(),
        kind: z.enum(['income', 'expense', 'transfer', 'investment']).optional(),
        dreGroup: z.enum(['deduction', 'cost', 'financial', 'tax']).nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body)
    try {
      return await categoriesService.updateCategory(id, body)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/categories/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const query = z
      .object({ reassignTo: z.coerce.number().int().positive().nullable().optional() })
      .parse(req.query)
    return categoriesService.removeCategory(
      id,
      query.reassignTo === undefined ? {} : { reassignTo: query.reassignTo },
    )
  })

  app.get('/rules', async () => {
    const [rules, memory] = await Promise.all([categoriesService.listRules(), categoriesService.listMemory()])
    return { rules, memory }
  })

  app.post('/rules', async (req) => {
    const body = z
      .object({
        categoryId: z.number().int().positive(),
        pattern: z.string().min(1),
        field: z.enum(['description', 'raw_category']).optional(),
        matchType: z.enum(['contains', 'starts_with', 'equals', 'regex']).optional(),
        direction: z.enum(['any', 'in', 'out']).optional(),
        priority: z.number().int().min(1).max(999).optional(),
        amountMinCents: z.number().int().nullable().optional(),
        amountMaxCents: z.number().int().nullable().optional(),
        accountId: z.number().int().positive().nullable().optional(),
      })
      .parse(req.body)
    return categoriesService.createRule(body)
  })

  app.patch('/rules/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        categoryId: z.number().int().positive().optional(),
        pattern: z.string().min(1).optional(),
        matchType: z.enum(['contains', 'starts_with', 'equals', 'regex']).optional(),
        direction: z.enum(['any', 'in', 'out']).optional(),
        priority: z.number().int().min(1).max(999).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body)
    return categoriesService.updateRule(id, body)
  })

  app.delete('/rules/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return categoriesService.deleteRule(id)
  })

  app.delete('/rules/memory/:signature', async (req) => {
    const { signature } = z.object({ signature: z.string().min(1) }).parse(req.params)
    return categoriesService.forgetMemory(decodeURIComponent(signature))
  })

  app.post('/rules/recategorize', async (req) => {
    const body = z
      .object({
        onlyUncategorized: z.boolean().default(true),
        ids: z.array(z.number().int().positive()).optional(),
      })
      .parse(req.body ?? {})
    return categorization.recategorize(body)
  })

  /* ---------------------------------------------------------------- *
   * Transactions
   * ---------------------------------------------------------------- */
  app.get('/transactions', async (req) => {
    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        accountId: z.coerce.number().int().positive().optional(),
        categoryId: z.coerce.number().int().positive().optional(),
        parentCategoryId: z.coerce.number().int().positive().optional(),
        direction: z.enum(['in', 'out']).optional(),
        categoryKind: z.enum(['income', 'expense', 'transfer', 'investment']).optional(),
        uncategorized: z.coerce.boolean().optional(),
        needsReview: z.coerce.boolean().optional(),
        search: z.string().optional(),
        source: z.string().optional(),
        includeHidden: z.coerce.boolean().optional(),
        sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']).optional(),
        limit: z.coerce.number().int().min(1).max(2000).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        /** id de um grupo do orçamento, ou `none` para "Sem grupo" */
        budgetGroup: z.union([z.literal('none'), z.coerce.number().int().positive()]).optional(),
      })
      .parse(req.query)
    const { budgetGroup, ...filter } = query
    const scope = budgetGroup === undefined ? null : await budgetService.groupTransactionScope(budgetGroup)
    return txnService.listTransactions(scope ? { ...filter, categoryIdIn: scope.categoryIds, accountIdIn: scope.accountIds } : filter)
  })

  // "Entradas automáticas": marca como conferidas as dadas, ou todas.
  app.post('/transactions/mark-reviewed', async (req) => {
    const body = z.object({ ids: z.array(z.number().int().positive()).optional() }).parse(req.body ?? {})
    return txnService.markReviewed(body.ids)
  })

  app.post('/transactions', async (req) => {
    const body = z
      .object({
        accountId: z.number().int().positive(),
        postedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        description: z.string().min(1),
        amountCents: z.number().int(),
        categoryId: z.number().int().positive().nullable().optional(),
        notes: z.string().nullable().optional(),
        source: z.enum(['manual', 'daily', 'adjustment']).optional(),
      })
      .parse(req.body)
    return txnService.createTransaction(body)
  })

  app.patch('/transactions/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        postedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        description: z.string().min(1).optional(),
        amountCents: z.number().int().optional(),
        accountId: z.number().int().positive().optional(),
        notes: z.string().nullable().optional(),
        ignored: z.boolean().optional(),
        scope: z.enum(['only', 'this_and_future', 'all']).optional(),
      })
      .parse(req.body)
    const { scope, ...patch } = body
    return txnService.updateTransaction(id, patch, scope)
  })

  app.post('/transactions/categorize', async (req) => {
    const body = z
      .object({
        ids: z.array(z.number().int().positive()).min(1),
        categoryId: z.number().int().positive().nullable(),
        learn: z.boolean().default(true),
        saveAsRule: z.boolean().default(false),
      })
      .parse(req.body)
    return txnService.setCategory(body.ids, body.categoryId, {
      learn: body.learn,
      saveAsRule: body.saveAsRule,
    })
  })

  app.post('/transactions/hide', async (req) => {
    const body = z
      .object({
        ids: z.array(z.number().int().positive()).min(1),
        hidden: z.boolean(),
      })
      .parse(req.body)
    return txnService.setHidden(body.ids, body.hidden)
  })

  app.post('/transactions/credit-card', async (req) => {
    const body = z
      .object({
        ids: z.array(z.number().int().positive()).min(1),
        creditCardId: z.number().int().positive().nullable(),
      })
      .parse(req.body)
    return txnService.setCreditCard(body.ids, body.creditCardId)
  })

  app.post('/transactions/delete', async (req) => {
    const body = z
      .object({
        ids: z.array(z.number().int().positive()).min(1),
        // Only matters for ids still pending and tied to a forecast/debt
        // template — a plain transaction ignores it. See decisions/0020.
        scope: z.enum(['only', 'this_and_future', 'all']).default('only'),
      })
      .parse(req.body)
    return txnService.deleteTransactions(body.ids, body.scope)
  })
}
