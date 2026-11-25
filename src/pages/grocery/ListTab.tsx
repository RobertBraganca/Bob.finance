import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { subtotalCents } from '@shared/grocery'
import { api, ApiError } from '../../lib/api'
import { money } from '../../lib/format'
import { Button, Card, ConfirmDeleteModal, EmptyState, useToast } from '../../components/ui'
import { AddProduct } from './AddProduct'
import { BudgetFooter, SyncIndicator, qtyStep } from './parts'
import { groceryKeys, type useTripItems } from './useGrocery'
import { fmtQty, type GroceryBudget, type GroceryProduct, type GroceryTrip } from './types'

type TripItems = ReturnType<typeof useTripItems>

/**
 * Montar a lista em casa: produtos e quantidades, com o previsto calculado
 * pelos últimos preços pagos e o quanto sobra do teto do mês.
 */
export function ListTab({
  trip,
  tripItems,
  products,
  budget,
  onStarted,
}: {
  trip: GroceryTrip | null
  tripItems: TripItems
  products: GroceryProduct[]
  budget: GroceryBudget | undefined
  onStarted: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [discarding, setDiscarding] = useState(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: groceryKeys.active })
  const fail = (fallback: string) => (e: unknown) => toast(e instanceof ApiError ? e.message : fallback, 'error')

  const create = useMutation({
    mutationFn: (from: 'empty' | 'last') => api.post<GroceryTrip>('/grocery/trips', { from }),
    onSuccess: (created) => queryClient.setQueryData(groceryKeys.active, created),
    onError: fail('Não foi possível criar a lista. Confira a conexão e tente de novo.'),
  })
  const start = useMutation({
    mutationFn: async () => {
      if (!(await tripItems.drain())) throw new Error('fila')
      return api.post<GroceryTrip>(`/grocery/trips/${trip!.id}/status`, { status: 'shopping' })
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(groceryKeys.active, updated)
      onStarted()
    },
    onError: fail('Ainda há itens sem salvar. Quando a conexão voltar, tente de novo.'),
  })
  const discard = useMutation({
    mutationFn: () => api.del(`/grocery/trips/${trip!.id}`),
    onSuccess: () => {
      setDiscarding(false)
      void refresh()
    },
    onError: fail('Não foi possível descartar a lista.'),
  })

  if (!trip) {
    return (
      <Card>
        <EmptyState
          icon="cart"
          title="Monte a próxima compra"
          body="Escolha os produtos e as quantidades em casa. O previsto usa o último preço que você pagou em cada um."
          action={
            <div className="row row--wrap" style={{ justifyContent: 'center' }}>
              <Button variant="primary" icon="plus" loading={create.isPending && create.variables === 'empty'} onClick={() => create.mutate('empty')}>
                Nova lista
              </Button>
              <Button icon="refresh" loading={create.isPending && create.variables === 'last'} onClick={() => create.mutate('last')}>
                Repetir última compra
              </Button>
            </div>
          }
        />
      </Card>
    )
  }

  const { items, totals, setItem, removeItem } = tripItems
  const inList = new Set(items.map((i) => i.productId))
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))

  return (
    <div className="stack">
      <Card
        title="Lista"
        subtitle={trip.status === 'shopping' ? 'Compra em andamento: o que mudar aqui aparece na aba No mercado.' : `${items.length} ${items.length === 1 ? 'produto' : 'produtos'}`}
        actions={<SyncIndicator status={tripItems.status} pending={tripItems.pending} />}
      >
        <AddProduct
          products={products}
          excludeIds={inList}
          onAdd={(p) => setItem({ productId: p.id, name: p.name, unit: p.unit }, { plannedQty: p.defaultQty })}
        />
        {sorted.length === 0 ? (
          <p className="muted">Nenhum produto ainda. Comece digitando acima.</p>
        ) : (
          <ul className="grocery-list">
            {sorted.map((item) => {
              const step = qtyStep(item.unit)
              return (
                <li key={item.productId} className="grocery-row">
                  <div className="grocery-row__main" style={{ cursor: 'default' }}>
                    <span className="grocery-row__name">{item.name}</span>
                    <span className="grocery-row__sub" style={item.lastUnitPriceCents === null ? { color: 'var(--status-warning)' } : undefined}>
                      {item.lastUnitPriceCents === null
                        ? 'sem preço ainda'
                        : `últ. ${money(item.lastUnitPriceCents)}/${item.unit} · ${money(subtotalCents(item.plannedQty, item.lastUnitPriceCents))}`}
                    </span>
                  </div>
                  <div className="grocery-stepper">
                    <Button
                      size="sm"
                      variant="quiet"
                      icon={item.plannedQty - step <= 0 ? 'trash' : 'minus'}
                      title={item.plannedQty - step <= 0 ? `Tirar ${item.name} da lista` : `Menos ${item.name}`}
                      onClick={() =>
                        item.plannedQty - step <= 0
                          ? removeItem(item)
                          : setItem(item, { plannedQty: Math.round((item.plannedQty - step) * 1000) / 1000 })
                      }
                    />
                    <span className="grocery-stepper__value">
                      {fmtQty(item.plannedQty)} {item.unit}
                    </span>
                    <Button
                      size="sm"
                      variant="quiet"
                      icon="plus"
                      title={`Mais ${item.name}`}
                      onClick={() => setItem(item, { plannedQty: Math.round((item.plannedQty + step) * 1000) / 1000 })}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <BudgetFooter mode="home" totals={totals} budget={budget}>
        <div className="row row--between row--wrap">
          {trip.status === 'planning' ? (
            <Button variant="quiet" icon="trash" onClick={() => setDiscarding(true)}>
              Descartar lista
            </Button>
          ) : (
            <span />
          )}
          {trip.status === 'planning' ? (
            <Button variant="primary" icon="cart" loading={start.isPending} onClick={() => start.mutate()} disabled={items.length === 0}>
              Começar compra
            </Button>
          ) : (
            <Button variant="primary" icon="cart" onClick={onStarted}>
              Ir para o mercado
            </Button>
          )}
        </div>
      </BudgetFooter>

      {discarding && (
        <ConfirmDeleteModal
          title="Descartar esta lista?"
          body={`Isto apaga a lista com ${items.length} ${items.length === 1 ? 'produto' : 'produtos'}. Os produtos continuam no catálogo e o histórico de preços não muda.`}
          confirmLabel="Descartar lista"
          pending={discard.isPending}
          onConfirm={() => discard.mutate()}
          onCancel={() => setDiscarding(false)}
        />
      )}
    </div>
  )
}
