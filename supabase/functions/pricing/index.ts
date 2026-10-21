import '@supabase/functions-js/edge-runtime.d.ts'
import { runInRequestScope } from '../_shared/core/requestCache.ts'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z, ZodError } from 'zod'
import * as pricing from '../_shared/services/pricing.ts'
import * as proposals from '../_shared/services/proposals.ts'
import * as clientsService from '../_shared/services/clients.ts'
import * as catalog from '../_shared/services/serviceCatalog.ts'
import * as dealsService from '../_shared/services/deals.ts'
import { DEAL_STAGES } from '../_shared/core/deals.ts'
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
  serviceId: z.number().int().positive().nullable().optional(),
})

const proposalFields = {
  title: z.string().trim().min(1).max(160),
  clientLabel: z.string().trim().min(1).max(160),
  clientId: z.number().int().positive().nullable().optional(),
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
  clientId: z.coerce.number().int().positive().optional(),
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
// Um escopo de cache por requisição (core/requestCache): as telas leem as mesmas
// funções caras várias vezes, e aqui cada uma roda uma vez por requisição.
app.use('*', (_c, next) => runInRequestScope(next))
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
    .extend({ clientLabel: z.string().min(1).max(120), clientId: z.number().int().positive().nullable().optional(), ...commercialTerms })
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
    .extend({ clientLabel: z.string().min(1).max(120).optional(), clientId: z.number().int().positive().nullable().optional(), ...commercialTerms })
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
  return c.json(await proposals.listProposals({ q: query.q, statuses: statusList(query.status), sort: query.sort, clientId: query.clientId }))
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

/* ---------------------------------------------------------------- *
 * Clientes, catálogo de serviços e negócios (docs/specs/clientes-e-negocios).
 * Porta de server/src/routes/clients.ts. PricingError vira 422 no onError acima.
 * Rotas fixas antes das com :id.
 * ---------------------------------------------------------------- */
const optionalText = (max: number) => z.string().max(max).nullable().optional()
const clientFields = {
  name: z.string().trim().min(1).max(160),
  kind: z.enum(clientsService.CLIENT_KINDS).optional(),
  status: z.enum(clientsService.CLIENT_STATUSES).optional(),
  segment: optionalText(120),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  phone: optionalText(60),
  document: optionalText(40),
  website: optionalText(200),
  source: optionalText(120),
  description: optionalText(4000),
  isRecurring: z.boolean().optional(),
}
const contactFields = {
  name: z.string().trim().min(1).max(160),
  role: optionalText(120),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  phone: optionalText(60),
  isPrimary: z.boolean().optional(),
}
const serviceFields = {
  name: z.string().trim().min(1).max(160),
  description: optionalText(2000),
  defaultPriceCents: z.number().int().min(0).max(1_000_000_000).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
}
const contactParams = idParam.extend({ contactId: z.coerce.number().int().positive() })
const aliasParams = idParam.extend({ aliasId: z.coerce.number().int().positive() })
const dealStageParams = z.object({ kind: z.enum(['proposal', 'quote']), id: z.coerce.number().int().positive() })
const dealStageList = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is (typeof DEAL_STAGES)[number] => (DEAL_STAGES as readonly string[]).includes(s))

