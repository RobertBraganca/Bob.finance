import '@supabase/functions-js/edge-runtime.d.ts'
import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z, ZodError } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '../_shared/db/client.ts'
import { profileConfigSchema, validateProfileShape } from '../_shared/csv/profile.ts'
import * as categoriesService from '../_shared/services/categories.ts'
import * as categorization from '../_shared/services/categorization.ts'
import * as importsService from '../_shared/services/imports.ts'
import * as txnService from '../_shared/services/transactions.ts'

/**
 * Porta de server/src/routes/ledger.ts (Fastify) para Hono/Deno.Serve —
 * mesma lógica de negócio, casca HTTP trocada. Ver decisions/0026.
 * Mesmo prefixo novo (`/ledger`) que insights.ts ganhou (`/insights`): as
 * rotas aqui não tinham prefixo próprio no Fastify.
 */

const { accounts, parserProfiles, transactions } = schema
const idParam = z.object({ id: z.coerce.number().int().positive() })

const app = new Hono().basePath('/ledger')
app.use('*', cors({ origin: '*' }))

app.onError((error, c) => {
  if (error instanceof ZodError) return c.json({ error: 'dados inválidos', issues: error.issues }, 400)
  console.error(error)
  return c.json({ error: error instanceof Error ? error.message : 'erro interno' }, 500)
})

/* ---------------------------------------------------------------- *
 * Accounts
 * ---------------------------------------------------------------- */
app.get('/accounts', async (c) =>
  c.json({ accounts: await db.select().from(accounts).where(eq(accounts.archived, false)) }),
)

app.post('/accounts', async (c) => {
  const body = z
    .object({
      name: z.string().min(1),
      institution: z.string().min(1),
      kind: z.string().default('checking'),
      openingBalanceCents: z.number().int().default(0),
    })
    .parse(await c.req.json())
  const [row] = await db
    .insert(accounts)
    .values({ ...body, kind: body.kind as (typeof accounts.$inferInsert)['kind'] })
    .returning()
  return c.json(row)
})

app.patch('/accounts/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      name: z.string().min(1).optional(),
      institution: z.string().min(1).optional(),
      kind: z.string().optional(),
      openingBalanceCents: z.number().int().optional(),
      archived: z.boolean().optional(),
    })
    .parse(await c.req.json())
  const [row] = await db
    .update(accounts)
    .set({ ...body, kind: body.kind as (typeof accounts.$inferInsert)['kind'] | undefined })
    .where(eq(accounts.id, id))
    .returning()
  return c.json(row ?? null)
})

app.delete('/accounts/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())

  const used =
    (await db.select({ n: sql<number>`count(*)` }).from(transactions).where(eq(transactions.accountId, id)))[0]?.n ??
    0
  const referencedByProfile =
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(parserProfiles)
        .where(eq(parserProfiles.defaultAccountId, id))
    )[0]?.n ?? 0

  if (used > 0 || referencedByProfile > 0) {
    await db.update(accounts).set({ archived: true }).where(eq(accounts.id, id))
    return c.json({ archived: true, deleted: false, affected: used })
  }

  const account = (await db.select().from(accounts).where(eq(accounts.id, id)))[0]
  if (!account) return c.json({ error: 'conta não encontrada' }, 404)

  await db.delete(accounts).where(eq(accounts.id, id))
  return c.json({ archived: false, deleted: true, affected: 0 })
})

/* ---------------------------------------------------------------- *
 * Parser profiles
 * ---------------------------------------------------------------- */
app.get('/profiles', async (c) => c.json({ profiles: await importsService.listProfiles() }))

app.post('/profiles', async (c) => {
  const config = profileConfigSchema.parse(await c.req.json())
  const problems = validateProfileShape(config)
  if (problems.length > 0) return c.json({ error: 'perfil inválido', problems }, 400)
  const [row] = await db
    .insert(parserProfiles)
    .values(config as typeof parserProfiles.$inferInsert)
    .returning()
  return c.json(row)
})

app.patch('/profiles/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const current = await importsService.getProfile(id)
  if (!current) return c.json({ error: 'perfil não encontrado' }, 404)
  const merged = profileConfigSchema.parse({ ...current, ...(await c.req.json()) })
  const problems = validateProfileShape(merged)
  if (problems.length > 0) return c.json({ error: 'perfil inválido', problems }, 400)
  const [row] = await db
    .update(parserProfiles)
    .set(merged as typeof parserProfiles.$inferInsert)
    .where(eq(parserProfiles.id, id))
    .returning()
  return c.json(row)
})

app.delete('/profiles/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json({ removed: (await db.delete(parserProfiles).where(eq(parserProfiles.id, id))).count })
})

/* ---------------------------------------------------------------- *
 * Import: detect -> stage -> review -> commit
 * ---------------------------------------------------------------- */
app.post('/imports/detect', async (c) => {
  const body = z.object({ filename: z.string(), contentBase64: z.string() }).parse(await c.req.json())
  const buffer = Buffer.from(body.contentBase64, 'base64')
  if (buffer.length === 0) return c.json({ error: 'arquivo vazio' }, 400)
  return c.json({ filename: body.filename, ...(await importsService.detect(buffer)) })
})

