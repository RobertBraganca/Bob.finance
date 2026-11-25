import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '../db/client'
import { categories, categoryCaps, groceryProducts, grocerySettings, groceryTripItems, groceryTrips, transactions } from '../db/schema'
import { addMonthsToDate, periodBounds, todayIso } from '../core/dates'
import {
  basketIndex,
  basketSeries,
  lastPrices,
  linkWindow,
  normalizeName,
  priceChange,
  rankLinkCandidates,
  tripTotals,
  type BasketIndex,
  type BasketPoint,
  type BasketTrip,
  type CalcItem,
  type GroceryUnit,
  type PricePoint,
  type TripTotals,
} from '../core/grocery'
import { accountScope, idList } from './withdrawals'

/**
 * Lista de compras / Mercado (docs/specs/lista-de-compras).
 *
 * A compra nunca cria lançamento: o gasto real entra pelo Open Finance, e a
 * compra só aponta para ele (`transaction_id`). Preço não é guardado no
 * produto: último preço, histórico e índice da cesta saem dos itens MARCADOS
 * das compras concluídas. O orçamento é o teto da categoria de mercado em
 * Orçamento (`category_caps`), com o gasto medido como lá (escopo pessoal,
 * categoria + filhas).
 *
 * Edge: leituras em sequência, nunca `Promise.all`.
 */

export class GroceryError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message)
  }
}

export type GroceryProduct = {
  id: number
  name: string
  unit: GroceryUnit
  defaultQty: number
  archived: boolean
  lastUnitPriceCents: number | null
  lastPurchasedOn: string | null
}

export type GroceryItem = CalcItem & {
  id: number
  name: string
  unit: GroceryUnit
  clientRev: number
}

export type GroceryTrip = {
  id: number
  status: 'planning' | 'shopping' | 'done'
  startedAt: string | null
  purchasedOn: string | null
  transactionId: number | null
  items: GroceryItem[]
  totals: TripTotals
}

/* ------------------------------------------------------------------ *
 * Preços (derivados)
 * ------------------------------------------------------------------ */

/** Preço de cada item marcado em compra concluída, opcionalmente antes de uma data. */
async function pricePoints(executor: DbExecutor, before?: string): Promise<PricePoint[]> {
  const rows = await executor
    .select({
      productId: groceryTripItems.productId,
      tripId: groceryTrips.id,
      purchasedOn: groceryTrips.purchasedOn,
      unitPriceCents: groceryTripItems.unitPriceCents,
    })
    .from(groceryTripItems)
    .innerJoin(groceryTrips, eq(groceryTrips.id, groceryTripItems.tripId))
    .where(
      and(
        eq(groceryTrips.status, 'done'),
        eq(groceryTripItems.checked, true),
        before ? sql`${groceryTrips.purchasedOn} < ${before}` : undefined,
      ),
    )
  return rows.map((r) => ({ ...r, purchasedOn: r.purchasedOn as string }))
}

/* ------------------------------------------------------------------ *
 * Produtos
 * ------------------------------------------------------------------ */

export async function listProducts(options: { archived?: boolean } = {}, executor: DbExecutor = db): Promise<GroceryProduct[]> {
  const rows = await executor
    .select()
    .from(groceryProducts)
    .where(options.archived === undefined ? undefined : eq(groceryProducts.archived, options.archived))
    .orderBy(asc(groceryProducts.name))
  const last = lastPrices(await pricePoints(executor))
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    unit: p.unit,
    defaultQty: p.defaultQty,
    archived: p.archived,
    lastUnitPriceCents: last.get(p.id)?.unitPriceCents ?? null,
    lastPurchasedOn: last.get(p.id)?.purchasedOn ?? null,
  }))
}

export type ProductInput = { name: string; unit: GroceryUnit; defaultQty?: number }

/** Cria o produto; nome já existente (normalizado) devolve o existente, desarquivado. */
export async function createProduct(input: ProductInput, executor: DbExecutor = db) {
  const name = input.name.trim().replace(/\s+/g, ' ')
  const nameKey = normalizeName(name)
  if (!nameKey) throw new GroceryError(422, 'Dê um nome ao produto.')
  const [existing] = await executor.select().from(groceryProducts).where(eq(groceryProducts.nameKey, nameKey))
  if (existing) {
    if (existing.archived) {
      await executor.update(groceryProducts).set({ archived: false }).where(eq(groceryProducts.id, existing.id))
    }
    return { product: { ...existing, archived: false }, created: false }
  }
  const [product] = await executor
    .insert(groceryProducts)
    .values({ name, nameKey, unit: input.unit, defaultQty: input.defaultQty ?? 1 })
    .returning()
  return { product, created: true }
}

