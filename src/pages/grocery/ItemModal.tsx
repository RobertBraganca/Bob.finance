import { useState } from 'react'
import { subtotalCents } from '@shared/grocery'
import { centsToInput, money, parseMoneyInput } from '../../lib/format'
import { Button, Field, Modal, TextInput } from '../../components/ui'
import { PriceChange, parseQty, qtyToInput } from './parts'
import type { GroceryItem } from './types'

/**
 * Preço e quantidade de um item, no corredor. O preço vem preenchido com o
 * último pago; o subtotal é calculado enquanto digita. "Pôr no carrinho" grava
 * e marca o item.
 */
export function ItemModal({
  item,
  onSave,
  onUncheck,
  onClose,
}: {
  item: GroceryItem
  onSave: (values: { qty: number; unitPriceCents: number }) => void
  onUncheck: () => void
  onClose: () => void
}) {
  const [qty, setQty] = useState(qtyToInput(item.qty ?? item.plannedQty))
  const [price, setPrice] = useState(centsToInput(item.unitPriceCents ?? item.lastUnitPriceCents))
  const [error, setError] = useState<string | null>(null)
  const parsedQty = parseQty(qty)
  const parsedPrice = parseMoneyInput(price)
  const subtotal = parsedQty !== null && parsedPrice !== null && parsedPrice >= 0 ? subtotalCents(parsedQty, parsedPrice) : null

  const save = () => {
    if (parsedQty === null) return setError('Digite a quantidade, por exemplo 1 ou 1,250.')
    if (parsedPrice === null || parsedPrice < 0) return setError(`Digite o preço por ${item.unit}, por exemplo 6,49.`)
    onSave({ qty: parsedQty, unitPriceCents: parsedPrice })
  }

  return (
    <Modal
      title={item.name}
      onClose={onClose}
      footer={
        <>
          {item.checked ? (
            <Button variant="quiet" onClick={onUncheck}>
              Tirar do carrinho
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" icon="check" onClick={save}>
            Pôr no carrinho
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        {/* Preço primeiro: é o que se digita no corredor, e o modal foca o primeiro campo. */}
        <div className="grid-2" style={{ gap: 'var(--sp-3)' }}>
          <Field label={`Preço por ${item.unit}`} hint={item.lastUnitPriceCents !== null ? `Último: ${money(item.lastUnitPriceCents)}` : 'Primeira compra deste produto'}>
            {(id) => <TextInput id={id} numeral value={price} onChange={setPrice} placeholder="0,00" />}
          </Field>
          <Field label={`Quantidade (${item.unit})`}>{(id) => <TextInput id={id} numeral value={qty} onChange={setQty} />}</Field>
        </div>
        <div className="row row--between" aria-live="polite">
          <span className="muted">Subtotal</span>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <PriceChange price={parsedPrice} last={item.lastUnitPriceCents} />
            <strong className="numeral">{subtotal === null ? '-' : money(subtotal)}</strong>
          </span>
        </div>
        {error && <span className="field__error">{error}</span>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
