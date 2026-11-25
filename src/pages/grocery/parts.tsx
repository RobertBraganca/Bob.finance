import { Link } from 'react-router-dom'
import { budgetBalance, type TripTotals } from '@shared/grocery'
import { money } from '../../lib/format'
import { Icon, Meter, capUsageState } from '../../components/ui'
import type { SyncStatus } from './useGrocery'
import type { GroceryBudget } from './types'
import { fmtChange } from './types'

/** Preço pago contra o último: em preço, subir é o lado ruim (vermelho), sempre com seta e texto. */
export function PriceChange({ price, last }: { price: number | null; last: number | null }) {
  if (price === null) return null
  if (last === null) return <span className="grocery-change grocery-change--new">novo</span>
  if (last === 0 || price === last) return <span className="grocery-change grocery-change--flat">igual</span>
  const change = (price - last) / last
  const up = change > 0
  return (
    <span className={`grocery-change grocery-change--${up ? 'up' : 'down'}`} title={`Último preço ${money(last)}`}>
      <Icon name={up ? 'arrowUpRight' : 'arrowDownLeft'} size={12} strokeWidth={2.2} />
      {fmtChange(Math.round(change * 1000) / 1000)}
      <span className="sr-only">{up ? ' mais caro que da última vez' : ' mais barato que da última vez'}</span>
    </span>
  )
}

/**
 * Rodapé fixo da lista. Em casa o número grande é o previsto; no mercado é o
 * real, com o previsto ao lado. O saldo é o teto de mercado do mês (Orçamento)
 * menos o que já foi gasto na categoria menos esta compra (`budgetBalance`).
 */
export function BudgetFooter({
  mode,
  totals,
  budget,
  children,
}: {
  mode: 'home' | 'store'
  totals: TripTotals
  budget: GroceryBudget | undefined
  children?: React.ReactNode
}) {
  const tripCents = mode === 'home' ? totals.plannedCents : totals.realCents
  const balance = budget
    ? budgetBalance({ capCents: budget.capCents, spentCents: budget.spentCents, tripCents, tripLinked: budget.activeTripLinked })
    : null
  const cap = budget?.capCents ?? null
  const usedBps = cap ? Math.round(((cap - (balance ?? cap)) / cap) * 10_000) : 0
  const over = balance !== null && balance < 0

  return (
    <div className="grocery-footer" aria-live="polite">
      <div className="grocery-footer__figures">
        <div className="stack stack--tight">
          <span className="stat__label">{mode === 'home' ? 'Previsto' : 'Total no carrinho'}</span>
          <span className="grocery-footer__main">{money(tripCents)}</span>
        </div>
        <div className="stack stack--tight" style={{ alignItems: 'flex-end', textAlign: 'right' }}>
          {mode === 'store' && <span className="grocery-footer__line">Previsto {money(totals.plannedCents)}</span>}
          <span className="grocery-footer__line">
            {totals.checkedCount}/{totals.totalCount} {mode === 'store' ? 'no carrinho' : 'marcados'}
          </span>
          {totals.missingPriceCount > 0 && mode === 'home' && (
            <span className="grocery-footer__line">
              {totals.missingPriceCount} {totals.missingPriceCount === 1 ? 'item sem preço' : 'itens sem preço'} fora do previsto
            </span>
          )}
          {totals.checkedWithoutPriceCount > 0 && mode === 'store' && (
            <span className="grocery-footer__line">
              {totals.checkedWithoutPriceCount} {totals.checkedWithoutPriceCount === 1 ? 'marcado sem preço' : 'marcados sem preço'}
            </span>
          )}
        </div>
      </div>
      {budget && budget.categoryId !== null && cap !== null && balance !== null ? (
        <>
          <Meter usedBps={usedBps} state={capUsageState(usedBps)} label={`Teto de ${budget.categoryName ?? 'mercado'} do mês`} />
          <span className="grocery-footer__line">
            {over ? (
              <span className="grocery-footer__over">
                <Icon name="alert" size={12} /> Passa {money(-balance)} do teto de {money(cap)}
              </span>
            ) : (
              <>
                Sobra {money(balance)} do teto de {money(cap)}
                {mode === 'home' ? ' depois desta lista' : ''}
              </>
            )}
            <span className="muted"> · já gasto no mês {money(budget.spentCents)}</span>
          </span>
        </>
      ) : budget ? (
        <span className="grocery-footer__line">
          {budget.categoryId === null ? (
            'Nenhuma categoria Supermercado ativa para medir o orçamento.'
          ) : (
            <>
              Sem teto de {budget.categoryName} neste mês. <Link to="/metas">Definir teto</Link>
            </>
          )}
        </span>
      ) : null}
      {children}
    </div>
  )
}

const SYNC_LABEL: Record<SyncStatus, string> = {
  idle: '',
  saving: 'Salvando…',
  saved: 'Salvo',
  offline: 'Sem conexão',
  retrying: 'Tentando salvar',
}

/** Estado da fila offline: discreto, mas nunca esconde que há edição não enviada. */
export function SyncIndicator({ status, pending }: { status: SyncStatus; pending: number }) {
  if (status === 'idle' && pending === 0) return null
  const icon = status === 'offline' || status === 'retrying' ? 'alert' : status === 'saving' ? 'loader' : 'check'
  return (
    <span className="grocery-sync" role="status">
      <Icon name={icon} size={12} className={status === 'saving' ? 'spin' : undefined} />
      {SYNC_LABEL[status]}
      {pending > 0 && status !== 'saving' ? ` · ${pending} ${pending === 1 ? 'pendente' : 'pendentes'}` : ''}
    </span>
  )
}

/** Quantidade digitada em pt-BR ("1,250") para número; inválida ou ≤ 0 vira null. */
export function parseQty(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.')
  if (!cleaned) return null
  const value = Number(cleaned)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 1000) / 1000
}

export const qtyToInput = (value: number | null) => (value === null ? '' : String(value).replace('.', ','))

/** Passo do − / +: 1 para unidade e litro, 0,5 para quilo. */
export const qtyStep = (unit: 'un' | 'kg' | 'L') => (unit === 'kg' ? 0.5 : 1)