export type ProductPatch = { name?: string; unit?: GroceryUnit; defaultQty?: number; archived?: boolean }

export async function updateProduct(id: number, patch: ProductPatch, executor: DbExecutor = db) {
  const [current] = await executor.select().from(groceryProducts).where(eq(groceryProducts.id, id))
  if (!current) throw new GroceryError(404, 'Produto não encontrado.')
  const set: Partial<typeof groceryProducts.$inferInsert> = {}
  if (patch.name !== undefined) {
    const name = patch.name.trim().replace(/\s+/g, ' ')
    const nameKey = normalizeName(name)
    if (!nameKey) throw new GroceryError(422, 'Dê um nome ao produto.')
    const [clash] = await executor.select({ id: groceryProducts.id }).from(groceryProducts).where(eq(groceryProducts.nameKey, nameKey))
    if (clash && clash.id !== id) throw new GroceryError(409, 'Já existe um produto com esse nome.')
    set.name = name
    set.nameKey = nameKey
  }
  if (patch.unit !== undefined && patch.unit !== current.unit) {
    const [priced] = await executor
      .select({ id: groceryTripItems.id })
      .from(groceryTripItems)
      .innerJoin(groceryTrips, eq(groceryTrips.id, groceryTripItems.tripId))
      .where(and(eq(groceryTripItems.productId, id), eq(groceryTrips.status, 'done'), sql`${groceryTripItems.unitPriceCents} is not null`))
      .limit(1)
    if (priced) throw new GroceryError(409, 'Este produto já tem preço no histórico. Crie outro produto para a nova unidade.')
    set.unit = patch.unit
  }
  if (patch.defaultQty !== undefined) set.defaultQty = patch.defaultQty
  if (patch.archived !== undefined) set.archived = patch.archived
  if (Object.keys(set).length === 0) return current
  const [product] = await executor.update(groceryProducts).set(set).where(eq(groceryProducts.id, id)).returning()
  return product
}

/* ------------------------------------------------------------------ *
 * Compras
 * ------------------------------------------------------------------ */

async function loadTrip(id: number, executor: DbExecutor): Promise<GroceryTrip | null> {
  const [trip] = await executor.select().from(groceryTrips).where(eq(groceryTrips.id, id))
  if (!trip) return null
  const rows = await executor
    .select({
      id: groceryTripItems.id,
      productId: groceryTripItems.productId,
      name: groceryProducts.name,
      unit: groceryProducts.unit,
      plannedQty: groceryTripItems.plannedQty,
      qty: groceryTripItems.qty,
      unitPriceCents: groceryTripItems.unitPriceCents,
      checked: groceryTripItems.checked,
      clientRev: groceryTripItems.clientRev,
    })
    .from(groceryTripItems)
    .innerJoin(groceryProducts, eq(groceryProducts.id, groceryTripItems.productId))
    .where(eq(groceryTripItems.tripId, id))
    .orderBy(asc(groceryProducts.name))
  // Último preço ANTES desta compra: numa compra concluída, o previsto não usa o próprio preço dela.
  const last = lastPrices(await pricePoints(executor, trip.status === 'done' ? (trip.purchasedOn ?? undefined) : undefined))
  const items: GroceryItem[] = rows.map((r) => ({ ...r, lastUnitPriceCents: last.get(r.productId)?.unitPriceCents ?? null }))
  return {
    id: trip.id,
    status: trip.status,
    startedAt: trip.startedAt,
    purchasedOn: trip.purchasedOn,
    transactionId: trip.transactionId,
    items,
    totals: tripTotals(items),
  }
}

async function requireTrip(id: number, executor: DbExecutor) {
  const [trip] = await executor.select().from(groceryTrips).where(eq(groceryTrips.id, id))
  if (!trip) throw new GroceryError(404, 'Compra não encontrada.')
  return trip
}

