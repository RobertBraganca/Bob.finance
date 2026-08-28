import { useAccounts } from '../../lib/store'
import { CategorySelect, Segmented, Select, TextInput } from '../ui'

/**
 * The one manual-entry form shared by every screen that logs a lançamento
 * by hand — Lançamentos, a pendência de fluxo de caixa/dívida, a nota do
 * diário. Same fields everywhere: recebido/pago, data, descrição,
 * categoria, conta. Deliberately no anexo — see `specs/transactions-ledger`.
 */
export type TransactionFormValue = {
  postedOn: string
  description: string
  /** raw money-input string (see `parseMoneyInput`), always unsigned — direction carries the sign */
  amount: string
  direction: 'in' | 'out'
  categoryId: number | null
  accountId: number | null
  /** true = ainda não recebido/pago. Omitted entirely when the field doesn't apply (a brand-new manual lançamento is always confirmed). */
  pending?: boolean
}

export function TransactionForm({
  value,
  onChange,
  showDirection = true,
  showPending = false,
  descriptionPlaceholder,
}: {
  value: TransactionFormValue
  onChange: (patch: Partial<TransactionFormValue>) => void
  /** false when the caller already fixed the direction (e.g. editing a pendência tied to one flow) — the toggle is hidden, not disabled */
  showDirection?: boolean
  /** shows the "já recebido/pago" checkbox, mapped to `pending` */
  showPending?: boolean
  descriptionPlaceholder?: string
}) {
  const accounts = useAccounts()

  return (
    <div className="stack">
      <div className="field">
        <label className="field__label">Descrição</label>
        <TextInput
          value={value.description}
          onChange={(description) => onChange({ description })}
          placeholder={descriptionPlaceholder}
        />
      </div>

      <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label className="field__label">Data</label>
          <TextInput value={value.postedOn} onChange={(postedOn) => onChange({ postedOn })} type="date" />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label className="field__label">Conta</label>
          <Select
            value={value.accountId}
            options={(accounts.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
            onChange={(accountId) => onChange({ accountId })}
          />
        </div>
      </div>

      {showDirection && (
        <div className="field">
          <label className="field__label">Tipo</label>
          <Segmented
            ariaLabel="Tipo de lançamento"
            value={value.direction}
            onChange={(direction) => {
              // A category valid for the old direction may not be valid for
              // the new one (receita/despesa nunca se sobrepõem) — limpa em
              // vez de manter uma categoria agora incompatível.
              onChange({ direction, categoryId: null })
            }}
            options={[
              { value: 'in', label: 'Entrada' },
              { value: 'out', label: 'Saída' },
            ]}
          />
        </div>
      )}

      <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label className="field__label">Valor (R$)</label>
          <TextInput value={value.amount} onChange={(amount) => onChange({ amount })} placeholder="0,00" numeral />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label className="field__label">Categoria</label>
          <CategorySelect
            value={value.categoryId}
            direction={value.direction}
            onChange={(categoryId) => onChange({ categoryId })}
          />
        </div>
      </div>

      {showPending && (
        <label className="row" style={{ gap: 'var(--sp-2)', fontSize: 'var(--text-sm)' }}>
          <input
            type="checkbox"
            className="checkbox"
            checked={!value.pending}
            onChange={(event) => onChange({ pending: !event.target.checked })}
          />
          {value.direction === 'in' ? 'Já recebido' : 'Já pago'}
        </label>
      )}
    </div>
  )
}
