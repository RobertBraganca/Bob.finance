import '@supabase/functions-js/edge-runtime.d.ts'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z, ZodError } from 'zod'
import * as pricing from '../_shared/services/pricing.ts'
import * as proposals from '../_shared/services/proposals.ts'
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

/* ------------------------------------------------------------------ *
 * Orçamentos de serviço (decisions/0040, specs/service-proposals)
 * ------------------------------------------------------------------ */
const proposalItemSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(2000).nullable().optional(),
  unitPriceCents: z.number().int().min(0).max(1_000_000_000),
  quantity: z.number().positive().max(100_000),
  sourceQuoteId: z.number().int().positive().nullable().optional(),
})

const proposalFields = {
  title: z.string().trim().min(1).max(160),
  clientLabel: z.string().trim().min(1).max(160),
  status: z.enum(proposals.EDITABLE_STATUSES).optional(),
  discountBps: z.number().int().min(0).max(10_000).optional(),
  validityDays: z.number().int().min(1).max(365).optional(),
  installments: z.number().int().min(1).max(60).optional(),
  paymentTerms: z.string().max(1000).nullable().optional(),
  deliveryTerms: z.string().max(1000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  items: z.array(proposalItemSchema).max(100),
}
const proposalCreateBody = z.object(proposalFields)
const proposalPatchBody = z.object(proposalFields).partial()

const proposalListQuery = z.object({
  q: z.string().max(160).optional(),
  status: z.string().optional(),
  sort: z.enum(proposals.PROPOSAL_SORTS).optional(),
})

const statusList = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is proposals.ProposalStatus => (proposals.PROPOSAL_STATUSES as readonly string[]).includes(s))

const approveProposalBody = z.object({
  accountId: z.number().int().positive(),
  firstDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  installments: z.number().int().min(1).max(60).optional(),
  firstAlreadyReceived: z.boolean().optional(),
})

const issuerBody = z
  .object({
    businessName: z.string().max(160).nullable(),
    document: z.string().max(30).nullable(),
    email: z.string().max(160).nullable(),
    phone: z.string().max(40).nullable(),
    logoPath: z.string().max(300).nullable(),
    defaultValidityDays: z.number().int().min(1).max(365),
  })
  .partial()

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

// Os tres graficos da pagina Precificacao num pedido so. Antes de
// /quotes/:id para "analytics" nao ser lido como um id.
app.get('/quotes/analytics', async (c) => {
  const query = z.object({ monthsBack: z.coerce.number().int().min(1).max(60).default(12) }).parse(c.req.query())
  return c.json(await pricing.quoteAnalytics(query.monthsBack))
})

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
      accountId: z.number().int().positive().optional(),
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      actualPriceCents: z.number().int().positive().optional(),
      secondInstallmentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      recurring: z
        .object({
          accountId: z.number().int().positive(),
          dueDay: z.number().int().min(1).max(28),
          startPeriod: z.string().regex(/^\d{4}-\d{2}$/),
        })
        .optional(),
    })
    .parse(await c.req.json())
  return c.json(await pricing.approveQuote(id, body))
})


/* ------------------------------------------------------------------ *
 * Orçamentos de serviço (decisions/0040). Rotas fixas antes das com :id.
 * PricingError vira 422 no onError acima.
 * ------------------------------------------------------------------ */
app.get('/proposals', async (c) => {
  const query = proposalListQuery.parse(c.req.query())
  return c.json(await proposals.listProposals({ q: query.q, statuses: statusList(query.status), sort: query.sort }))
})
app.get('/proposals/summary', async (c) => c.json(await proposals.proposalsSummary()))
app.get('/proposals/item-suggestions', async (c) => {
  const { q } = z.object({ q: z.string().max(160).optional() }).parse(c.req.query())
  return c.json({ suggestions: await proposals.itemSuggestions(q) })
})
app.get('/proposals/client-suggestions', async (c) => c.json({ clients: await proposals.clientSuggestions() }))
app.get('/proposals/quote-options', async (c) => c.json({ quotes: await proposals.quotesForPicker() }))
app.get('/proposal-issuer', async (c) => c.json(await proposals.getIssuer()))
app.put('/proposal-issuer', async (c) => c.json(await proposals.updateIssuer(issuerBody.parse(await c.req.json()))))

app.post('/proposals', async (c) => c.json(await proposals.createProposal(proposalCreateBody.parse(await c.req.json()))))
app.get('/proposals/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const proposal = await proposals.getProposal(id)
  if (!proposal) return c.json({ error: 'orçamento não encontrado' }, 404)
  return c.json(proposal)
})
app.patch('/proposals/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const proposal = await proposals.updateProposal(id, proposalPatchBody.parse(await c.req.json()))
  if (!proposal) return c.json({ error: 'orçamento não encontrado' }, 404)
  return c.json(proposal)
})
app.post('/proposals/:id/status', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const { status } = z.object({ status: z.enum(proposals.EDITABLE_STATUSES) }).parse(await c.req.json())
  const proposal = await proposals.setProposalStatus(id, status)
  if (!proposal) return c.json({ error: 'orçamento não encontrado' }, 404)
  return c.json(proposal)
})
app.post('/proposals/:id/mark-sent', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const proposal = await proposals.markProposalSent(id)
  if (!proposal) return c.json({ error: 'orçamento não encontrado' }, 404)
  return c.json(proposal)
})
app.post('/proposals/:id/approve', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await proposals.approveProposal(id, approveProposalBody.parse(await c.req.json())))
})
app.post('/proposals/:id/duplicate', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const proposal = await proposals.duplicateProposal(id)
  if (!proposal) return c.json({ error: 'orçamento não encontrado' }, 404)
  return c.json(proposal)
})
app.delete('/proposals/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await proposals.deleteProposal(id))
})

Deno.serve(app.fetch)