export async function getActiveTrip(executor: DbExecutor = db): Promise<GroceryTrip | null> {
  const [active] = await executor
    .select({ id: groceryTrips.id })
    .from(groceryTrips)
    .where(inArray(groceryTrips.status, ['planning', 'shopping']))
  return active ? loadTrip(active.id, executor) : null
}

export async function getTrip(id: number, executor: DbExecutor = db): Promise<GroceryTrip> {
  const trip = await loadTrip(id, executor)
  if (!trip) throw new GroceryError(404, 'Compra não encontrada.')
  return trip
}

/** Nova lista, vazia ou com os itens e quantidades da última compra concluída. */
export async function createTrip(input: { from: 'empty' | 'last' }, executor: DbExecutor = db): Promise<GroceryTrip> {
  const [active] = await executor
    .select({ id: groceryTrips.id })
    .from(groceryTrips)
    .where(inArray(groceryTrips.status, ['planning', 'shopping']))
  if (active) throw new GroceryError(409, 'Já existe uma lista em andamento.')
  const [trip] = await executor.insert(groceryTrips).values({}).returning({ id: groceryTrips.id })
  if (!trip) throw new Error('insert de grocery_trips não devolveu linha')
  if (input.from === 'last') {
    const [previous] = await executor
      .select({ id: groceryTrips.id })
      .from(groceryTrips)
      .where(eq(groceryTrips.status, 'done'))
      .orderBy(desc(groceryTrips.purchasedOn), desc(groceryTrips.id))
      .limit(1)
    if (previous) {
      const items = await executor
        .select({ productId: groceryTripItems.productId, plannedQty: groceryTripItems.plannedQty, qty: groceryTripItems.qty })
        .from(groceryTripItems)
        .innerJoin(groceryProducts, eq(groceryProducts.id, groceryTripItems.productId))
        .where(and(eq(groceryTripItems.tripId, previous.id), eq(groceryProducts.archived, false)))
      if (items.length > 0) {
        await executor
          .insert(groceryTripItems)
          .values(items.map((i) => ({ tripId: trip.id, productId: i.productId, plannedQty: i.qty ?? i.plannedQty })))
      }
    }
  }
  return getTrip(trip.id, executor)
}

export async function deleteTrip(id: number, executor: DbExecutor = db) {
  const trip = await requireTrip(id, executor)
  if (trip.status !== 'planning') throw new GroceryError(409, 'Só dá para descartar uma lista que ainda não foi ao mercado.')
  await executor.delete(groceryTrips).where(eq(groceryTrips.id, id))
  return { deleted: true }
}

export async function updateTrip(id: number, patch: { purchasedOn: string }, executor: DbExecutor = db) {
  const trip = await requireTrip(id, executor)
  if (trip.status !== 'done') throw new GroceryError(409, 'A data só muda numa compra concluída.')
  await executor.update(groceryTrips).set({ purchasedOn: patch.purchasedOn }).where(eq(groceryTrips.id, id))
  return getTrip(id, executor)
}

export type ItemInput = {
  plannedQty: number
  qty: number | null
  unitPriceCents: number | null
  checked: boolean
  clientRev: number
}

/**
 * Grava o estado completo de um item (idempotente). Uma escrita com
 * `clientRev` menor ou igual ao gravado é ignorada: a fila offline pode
 * reenviar ou entregar fora de ordem sem desfazer uma edição mais nova.
 */
export async function putItem(tripId: number, productId: number, input: ItemInput, executor: DbExecutor = db): Promise<GroceryItem> {
  const trip = await requireTrip(tripId, executor)
  if (trip.status === 'done') throw new GroceryError(409, 'Esta compra já foi concluída.')
  const [product] = await executor.select({ id: groceryProducts.id }).from(groceryProducts).where(eq(groceryProducts.id, productId))
  if (!product) throw new GroceryError(404, 'Produto não encontrado.')
  const values = {
    tripId,
    productId,
    plannedQty: input.plannedQty,
    qty: input.qty,
    unitPriceCents: input.unitPriceCents,
    checked: input.checked,
    clientRev: input.clientRev,
  }
  await executor
    .insert(groceryTripItems)
    .values(values)
    .onConflictDoUpdate({
      target: [groceryTripItems.tripId, groceryTripItems.productId],
      set: {
        plannedQty: sql`excluded.planned_qty`,
        qty: sql`excluded.qty`,
        unitPriceCents: sql`excluded.unit_price_cents`,
        checked: sql`excluded.checked`,
        clientRev: sql`excluded.client_rev`,
      },
      setWhere: sql`${groceryTripItems.clientRev} < excluded.client_rev`,
    })
  const full = await getTrip(tripId, executor)
  const item = full.items.find((i) => i.productId === productId)
  if (!item) throw new GroceryError(404, 'Item não encontrado.')
  return item
}