app.post('/imports/stage', async (c) => {
  const body = z
    .object({
      filename: z.string(),
      contentBase64: z.string(),
      profileId: z.number().int().positive(),
      accountId: z.number().int().positive(),
    })
    .parse(await c.req.json())
  const buffer = Buffer.from(body.contentBase64, 'base64')
  if (buffer.length === 0) return c.json({ error: 'arquivo vazio' }, 400)
  try {
    return c.json(
      await importsService.stageImport({
        buffer,
        filename: body.filename,
        profileId: body.profileId,
        accountId: body.accountId,
      }),
    )
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

app.get('/imports', async (c) => c.json({ batches: await importsService.listBatches() }))

app.get('/imports/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const batch = await importsService.getBatch(id)
  if (!batch) return c.json({ error: 'lote não encontrado' }, 404)
  return c.json(batch)
})

app.patch('/imports/:id/rows', async (c) => {
  const { id } = idParam.parse(c.req.param())
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
    .parse(await c.req.json())
  const result = await importsService.patchStagedRows(id, body.patches)
  if (!result) return c.json({ error: 'lote não encontrado' }, 404)
  return c.json(result)
})

app.post('/imports/:id/commit', async (c) => {
  const { id } = idParam.parse(c.req.param())
  try {
    return c.json(await importsService.commitImport(id))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

app.post('/imports/:id/discard', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await importsService.discardImport(id))
})

app.post('/imports/:id/revert', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await importsService.revertBatch(id))
})

/* ---------------------------------------------------------------- *
 * Categories, rules, learned memory
 * ---------------------------------------------------------------- */
app.get('/categories', async (c) => {
  const [tree, options] = await Promise.all([categoriesService.categoryTree(), categoriesService.categoryOptions()])
  return c.json({ tree, options })
})

app.post('/categories', async (c) => {
  const body = z
    .object({
      name: z.string().min(1),
      parentId: z.number().int().positive().nullable().optional(),
      kind: z.enum(['income', 'expense', 'transfer', 'investment']).optional(),
      color: z.string().optional(),
      icon: z.string().optional(),
    })
    .parse(await c.req.json())
  try {
    return c.json(await categoriesService.createCategory(body))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

app.patch('/categories/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      name: z.string().min(1).optional(),
      color: z.string().optional(),
      icon: z.string().optional(),
      kind: z.enum(['income', 'expense', 'transfer', 'investment']).optional(),
      sortOrder: z.number().int().optional(),
    })
    .parse(await c.req.json())
  return c.json(await categoriesService.updateCategory(id, body))
})

app.delete('/categories/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const query = z.object({ reassignTo: z.coerce.number().int().positive().nullable().optional() }).parse(c.req.query())
  return c.json(
    await categoriesService.removeCategory(id, query.reassignTo === undefined ? {} : { reassignTo: query.reassignTo }),
  )
})

app.get('/rules', async (c) => {
  const [rules, memory] = await Promise.all([categoriesService.listRules(), categoriesService.listMemory()])
  return c.json({ rules, memory })
})

app.post('/rules', async (c) => {
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
    .parse(await c.req.json())
  return c.json(await categoriesService.createRule(body))
})

app.patch('/rules/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      categoryId: z.number().int().positive().optional(),
      pattern: z.string().min(1).optional(),
      matchType: z.enum(['contains', 'starts_with', 'equals', 'regex']).optional(),
      direction: z.enum(['any', 'in', 'out']).optional(),
      priority: z.number().int().min(1).max(999).optional(),
      active: z.boolean().optional(),
    })
    .parse(await c.req.json())
  return c.json(await categoriesService.updateRule(id, body))
})

app.delete('/rules/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await categoriesService.deleteRule(id))
})

app.delete('/rules/memory/:signature', async (c) => {
  const { signature } = z.object({ signature: z.string().min(1) }).parse(c.req.param())
  return c.json(await categoriesService.forgetMemory(decodeURIComponent(signature)))
})

app.post('/rules/recategorize', async (c) => {
  let raw: unknown = {}
  try {
    raw = await c.req.json()
  } catch {
    // corpo vazio é válido — ambos os campos são opcionais
  }
  const body = z
    .object({
      onlyUncategorized: z.boolean().default(true),
      ids: z.array(z.number().int().positive()).optional(),
    })
    .parse(raw)
  return c.json(await categorization.recategorize(body))
})

/* ---------------------------------------------------------------- *
 * Transactions
 * ---------------------------------------------------------------- */
app.get('/transactions', async (c) => {
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
    .parse(c.req.query())
  return c.json(await txnService.listTransactions(query))
})

app.post('/transactions', async (c) => {
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
    .parse(await c.req.json())
  return c.json(await txnService.createTransaction(body))
})

app.patch('/transactions/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      postedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      description: z.string().min(1).optional(),
      amountCents: z.number().int().optional(),
      accountId: z.number().int().positive().optional(),
      notes: z.string().nullable().optional(),
      scope: z.enum(['only', 'this_and_future', 'all']).optional(),
    })
    .parse(await c.req.json())
  const { scope, ...patch } = body
  return c.json(await txnService.updateTransaction(id, patch, scope))
})

app.post('/transactions/categorize', async (c) => {
  const body = z
    .object({
      ids: z.array(z.number().int().positive()).min(1),
      categoryId: z.number().int().positive().nullable(),
      learn: z.boolean().default(true),
      saveAsRule: z.boolean().default(false),
    })
    .parse(await c.req.json())
  return c.json(await txnService.setCategory(body.ids, body.categoryId, { learn: body.learn, saveAsRule: body.saveAsRule }))
})

app.post('/transactions/delete', async (c) => {
  const body = z
    .object({
      ids: z.array(z.number().int().positive()).min(1),
      scope: z.enum(['only', 'this_and_future', 'all']).default('only'),
    })
    .parse(await c.req.json())
  return c.json(await txnService.deleteTransactions(body.ids, body.scope))
})

Deno.serve(app.fetch)
