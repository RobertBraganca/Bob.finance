import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { tripTotals } from '@shared/grocery'
import { api, ApiError } from '../../lib/api'
import { todayIso } from '../../lib/period'
import { useToast } from '../../components/ui'
import {
  applyPending,
  backoffMs,
  enqueue,
  loadQueue,
  nextRev,
  queueKey,
  saveQueue,
  settle,
  type QueueEntry,
  type QueueState,
  type QueuedItemBody,
} from '../../lib/groceryQueue'
import type { GroceryBudget, GroceryItem, GroceryProduct, GroceryTrip } from './types'

export const groceryKeys = {
  active: ['grocery', 'active'] as const,
  products: ['grocery', 'products'] as const,
  trips: (year: string) => ['grocery', 'trips', year] as const,
  budget: (period: string) => ['grocery-budget', period] as const,
  analytics: (year: string) => ['grocery-analytics', year] as const,
}

export function useActiveTrip() {
  return useQuery({
    queryKey: groceryKeys.active,
    queryFn: () => api.get<{ trip: GroceryTrip | null }>('/grocery/trips/active').then((r) => r.trip),
  })
}

export function useProducts() {
  return useQuery({
    queryKey: groceryKeys.products,
    queryFn: () => api.get<{ products: GroceryProduct[] }>('/grocery/products', { archived: 'false' }).then((r) => r.products),
  })
}

export function useBudget() {
  const period = todayIso().slice(0, 7)
  return useQuery({
    queryKey: groceryKeys.budget(period),
    queryFn: () => api.get<GroceryBudget>('/grocery-insights/budget', { period }),
  })
}

export type SyncStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'retrying'

/**
 * Itens da compra ativa com a fila offline por cima (src/lib/groceryQueue.ts).
 * Toda edição aparece na hora (o total é recalculado aqui, sem esperar a rede)
 * e vai para a fila; a fila envia em ordem e tenta de novo quando a conexão
 * volta, ao voltar o foco para a aba e com espera crescente.
 */
export function useTripItems(trip: GroceryTrip | null | undefined) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [queue, setQueue] = useState<QueueState>(loadQueue)
  const queueRef = useRef(queue)
  const flushing = useRef(false)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [status, setStatus] = useState<SyncStatus>(() => (loadQueue().length ? 'retrying' : 'idle'))

  const update = useCallback((fn: (q: QueueState) => QueueState) => {
    const next = fn(queueRef.current)
    queueRef.current = next
    saveQueue(next)
    setQueue(next)
  }, [])

  const flush = useCallback(async () => {
    if (flushing.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    flushing.current = true
    let sent = false
    try {
      while (queueRef.current.length > 0) {
        const entry = queueRef.current[0]!
        setStatus('saving')
        try {
          const path = `/grocery/trips/${entry.tripId}/items/${entry.productId}`
          // A resposta entra no cache ANTES de a pendência sair da fila: sem isso
          // a tela voltava por um instante ao estado antigo até a releitura chegar.
          if (entry.body) {
            const saved = await api.put<GroceryItem>(path, entry.body)
            queryClient.setQueryData<GroceryTrip | null>(groceryKeys.active, (t) =>
              t && t.id === entry.tripId
                ? {
                    ...t,
                    items: t.items.some((i) => i.productId === saved.productId)
                      ? t.items.map((i) => (i.productId === saved.productId ? saved : i))
                      : [...t.items, saved],
                  }
                : t,
            )
          } else {
            await api.del(path)
            queryClient.setQueryData<GroceryTrip | null>(groceryKeys.active, (t) =>
              t && t.id === entry.tripId ? { ...t, items: t.items.filter((i) => i.productId !== entry.productId) } : t,
            )
          }
          update((q) => settle(q, entry.key, entry.clientRev))
          attempt.current = 0
          sent = true
        } catch (error) {
          // Regra recusou (compra já concluída, produto apagado): tentar de novo não muda nada.
          const refused = error instanceof ApiError && error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status)
          if (refused) {
            update((q) => settle(q, entry.key, entry.clientRev))
            toast(`${entry.name}: ${(error as ApiError).message}`, 'error')
            continue
          }
          setStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'retrying')
          timer.current = setTimeout(() => void flush(), backoffMs(attempt.current++))
          return
        }
      }
      setStatus(sent ? 'saved' : 'idle')
      if (sent) {
        void queryClient.invalidateQueries({ queryKey: groceryKeys.active })
      }
    } finally {
      flushing.current = false
    }
  }, [queryClient, toast, update])

  useEffect(() => {
    if (queueRef.current.length > 0) void flush()
    const retry = () => {
      attempt.current = 0
      if (queueRef.current.length > 0) void flush()
    }
    const offline = () => queueRef.current.length > 0 && setStatus('offline')
    const visible = () => document.visibilityState === 'visible' && retry()
    window.addEventListener('online', retry)
    window.addEventListener('offline', offline)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('online', retry)
      window.removeEventListener('offline', offline)
      document.removeEventListener('visibilitychange', visible)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [flush])

  const items = useMemo<GroceryItem[]>(
    () => (trip ? (applyPending(trip.items, queue, trip.id) as GroceryItem[]) : []),
    [trip, queue],
  )
  const totals = useMemo(() => tripTotals(items), [items])

  /** Grava o estado novo de um item (mescla com o atual). */
  const setItem = useCallback(
    (product: { productId: number; name: string; unit: GroceryItem['unit'] }, patch: Partial<Omit<QueuedItemBody, 'clientRev'>>) => {
      if (!trip) return
      const current = items.find((i) => i.productId === product.productId)
      const key = queueKey(trip.id, product.productId)
      const queued = queueRef.current.find((e) => e.key === key)
      const clientRev = nextRev(Math.max(current?.clientRev ?? 0, queued?.clientRev ?? 0))
      const body: QueuedItemBody = {
        plannedQty: patch.plannedQty ?? current?.plannedQty ?? 1,
        qty: patch.qty !== undefined ? patch.qty : (current?.qty ?? null),
        unitPriceCents: patch.unitPriceCents !== undefined ? patch.unitPriceCents : (current?.unitPriceCents ?? null),
        checked: patch.checked ?? current?.checked ?? false,
        clientRev,
      }
      const entry: QueueEntry = { key, tripId: trip.id, productId: product.productId, name: product.name, unit: product.unit, clientRev, body }
      update((q) => enqueue(q, entry))
      void flush()
    },
    [trip, items, update, flush],
  )

  const removeItem = useCallback(
    (item: GroceryItem) => {
      if (!trip) return
      const key = queueKey(trip.id, item.productId)
      const clientRev = nextRev(item.clientRev)
      update((q) => enqueue(q, { key, tripId: trip.id, productId: item.productId, name: item.name, unit: item.unit, clientRev, body: null }))
      void flush()
    },
    [trip, update, flush],
  )

  /** Espera a fila esvaziar (usado antes de concluir a compra). */
  const drain = useCallback(async () => {
    await flush()
    return queueRef.current.length === 0
  }, [flush])

  const pending = trip ? queue.filter((e) => e.tripId === trip.id).length : 0
  return { items, totals, setItem, removeItem, drain, pending, status }
}