export async function deleteItem(tripId: number, productId: number, executor: DbExecutor = db) {
  const trip = await requireTrip(tripId, executor)
  if (trip.status === 'done') throw new GroceryError(409, 'Esta compra já foi concluída.')
  await executor
    .delete(groceryTripItems)
    .where(and(eq(groceryTripItems.tripId, tripId), eq(groceryTripItems.productId, productId)))
  return { deleted: true }
}

/** planning → shopping → done. Concluir grava a data da compra (padrão: hoje). */
export async function setTripStatus(
  id: number,
  input: { status: 'shopping' | 'done'; purchasedOn?: string },
  executor: DbExecutor = db,
): Promise<GroceryTrip> {
  const trip = await requireTrip(id, executor)
  if (trip.status === 'done') throw new GroceryError(409, 'Esta compra já foi concluída.')
  if (input.status === 'shopping') {
    if (trip.status === 'planning') {
      await executor.update(groceryTrips).set({ status: 'shopping', startedAt: new Date().toISOString() }).where(eq(groceryTrips.id, id))
    }
    return getTrip(id, executor)
  }
  const [checked] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(groceryTripItems)
    .where(and(eq(groceryTripItems.tripId, id), eq(groceryTripItems.checked, true)))
  if (!checked || checked.n === 0) throw new GroceryError(422, 'Marque pelo menos um item antes de concluir.')
  await executor
    .update(groceryTrips)
    .set({ status: 'done', purchasedOn: input.purchasedOn ?? todayIso(), startedAt: trip.startedAt ?? new Date().toISOString() })
    .where(eq(groceryTrips.id, id))
  return getTrip(id, executor)
}

export type TripSummary = {
  id: number
  purchasedOn: string
  realCents: number
  plannedCents: number
  itemCount: number
  transactionId: number | null
  transactionAmountCents: number | null
}

/** Compras concluídas (todas, ou de um ano), da mais recente para a mais antiga. */
export async function listTrips(options: { year?: string } = {}, executor: DbExecutor = db): Promise<TripSummary[]> {
  const loaded = await doneTrips(executor)
  return loaded
    .filter((t) => !options.year || t.purchasedOn.startsWith(`${options.year}-`))
    .sort((a, b) => b.purchasedOn.localeCompare(a.purchasedOn) || b.id - a.id)
    .map((t) => ({
      id: t.id,
      purchasedOn: t.purchasedOn,
      realCents: t.totals.realCents,
      plannedCents: t.totals.plannedCents,
      itemCount: t.totals.checkedCount,
      transactionId: t.transactionId,
      transactionAmountCents: t.transactionAmountCents,
    }))
}

type LoadedDoneTrip = {
  id: number
  purchasedOn: string
  transactionId: number | null
  transactionAmountCents: number | null
  items: Array<{ productId: number; plannedQty: number; qty: number | null; unitPriceCents: number | null; checked: boolean }>
  totals: TripTotals
}

/**
 * Todas as compras concluídas com itens, em duas consultas. O previsto de cada
 * uma usa o último preço de compras ANTERIORES a ela (recalculado, nada congelado).
 */
