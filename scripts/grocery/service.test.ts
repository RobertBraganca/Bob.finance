import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { sql } from 'drizzle-orm'

/**
 * Lista de compras (docs/specs/lista-de-compras) no banco. Cada teste roda numa
 * transação que aplica a migração e sempre desfaz: nada fica gravado. Sem
 * credenciais do banco, a suíte é pulada.
 */

try {
  process.loadEnvFile(process.env.BOB_ENV_FILE)
} catch {
  // sem .env: a parte de banco é pulada
}
const hasDb = Boolean(process.env.SUPABASE_DB_HOST && process.env.SUPABASE_DB_PASSWORD)
const skip = hasDb ? false : 'sem credenciais do banco (.env ou BOB_ENV_FILE)'
const loaded = hasDb
  ? {
      client: await import('../../server/src/db/client'),
      schema: await import('../../server/src/db/schema'),
      grocery: await import('../../server/src/services/grocery'),
    }
  : null

const MIGRATION = readFileSync(new URL('../../supabase/migrations/20261125120000_grocery.sql', import.meta.url), 'utf8')
class Rollback extends Error {}
type Tx = import('../../server/src/db/client').DbExecutor

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  const { db } = loaded!.client
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`)
      await tx.execute(sql.raw(MIGRATION))
      // a migração pode já estar aplicada: começa sempre do zero dentro da transação
      await tx.execute(sql`delete from grocery_trip_items; delete from grocery_trips; delete from grocery_products; delete from grocery_settings`)
      await fn(tx)
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
}

const rejectsWith = (run: () => Promise<unknown>, status: number, pattern?: RegExp) =>
  assert.rejects(run, (error: unknown) => {
    const g = loaded!.grocery
    return error instanceof g.GroceryError && error.status === status && (!pattern || pattern.test(error.message))
  })

/** Compra concluída com itens marcados e preço, numa data. */
async function doneTrip(tx: Tx, purchasedOn: string, items: Array<{ productId: number; qty: number; price: number }>) {
  const g = loaded!.grocery
  const trip = await g.createTrip({ from: 'empty' }, tx)
  for (const it of items) {
    await g.putItem(trip.id, it.productId, { plannedQty: it.qty, qty: it.qty, unitPriceCents: it.price, checked: true, clientRev: 1 }, tx)
  }
  await g.setTripStatus(trip.id, { status: 'done', purchasedOn }, tx)
  return trip.id
}

describe('lista de compras no banco (rollback)', { skip }, () => {
  test('produto com nome repetido devolve o existente e desarquiva', async () => {
    await inRollback(async (tx) => {
      const g = loaded!.grocery
      const a = await g.createProduct({ name: 'Feijão Carioca 1kg', unit: 'un' }, tx)
      assert.equal(a.created, true)
      await g.updateProduct(a.product.id, { archived: true }, tx)
      const b = await g.createProduct({ name: '  feijao   carioca 1KG', unit: 'kg' }, tx)
      assert.equal(b.created, false)
      assert.equal(b.product.id, a.product.id)
      const [row] = await g.listProducts({}, tx)
      assert.equal(row?.archived, false)
      assert.equal(row?.unit, 'un')
    })
  })

  test('uma lista ativa por vez; item idempotente e clientRev antigo ignorado', async () => {
    await inRollback(async (tx) => {
      const g = loaded!.grocery
      const { product } = await g.createProduct({ name: 'Leite 1L', unit: 'L' }, tx)
      const trip = await g.createTrip({ from: 'empty' }, tx)
      await rejectsWith(() => g.createTrip({ from: 'empty' }, tx), 409)

      const put = (rev: number, price: number) =>
        g.putItem(trip.id, product.id, { plannedQty: 12, qty: 12, unitPriceCents: price, checked: true, clientRev: rev }, tx)
      await put(2, 549)
      await put(2, 549) // reenvio: igual
      await put(1, 499) // atrasado: ignorado
      const item = (await g.getActiveTrip(tx))!.items[0]!
      assert.equal(item.unitPriceCents, 549)
      assert.equal(item.clientRev, 2)
      assert.equal((await g.getActiveTrip(tx))!.totals.realCents, 12 * 549)
    })
  })

  test('fluxo de status: concluir exige item marcado; compra concluída não aceita item', async () => {
    await inRollback(async (tx) => {
      const g = loaded!.grocery
      const { product } = await g.createProduct({ name: 'Arroz 5kg', unit: 'un' }, tx)
      const trip = await g.createTrip({ from: 'empty' }, tx)
      await g.putItem(trip.id, product.id, { plannedQty: 1, qty: null, unitPriceCents: null, checked: false, clientRev: 1 }, tx)
      const shopping = await g.setTripStatus(trip.id, { status: 'shopping' }, tx)
      assert.equal(shopping.status, 'shopping')
      assert.ok(shopping.startedAt)
      await rejectsWith(() => g.setTripStatus(trip.id, { status: 'done' }, tx), 422)
      await g.putItem(trip.id, product.id, { plannedQty: 1, qty: 1, unitPriceCents: 2790, checked: true, clientRev: 2 }, tx)
      const done = await g.setTripStatus(trip.id, { status: 'done', purchasedOn: '2026-11-20' }, tx)
      assert.equal(done.purchasedOn, '2026-11-20')
      await rejectsWith(() => g.putItem(trip.id, product.id, { plannedQty: 1, qty: 1, unitPriceCents: 1, checked: true, clientRev: 9 }, tx), 409)
      assert.equal(await g.getActiveTrip(tx), null)
      await rejectsWith(() => g.deleteTrip(trip.id, tx), 409)
    })
  })

  test('repetir última copia produtos e quantidades reais; último preço aparece na lista', async () => {
    await inRollback(async (tx) => {
      const g = loaded!.grocery
      const leite = (await g.createProduct({ name: 'Leite', unit: 'L' }, tx)).product
      const carne = (await g.createProduct({ name: 'Patinho', unit: 'kg' }, tx)).product
      await doneTrip(tx, '2026-11-01', [
        { productId: leite.id, qty: 12, price: 529 },
        { productId: carne.id, qty: 1.08, price: 4290 },
      ])
      const next = await g.createTrip({ from: 'last' }, tx)
      const byName = new Map(next.items.map((i) => [i.name, i]))
      assert.equal(byName.get('Patinho')?.plannedQty, 1.08)
      assert.equal(byName.get('Leite')?.lastUnitPriceCents, 529)
      assert.equal(next.totals.plannedCents, 12 * 529 + 4633)
      assert.equal(next.totals.missingPriceCount, 0)
    })
  })

  test('unidade não muda depois que o produto tem preço no histórico', async () => {
    await inRollback(async (tx) => {
      const g = loaded!.grocery
      const { product } = await g.createProduct({ name: 'Banana', unit: 'un' }, tx)
      await g.updateProduct(product.id, { unit: 'kg' }, tx) // sem histórico: pode
      await doneTrip(tx, '2026-11-01', [{ productId: product.id, qty: 1.5, price: 649 }])
      await rejectsWith(() => g.updateProduct(product.id, { unit: 'un' }, tx), 409, /outro produto/)
    })
  })

  test('vínculo: candidatos na janela e na categoria; lançamento não vincula duas vezes', async () => {
    await inRollback(async (tx) => {
      const g = loaded!.grocery
      const { schema } = loaded!
      const settings = await g.getSettings(tx)
      assert.ok(settings.categoryId, 'precisa de uma categoria "Supermercado" ativa no banco')
      const [account] = await tx.select({ id: schema.accounts.id }).from(schema.accounts).limit(1)
      const insertTxn = async (postedOn: string, amountCents: number, categoryId: number | null) => {
        const [row] = await tx
          .insert(schema.transactions)
          .values({
            accountId: account!.id,
            postedOn,
            description: '[teste] mercado',
            amountCents,
            direction: 'out',
            categoryId,
            dedupeHash: `teste-grocery-${postedOn}-${amountCents}-${Math.random()}`,
          })
          .returning({ id: schema.transactions.id })
        return row!.id
      }
      const { product } = await g.createProduct({ name: 'Café', unit: 'un' }, tx)
      const tripA = await doneTrip(tx, '2031-03-01', [{ productId: product.id, qty: 10, price: 3800 }])
      const near = await insertTxn('2031-03-02', -38500, settings.categoryId)
      const far = await insertTxn('2031-03-01', -40000, settings.categoryId)
      await insertTxn('2031-03-20', -38000, settings.categoryId) // fora da janela
      await insertTxn('2031-03-01', -38000, null) // outra categoria

      const candidates = await g.linkCandidates(tripA, tx)
      assert.deepEqual(
        candidates.map((c) => [c.id, c.differenceCents]),
        [
          [near, 500],
          [far, 2000],
        ],
      )
      await g.linkTrip(tripA, near, tx)
      const tripB = await doneTrip(tx, '2031-03-02', [{ productId: product.id, qty: 1, price: 3900 }])
      await rejectsWith(() => g.linkTrip(tripB, near, tx), 409)
      assert.deepEqual(
        (await g.linkCandidates(tripB, tx)).map((c) => c.id),
        [far],
      )
      const summary = await g.listTrips({ year: '2031' }, tx)
      assert.equal(summary.find((t) => t.id === tripA)?.transactionAmountCents, -38500)
    })
  })

  test('análise: índice da cesta, ranking por produto e previsto × real', async () => {
    await inRollback(async (tx) => {
      const g = loaded!.grocery
      const cafe = (await g.createProduct({ name: 'Café', unit: 'un' }, tx)).product
      const arroz = (await g.createProduct({ name: 'Arroz', unit: 'un' }, tx)).product
      await doneTrip(tx, '2026-01-10', [
        { productId: cafe.id, qty: 2, price: 1000 },
        { productId: arroz.id, qty: 1, price: 500 },
      ])
      await doneTrip(tx, '2026-06-10', [
        { productId: cafe.id, qty: 5, price: 1240 },
        { productId: arroz.id, qty: 1, price: 480 },
      ])
      const a = await g.analytics('2026', tx)
      assert.deepEqual(
        a.series.map((p) => p.index),
        [100, 118.4], // (2×1240 + 480) / (2×1000 + 500) = 2960 / 2500
      )
      assert.equal(a.kpis.basketSinceStart?.index, 118.4)
      assert.equal(a.kpis.tripsCount, 2)
      assert.equal(a.kpis.avgTicketCents, Math.round((2500 + 6680) / 2))
      // previsto da 2ª compra: 5×1000 + 1×500 = 5500; real 6680
      assert.equal(a.kpis.plannedVsRealCents, 1180)
      assert.deepEqual(
        a.products.map((p) => [p.name, p.change]),
        [
          ['Café', 0.24],
          ['Arroz', -0.04],
        ],
      )
      assert.equal(a.unlinkedTrips, 2)
    })
  })
})
