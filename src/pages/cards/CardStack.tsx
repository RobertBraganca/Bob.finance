import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { bps, money, date as fmtDate } from '../../lib/format'
import { tintsFor } from '../../lib/bankColors'
import type { CardRow } from '../CreditCards'

/** Quanto de cada cartão de trás aparece acima do da frente. */
const PEEK = 52

/**
 * Pilha de cartões, um por cima do outro, na cor do banco. O da frente
 * mostra o limite disponível; os de trás mostram só a faixa de cima. Tocar
 * num cartão de trás puxa ele para a frente, e os que estavam na frente
 * sobem uma posição.
 *
 * A ordem é guardada aqui; quem está na frente vem de fora (`selectedId`),
 * para a fatura logo abaixo acompanhar o mesmo cartão.
 */
export function CardStack({
  cards,
  selectedId,
  onSelect,
}: {
  cards: CardRow[]
  selectedId: number
  onSelect: (id: number) => void
}) {
  const ids = cards.map((c) => c.id)
  const [order, setOrder] = useState<number[]>(() => [...ids.filter((id) => id !== selectedId), selectedId])
  const [pulled, setPulled] = useState<number | null>(null)
  const fromStack = useRef(false)
  const frontRef = useRef<HTMLDivElement>(null)

  // Ajuste durante a renderização (sem efeito): cartão novo entra atrás,
  // excluído sai, e o selecionado de fora vai para a frente.
  let next = [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))]
  if (ids.includes(selectedId) && next[next.length - 1] !== selectedId) {
    next = [...next.filter((id) => id !== selectedId), selectedId]
  }
  const frontId = next[next.length - 1] ?? selectedId
  if (next.join() !== order.join()) {
    if (order.length > 0 && order[order.length - 1] !== frontId) setPulled(frontId)
    setOrder(next)
  }
  useEffect(() => {
    // Quem puxou pelo teclado não perde o foco: o botão de trás vira o cartão da frente.
    if (fromStack.current && pulled === frontId) frontRef.current?.focus({ preventScroll: true })
    fromStack.current = false
  }, [pulled, frontId])

  const tints = tintsFor(cards)
  const byId = new Map(cards.map((c) => [c.id, c]))
  const front = byId.get(frontId)

  return (
    <div className="card-stack" role="group" aria-label="Seus cartões" style={{ height: `calc(${(next.length - 1) * PEEK}px + var(--card-face-h))` }}>
      {next.map((id, i) => {
        const card = byId.get(id)
        if (!card) return null
        const tint = tints.get(id)!
        const isFront = id === frontId
        const slotStyle = {
          '--card-bg': tint.bg,
          zIndex: i + 1,
          transform: `translateY(${i * PEEK}px)`,
        } as CSSProperties
        const className = `card-face card-face--${tint.ink}`
        return (
          <div key={id} className="card-stack__slot" style={slotStyle}>
            {isFront ? (
              <div
                ref={frontRef}
                tabIndex={-1}
                className={`${className} card-face--front${pulled === id ? ' card-face--pulled' : ''}`}
                onAnimationEnd={() => setPulled(null)}
              >
                <FrontFace card={card} />
              </div>
            ) : (
              <button
                type="button"
                className={`${className} card-face--back`}
                aria-label={`Mostrar ${card.name}, ${money(card.availableLimitCents)} disponível`}
                onClick={() => {
                  fromStack.current = true
                  onSelect(id)
                }}
              >
                <span className="card-face__top">
                  <span className="card-face__name">{card.name}</span>
                  <span className="card-face__peek">{money(card.availableLimitCents)}</span>
                </span>
              </button>
            )}
          </div>
        )
      })}
      <span className="sr-only" aria-live="polite">
        {front && pulled !== null ? `${front.name} na frente` : ''}
      </span>
    </div>
  )
}

function FrontFace({ card }: { card: CardRow }) {
  const usedPct = Math.max(0, Math.min(100, card.usedBps / 100))
  const source = card.source === 'manual' ? 'Medido à mão' : card.syncError ? 'Leitura falhou' : 'Open Finance'
  return (
    <>
      <span className="card-face__top">
        <span className="card-face__name">{card.name}</span>
        <span className="card-face__chip">{source}</span>
      </span>
      <span className="card-face__body">
        <span className="card-face__label">Limite disponível</span>
        <span className="card-face__value">{money(card.availableLimitCents)}</span>
        <span className="card-face__sub">
          de {money(card.creditLimitCents)} · {bps(Math.max(0, 10_000 - card.usedBps), 0)} livre
        </span>
      </span>
      <span
        className="card-face__meter"
        role="progressbar"
        aria-label={`Limite usado do ${card.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(usedPct)}
      >
        <span style={{ clipPath: `inset(0 ${100 - usedPct}% 0 0 round 9999px)` }} />
      </span>
      <span className="card-face__foot">
        <span>
          Fecha {fmtDate(card.nextClosingOn)} · Vence {fmtDate(card.nextDueOn)}
        </span>
        {card.openBillCents !== null && <span>Fatura {money(card.openBillCents)}</span>}
      </span>
    </>
  )
}