async function doneTrips(executor: DbExecutor): Promise<LoadedDoneTrip[]> {
  const trips = await executor
    .select({
      id: groceryTrips.id,
      purchasedOn: groceryTrips.purchasedOn,
      transactionId: groceryTrips.transactionId,
      transactionAmountCents: transactions.amountCents,
    })
    .from(groceryTrips)
    .leftJoin(transactions, eq(transactions.id, groceryTrips.transactionId))
    .where(eq(groceryTrips.status, 'done'))
    .orderBy(asc(groceryTrips.purchasedOn), asc(groceryTrips.id))
  if (trips.length === 0) return []
  const items = await executor
    .select({
      tripId: groceryTripItems.tripId,
      productId: groceryTripItems.productId,
      plannedQty: groceryTripItems.plannedQty,
      qty: groceryTripItems.qty,
      unitPriceCents: groceryTripItems.unitPriceCents,
      checked: groceryTripItems.checked,
    })
    .from(groceryTripItems)
    .where(inArray(groceryTripItems.tripId, trips.map((t) => t.id)))
  const byTrip = new Map<number, typeof items>()
  for (const it of items) {
    const bucket = byTrip.get(it.tripId)
    if (bucket) bucket.push(it)
    else byTrip.set(it.tripId, [it])
  }
  const points: PricePoint[] = []
  for (const t of trips) {
    for (const it of byTrip.get(t.id) ?? []) {
      if (it.checked) points.push({ productId: it.productId, tripId: t.id, purchasedOn: t.purchasedOn as string, unitPriceCents: it.unitPriceCents })
    }
  }
  return trips.map((t) => {
    const purchasedOn = t.purchasedOn as string
    const before = lastPrices(points.filter((p) => p.purchasedOn < purchasedOn))
    const tripItems = byTrip.get(t.id) ?? []
    const calc: CalcItem[] = tripItems.map((it) => ({ ...it, lastUnitPriceCents: before.get(it.productId)?.unitPriceCents ?? null }))
    return {
      id: t.id,
      purchasedOn,
      transactionId: t.transactionId,
      transactionAmountCents: t.transactionAmountCents,
      items: tripItems,
      totals: tripTotals(calc),
    }
  })
}

/* ------------------------------------------------------------------ *
 * Categoria de mercado, orçamento e vínculo
 * ------------------------------------------------------------------ */

/**
 * A categoria de mercado. Sem escolha gravada, procura uma categoria NÃO
 * arquivada chamada "Supermercado" e grava a escolha.
 */
export async function getSettings(executor: DbExecutor = db): Promise<{ categoryId: number | null; categoryName: string | null }> {
  const [row] = await executor.select().from(grocerySettings).where(eq(grocerySettings.id, 1))
  let categoryId = row?.categoryId ?? null
  if (categoryId === null) {
    const candidates = await executor
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.archived, false))
    const found = candidates.find((c) => normalizeName(c.name) === 'supermercado')
    if (found) {
      categoryId = found.id
      await executor
        .insert(grocerySettings)
        .values({ id: 1, categoryId })
        .onConflictDoUpdate({ target: grocerySettings.id, set: { categoryId } })
    }
  }
  if (categoryId === null) return { categoryId: null, categoryName: null }
  const [category] = await executor.select({ name: categories.name }).from(categories).where(eq(categories.id, categoryId))
  return { categoryId, categoryName: category?.name ?? null }
}

export async function setSettings(input: { categoryId: number | null }, executor: DbExecutor = db) {
  if (input.categoryId !== null) {
    const [category] = await executor.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId))
    if (!category) throw new GroceryError(404, 'Categoria não encontrada.')
  }
  await executor
    .insert(grocerySettings)
    .values({ id: 1, categoryId: input.categoryId })
    .onConflictDoUpdate({ target: grocerySettings.id, set: { categoryId: input.categoryId } })
  return getSettings(executor)
}

/** A categoria e as filhas diretas (o teto na mãe cobre as filhas, como em Orçamento). */
async function categoryFamily(categoryId: number, executor: DbExecutor): Promise<number[]> {
  const kids = await executor.select({ id: categories.id }).from(categories).where(eq(categories.parentId, categoryId))
  return [categoryId, ...kids.map((k) => k.id)]
}

/**
 * Gasto da família de categorias por mês (YYYY-MM), no escopo pessoal e com os
 * mesmos filtros do teto em Orçamento: efetivado, não ignorado, sem ajuste, saída.
 */
async function spentByMonth(ids: number[], from: string, to: string, executor: DbExecutor): Promise<Map<string, number>> {
  const scope = await accountScope()
  const rows = await executor.execute<{ month: string; cents: number }>(sql`
    select substr(t.posted_on, 1, 7) as month, coalesce(sum(abs(t.amount_cents)), 0)::bigint as cents
    from transactions t
    where t.category_id in (${idList(ids)})
      and t.posted_on between ${from} and ${to}
      and t.pending = false and t.ignored = false and t.source <> 'adjustment'
      and t.amount_cents < 0
      and t.account_id in (${idList(scope.personal)})
    group by 1
  `)
  return new Map(rows.map((r) => [r.month, Number(r.cents)]))
}

