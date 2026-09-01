import '@supabase/functions-js/edge-runtime.d.ts'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z, ZodError } from 'zod'
import * as pricing from '../_shared/services/pricing.ts'
import { requireAdmin } from '../_shared/auth.ts'

/**
 * Precificação de projetos. Ver `specs/project-pricing`.
 *
 * Porta de server/src/routes/pricing.ts (Fastify) para Hono/Deno.Serve
 * — mesma lógica de negócio (services/pricing.ts, copiado verbatim em
 * _shared/), só a casca HTTP muda. Ver decisions/0026 para o porquê
 * dessa migração (backend Fastify nunca chegou a ter onde rodar em
 * produção; Edge Functions é a alternativa escolhida).
 *
 * `/pricing/simulate` é um POST que não grava nada: o corpo é grande
 * demais para query string, e é Simulação pura (decisions/0010).
 * Persistir é uma chamada separada e explícita a `/pricing/quotes`.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() })

const directCostSchema = z.object({
  label: z.string().min(1).max(80),
  amountCents: z.number().int(),
})

const simulateBody = z.object({
  estimatedHours: z.number().positive().max(100_000),
  directCosts: z.array(directCostSchema).max(50).optional(),
  complexityOptionId: z.number().int().positive().nullable().optional(),
  urgencyOptionId: z.number().int().positive().nullable().optional(),
  clientSizeOptionId: z.number().int().positive().nullable().optional(),
  usageRightsOptionId: z.number().int().positive().nullable().optional(),
  extraMarginBps: z.number().int().min(0).max(100_000).optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
})

const app = new Hono().basePath('/pricing')

app.use('*', cors({ origin: '*' }))
app.use('*', requireAdmin)

// Zod falhando é problema do dado de entrada, não falha de servidor —
// mesmo tratamento que o setErrorHandler do Fastify dava.
app.onError((error, c) => {
  if (error instanceof ZodError) {
    return c.json({ error: 'dados inválidos', issues: error.issues }, 400)
  }
  if (error instanceof pricing.PricingError) {
    // "Sem base para calcular" é estado da configuração do usuário, não
    // falha de servidor — mesmo tratamento que o resto do app dá para
    // uma divisão que ele se recusa a fazer.
    return c.json({ error: error.message }, 422)
  }
  console.error(error)
  return c.json({ error: 'erro interno' }, 500)
})

/* ---------------------------------------------------------------- *
 * Settings
 * ---------------------------------------------------------------- */
app.get('/settings', async (c) => {
  return c.json({
    settings: await pricing.getSettings(),
    defaults: pricing.DEFAULT_PRICING_SETTINGS,
  })
})

app.put('/settings', async (c) => {
  const body = z
    .object({
      availableHoursPerMonth: z.number().int().min(1).max(744).optional(),
      billablePercentageBps: z.number().int().min(1).max(10_000).optional(),
    })
    .parse(await c.req.json())
  return c.json({ settings: await pricing.updateSettings(body), defaults: pricing.DEFAULT_PRICING_SETTINGS })
})

/* ---------------------------------------------------------------- *
 * Multiplier bank
 * ---------------------------------------------------------------- */
app.get('/multipliers', async (c) => {
  const query = z.object({ dimension: z.enum(pricing.PRICING_DIMENSIONS).optional() }).parse(c.req.query())
  const [multipliers, byDimension] = await Promise.all([
    pricing.listMultipliers(query.dimension),
    pricing.multipliersByDimension(),
  ])
  return c.json({
    multipliers,
    byDimension,
    dimensions: pricing.PRICING_DIMENSIONS.map((value) => ({
      value,
      label: pricing.DIMENSION_LABELS[value],
    })),
  })
})

app.post('/multipliers', async (c) => {
  const body = z
    .object({
      dimension: z.enum(pricing.PRICING_DIMENSIONS),
      label: z.string().min(1).max(60),
      description: z.string().max(200).nullable().optional(),
      multiplierBps: z.number().int().min(1).max(1_000_000),
      sortOrder: z.number().int().optional(),
    })
    .parse(await c.req.json())
  return c.json(await pricing.createMultiplier(body))
})

app.patch('/multipliers/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      label: z.string().min(1).max(60).optional(),
      description: z.string().max(200).nullable().optional(),
      multiplierBps: z.number().int().min(1).max(1_000_000).optional(),
      sortOrder: z.number().int().optional(),
      active: z.boolean().optional(),
    })
    .parse(await c.req.json())
  return c.json(await pricing.updateMultiplier(id, body))
})

app.delete('/multipliers/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await pricing.deleteMultiplier(id))
})

/* ---------------------------------------------------------------- *
 * Simulation and quotes
 * ---------------------------------------------------------------- */
app.post('/simulate', async (c) => {
  const body = simulateBody.parse(await c.req.json())
  return c.json(await pricing.simulate(body))
})

/** Condições comerciais: aceitas na criação e na edição, e (ao contrário
 * dos campos de cálculo) também depois da aprovação — não mexem em preço. */
const commercialTerms = {
  installments: z.number().int().min(1).max(60).optional(),
  paymentTerms: z.string().max(500).nullable().optional(),
}

app.get('/quotes', async (c) => c.json({ quotes: await pricing.listQuotes() }))

app.post('/quotes', async (c) => {
  const body = simulateBody
    .extend({ clientLabel: z.string().min(1).max(120), ...commercialTerms })
    .parse(await c.req.json())
  return c.json(await pricing.saveQuote(body))
})

app.get('/quotes/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const quote = await pricing.getQuote(id)
  if (!quote) return c.json({ error: 'cotação não encontrada' }, 404)
  return c.json(quote)
})

app.patch('/quotes/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  // Todo campo de simulateBody, mas nenhum obrigatório: um patch pode
  // tocar só um campo (ex. só directCosts) sem reenviar os outros —
  // decisions/0021, updateQuote mescla com o que já existe na linha.
  const body = simulateBody
    .omit({ period: true })
    .partial()
    .extend({ clientLabel: z.string().min(1).max(120).optional(), ...commercialTerms })
    .parse(await c.req.json())
  const quote = await pricing.updateQuote(id, body)
  if (!quote) return c.json({ error: 'cotação não encontrada' }, 404)
  return c.json(quote)
})

app.delete('/quotes/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await pricing.deleteQuote(id))
})

app.patch('/quotes/:id/status', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z.object({ status: z.enum(pricing.QUOTE_STATUSES) }).parse(await c.req.json())
  const quote = await pricing.setQuoteStatus(id, body.status)
  if (!quote) return c.json({ error: 'cotação não encontrada' }, 404)
  return c.json(quote)
})

app.post('/quotes/:id/approve', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      accountId: z.number().int().positive(),
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      actualPriceCents: z.number().int().positive().optional(),
    })
    .parse(await c.req.json())
  return c.json(await pricing.approveQuote(id, body))
})

Deno.serve(app.fetch)
