import { useId, type ReactNode } from 'react'
import { money, parseMoneyInput, parsePercentInput } from '../../lib/format'
import { currentPeriod, shiftPeriod } from '../../lib/period'
import { monthlyRate, type PeriodUnit, type RateUnit } from '@shared/calculators'
import { Button, Card, Segmented, TextInput } from '../../components/ui'

/**
 * Campos e ajudas comuns às Calculadoras de Investimentos (juros, renda,
 * primeiro milhão e imóvel) e à edição do plano de imóvel.
 */
/* ------------------------------------------------------------------ *
 * Campos
 * ------------------------------------------------------------------ */
export function MoneyField({ label, value, onChange, placeholder = '0,00', hint }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: ReactNode }) {
  const id = useId()
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <TextInput id={id} value={value} onChange={onChange} placeholder={placeholder} numeral />
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  )
}

export function RateField({ value, unit, onChange, onUnit }: { value: string; unit: RateUnit; onChange: (v: string) => void; onUnit: (u: RateUnit) => void }) {
  const id = useId()
  const pct = parsePercentInput(value)
  const other =
    pct === null
      ? null
      : unit === 'year'
        ? `${(monthlyRate(pct / 100, 'year') * 100).toLocaleString('pt-BR', { maximumFractionDigits: 3 })}% ao mês`
        : `${((Math.pow(1 + pct / 10_000, 12) - 1) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% ao ano`
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        Taxa de juros (%)
      </label>
      <div className="row" style={{ gap: 'var(--sp-2)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextInput id={id} value={value} onChange={onChange} placeholder="0" numeral />
        </div>
        <Segmented
          ariaLabel="Unidade da taxa"
          value={unit}
          onChange={onUnit}
          options={[
            { value: 'year', label: 'ao ano' },
            { value: 'month', label: 'ao mês' },
          ]}
        />
      </div>
      <span className="field__hint">{other ? `equivale a ${other}` : 'Selic, CDB e poupança costumam ser divulgados ao ano.'}</span>
    </div>
  )
}

export function PeriodField({ label, value, unit, onChange, onUnit }: { label: string; value: string; unit: PeriodUnit; onChange: (v: string) => void; onUnit: (u: PeriodUnit) => void }) {
  const id = useId()
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="row" style={{ gap: 'var(--sp-2)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextInput id={id} value={value} onChange={onChange} placeholder="0" numeral />
        </div>
        <Segmented
          ariaLabel="Unidade do prazo"
          value={unit}
          onChange={onUnit}
          options={[
            { value: 'year', label: 'anos' },
            { value: 'month', label: 'meses' },
          ]}
        />
      </div>
    </div>
  )
}

/** Valor em centavos, positivo; vazio vira 0 (valor inicial e aporte podem ficar em branco). */
export const cents = (raw: string) => Math.abs(parseMoneyInput(raw) ?? 0)
/**
 * Número decimal livre ("12,5" ou "12.5"), ou `null` se vazio ou inválido.
 * Ponto só é separador de milhar quando também há vírgula ("1.200,5").
 */
export const decimal = (raw: string) => {
  const trimmed = raw.trim()
  const cleaned = trimmed.includes(',') ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? n : null
}
/** Taxa anual equivalente em pontos-base, para a meta (que guarda o retorno ao ano). */
export const annualBps = (pct: number, unit: RateUnit) => Math.round((unit === 'year' ? pct : (Math.pow(1 + pct / 100, 12) - 1) * 100) * 100)
export const dueDate = (months: number) => `${shiftPeriod(currentPeriod(), months)}-28`

export function InputCard({ title, subtitle, children, onUsePortfolio, onClear, portfolioValueCents }: { title: string; subtitle: string; children: ReactNode; onUsePortfolio: () => void; onClear: () => void; portfolioValueCents: number }) {
  return (
    <Card title={title} subtitle={subtitle}>
      <div className="stack">
        {children}
        <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
          <Button size="sm" icon="wallet" onClick={onUsePortfolio} disabled={portfolioValueCents <= 0} title={`Preenche o valor inicial com ${money(portfolioValueCents)}`}>
            Usar minha carteira
          </Button>
          <Button variant="quiet" size="sm" icon="x" onClick={onClear}>
            Limpar
          </Button>
        </div>
      </div>
    </Card>
  )
}
