import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { accounts, parserProfiles, transactions } from '../db/schema'
import { profileConfigSchema, validateProfileShape } from '../csv/profile'
import * as categoriesService from '../services/categories'
import * as categorization from '../services/categorization'
import * as importsService from '../services/imports'
import * as txnService from '../services/transactions'

const idParam = z.object({ id: z.coerce.number().int().positive() })

export async function ledgerRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- *
   * Accounts
   * ---------------------------------------------------------------- */
  app.get('/accounts', async () => ({
    accounts: db.select().from(accounts).where(eq(accounts.archived, false)).all(),
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
    return db.insert(accounts).values(body).returning().get()
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

    return db.update(accounts).set(body).where(eq(accounts.id, id)).returning().get() ?? null
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
      db.select({ n: sql<number>`count(*)` }).from(transactions).where(eq(transactions.accountId, id)).get()
        ?.n ?? 0
    const referencedByProfile =
      db
        .select({ n: sql<number>`count(*)` })
        .from(parserProfiles)
        .where(eq(parserProfiles.defaultAccountId, id))
        .get()?.n ?? 0

    if (used > 0 || referencedByProfile > 0) {
      db.update(accounts).set({ archived: true }).where(eq(accounts.id, id)).run()
      return { archived: true, deleted: false, affected: used }
    }

    const account = db.select().from(accounts).where(eq(accounts.id, id)).get()
    if (!account) return reply.code(404).send({ error: 'conta não encontrada' })

    db.delete(accounts).where(eq(accounts.id, id)).run()
    return { archived: false, deleted: true, affected: 0 }
  })

  /* ---------------------------------------------------------------- *
   * Parser profiles — a bank dialect is a row, editable from the UI.
   * ---------------------------------------------------------------- */
  app.get('/profiles', async () => ({ profiles: importsService.listProfiles() }))

  app.post('/profiles', async (req, reply) => {
    const config = profileConfigSchema.parse(req.body)
    const problems = validateProfileShape(config)
    if (problems.length > 0) return reply.code(400).send({ error: 'perfil inválido', problems })
    return db.insert(parserProfiles).values(config).returning().get()
  })

  app.patch('/profiles/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const current = importsService.getProfile(id)
    if (!current) return reply.code(404).send({ error: 'perfil não encontrado' })
    const merged = profileConfigSchema.parse({ ...current, ...(req.body as object) })
    const problems = validateProfileShape(merged)
    if (problems.length > 0) return reply.code(400).send({ error: 'perfil inválido', problems })
    return db.update(parserProfiles).set(merged).where(eq(parserProfiles.id, id)).returning().get()
  })

  app.delete('/profiles/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return { removed: db.delete(parserProfiles).where(eq(parserProfiles.id, id)).run().changes }
  })

  /* ---------------------------------------------------------------- *
   * Import: detect -> stage -> review -> commit
   * ---------------------------------------------------------------- */
  app.post('/imports/detect', async (req, reply) => {
    const body = z.object({ filename: z.string(), contentBase64: z.string() }).parse(req.body)
    const buffer = Buffer.from(body.contentBase64, 'base64')
    if (buffer.length === 0) return reply.code(400).send({ error: 'arquivo vazio' })
    return { filename: body.filename, ...importsService.detect(buffer) }
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
      return importsService.stageImport({
        buffer,
        filename: body.filename,
        profileId: body.profileId,
        accountId: body.accountId,
      })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/imports', async () => ({ batches: importsService.listBatches() }))

  app.get('/imports/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const batch = importsService.getBatch(id)
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
          }),
        ),
      })
      .parse(req.body)
    const result = importsService.patchStagedRows(id, body.patches)
    if (!result) return reply.code(404).send({ error: 'lote não encontrado' })
    return result
  })

  app.post('/imports/:id/commit', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    try {
      return importsService.commitImport(id)
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
  app.get('/categories', async () => ({
    tree: categoriesService.categoryTree(),
    options: categoriesService.categoryOptions(),
  }))

  app.post('/categories', async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1),
        parentId: z.number().int().positive().nullable().optional(),
        kind: z.enum(['income', 'expense', 'transfer', 'investment']).optional(),
        color: z.string().optional(),
        icon: z.string().optional(),
      })
      .parse(req.body)
    try {
      return categoriesService.createCategory(body)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.patch('/categories/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        name: z.string().min(1).optional(),
        color: z.string().optional(),
        icon: z.string().optional(),
        kind: z.enum(['income', 'expense', 'transfer', 'investment']).optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body)
    return categoriesService.updateCategory(id, body)
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

  app.get('/rules', async () => ({
    rules: categoriesService.listRules(),
    memory: categoriesService.listMemory(),
  }))

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
        search: z.string().optional(),
        source: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(2000).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query)
    return txnService.listTransactions(query)
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
      })
      .parse(req.body)
    return txnService.updateTransaction(id, body)
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
