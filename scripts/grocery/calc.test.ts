import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  basketIndex,
  basketSeries,
  budgetBalance,
  lastPrices,
  linkWindow,
  normalizeName,
  priceChange,
  rankLinkCandidates,
  subtotalCents,
  tripTotals,
  type CalcItem,
} from '../../shared/grocery'

/** Lista de compras (docs/specs/lista-de-compras): só a conta pura, sem banco. */

const item = (patch: Partial<CalcItem>): CalcItem => ({
  productId: 1,
  plannedQty: 1,
  qty: null,
  unitPriceCents: null,
  checked: false,
  lastUnitPriceCents: null,
  ...patch,
})

describe('normalizeName', () => {
  test('minúsculas, sem acento, espaços colapsados', () => {
    assert.equal(normalizeName('  Feijão   Carioca 1KG '), 'feijao carioca 1kg')
    assert.equal(normalizeName('AÇÚCAR'), normalizeName('acucar'))
  })
})

describe('subtotalCents', () => {
  test('quantidade com 3 casas, arredondado para o centavo mais próximo', () => {
    assert.equal(subtotalCents(1.25, 3990), 4988) // 4987,5 → 4988
    assert.equal(subtotalCents(1.08, 4290), 4633) // 4633,2
    assert.equal(subtotalCents(12, 529), 6348)
    assert.equal(subtotalCents(0.333, 100), 33)
  })
  test('sem erro de ponto flutuante', () => {
    assert.equal(subtotalCents(1.005, 1000), 1005)
    assert.equal(subtotalCents(0.1, 3), 0) // 0,3 centavo
    assert.equal(subtotalCents(0.5, 1), 1) // meio centavo arredonda para cima
  })
})

describe('tripTotals', () => {
  test('previsto usa o último preço e conta os itens sem preço à parte', () => {
    const t = tripTotals([
      item({ productId: 1, plannedQty: 2, lastUnitPriceCents: 500 }),
      item({ productId: 2, plannedQty: 1.5, lastUnitPriceCents: 649 }),
      item({ productId: 3, plannedQty: 1, lastUnitPriceCents: null }),
    ])
    assert.equal(t.plannedCents, 1000 + 974)
    assert.equal(t.missingPriceCount, 1)
    assert.equal(t.totalCount, 3)
  })
  test('real soma só os marcados com preço; marcado sem preço vale zero e é contado', () => {
    const t = tripTotals([
      item({ productId: 1, checked: true, qty: 2, unitPriceCents: 500 }),
      item({ productId: 2, checked: false, qty: 1, unitPriceCents: 999 }),
      item({ productId: 3, checked: true, qty: null, unitPriceCents: null }),
    ])
    assert.equal(t.realCents, 1000)
    assert.equal(t.checkedCount, 2)
    assert.equal(t.checkedWithoutPriceCount, 1)
  })
  test('marcado com preço e sem quantidade usa a quantidade planejada', () => {
    const t = tripTotals([item({ checked: true, plannedQty: 3, qty: null, unitPriceCents: 100 })])
    assert.equal(t.realCents, 300)
  })
})

describe('budgetBalance', () => {
  test('sem teto não há saldo', () => {
    assert.equal(budgetBalance({ capCents: null, spentCents: 100, tripCents: 50, tripLinked: false }), null)
  })
  test('compra sem vínculo soma ao gasto; vinculada já está no gasto', () => {
    assert.equal(budgetBalance({ capCents: 120000, spentCents: 45000, tripCents: 38000, tripLinked: false }), 37000)
    assert.equal(budgetBalance({ capCents: 120000, spentCents: 83000, tripCents: 38000, tripLinked: true }), 37000)
  })
  test('pode ficar negativo', () => {
    assert.equal(budgetBalance({ capCents: 1000, spentCents: 900, tripCents: 500, tripLinked: false }), -400)
  })
})

