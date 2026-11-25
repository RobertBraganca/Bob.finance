import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { applyPending, backoffMs, enqueue, nextRev, queueKey, settle, type QueueEntry } from '../../src/lib/groceryQueue'

/** Fila offline da lista de compras: só a parte pura, sem aparelho nem rede. */

const entry = (productId: number, rev: number, patch: Partial<QueueEntry['body'] & object> = {}, tripId = 1): QueueEntry => ({
  key: queueKey(tripId, productId),
  tripId,
  productId,
  name: `p${productId}`,
  unit: 'un',
  clientRev: rev,
  body: { plannedQty: 1, qty: 1, unitPriceCents: 100, checked: true, clientRev: rev, ...patch },
})

const serverItem = (productId: number, rev: number, price: number | null = null) => ({
  productId,
  name: `p${productId}`,
  unit: 'un' as const,
  plannedQty: 1,
  qty: null,
  unitPriceCents: price,
  checked: false,
  clientRev: rev,
  lastUnitPriceCents: 90,
  id: productId * 10,
})

describe('fila', () => {
  test('mesmo item colapsa: fica só o último estado, na mesma posição', () => {
    let q = enqueue([], entry(1, 1))
    q = enqueue(q, entry(2, 1))
    q = enqueue(q, entry(1, 2, { unitPriceCents: 150 }))
    assert.deepEqual(
      q.map((e) => [e.productId, e.clientRev, e.body?.unitPriceCents]),
      [
        [1, 2, 150],
        [2, 1, 100],
      ],
    )
  })

  test('envio confirmado tira a entrada; edição feita durante o envio fica', () => {
    const q = enqueue(enqueue([], entry(1, 5)), entry(2, 1))
    assert.deepEqual(settle(q, queueKey(1, 1), 5).map((e) => e.productId), [2])
    const edited = enqueue(q, entry(1, 6))
    assert.deepEqual(settle(edited, queueKey(1, 1), 5).map((e) => [e.productId, e.clientRev]), [
      [1, 6],
      [2, 1],
    ])
  })

  test('revisão sempre cresce, mesmo com o relógio parado ou atrasado', () => {
    assert.equal(nextRev(0, 1000), 1000)
    assert.equal(nextRev(1000, 1000), 1001)
    assert.equal(nextRev(5000, 1000), 5001)
  })

  test('espera dobra até 30s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})

describe('applyPending', () => {
  test('pendência mais nova vence a do servidor; a já entregue é ignorada', () => {
    const items = applyPending([serverItem(1, 3), serverItem(2, 9, 500)], [entry(1, 4, { unitPriceCents: 777 }), entry(2, 8)], 1)
    assert.deepEqual(
      items.map((i) => [i.productId, i.unitPriceCents, i.checked]),
      [
        [1, 777, true],
        [2, 500, false],
      ],
    )
  })

  test('item só na fila entra no fim; remoção pendente some com o item; outra compra não interfere', () => {
    const removal: QueueEntry = { ...entry(1, 4), body: null }
    const items = applyPending([serverItem(1, 3), serverItem(2, 1)], [removal, entry(3, 2), entry(4, 2, {}, 99)], 1)
    assert.deepEqual(
      items.map((i) => i.productId),
      [2, 3],
    )
    assert.equal(items[1]?.lastUnitPriceCents, null)
  })
})
