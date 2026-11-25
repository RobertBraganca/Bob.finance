import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { subtotalCents } from '@shared/grocery'
import { api, ApiError } from '../../lib/api'
import { money } from '../../lib/format'
import { todayIso } from '../../lib/period'
import { Button, Card, EmptyState, Field, Icon, Modal, TextInput, useToast } from '../../components/ui'
import { AddProduct } from './AddProduct'
import { ItemModal } from './ItemModal'
import { BudgetFooter, PriceChange, SyncIndicator } from './parts'
import { groceryKeys, type useTripItems } from './useGrocery'
import { fmtQty, type GroceryBudget, type GroceryItem, type GroceryProduct, type GroceryTrip } from './types'

type TripItems = ReturnType<typeof useTripItems>

/**
 * No mercado: toque no item para digitar quantidade e preço, e o total do
 * carrinho sobe na hora. Pendentes no topo; o que já está no carrinho desce.
 */
export function ShoppingTab({
  trip,
  tripItems,
  products,
  budget,
  onGoToList,
  onFinished,
}: {
  trip: GroceryTrip | null
  tripItems: TripItems
  products: GroceryProduct[]
  budget: GroceryBudget | undefined
  onGoToList: () => void
  /** compra concluída: a página pergunta o vínculo (esta aba sai da tela quando não há compra ativa) */
  onFinished: (tripId: number) => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<GroceryItem | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [purchasedOn, setPurchasedOn] = useState(todayIso())

  const start = useMutation({
    mutationFn: () => api.post<GroceryTrip>(`/grocery/trips/${trip!.id}/status`, { status: 'shopping' }),
    onSuccess: (updated) => queryClient.setQueryData(groceryKeys.active, updated),
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Não foi possível começar a compra.', 'error'),
  })
  const finish = useMutation({
    mutationFn: async () => {
      if (!(await tripItems.drain())) throw new Error('Ainda há itens sem salvar. Quando a conexão voltar, conclua de novo.')
      return api.post<GroceryTrip>(`/grocery/trips/${trip!.id}/status`, { status: 'done', purchasedOn })
    },
    onSuccess: (done) => {
      setFinishing(false)
      queryClient.setQueryData(groceryKeys.active, null)
      void queryClient.invalidateQueries({ queryKey: ['grocery'] })
      void queryClient.invalidateQueries({ queryKey: ['grocery-analytics'] })
      void queryClient.invalidateQueries({ queryKey: ['grocery-budget'] })
      toast(`Compra concluída: ${money(done.totals.realCents)}`)
      onFinished(done.id)
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Não foi possível concluir a compra.', 'error'),
  })

  if (!trip) {
    return (
      <Card>
        <EmptyState
          icon="cart"
          title="Nenhuma compra em andamento"
          body="Monte a lista na aba Lista e toque em Começar compra quando chegar ao mercado."
          action={
            <Button variant="primary" onClick={onGoToList}>
              Ir para a lista
            </Button>
          }
        />
      </Card>
    )
  }

  const { items, totals, setItem } = tripItems
  const pending = items.filter((i) => !i.checked).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  const done = items.filter((i) => i.checked).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  const inList = new Set(items.map((i) => i.productId))

  const toggle = (item: GroceryItem) => {
    if (item.checked) setItem(item, { checked: false })
    else if (item.unitPriceCents === null && item.lastUnitPriceCents === null) setEditing(item)
    else setItem(item, { checked: true, qty: item.qty ?? item.plannedQty, unitPriceCents: item.unitPriceCents ?? item.lastUnitPriceCents })
  }

  const row = (item: GroceryItem) => {
    const price = item.unitPriceCents
    const qty = item.qty ?? item.plannedQty
    return (
      <li key={item.productId} className={`grocery-row${item.checked ? ' grocery-row--done' : ''}`}>
        <button
          type="button"
          className="grocery-check"
          role="checkbox"
          aria-checked={item.checked}
          aria-label={item.checked ? `Tirar ${item.name} do carrinho` : `Pôr ${item.name} no carrinho`}
          onClick={() => toggle(item)}
        >
          <span className="grocery-check__box">{item.checked && <Icon name="check" size={14} strokeWidth={2.6} />}</span>
        </button>
        <button type="button" className="grocery-row__main" onClick={() => setEditing(item)} aria-label={`Preço e quantidade de ${item.name}`}>
          <span className="grocery-row__name">{item.name}</span>
          <span className="grocery-row__sub">
            {item.checked && price !== null
              ? `${fmtQty(qty)} ${item.unit} × ${money(price)}`
              : item.lastUnitPriceCents !== null
                ? `${fmtQty(qty)} ${item.unit} · últ. ${money(item.lastUnitPriceCents)}/${item.unit}`
                : `${fmtQty(qty)} ${item.unit} · sem preço ainda`}
          </span>
        </button>
        <span className="grocery-row__end">
          {item.checked && price !== null && <strong className="numeral">{money(subtotalCents(qty, price))}</strong>}
          {item.checked && <PriceChange price={price} last={item.lastUnitPriceCents} />}
        </span>
      </li>
    )
  }

  return (
    <div className="stack">
      {trip.status === 'planning' && (
        <Card muted>
          <div className="row row--between row--wrap">
            <span>A lista ainda está em montagem.</span>
            <Button variant="primary" icon="cart" loading={start.isPending} onClick={() => start.mutate()}>
              Começar compra
            </Button>
          </div>
        </Card>
      )}
      <Card
        title={pending.length ? `Faltam ${pending.length}` : 'Tudo no carrinho'}
        actions={<SyncIndicator status={tripItems.status} pending={tripItems.pending} />}
      >
        {pending.length > 0 && <ul className="grocery-list">{pending.map(row)}</ul>}
        <AddProduct
          label="Item fora da lista"
          products={products}
          excludeIds={inList}
          onAdd={(p) => {
            const item: GroceryItem = {
              productId: p.id,
              name: p.name,
              unit: p.unit,
              plannedQty: p.defaultQty,
              qty: null,
              unitPriceCents: null,
              checked: false,
              clientRev: 0,
              lastUnitPriceCents: p.lastUnitPriceCents,
            }
            setItem(item, { plannedQty: p.defaultQty })
            setEditing(item)
          }}
        />
      </Card>
      {done.length > 0 && (
        <Card title={`No carrinho (${done.length})`}>
          <ul className="grocery-list">{done.map(row)}</ul>
        </Card>
      )}

      <BudgetFooter mode="store" totals={totals} budget={budget}>
        <div className="row row--between row--wrap">
          <Button variant="quiet" icon="list" onClick={onGoToList}>
            Editar lista
          </Button>
          <Button variant="primary" icon="check" disabled={totals.checkedCount === 0} onClick={() => setFinishing(true)}>
            Concluir compra
          </Button>
        </div>
      </BudgetFooter>

      {editing && (
        <ItemModal
          item={(() => {
            // Item recém-adicionado só existe na fila, sem o último preço: usa o do catálogo.
            const found = items.find((i) => i.productId === editing.productId)
            return found ? { ...found, lastUnitPriceCents: found.lastUnitPriceCents ?? editing.lastUnitPriceCents } : editing
          })()}
          onClose={() => setEditing(null)}
          onUncheck={() => {
            setItem(editing, { checked: false })
            setEditing(null)
          }}
          onSave={({ qty, unitPriceCents }) => {
            setItem(editing, { qty, unitPriceCents, checked: true })
            setEditing(null)
          }}
        />
      )}

      {finishing && (
        <Modal
          title="Concluir compra"
          onClose={() => setFinishing(false)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setFinishing(false)}>
                Voltar
              </Button>
              <Button variant="primary" icon="check" loading={finish.isPending} onClick={() => finish.mutate()}>
                Concluir compra
              </Button>
            </>
          }
        >
          <div className="stack">
            <p>
              {totals.checkedCount} {totals.checkedCount === 1 ? 'item' : 'itens'} no carrinho, total {money(totals.realCents)}.
              {pending.length > 0 && ` ${pending.length} ${pending.length === 1 ? 'item ficou' : 'itens ficaram'} fora e não entram no histórico de preços.`}
            </p>
            {totals.checkedWithoutPriceCount > 0 && (
              <p className="muted">
                {totals.checkedWithoutPriceCount} {totals.checkedWithoutPriceCount === 1 ? 'item marcado está' : 'itens marcados estão'} sem preço e contam R$ 0,00.
              </p>
            )}
            {tripItems.pending > 0 && (
              <p className="muted">
                {tripItems.pending} {tripItems.pending === 1 ? 'edição ainda não foi salva' : 'edições ainda não foram salvas'}. A compra é concluída depois que tudo for enviado.
              </p>
            )}
            <Field label="Data da compra">{(id) => <TextInput id={id} type="date" value={purchasedOn} onChange={setPurchasedOn} max={todayIso()} />}</Field>
          </div>
        </Modal>
      )}
    </div>
  )
}
