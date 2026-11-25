/**
 * Fila offline da lista de compras (docs/specs/lista-de-compras, "Fila offline").
 *
 * No mercado o sinal cai. Toda edição de item vira o ESTADO COMPLETO do item
 * numa fila guardada no aparelho, chaveada por `tripId:productId`: editar o
 * mesmo item três vezes sem rede envia só o último estado. O servidor ignora
 * escrita com `clientRev` menor ou igual ao gravado, então reenviar nunca
 * desfaz uma edição mais nova. A parte de cima deste arquivo é pura (testada
 * em scripts/grocery/queue.test.ts); só `loadQueue`/`saveQueue` tocam o aparelho.
 */

export type QueuedItemBody = {
  plannedQty: number
  qty: number | null
  unitPriceCents: number | null
  checked: boolean
  clientRev: number
}

export type QueueEntry = {
  key: string
  tripId: number
  productId: number
  /** `null`: tirar o item da lista */
  body: QueuedItemBody | null
  /** para mostrar o item adicionado offline antes de o servidor responder */
  name: string
  unit: 'un' | 'kg' | 'L'
  clientRev: number
}

export type QueueState = QueueEntry[]

export const queueKey = (tripId: number, productId: number) => `${tripId}:${productId}`

/** Revisão crescente por item: o relógio, mas nunca menor ou igual à anterior. */
export function nextRev(previous: number, now = Date.now()): number {
  return Math.max(now, previous + 1)
}

/** Põe na fila; uma entrada do mesmo item é substituída (fica a mais nova, no mesmo lugar). */
export function enqueue(state: QueueState, entry: QueueEntry): QueueState {
  const at = state.findIndex((e) => e.key === entry.key)
  if (at === -1) return [...state, entry]
  const next = state.slice()
  next[at] = entry
  return next
}

/**
 * Tira a entrada depois do envio, só se ela ainda é a que foi enviada: se o
 * item foi editado de novo enquanto a requisição viajava, a edição nova fica.
 */
export function settle(state: QueueState, key: string, sentRev: number): QueueState {
  return state.filter((e) => !(e.key === key && e.clientRev === sentRev))
}

/** Espera antes da próxima tentativa: 1s, 2s, 4s… até 30s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt))
}

export type OverlayItem = {
  productId: number
  name: string
  unit: 'un' | 'kg' | 'L'
  plannedQty: number
  qty: number | null
  unitPriceCents: number | null
  checked: boolean
  clientRev: number
  lastUnitPriceCents: number | null
}

/**
 * O que a tela mostra: os itens do servidor com as pendências da fila por
 * cima. Uma pendência com revisão menor ou igual à do servidor já chegou e é
 * ignorada; item só na fila (adicionado offline) entra no fim; remoção
 * pendente some com o item.
 */
export function applyPending<T extends OverlayItem>(serverItems: T[], state: QueueState, tripId: number): Array<T | OverlayItem> {
  const pending = new Map(state.filter((e) => e.tripId === tripId).map((e) => [e.productId, e]))
  const out: Array<T | OverlayItem> = []
  for (const item of serverItems) {
    const p = pending.get(item.productId)
    pending.delete(item.productId)
    if (!p || p.clientRev <= item.clientRev) {
      out.push(item)
      continue
    }
    if (p.body === null) continue
    out.push({ ...item, ...p.body })
  }
  for (const p of pending.values()) {
    if (p.body === null) continue
    out.push({ productId: p.productId, name: p.name, unit: p.unit, lastUnitPriceCents: null, ...p.body })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Aparelho
 * ------------------------------------------------------------------ */
const STORAGE_KEY = 'bob-finance:grocery-queue'

export function loadQueue(): QueueState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as QueueState) : []
  } catch {
    return []
  }
}

export function saveQueue(state: QueueState): void {
  try {
    if (state.length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // sem armazenamento: a fila vive só na memória desta aba
  }
}