export type GroceryBudget = {
  period: string
  categoryId: number | null
  categoryName: string | null
  capCents: number | null
  spentCents: number
  /** a compra ativa já está vinculada (o gasto dela já está em `spentCents`) */
  activeTripLinked: boolean
}

export async function budget(period: string, executor: DbExecutor = db): Promise<GroceryBudget> {
  const settings = await getSettings(executor)
  const active = await executor
    .select({ transactionId: groceryTrips.transactionId })
    .from(groceryTrips)
    .where(inArray(groceryTrips.status, ['planning', 'shopping']))
  const activeTripLinked = Boolean(active[0]?.transactionId)
  if (settings.categoryId === null) {
    return { period, categoryId: null, categoryName: null, capCents: null, spentCents: 0, activeTripLinked }
  }
  const [cap] = await executor
    .select({ capCents: categoryCaps.capCents })
    .from(categoryCaps)
    .where(and(eq(categoryCaps.period, period), eq(categoryCaps.categoryId, settings.categoryId)))
  const { start, end } = periodBounds(period)
  const spent = await spentByMonth(await categoryFamily(settings.categoryId, executor), start, end, executor)
  return {
    period,
    categoryId: settings.categoryId,
    categoryName: settings.categoryName,
    capCents: cap?.capCents ?? null,
    spentCents: spent.get(period) ?? 0,
    activeTripLinked,
  }
}

export type LinkCandidateRow = { id: number; postedOn: string; description: string; amountCents: number; differenceCents: number }

/** Lançamentos de mercado perto da data da compra, ainda sem compra vinculada. */
export async function linkCandidates(tripId: number, executor: DbExecutor = db): Promise<LinkCandidateRow[]> {
  const trip = await getTrip(tripId, executor)
  if (trip.status !== 'done' || !trip.purchasedOn) throw new GroceryError(409, 'Conclua a compra antes de vincular.')
  const settings = await getSettings(executor)
  if (settings.categoryId === null) return []
  const ids = await categoryFamily(settings.categoryId, executor)
  const { from, to } = linkWindow(trip.purchasedOn)
  const rows = await executor
    .select({ id: transactions.id, postedOn: transactions.postedOn, description: transactions.description, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        inArray(transactions.categoryId, ids),
        sql`${transactions.postedOn} between ${from} and ${to}`,
        sql`${transactions.amountCents} < 0`,
        eq(transactions.ignored, false),
        sql`not exists (select 1 from grocery_trips g where g.transaction_id = ${transactions.id} and g.id <> ${tripId})`,
      ),
    )
  return rankLinkCandidates(rows, { realCents: trip.totals.realCents, purchasedOn: trip.purchasedOn })
}

export async function linkTrip(tripId: number, transactionId: number, executor: DbExecutor = db) {
  const trip = await requireTrip(tripId, executor)
  if (trip.status !== 'done') throw new GroceryError(409, 'Conclua a compra antes de vincular.')
  const [txn] = await executor.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, transactionId))
  if (!txn) throw new GroceryError(404, 'Lançamento não encontrado.')
  const [other] = await executor
    .select({ id: groceryTrips.id })
    .from(groceryTrips)
    .where(and(eq(groceryTrips.transactionId, transactionId), sql`${groceryTrips.id} <> ${tripId}`))
  if (other) throw new GroceryError(409, 'Esse lançamento já está vinculado a outra compra.')
  await executor.update(groceryTrips).set({ transactionId }).where(eq(groceryTrips.id, tripId))
  return getTrip(tripId, executor)
}

export async function unlinkTrip(tripId: number, executor: DbExecutor = db) {
  await requireTrip(tripId, executor)
  await executor.update(groceryTrips).set({ transactionId: null }).where(eq(groceryTrips.id, tripId))
  return getTrip(tripId, executor)
}

/* ------------------------------------------------------------------ *
 * Análise
 * ------------------------------------------------------------------ */

export type ProductTrend = {
  productId: number
  name: string
  unit: GroceryUnit
  archived: boolean
  firstUnitPriceCents: number
  lastUnitPriceCents: number
  change: number | null
  history: Array<{ purchasedOn: string; unitPriceCents: number }>
}

