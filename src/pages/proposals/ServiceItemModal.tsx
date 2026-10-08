import { useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { centsToInput, money, parseMoneyInput } from '../../lib/format'
import { lineTotalCents } from '@shared/proposals'
import { Button, EmptyState, Modal, SkeletonLines, TextArea, TextInput } from '../../components/ui'
import { formatQuantity, type ProposalItem } from './types'

type Suggestion = { title: string; description: string | null; unitPriceCents: number }

/**
 * Janela de um serviço do orçamento: título (com sugestões dos serviços já
 * usados, que preenchem descrição e preço), descrição, preço e quantidade com
 * − e +. A quantidade aceita decimais (12,5 horas).
 */
export function ServiceItemModal({
  item,
  onSave,
  onDelete,
  onClose,
}: {
  item: ProposalItem | null
  onSave: (item: ProposalItem) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(item?.title ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [price, setPrice] = useState(item ? centsToInput(item.unitPriceCents) : '')
  const [quantity, setQuantity] = useState(item ? formatQuantity(item.quantity) : '1')
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const priceId = useId()
  const quantityId = useId()
  const listId = useId()

  const suggestions = useQuery({
    queryKey: ['proposals', 'item-suggestions'],
    queryFn: () => api.get<{ suggestions: Suggestion[] }>('/pricing/proposals/item-suggestions'),
    staleTime: 5 * 60_000,
  })

  const quantityValue = Number(quantity.replace(/\./g, '').replace(',', '.'))
  const priceCents = parseMoneyInput(price)
  const lineCents =
    priceCents !== null && Number.isFinite(quantityValue) && quantityValue > 0
      ? lineTotalCents({ unitPriceCents: Math.abs(priceCents), quantity: quantityValue })
      : null

  const byTitle = useMemo(() => {
    const map = new Map<string, Suggestion>()
    for (const s of suggestions.data?.suggestions ?? []) map.set(s.title.toLowerCase(), s)
    return map
  }, [suggestions.data])

  const changeTitle = (value: string) => {
    setTitle(value)
    // Escolheu uma sugestão (o texto bate com um serviço já usado) e ainda não
    // digitou preço nem descrição: preenche com os da última vez.
    const hit = byTitle.get(value.trim().toLowerCase())
    if (hit && !price) setPrice(centsToInput(hit.unitPriceCents))
    if (hit && !description && hit.description) setDescription(hit.description)
  }

  const step = (delta: number) => {
    const current = Number.isFinite(quantityValue) ? quantityValue : 0
    setQuantity(formatQuantity(Math.max(1, Math.round((current + delta) * 100) / 100)))
  }

  const save = () => {
    if (!title.trim()) return setError('Dê um título ao serviço.')
    if (priceCents === null) return setError('Informe o preço.')
    if (!(Number.isFinite(quantityValue) && quantityValue > 0)) return setError('A quantidade precisa ser maior que zero.')
    onSave({
      id: item?.id,
      title: title.trim(),
      description: description.trim() || null,
      unitPriceCents: Math.abs(priceCents),
      quantity: quantityValue,
      sourceQuoteId: item?.sourceQuoteId ?? null,
    })
  }

  return (
    <Modal
      title={item ? 'Editar serviço' : 'Serviço'}
      onClose={onClose}
      footer={
        <>
          {onDelete ? <Button variant="danger" icon="trash" onClick={onDelete} title="Remover serviço" /> : <span />}
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" onClick={save}>
              Salvar
            </Button>
          </span>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor={titleId}>
            Serviço
          </label>
          <TextInput id={titleId} value={title} onChange={changeTitle} placeholder="ex. Design de interfaces" list={listId} autoFocus />
          <datalist id={listId}>
            {(suggestions.data?.suggestions ?? []).map((s) => (
              <option key={s.title} value={s.title}>
                {money(s.unitPriceCents)}
              </option>
            ))}
          </datalist>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={descriptionId}>
            Descrição (opcional)
          </label>
          <TextArea id={descriptionId} value={description} onChange={setDescription} placeholder="O que está incluído neste serviço" />
        </div>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 160px' }}>
            <label className="field__label" htmlFor={priceId}>
              Preço unitário (R$)
            </label>
            <TextInput id={priceId} value={price} onChange={setPrice} placeholder="0,00" numeral />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={quantityId}>
              Quantidade
            </label>
            <div className="stepper">
              <Button variant="quiet" size="sm" icon="minus" title="Diminuir quantidade" onClick={() => step(-1)} />
              <TextInput id={quantityId} value={quantity} onChange={setQuantity} numeral />
              <Button variant="quiet" size="sm" icon="plus" title="Aumentar quantidade" onClick={() => step(1)} />
            </div>
          </div>
        </div>
        <div className="row row--between" style={{ padding: 'var(--sp-3) var(--sp-4)', background: 'var(--surface-muted)', borderRadius: 'var(--r-sm)' }}>
          <span className="field__label" style={{ margin: 0 }}>
            Valor do serviço
          </span>
          <strong className="tabular">{lineCents === null ? '-' : money(lineCents)}</strong>
        </div>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

type QuoteOption = {
  id: number
  clientLabel: string
  estimatedHours: number
  recommendedPriceCents: number
  status: string
  createdAt: string
}

/**
 * "Trazer de uma cotação": a cotação continua sendo a calculadora
 * (decisions/0040); o item nasce com o preço recomendado dela e depois é
 * independente.
 */
export function QuotePickerModal({ onPick, onClose }: { onPick: (item: ProposalItem) => void; onClose: () => void }) {
  const quotes = useQuery({
    queryKey: ['proposals', 'quote-options'],
    queryFn: () => api.get<{ quotes: QuoteOption[] }>('/pricing/proposals/quote-options'),
  })
  const rows = quotes.data?.quotes ?? []

  return (
    <Modal title="Trazer de uma cotação" onClose={onClose} wide>
      {quotes.isError ? (
        <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar as cotações agora." />
      ) : !quotes.data ? (
        <SkeletonLines lines={4} />
      ) : rows.length === 0 ? (
        <EmptyState icon="calculator" title="Nenhuma cotação salva" body="Simule um projeto na aba Cotações para trazer o preço calculado para cá." />
      ) : (
        <div className="stack stack--tight">
          <p className="chart__note" style={{ margin: 0 }}>
            O serviço entra com o preço recomendado da cotação. Depois você ajusta título, descrição e valor à vontade.
          </p>
          {rows.map((q) => (
            <button
              key={q.id}
              type="button"
              className="proposal-item"
              style={{ textAlign: 'left', width: '100%', background: 'none', border: 0, cursor: 'pointer' }}
              onClick={() =>
                onPick({
                  title: `Projeto: ${q.clientLabel}`,
                  description: `Estimativa de ${formatQuantity(q.estimatedHours)} horas`,
                  unitPriceCents: q.recommendedPriceCents,
                  quantity: 1,
                  sourceQuoteId: q.id,
                })
              }
            >
              <span style={{ minWidth: 0 }}>
                <strong>{q.clientLabel}</strong>
                <span className="proposal-item__desc">{formatQuantity(q.estimatedHours)} horas estimadas</span>
              </span>
              <span />
              <strong className="tabular proposal-item__value">{money(q.recommendedPriceCents)}</strong>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
