import type { BasketIndex, BasketPoint, GroceryUnit, TripTotals } from '@shared/grocery'

/** Formas das respostas de /grocery e /grocery-insights (server/src/services/grocery.ts). */

export type GroceryProduct = {
  id: number
  name: string
  unit: GroceryUnit
  defaultQty: number
  archived: boolean
  lastUnitPriceCents: number | null
  lastPurchasedOn: string | null
}

export type GroceryItem = {
  id?: number
  productId: number
  name: string
  unit: GroceryUnit
  plannedQty: number
  qty: number | null
  unitPriceCents: number | null
  checked: boolean
  clientRev: number
  lastUnitPriceCents: number | null
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

export type GroceryBudget = {
  period: string
  categoryId: number | null
  categoryName: string | null
  capCents: number | null
  spentCents: number
  activeTripLinked: boolean
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

export type LinkCandidate = { id: number; postedOn: string; description: string; amountCents: number; differenceCents: number }

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
    spentYearCents: number | null
    tripsCount: number
    avgTicketCents: number | null
    basketSinceStart: BasketIndex | null
    basket12m: BasketIndex | null
    plannedVsRealCents: number
  }
  unlinkedTrips: number
  monthly: Array<{ month: string; currentCents: number; previousCents: number }>
  series: BasketPoint[]
  products: ProductTrend[]
}

export const UNIT_LABEL: Record<GroceryUnit, string> = { un: 'un', kg: 'kg', L: 'L' }

/** Quantidade em pt-BR: até 3 casas, sem zeros sobrando (1,25 kg; 12 un). */
export const fmtQty = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 3 })

/** Variação relativa (0.24) em texto com sinal: +24%, −4%. */
export const fmtChange = (value: number | null) =>
  value === null ? '-' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`

/** Índice de cesta (118,4) como variação: +18,4%. */
export const fmtIndex = (index: number | null) => (index === null ? '-' : fmtChange(Math.round((index - 100) * 10) / 1000))
