import { useRef, useState } from 'react'
import { Icon } from './Icon'
import { MonthGrid } from './MonthGrid'
import { usePopoverDismiss } from './DateRangePopover'
import { periodLong } from '../../lib/format'
import { currentPeriod, shiftPeriod } from '../../lib/period'

/**
 * O único seletor de mês do app.
 *
 * Antes de 01/09/2026 havia três gramáticas para a mesma ação: botão com
 * `chevronDown` e "Mês anterior/seguinte" (Diário), botões de texto puro
 * "Anterior/Seguinte" (Motor financeiro, Saúde financeira, Metas do mês) e
 * o seletor de faixa com ícone de calendário (Visão geral, Lançamentos,
 * DRE — esse continua sendo outra coisa, porque escolhe um intervalo de
 * datas, não um mês).
 *
 * Três decisões que valem registro:
 *
 *  - Seta, nunca chevron. `chevronDown` significa "expande", não "anda";
 *    era o ícone do Diário para ir ao mês anterior.
 *  - O rótulo é clicável e abre a grade de meses. Antes, ir de setembro a
 *    janeiro eram oito cliques.
 *  - "Próximo" desabilita no mês corrente. Só o Diário fazia isso; as
 *    outras três páginas paginavam indefinidamente para meses vazios.
 *    Passar `max` mais restritivo (o último mês COM DADO, por exemplo)
 *    aperta ainda mais.
 *
 * A página de Investimentos não usa este componente: ela tem períodos de
 * revisão próprios, e essa exceção é deliberada.
 */
export function PeriodNav({
  period,
  onChange,
  max = currentPeriod(),
  label,
}: {
  period: string
  onChange: (period: string) => void
  /** Mês mais recente navegável. Padrão: o mês corrente. */
  max?: string
  /** Sobrescreve o rótulo. Padrão: o mês por extenso. */
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [viewYear, setViewYear] = useState(() => Number(period.slice(0, 4)))
  const anchorRef = useRef<HTMLDivElement>(null)

  usePopoverDismiss(open, anchorRef, () => setOpen(false))

  const atMax = period >= max

  const go = (months: number) => {
    const next = shiftPeriod(period, months)
    if (next > max) return
    onChange(next)
    setViewYear(Number(next.slice(0, 4)))
  }

  return (
    <div className="popover-anchor period-nav" ref={anchorRef}>
      <button
        type="button"
        className="period-nav__step"
        onClick={() => go(-1)}
        aria-label="Mês anterior"
      >
        <Icon name="arrowLeft" size={14} />
      </button>

      <button
        type="button"
        className="period-nav__label"
        onClick={() => {
          setViewYear(Number(period.slice(0, 4)))
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {label ?? periodLong(period)}
      </button>

      <button
        type="button"
        className="period-nav__step"
        onClick={() => go(1)}
        disabled={atMax}
        aria-label="Mês seguinte"
      >
        <Icon name="arrowRight" size={14} />
      </button>

      {open && (
        <div className="popover-panel period-picker" role="dialog" aria-label="Escolher mês">
          <MonthGrid
            viewYear={viewYear}
            onViewYearChange={setViewYear}
            selected={period}
            onSelect={(next) => {
              onChange(next)
              setOpen(false)
            }}
            max={max}
          />
          <div className="row row--between">
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                onChange(max)
                setViewYear(Number(max.slice(0, 4)))
                setOpen(false)
              }}
            >
              Mês atual
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
