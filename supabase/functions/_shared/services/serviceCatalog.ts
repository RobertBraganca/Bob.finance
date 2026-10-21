import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '../db/client.ts'
import { serviceCatalog, serviceProposalItems, serviceProposals } from '../db/schema.ts'
import { normalizeDescription } from '../core/normalize.ts'
import { lineTotalCents } from '../core/proposals.ts'
import { PricingError } from './pricing.ts'

/**
 * Catálogo leve de serviços (docs/specs/clientes-e-negocios, fase 3): o
 * serviço que se escolhe ao montar o orçamento, para "Logo" e "Logotipo" não
 * virarem dois serviços nos números. O item do orçamento continua editável;
 * o catálogo só dá o nome e o preço de partida.
 *
 * Os números de cada serviço saem dos orçamentos APROVADOS: quantas vezes foi
 * vendido, a receita (o item com a fatia dele do desconto) e para quantos
 * clientes. Item sem serviço do catálogo cai em "sem catálogo", agrupado pelo
 * título, para o usuário ver o que vale cadastrar.
 */

export type ServiceInput = {
  name: string
  description?: string | null
  defaultPriceCents?: number
  active?: boolean
  sortOrder?: number
}

export type ServiceStats = {
  timesSold: number
  quantity: number
  revenueCents: number
  clients: number
  lastSoldOn: string | null
}

const emptyStats = (): ServiceStats => ({ timesSold: 0, quantity: 0, revenueCents: 0, clients: 0, lastSoldOn: null })

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code
  return code === '23505'
}

/** Itens dos orçamentos aprovados, cada um com a receita dele (já com a fatia do desconto). */
async function soldItems(executor: DbExecutor) {
  const approved = await executor.select().from(serviceProposals).where(eq(serviceProposals.status, 'approved'))
  if (approved.length === 0) return []
  const items = await executor.select().from(serviceProposalItems).where(inArray(serviceProposalItems.proposalId, approved.map((p) => p.id)))
  const byProposal = new Map(approved.map((p) => [p.id, p] as const))
  const subtotal = new Map<number, number>()
  for (const item of items) subtotal.set(item.proposalId, (subtotal.get(item.proposalId) ?? 0) + lineTotalCents(item))
  return items.map((item) => {
    const proposal = byProposal.get(item.proposalId)!
    const line = lineTotalCents(item)
    const sub = subtotal.get(item.proposalId) ?? 0
    // A receita do item é a fatia dele no valor aprovado (o desconto se divide pelo peso de cada item).
    const approvedTotal = proposal.approvedAmountCents ?? Math.round(sub * (1 - proposal.discountBps / 10_000))
    const revenueCents = sub > 0 ? Math.round((line / sub) * approvedTotal) : 0
    return { item, proposal, revenueCents }
  })
}

export async function listServices(executor: DbExecutor = db) {
  const services = await executor.select().from(serviceCatalog).orderBy(asc(serviceCatalog.sortOrder), asc(serviceCatalog.name))
  const sold = await soldItems(executor)

  const stats = new Map<number, ServiceStats & { clientKeys: Set<string> }>()
  const uncatalogued = new Map<string, ServiceStats & { title: string; clientKeys: Set<string> }>()
  for (const { item, proposal, revenueCents } of sold) {
    const clientKey = proposal.clientId !== null ? `id:${proposal.clientId}` : `nome:${normalizeDescription(proposal.clientLabel)}`
    const soldOn = proposal.updatedAt.slice(0, 10)
    const bucket =
      item.serviceId !== null
        ? (stats.get(item.serviceId) ?? stats.set(item.serviceId, { ...emptyStats(), clientKeys: new Set() }).get(item.serviceId)!)
        : (() => {
            const key = normalizeDescription(item.title)
            return uncatalogued.get(key) ?? uncatalogued.set(key, { ...emptyStats(), title: item.title, clientKeys: new Set() }).get(key)!
          })()
    bucket.timesSold += 1
    bucket.quantity += item.quantity
    bucket.revenueCents += revenueCents
    bucket.clientKeys.add(clientKey)
    if (!bucket.lastSoldOn || soldOn > bucket.lastSoldOn) bucket.lastSoldOn = soldOn
  }
  const finish = ({ clientKeys, ...rest }: ServiceStats & { clientKeys: Set<string> }) => ({ ...rest, clients: clientKeys.size })
  return {
    services: services.map((s) => ({ ...s, stats: stats.has(s.id) ? finish(stats.get(s.id)!) : emptyStats() })),
    uncatalogued: [...uncatalogued.values()]
      .map((u) => ({ ...finish(u), title: u.title }))
      .sort((a, b) => b.revenueCents - a.revenueCents)
      .slice(0, 10),
    assumptions: {
      base: 'itens dos orçamentos aprovados',
      receita: 'a fatia do item no valor aprovado do orçamento (o desconto se divide pelo peso de cada item)',
      semCatalogo: 'itens sem serviço do catálogo, agrupados pelo título',
    },
  }
}

