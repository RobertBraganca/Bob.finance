/**
 * Contas da lista de compras (docs/specs/lista-de-compras). Puras: a tela usa
 * para o total em tempo real (sem esperar a rede) e o servidor para os KPIs,
 * com o mesmo resultado. Nada aqui consulta dado do app.
 *
 * Dinheiro em centavos inteiros; quantidade com até 3 casas (1,250 kg).
 * O preço é sempre por unidade do produto (R$/un, R$/kg, R$/L).
 */

export type GroceryUnit = 'un' | 'kg' | 'L'
export const GROCERY_UNITS: GroceryUnit[] = ['un', 'kg', 'L']

/** Nome para comparar produtos: minúsculas, sem acento, espaços colapsados. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * qty × preço unitário, TRUNCADO no centavo, como a balança e o cupom fiscal
 * (0,406 kg × R$ 39,80 = 16,1588 sai 16,15 no cupom): assim o total do
 * carrinho bate com o caixa. Conta em inteiros (milésimos de unidade) para
 * não herdar erro de ponto flutuante.
 */
export function subtotalCents(qty: number, unitPriceCents: number): number {
  const thousandths = Math.round(qty * 1000)
  return Math.floor((thousandths * unitPriceCents) / 1000)
}

export type CalcItem = {
  productId: number
  plannedQty: number
  /** quantidade real; vazia até preencher no mercado (usa a planejada) */
  qty: number | null
  unitPriceCents: number | null
  checked: boolean
  /** último preço pago em compra concluída (null: produto sem histórico) */
  lastUnitPriceCents: number | null
}

export type TripTotals = {
  /** Σ quantidade planejada × último preço, sem os itens sem histórico */
  plannedCents: number
  missingPriceCount: number
  /** Σ subtotal dos itens marcados com preço */
  realCents: number
  checkedCount: number
  checkedWithoutPriceCount: number
  totalCount: number
}

export function tripTotals(items: CalcItem[]): TripTotals {
  const totals: TripTotals = {
    plannedCents: 0,
    missingPriceCount: 0,
    realCents: 0,
    checkedCount: 0,
    checkedWithoutPriceCount: 0,
    totalCount: items.length,
  }
  for (const it of items) {
    if (it.lastUnitPriceCents === null) totals.missingPriceCount++
    else totals.plannedCents += subtotalCents(it.plannedQty, it.lastUnitPriceCents)

    if (!it.checked) continue
    totals.checkedCount++
    if (it.unitPriceCents === null) totals.checkedWithoutPriceCount++
    else totals.realCents += subtotalCents(it.qty ?? it.plannedQty, it.unitPriceCents)
  }
  return totals
}

/**
 * Quanto sobra do teto de mercado do mês. `spentCents` vem do ledger; uma
 * compra já vinculada ao lançamento real já está nele e não soma de novo.
 * Sem teto, não há saldo (null).
 */
export function budgetBalance(input: {
  capCents: number | null
  spentCents: number
  tripCents: number
  tripLinked: boolean
}): number | null {
  if (input.capCents === null) return null
  return input.capCents - input.spentCents - (input.tripLinked ? 0 : input.tripCents)
}

export type PricePoint = { productId: number; tripId: number; purchasedOn: string; unitPriceCents: number | null }

/** Último preço de cada produto: compra mais recente com preço (empate: id maior). */
export function lastPrices(points: PricePoint[]): Map<number, { unitPriceCents: number; purchasedOn: string }> {
  const best = new Map<number, PricePoint>()
  for (const p of points) {
    if (p.unitPriceCents === null) continue
    const cur = best.get(p.productId)
    if (!cur || p.purchasedOn > cur.purchasedOn || (p.purchasedOn === cur.purchasedOn && p.tripId > cur.tripId)) {
      best.set(p.productId, p)
    }
  }
  const out = new Map<number, { unitPriceCents: number; purchasedOn: string }>()
  for (const [id, p] of best) out.set(id, { unitPriceCents: p.unitPriceCents as number, purchasedOn: p.purchasedOn })
  return out
}

export type BasketItem = { productId: number; qty: number; unitPriceCents: number | null }
export type BasketIndex = { index: number | null; matched: number; total: number }

/**
 * Índice de cesta fixa entre a compra-base e outra:
 * 100 × Σ(qty_base × preço_atual) / Σ(qty_base × preço_base), só com os
 * produtos que têm preço nas duas. Comprar mais ou menos não muda o índice;
 * só o preço muda. Uma casa decimal.
 */
export function basketIndex(base: BasketItem[], current: BasketItem[]): BasketIndex {
  const now = new Map<number, number>()
  for (const c of current) if (c.unitPriceCents !== null) now.set(c.productId, c.unitPriceCents)
  const priced = base.filter((b) => b.unitPriceCents !== null)
  let numerator = 0
  let denominator = 0
  let matched = 0
  for (const b of priced) {
    const price = now.get(b.productId)
    if (price === undefined) continue
    matched++
    numerator += subtotalCents(b.qty, price)
    denominator += subtotalCents(b.qty, b.unitPriceCents as number)
  }
  const index = matched > 0 && denominator > 0 ? Math.round((numerator * 1000) / denominator) / 10 : null
  return { index, matched, total: priced.length }
}

export type BasketTrip = { tripId: number; purchasedOn: string; items: BasketItem[] }
export type BasketPoint = BasketIndex & { tripId: number; purchasedOn: string }

/** Série do índice: a primeira compra (por data, depois id) é a base 100. */
export function basketSeries(trips: BasketTrip[]): BasketPoint[] {
  const sorted = [...trips].sort((a, b) => a.purchasedOn.localeCompare(b.purchasedOn) || a.tripId - b.tripId)
  const base = sorted[0]
  if (!base) return []
  return sorted.map((t) => ({ tripId: t.tripId, purchasedOn: t.purchasedOn, ...basketIndex(base.items, t.items) }))
}

/** Variação relativa entre dois preços (0.24 = +24%); sem base, null. */
export function priceChange(firstCents: number | null, lastCents: number | null): number | null {
  if (firstCents === null || lastCents === null || firstCents <= 0) return null
  return Math.round(((lastCents - firstCents) / firstCents) * 10_000) / 10_000
}

function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Datas em que o lançamento real da compra pode cair: de −1 a +5 dias. */
export function linkWindow(purchasedOn: string): { from: string; to: string } {
  return { from: shiftIso(purchasedOn, -1), to: shiftIso(purchasedOn, 5) }
}

export type LinkCandidate = { id: number; postedOn: string; amountCents: number }

/**
 * Candidatos a lançamento real, do mais provável ao menos: valor mais perto do
 * real da compra, depois data mais perto. `differenceCents` = cobrado − lista
 * (positivo: o caixa cobrou mais do que a lista somou).
 */
export function rankLinkCandidates<T extends LinkCandidate>(
  candidates: T[],
  trip: { realCents: number; purchasedOn: string },
): Array<T & { differenceCents: number }> {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000
  const target = day(trip.purchasedOn)
  return candidates
    .map((c) => ({ ...c, differenceCents: Math.abs(c.amountCents) - trip.realCents }))
    .sort(
      (a, b) =>
        Math.abs(a.differenceCents) - Math.abs(b.differenceCents) ||
        Math.abs(day(a.postedOn) - target) - Math.abs(day(b.postedOn) - target) ||
        a.id - b.id,
    )
}
