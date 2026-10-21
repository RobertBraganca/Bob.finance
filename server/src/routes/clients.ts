import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import * as clientsService from '../services/clients'
import * as dealsService from '../services/deals'
import * as catalog from '../services/serviceCatalog'
import { PricingError } from '../services/pricing'
import { DEAL_STAGES } from '../core/deals'

/**
 * Clientes, catálogo de serviços e negócios (docs/specs/clientes-e-negocios).
 * Mesmas rotas na função Edge `pricing` (supabase/functions/pricing/index.ts).
 * Rotas fixas antes das com `:id`. Erro de regra (PricingError) vira 422.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() })
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
export const clientCreateBody = z.object(clientFields)
export const clientPatchBody = z.object(clientFields).partial()

const contactFields = {
  name: z.string().trim().min(1).max(160),
  role: optionalText(120),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  phone: optionalText(60),
  isPrimary: z.boolean().optional(),
}
export const contactCreateBody = z.object(contactFields)
export const contactPatchBody = z.object(contactFields).partial()

export const clientListQuery = z.object({
  q: z.string().max(160).optional(),
  kind: z.enum(clientsService.CLIENT_KINDS).optional(),
  status: z.enum(clientsService.CLIENT_STATUSES).optional(),
  recurring: z.enum(['true', 'false']).optional(),
})

const serviceFields = {
  name: z.string().trim().min(1).max(160),
  description: optionalText(2000),
  defaultPriceCents: z.number().int().min(0).max(1_000_000_000).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
}
export const serviceCreateBody = z.object(serviceFields)
export const servicePatchBody = z.object(serviceFields).partial()

export const dealListQuery = z.object({
  q: z.string().max(160).optional(),
  kind: z.enum(['proposal', 'quote']).optional(),
  stage: z.string().optional(),
  clientId: z.coerce.number().int().positive().optional(),
})
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const candidateQuery = z.object({ q: z.string().max(160).optional(), from: isoDate.optional(), to: isoDate.optional() })
export const linkTransactionsBody = z.object({ transactionIds: z.array(z.number().int().positive()).min(1).max(200) })

export const dealStageParams = z.object({ kind: z.enum(['proposal', 'quote']), id: z.coerce.number().int().positive() })
export const dealStageBody = z.object({ stage: z.enum(DEAL_STAGES) })

export const stageList = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is (typeof DEAL_STAGES)[number] => (DEAL_STAGES as readonly string[]).includes(s))

async function guarded<T>(reply: FastifyReply, work: () => Promise<T>) {
  try {
    return await work()
  } catch (error) {
    if (error instanceof PricingError) return reply.code(422).send({ error: error.message })
    throw error
  }
}

export async function clientsRoutes(app: FastifyInstance) {
  /* ---- clientes ---- */
  app.get('/pricing/clients', async (req) => {
    const query = clientListQuery.parse(req.query)
    return clientsService.listClients({
      q: query.q,
      kind: query.kind,
      status: query.status,
      recurring: query.recurring === undefined ? undefined : query.recurring === 'true',
    })
  })
  app.post('/pricing/clients', async (req, reply) => guarded(reply, () => clientsService.createClient(clientCreateBody.parse(req.body))))
  app.get('/pricing/clients/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const client = await clientsService.getClient(id)
    if (!client) return reply.code(404).send({ error: 'cliente não encontrado' })
    return client
  })
  app.patch('/pricing/clients/:id', async (req, reply) =>
    guarded(reply, async () => {
      const { id } = idParam.parse(req.params)
      const client = await clientsService.updateClient(id, clientPatchBody.parse(req.body))
      if (!client) return reply.code(404).send({ error: 'cliente não encontrado' })
      return client
    }),
  )
  app.delete('/pricing/clients/:id', async (req) => clientsService.deleteClient(idParam.parse(req.params).id))
  app.get('/pricing/clients/:id/payer-suggestions', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const suggestions = await clientsService.payerSuggestions(id)
    if (!suggestions) return reply.code(404).send({ error: 'cliente não encontrado' })
    return { suggestions }
  })
  app.post('/pricing/clients/:id/contacts', async (req, reply) =>
    guarded(reply, () => clientsService.addContact(idParam.parse(req.params).id, contactCreateBody.parse(req.body))),
  )
  app.patch('/pricing/clients/:id/contacts/:contactId', async (req, reply) =>
    guarded(reply, async () => {
      const { id, contactId } = idParam.extend({ contactId: z.coerce.number().int().positive() }).parse(req.params)
      const contact = await clientsService.updateContact(id, contactId, contactPatchBody.parse(req.body))
      if (!contact) return reply.code(404).send({ error: 'contato não encontrado' })
      return contact
    }),
  )
  app.delete('/pricing/clients/:id/contacts/:contactId', async (req) => {
    const { id, contactId } = idParam.extend({ contactId: z.coerce.number().int().positive() }).parse(req.params)
    return clientsService.deleteContact(id, contactId)
  })
  app.post('/pricing/clients/:id/aliases', async (req, reply) =>
    guarded(reply, () =>
      clientsService.addPayerAlias(idParam.parse(req.params).id, z.object({ alias: z.string().trim().min(1).max(160) }).parse(req.body).alias),
    ),
  )
  app.delete('/pricing/clients/:id/aliases/:aliasId', async (req) => {
    const { id, aliasId } = idParam.extend({ aliasId: z.coerce.number().int().positive() }).parse(req.params)
    return clientsService.deletePayerAlias(id, aliasId)
  })
  app.get('/pricing/clients/:id/transaction-candidates', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const candidates = await clientsService.transactionCandidates(id, candidateQuery.parse(req.query))
    if (!candidates) return reply.code(404).send({ error: 'cliente não encontrado' })
    return { transactions: candidates }
  })
  app.post('/pricing/clients/:id/transactions', async (req, reply) =>
    guarded(reply, async () => {
      const result = await clientsService.linkTransactions(idParam.parse(req.params).id, linkTransactionsBody.parse(req.body).transactionIds)
      if (!result) return reply.code(404).send({ error: 'cliente não encontrado' })
      return result
    }),
  )
  app.delete('/pricing/clients/:id/transactions/:transactionId', async (req) => {
    const { id, transactionId } = idParam.extend({ transactionId: z.coerce.number().int().positive() }).parse(req.params)
    return clientsService.unlinkTransaction(id, transactionId)
  })

  /* ---- catálogo de serviços ---- */
  app.get('/pricing/services', async () => catalog.listServices())
  app.post('/pricing/services', async (req, reply) => guarded(reply, () => catalog.createService(serviceCreateBody.parse(req.body))))
  app.patch('/pricing/services/:id', async (req, reply) =>
    guarded(reply, async () => {
      const service = await catalog.updateService(idParam.parse(req.params).id, servicePatchBody.parse(req.body))
      if (!service) return reply.code(404).send({ error: 'serviço não encontrado' })
      return service
    }),
  )
  app.delete('/pricing/services/:id', async (req) => catalog.deleteService(idParam.parse(req.params).id))
  app.post('/pricing/services/:id/adopt', async (req, reply) => guarded(reply, () => catalog.adoptItemsByTitle(idParam.parse(req.params).id)))

  /* ---- negócios (cotações e orçamentos juntos) ---- */
  app.get('/pricing/deals/summary', async () => dealsService.dealsSummary())
  app.get('/pricing/deals/analytics', async () => dealsService.dealsAnalytics())
  app.get('/pricing/deals', async (req) => {
    const query = dealListQuery.parse(req.query)
    return { deals: await dealsService.listDeals({ q: query.q, kind: query.kind, stages: stageList(query.stage), clientId: query.clientId }) }
  })
  app.post('/pricing/deals/:kind/:id/stage', async (req, reply) =>
    guarded(reply, async () => {
      const { kind, id } = dealStageParams.parse(req.params)
      const deal = await dealsService.setDealStage(kind, id, dealStageBody.parse(req.body).stage)
      if (!deal) return reply.code(404).send({ error: kind === 'proposal' ? 'orçamento não encontrado' : 'cotação não encontrada' })
      return deal
    }),
  )
}
