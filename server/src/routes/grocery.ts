import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import * as grocery from '../services/grocery'
import { todayIso } from '../core/dates'

/**
 * Lista de compras / Mercado (docs/specs/lista-de-compras). Mesmas rotas nas
 * funções Edge: `/grocery/**` na `ledger` (escritas e a lista ativa) e
 * `/grocery-insights/**` na `insights` (orçamento e análise, que passam pelo
 * cache de resposta). GroceryError vira o status dela (404/409/422).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const idParam = z.object({ id: z.coerce.number().int().positive() })
const itemParams = z.object({ id: z.coerce.number().int().positive(), productId: z.coerce.number().int().positive() })
const unit = z.enum(['un', 'kg', 'L'])
const quantity = z.number().positive().max(100_000)

export const groceryBodies = {
  productCreate: z.object({ name: z.string().trim().min(1).max(120), unit, defaultQty: quantity.optional() }),
  productPatch: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    unit: unit.optional(),
    defaultQty: quantity.optional(),
    archived: z.boolean().optional(),
  }),
  tripCreate: z.object({ from: z.enum(['empty', 'last']).default('empty') }),
  tripPatch: z.object({ purchasedOn: isoDate }),
  item: z.object({
    plannedQty: quantity,
    qty: quantity.nullable(),
    unitPriceCents: z.number().int().min(0).max(100_000_000).nullable(),
    checked: z.boolean(),
    clientRev: z.number().int().min(0),
  }),
  status: z.object({ status: z.enum(['shopping', 'done']), purchasedOn: isoDate.optional() }),
  link: z.object({ transactionId: z.number().int().positive() }),
  settings: z.object({ categoryId: z.number().int().positive().nullable() }),
}

async function guarded<T>(reply: FastifyReply, work: () => Promise<T>) {
  try {
    return await work()
  } catch (error) {
    if (error instanceof grocery.GroceryError) return reply.code(error.status).send({ error: error.message })
    throw error
  }
}

export async function groceryRoutes(app: FastifyInstance) {
  app.get('/grocery/products', async (req) => {
    const { archived } = z.object({ archived: z.enum(['true', 'false']).optional() }).parse(req.query)
    return { products: await grocery.listProducts(archived === undefined ? {} : { archived: archived === 'true' }) }
  })
  app.post('/grocery/products', async (req, reply) => guarded(reply, () => grocery.createProduct(groceryBodies.productCreate.parse(req.body))))
  app.patch('/grocery/products/:id', async (req, reply) =>
    guarded(reply, () => grocery.updateProduct(idParam.parse(req.params).id, groceryBodies.productPatch.parse(req.body))),
  )

  app.get('/grocery/trips/active', async () => ({ trip: await grocery.getActiveTrip() }))
  app.get('/grocery/trips', async (req) => {
    const { year } = z.object({ year: z.string().regex(/^\d{4}$/).optional() }).parse(req.query)
    return { trips: await grocery.listTrips(year ? { year } : {}) }
  })
  app.post('/grocery/trips', async (req, reply) => guarded(reply, () => grocery.createTrip(groceryBodies.tripCreate.parse(req.body ?? {}))))
  app.get('/grocery/trips/:id', async (req, reply) => guarded(reply, () => grocery.getTrip(idParam.parse(req.params).id)))
  app.patch('/grocery/trips/:id', async (req, reply) =>
    guarded(reply, () => grocery.updateTrip(idParam.parse(req.params).id, groceryBodies.tripPatch.parse(req.body))),
  )
  app.delete('/grocery/trips/:id', async (req, reply) => guarded(reply, () => grocery.deleteTrip(idParam.parse(req.params).id)))
  app.put('/grocery/trips/:id/items/:productId', async (req, reply) =>
    guarded(reply, () => {
      const { id, productId } = itemParams.parse(req.params)
      return grocery.putItem(id, productId, groceryBodies.item.parse(req.body))
    }),
  )
  app.delete('/grocery/trips/:id/items/:productId', async (req, reply) =>
    guarded(reply, () => {
      const { id, productId } = itemParams.parse(req.params)
      return grocery.deleteItem(id, productId)
    }),
  )
  app.post('/grocery/trips/:id/status', async (req, reply) =>
    guarded(reply, () => grocery.setTripStatus(idParam.parse(req.params).id, groceryBodies.status.parse(req.body))),
  )
  app.get('/grocery/trips/:id/link-candidates', async (req, reply) =>
    guarded(reply, async () => ({ candidates: await grocery.linkCandidates(idParam.parse(req.params).id) })),
  )
  app.post('/grocery/trips/:id/link', async (req, reply) =>
    guarded(reply, () => grocery.linkTrip(idParam.parse(req.params).id, groceryBodies.link.parse(req.body).transactionId)),
  )
  app.delete('/grocery/trips/:id/link', async (req, reply) => guarded(reply, () => grocery.unlinkTrip(idParam.parse(req.params).id)))

  app.get('/grocery/settings', async () => grocery.getSettings())
  app.put('/grocery/settings', async (req, reply) => guarded(reply, () => grocery.setSettings(groceryBodies.settings.parse(req.body))))

  app.get('/grocery-insights/budget', async (req) => {
    const { period } = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query)
    return grocery.budget(period ?? todayIso().slice(0, 7))
  })
  app.get('/grocery-insights/analytics', async (req) => {
    const { year } = z.object({ year: z.string().regex(/^\d{4}$/).optional() }).parse(req.query)
    return grocery.analytics(year ?? todayIso().slice(0, 4))
  })
}