export type GroceryAnalytics = {
  year: string
  categoryId: number | null
  kpis: {
    /** gasto real com mercado no ano (ledger), null sem categoria */
    spentYearCents: number | null
    tripsCount: number
    avgTicketCents: number | null
    basketSinceStart: BasketIndex | null
    basket12m: BasketIndex | null
    /** Σ(real − previsto) das compras do ano; positivo = gastou mais que o previsto */
    plannedVsRealCents: number
  }
  unlinkedTrips: number
  monthly: Array<{ month: string; currentCents: number; previousCents: number }>
  series: BasketPoint[]
  products: ProductTrend[]
}

export async function analytics(year: string, executor: DbExecutor = db): Promise<GroceryAnalytics> {
  const trips = await doneTrips(executor)
  const basketTrips: BasketTrip[] = trips.map((t) => ({
    tripId: t.id,
    purchasedOn: t.purchasedOn,
    items: t.items.filter((i) => i.checked).map((i) => ({ productId: i.productId, qty: i.qty ?? i.plannedQty, unitPriceCents: i.unitPriceCents })),
  }))
  const series = basketSeries(basketTrips)
  const latest = basketTrips[basketTrips.length - 1]
  const cutoff = addMonthsToDate(todayIso(), -12)
  const base12 = basketTrips.find((t) => t.purchasedOn >= cutoff)
  const basket12m = base12 && latest && base12.tripId !== latest.tripId ? basketIndex(base12.items, latest.items) : null
  const basketSinceStart = series.length >= 2 ? series[series.length - 1] : null

  const inYear = trips.filter((t) => t.purchasedOn.startsWith(`${year}-`))
  const avgTicketCents = inYear.length ? Math.round(inYear.reduce((s, t) => s + t.totals.realCents, 0) / inYear.length) : null
  const plannedVsRealCents = inYear
    .filter((t) => t.totals.missingPriceCount === 0)
    .reduce((s, t) => s + (t.totals.realCents - t.totals.plannedCents), 0)

  const settings = await getSettings(executor)
  const monthly: GroceryAnalytics['monthly'] = []
  let spentYearCents: number | null = null
  if (settings.categoryId !== null) {
    const prev = String(Number(year) - 1)
    const spent = await spentByMonth(await categoryFamily(settings.categoryId, executor), `${prev}-01-01`, `${year}-12-31`, executor)
    spentYearCents = 0
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0')
      const currentCents = spent.get(`${year}-${mm}`) ?? 0
      spentYearCents += currentCents
      monthly.push({ month: mm, currentCents, previousCents: spent.get(`${prev}-${mm}`) ?? 0 })
    }
  }

  const products = await executor.select().from(groceryProducts)
  const history = new Map<number, Array<{ purchasedOn: string; unitPriceCents: number }>>()
  for (const t of trips) {
    for (const it of t.items) {
      if (!it.checked || it.unitPriceCents === null) continue
      const bucket = history.get(it.productId) ?? []
      bucket.push({ purchasedOn: t.purchasedOn, unitPriceCents: it.unitPriceCents })
      history.set(it.productId, bucket)
    }
  }
  const trends: ProductTrend[] = []
  for (const p of products) {
    const h = history.get(p.id)
    const firstPoint = h?.[0]
    const lastPoint = h?.[h.length - 1]
    if (!h || !firstPoint || !lastPoint) continue
    const first = firstPoint.unitPriceCents
    const last = lastPoint.unitPriceCents
    trends.push({
      productId: p.id,
      name: p.name,
      unit: p.unit,
      archived: p.archived,
      firstUnitPriceCents: first,
      lastUnitPriceCents: last,
      change: priceChange(first, last),
      history: h,
    })
  }
  trends.sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity) || a.name.localeCompare(b.name))

  return {
    year,
    categoryId: settings.categoryId,
    kpis: {
      spentYearCents,
      tripsCount: inYear.length,
      avgTicketCents,
      basketSinceStart: basketSinceStart ? { index: basketSinceStart.index, matched: basketSinceStart.matched, total: basketSinceStart.total } : null,
      basket12m,
      plannedVsRealCents,
    },
    unlinkedTrips: trips.filter((t) => t.transactionId === null).length,
    monthly,
    series,
    products: trends,
  }
}
