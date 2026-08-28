import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as pricing from '../services/pricing'

/**
 * Precificação de projetos. See `specs/project-pricing`.
 *
 * `/pricing/simulate` is a POST that writes nothing: it takes a body too
 * large for a query string, and it is pure Simulação (`decisions/0010`).
 * Persisting is a separate, explicit call to `/pricing/quotes`.
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

export async function pricingRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- *
   * Settings
   * ---------------------------------------------------------------- */
  app.get('/pricing/settings', async () => ({
    settings: await pricing.getSettings(),
    defaults: pricing.DEFAULT_PRICING_SETTINGS,
  }))

  app.put('/pricing/settings', async (req) => {
    const body = z
      .object({
        availableHoursPerMonth: z.number().int().min(1).max(744).optional(),
        billablePercentageBps: z.number().int().min(1).max(10_000).optional(),
      })
      .parse(req.body)
    return { settings: await pricing.updateSettings(body), defaults: pricing.DEFAULT_PRICING_SETTINGS }
  })

  /* ---------------------------------------------------------------- *
   * Multiplier bank
   * ---------------------------------------------------------------- */
  app.get('/pricing/multipliers', async (req) => {
    const query = z.object({ dimension: z.enum(pricing.PRICING_DIMENSIONS).optional() }).parse(req.query)
    const [multipliers, byDimension] = await Promise.all([
      pricing.listMultipliers(query.dimension),
      pricing.multipliersByDimension(),
    ])
    return {
      multipliers,
      byDimension,
      dimensions: pricing.PRICING_DIMENSIONS.map((value) => ({
        value,
        label: pricing.DIMENSION_LABELS[value],
      })),
    }
  })

  app.post('/pricing/multipliers', async (req) => {
    const body = z
      .object({
        dimension: z.enum(pricing.PRICING_DIMENSIONS),
        label: z.string().min(1).max(60),
        description: z.string().max(200).nullable().optional(),
        multiplierBps: z.number().int().min(1).max(1_000_000),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body)
    return pricing.createMultiplier(body)
  })

  app.patch('/pricing/multipliers/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        label: z.string().min(1).max(60).optional(),
        description: z.string().max(200).nullable().optional(),
        multiplierBps: z.number().int().min(1).max(1_000_000).optional(),
        sortOrder: z.number().int().optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body)
    return pricing.updateMultiplier(id, body)
  })

  app.delete('/pricing/multipliers/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return pricing.deleteMultiplier(id)
  })

  /* ---------------------------------------------------------------- *
   * Simulation and quotes
   * ---------------------------------------------------------------- */
  app.post('/pricing/simulate', async (req, reply) => {
    const body = simulateBody.parse(req.body)
    try {
      return pricing.simulate(body)
    } catch (error) {
      // "No basis to calculate" is a state of the user's configuration, not
      // a server fault — same treatment the rest of the app gives a division
      // it refuses to make.
      if (error instanceof pricing.PricingError) return reply.code(422).send({ error: error.message })
      throw error
    }
  })

  app.get('/pricing/quotes', async () => ({ quotes: await pricing.listQuotes() }))

  app.post('/pricing/quotes', async (req, reply) => {
    const body = simulateBody.extend({ clientLabel: z.string().min(1).max(120) }).parse(req.body)
    try {
      return pricing.saveQuote(body)
    } catch (error) {
      if (error instanceof pricing.PricingError) return reply.code(422).send({ error: error.message })
      throw error
    }
  })

  app.get('/pricing/quotes/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const quote = await pricing.getQuote(id)
    if (!quote) return reply.code(404).send({ error: 'cotação não encontrada' })
    return quote
  })

  app.patch('/pricing/quotes/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    // Todo campo de simulateBody, mas nenhum obrigatório: um patch pode
    // tocar só um campo (ex. só directCosts) sem reenviar os outros —
    // decisions/0021, updateQuote mescla com o que já existe na linha.
    const body = simulateBody
      .omit({ period: true })
      .partial()
      .extend({ clientLabel: z.string().min(1).max(120).optional() })
      .parse(req.body)
    try {
      const quote = await pricing.updateQuote(id, body)
      if (!quote) return reply.code(404).send({ error: 'cotação não encontrada' })
      return quote
    } catch (error) {
      if (error instanceof pricing.PricingError) return reply.code(422).send({ error: error.message })
      throw error
    }
  })

  app.delete('/pricing/quotes/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return pricing.deleteQuote(id)
  })

  app.patch('/pricing/quotes/:id/status', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ status: z.enum(pricing.QUOTE_STATUSES) }).parse(req.body)
    const quote = await pricing.setQuoteStatus(id, body.status)
    if (!quote) return reply.code(404).send({ error: 'cotação não encontrada' })
    return quote
  })

  app.post('/pricing/quotes/:id/approve', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        accountId: z.number().int().positive(),
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(req.body)
    try {
      return pricing.approveQuote(id, body)
    } catch (error) {
      if (error instanceof pricing.PricingError) return reply.code(422).send({ error: error.message })
      throw error
    }
  })
}
