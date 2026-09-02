import { Icon } from './Icon'
import { MONTHS_SHORT } from '../../lib/format'

/**
 * Ano + grade de 12 meses: o miolo de qualquer escolha de mês no app.
 *
 * Existia só dentro do `PeriodPickerPopover` (Visão geral, Lançamentos,
 * DRE). O `PeriodNav` das páginas de mês precisava do mesmo, e copiar a
 * grade era o caminho para as duas divergirem no primeiro ajuste — que é
 * exatamente como o app chegou a três seletores de período diferentes
 * (revisão de 01/09/2026).
 *
 * `max` é o mês mais recente selecionável. Mês futuro aparece desabilitado
 * em vez de sumir: some e a grade muda de forma de mês para mês, o que
 * confunde mais do que um botão apagado.
 */
export function MonthGrid({
  viewYear,
  onViewYearChange,
  selected,
  onSelect,
  max,
}: {
  viewYear: number
  onViewYearChange: (year: number) => void
  /** `YYYY-MM` marcado como ativo, ou null quando a seleção não é um mês inteiro. */
  selected: string | null
  onSelect: (period: string) => void
  /** `YYYY-MM` mais recente selecionável. Sem isto, nada é bloqueado. */
  max?: string
}) {
  const yearIsFuture = max !== undefined && viewYear > Number(max.slice(0, 4))

  return (
    <>
      <div className="period-picker__year-nav">
        <button
          type="button"
          className="btn btn--quiet btn--sm btn--icon"
          onClick={() => onViewYearChange(viewYear - 1)}
          aria-label="Ano anterior"
        >
          <Icon name="arrowLeft" size={14} />
        </button>
        <strong>{viewYear}</strong>
        <button
          type="button"
          className="btn btn--quiet btn--sm btn--icon"
          onClick={() => onViewYearChange(viewYear + 1)}
          disabled={yearIsFuture}
          aria-label="Próximo ano"
        >
          <Icon name="arrowRight" size={14} />
        </button>
      </div>
      <div className="period-picker__grid">
        {MONTHS_SHORT.map((label, i) => {
          const period = `${viewYear}-${String(i + 1).padStart(2, '0')}`
          const isSelected = period === selected
          const isFuture = max !== undefined && period > max
          return (
            <button
              key={label}
              type="button"
              className={`period-picker__month${isSelected ? ' period-picker__month--active' : ''}`}
              onClick={() => onSelect(period)}
              disabled={isFuture}
              aria-current={isSelected ? 'true' : undefined}
            >
              {label}
            </button>
          )
        })}
      </div>
    </>
  )
}