/** Nome repetido conferido antes de gravar (um erro no Postgres aborta a transação inteira). */
async function assertNameFree(name: string, executor: DbExecutor, exceptId?: number) {
  const taken = (await executor.select({ id: serviceCatalog.id }).from(serviceCatalog).where(sql`lower(${serviceCatalog.name}) = lower(${name.trim()})`))[0]
  if (taken && taken.id !== exceptId) throw new PricingError(`já existe um serviço chamado "${name.trim()}"`)
}

export async function createService(input: ServiceInput, executor: DbExecutor = db) {
  if (!input.name.trim()) throw new PricingError('informe o nome do serviço')
  if ((input.defaultPriceCents ?? 0) < 0) throw new PricingError('o preço de referência não pode ser negativo')
  await assertNameFree(input.name, executor)
  try {
    return (
      await executor
        .insert(serviceCatalog)
        .values({
          name: input.name.trim(),
          description: input.description?.trim() || null,
          defaultPriceCents: Math.round(input.defaultPriceCents ?? 0),
          active: input.active ?? true,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning()
    )[0]!
  } catch (error) {
    if (isUniqueViolation(error)) throw new PricingError(`já existe um serviço chamado "${input.name.trim()}"`)
    throw error
  }
}

export async function updateService(id: number, patch: Partial<ServiceInput>, executor: DbExecutor = db) {
  if (patch.name !== undefined && !patch.name.trim()) throw new PricingError('informe o nome do serviço')
  if (patch.defaultPriceCents !== undefined && patch.defaultPriceCents < 0) throw new PricingError('o preço de referência não pode ser negativo')
  if (patch.name !== undefined) await assertNameFree(patch.name, executor, id)
  try {
    const row = (
      await executor
        .update(serviceCatalog)
        .set({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
          ...(patch.defaultPriceCents !== undefined ? { defaultPriceCents: Math.round(patch.defaultPriceCents) } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        })
        .where(eq(serviceCatalog.id, id))
        .returning()
    )[0]
    return row ?? null
  } catch (error) {
    if (isUniqueViolation(error)) throw new PricingError(`já existe um serviço chamado "${patch.name?.trim()}"`)
    throw error
  }
}

/** Apagar tira o serviço do catálogo; os itens dos orçamentos ficam, só perdem o vínculo. */
export async function deleteService(id: number, executor: DbExecutor = db) {
  return { removed: (await executor.delete(serviceCatalog).where(eq(serviceCatalog.id, id))).count }
}

/**
 * Liga ao serviço os itens antigos com o mesmo título (sem acento nem maiúsculas),
 * para o histórico contar no catálogo. Só itens ainda sem serviço.
 */
export async function adoptItemsByTitle(id: number, executor: DbExecutor = db) {
  const service = (await executor.select().from(serviceCatalog).where(eq(serviceCatalog.id, id)))[0]
  if (!service) throw new PricingError('serviço não encontrado')
  const target = normalizeDescription(service.name)
  const loose = await executor.select({ id: serviceProposalItems.id, title: serviceProposalItems.title }).from(serviceProposalItems).where(sql`${serviceProposalItems.serviceId} is null`)
  const ids = loose.filter((i) => normalizeDescription(i.title) === target).map((i) => i.id)
  if (ids.length > 0) await executor.update(serviceProposalItems).set({ serviceId: id }).where(inArray(serviceProposalItems.id, ids))
  return { linked: ids.length }
}