app.get('/clients', async (c) => {
  const query = z
    .object({
      q: z.string().max(160).optional(),
      kind: z.enum(clientsService.CLIENT_KINDS).optional(),
      status: z.enum(clientsService.CLIENT_STATUSES).optional(),
      recurring: z.enum(['true', 'false']).optional(),
    })
    .parse(c.req.query())
  return c.json(
    await clientsService.listClients({
      q: query.q,
      kind: query.kind,
      status: query.status,
      recurring: query.recurring === undefined ? undefined : query.recurring === 'true',
    }),
  )
})
app.post('/clients', async (c) => c.json(await clientsService.createClient(z.object(clientFields).parse(await c.req.json()))))
app.get('/clients/:id', async (c) => {
  const client = await clientsService.getClient(idParam.parse(c.req.param()).id)
  if (!client) return c.json({ error: 'cliente não encontrado' }, 404)
  return c.json(client)
})
app.patch('/clients/:id', async (c) => {
  const client = await clientsService.updateClient(idParam.parse(c.req.param()).id, z.object(clientFields).partial().parse(await c.req.json()))
  if (!client) return c.json({ error: 'cliente não encontrado' }, 404)
  return c.json(client)
})
app.delete('/clients/:id', async (c) => c.json(await clientsService.deleteClient(idParam.parse(c.req.param()).id)))
app.get('/clients/:id/payer-suggestions', async (c) => {
  const suggestions = await clientsService.payerSuggestions(idParam.parse(c.req.param()).id)
  if (!suggestions) return c.json({ error: 'cliente não encontrado' }, 404)
  return c.json({ suggestions })
})
app.post('/clients/:id/contacts', async (c) =>
  c.json(await clientsService.addContact(idParam.parse(c.req.param()).id, z.object(contactFields).parse(await c.req.json()))),
)
app.patch('/clients/:id/contacts/:contactId', async (c) => {
  const { id, contactId } = contactParams.parse(c.req.param())
  const contact = await clientsService.updateContact(id, contactId, z.object(contactFields).partial().parse(await c.req.json()))
  if (!contact) return c.json({ error: 'contato não encontrado' }, 404)
  return c.json(contact)
})
app.delete('/clients/:id/contacts/:contactId', async (c) => {
  const { id, contactId } = contactParams.parse(c.req.param())
  return c.json(await clientsService.deleteContact(id, contactId))
})
app.post('/clients/:id/aliases', async (c) => {
  const { alias } = z.object({ alias: z.string().trim().min(1).max(160) }).parse(await c.req.json())
  return c.json(await clientsService.addPayerAlias(idParam.parse(c.req.param()).id, alias))
})
app.delete('/clients/:id/aliases/:aliasId', async (c) => {
  const { id, aliasId } = aliasParams.parse(c.req.param())
  return c.json(await clientsService.deletePayerAlias(id, aliasId))
})
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
app.get('/clients/:id/transaction-candidates', async (c) => {
  const query = z.object({ q: z.string().max(160).optional(), from: isoDate.optional(), to: isoDate.optional() }).parse(c.req.query())
  const candidates = await clientsService.transactionCandidates(idParam.parse(c.req.param()).id, query)
  if (!candidates) return c.json({ error: 'cliente não encontrado' }, 404)
  return c.json({ transactions: candidates })
})
app.post('/clients/:id/transactions', async (c) => {
  const { transactionIds } = z.object({ transactionIds: z.array(z.number().int().positive()).min(1).max(200) }).parse(await c.req.json())
  const result = await clientsService.linkTransactions(idParam.parse(c.req.param()).id, transactionIds)
  if (!result) return c.json({ error: 'cliente não encontrado' }, 404)
  return c.json(result)
})
app.delete('/clients/:id/transactions/:transactionId', async (c) => {
  const { id, transactionId } = idParam.extend({ transactionId: z.coerce.number().int().positive() }).parse(c.req.param())
  return c.json(await clientsService.unlinkTransaction(id, transactionId))
})

app.get('/services', async (c) => c.json(await catalog.listServices()))
app.post('/services', async (c) => c.json(await catalog.createService(z.object(serviceFields).parse(await c.req.json()))))
app.patch('/services/:id', async (c) => {
  const service = await catalog.updateService(idParam.parse(c.req.param()).id, z.object(serviceFields).partial().parse(await c.req.json()))
  if (!service) return c.json({ error: 'serviço não encontrado' }, 404)
  return c.json(service)
})
app.delete('/services/:id', async (c) => c.json(await catalog.deleteService(idParam.parse(c.req.param()).id)))
app.post('/services/:id/adopt', async (c) => c.json(await catalog.adoptItemsByTitle(idParam.parse(c.req.param()).id)))

app.get('/deals/summary', async (c) => c.json(await dealsService.dealsSummary()))
app.get('/deals/analytics', async (c) => c.json(await dealsService.dealsAnalytics()))
app.get('/deals', async (c) => {
  const query = z
    .object({
      q: z.string().max(160).optional(),
      kind: z.enum(['proposal', 'quote']).optional(),
      stage: z.string().optional(),
      clientId: z.coerce.number().int().positive().optional(),
    })
    .parse(c.req.query())
  return c.json({ deals: await dealsService.listDeals({ q: query.q, kind: query.kind, stages: dealStageList(query.stage), clientId: query.clientId }) })
})
app.post('/deals/:kind/:id/stage', async (c) => {
  const { kind, id } = dealStageParams.parse(c.req.param())
  const { stage } = z.object({ stage: z.enum(DEAL_STAGES) }).parse(await c.req.json())
  const deal = await dealsService.setDealStage(kind, id, stage)
  if (!deal) return c.json({ error: kind === 'proposal' ? 'orçamento não encontrado' : 'cotação não encontrada' }, 404)
  return c.json(deal)
})

Deno.serve(app.fetch)