describe('lastPrices', () => {
  test('pega a compra mais recente com preço; empate na data, a de id maior', () => {
    const m = lastPrices([
      { productId: 1, tripId: 1, purchasedOn: '2026-01-10', unitPriceCents: 500 },
      { productId: 1, tripId: 3, purchasedOn: '2026-02-10', unitPriceCents: 550 },
      { productId: 1, tripId: 2, purchasedOn: '2026-02-10', unitPriceCents: 540 },
      { productId: 1, tripId: 4, purchasedOn: '2026-03-10', unitPriceCents: null },
      { productId: 2, tripId: 1, purchasedOn: '2026-01-10', unitPriceCents: 100 },
    ])
    assert.deepEqual(m.get(1), { unitPriceCents: 550, purchasedOn: '2026-02-10' })
    assert.deepEqual(m.get(2), { unitPriceCents: 100, purchasedOn: '2026-01-10' })
    assert.equal(m.get(3), undefined)
  })
})

describe('basketIndex', () => {
  const base = [
    { productId: 1, qty: 2, unitPriceCents: 1000 },
    { productId: 2, qty: 1, unitPriceCents: 500 },
  ]
  test('cesta fixa: pesos são as quantidades da compra-base', () => {
    const r = basketIndex(base, [
      { productId: 1, qty: 10, unitPriceCents: 1100 },
      { productId: 2, qty: 1, unitPriceCents: 500 },
    ])
    // (2×1100 + 1×500) / (2×1000 + 1×500) = 2700 / 2500
    assert.equal(r.index, 108)
    assert.equal(r.matched, 2)
    assert.equal(r.total, 2)
  })
  test('mudar só a quantidade comprada não muda o índice', () => {
    const r = basketIndex(base, [
      { productId: 1, qty: 1, unitPriceCents: 1000 },
      { productId: 2, qty: 7, unitPriceCents: 500 },
    ])
    assert.equal(r.index, 100)
  })
  test('produto ausente numa ponta fica fora e é informado', () => {
    const r = basketIndex(base, [{ productId: 1, qty: 2, unitPriceCents: 1200 }])
    assert.equal(r.index, 120)
    assert.equal(r.matched, 1)
    assert.equal(r.total, 2)
  })
  test('sem preço não entra; sem produto em comum o índice é null', () => {
    assert.equal(basketIndex(base, [{ productId: 9, qty: 1, unitPriceCents: 100 }]).index, null)
    assert.equal(basketIndex(base, [{ productId: 1, qty: 1, unitPriceCents: null }]).index, null)
  })
})

describe('basketSeries', () => {
  test('primeira compra é a base 100; as seguintes comparam com ela', () => {
    const s = basketSeries([
      { tripId: 2, purchasedOn: '2026-02-01', items: [{ productId: 1, qty: 1, unitPriceCents: 1100 }] },
      { tripId: 1, purchasedOn: '2026-01-01', items: [{ productId: 1, qty: 1, unitPriceCents: 1000 }] },
    ])
    assert.deepEqual(
      s.map((p) => [p.tripId, p.index]),
      [
        [1, 100],
        [2, 110],
      ],
    )
  })
  test('sem compras, série vazia', () => {
    assert.deepEqual(basketSeries([]), [])
  })
})

describe('priceChange', () => {
  test('variação relativa; sem base, null', () => {
    assert.equal(priceChange(1000, 1240), 0.24)
    assert.equal(priceChange(0, 100), null)
    assert.equal(priceChange(null, 100), null)
  })
})

describe('vínculo com o lançamento', () => {
  test('janela de −1 a +5 dias da data da compra', () => {
    assert.deepEqual(linkWindow('2026-03-01'), { from: '2026-02-28', to: '2026-03-06' })
    assert.deepEqual(linkWindow('2026-12-29'), { from: '2026-12-28', to: '2027-01-03' })
  })
  test('ordena pela proximidade do valor e depois da data', () => {
    const ranked = rankLinkCandidates(
      [
        { id: 1, postedOn: '2026-03-04', amountCents: -40000 },
        { id: 2, postedOn: '2026-03-01', amountCents: -38500 },
        { id: 3, postedOn: '2026-03-03', amountCents: -38500 },
        { id: 4, postedOn: '2026-03-02', amountCents: -12000 },
      ],
      { realCents: 38000, purchasedOn: '2026-03-01' },
    )
    assert.deepEqual(
      ranked.map((c) => [c.id, c.differenceCents]),
      [
        [2, 500],
        [3, 500],
        [1, 2000],
        [4, -26000],
      ],
    )
  })
})
