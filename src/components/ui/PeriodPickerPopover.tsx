import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Segmented } from './index'
import { MONTHS_SHORT, date as fmtDate, periodLong as fmtPeriodLong } from '../../lib/format'
import type { RangePreset } from '../../lib/store'

const QUICK_PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: '3m', label: '3m' },
  { value: '6m', label: '6m' },
  { value: '12m', label: '12m' },
  { value: 'ytd', label: 'Ano' },
  { value: 'max', label: 'Máximo' },
]

function daysInMonth(year: number, month1based: number): number {
  return new Date(year, month1based, 0).getDate()
}

/**
 * One trigger for the whole period selection — replaces the old preset
 * pill row plus a separate custom-range popover. Opens a single panel
 * whose main act is a year/month grid (pick any month, not just the
 * current one); 3m/6m/12m/Ano/Máximo and an arbitrary date range are
 * still one click away as a secondary row, so nothing from the old bar
 * was lost — it just all lives behind one control now.
 */
export function PeriodPickerPopover({
  preset,
  from,
  to,
  anchor,
  onPreset,
  onCustom,
}: {
  preset: RangePreset
  from: string
  to: string
  anchor: string
  onPreset: (preset: RangePreset) => void
  onCustom: (from: string, to: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'months' | 'custom'>('months')
  const [viewYear, setViewYear] = useState(() => Number(anchor.slice(0, 4)))
  const [draftFrom, setDraftFrom] = useState(from)
  const [draftTo, setDraftTo] = useState(to)
  const anchorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraftFrom(from)
    setDraftTo(to)
  }, [from, to])

  useEffect(() => {
    if (!open) return
    setMode('months')
    setViewYear(Number(anchor.slice(0, 4)))
  }, [open, anchor])

  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // The single calendar month this selection maps to, if any — drives
  // both the trigger label and which grid cell shows as selected.
  const selectedMonth = (() => {
    if (preset === 'mtd') return anchor.slice(0, 7)
    if (preset !== 'custom' || !from.endsWith('-01')) return null
    const period = from.slice(0, 7)
    const [y, m] = period.split('-').map(Number) as [number, number]
    const isCurrentMonth = period === anchor.slice(0, 7)
    const expectedTo = isCurrentMonth ? anchor : `${period}-${String(daysInMonth(y, m)).padStart(2, '0')}`
    return to === expectedTo ? period : null
  })()

  const quickLabel = QUICK_PRESETS.find((p) => p.value === preset)?.label
  const triggerLabel = quickLabel ?? (selectedMonth ? fmtPeriodLong(selectedMonth) : `${fmtDate(from)} a ${fmtDate(to)}`)

  const applyPreset = (next: RangePreset) => {
    onPreset(next)
    setOpen(false)
  }

  const selectMonth = (monthIndex0: number) => {
    const y = viewYear
    const m = monthIndex0 + 1
    const period = `${y}-${String(m).padStart(2, '0')}`
    const fromIso = `${period}-01`
    const isCurrentMonth = period === anchor.slice(0, 7)
    const toIso = isCurrentMonth ? anchor : `${period}-${String(daysInMonth(y, m)).padStart(2, '0')}`
    onCustom(fromIso, toIso)
    setOpen(false)
  }

  return (
    <div className="popover-anchor" ref={anchorRef}>
      <button type="button" className="filter-select" onClick={() => setOpen((v) => !v)}>
        <Icon name="calendar" size={14} className="filter-select__icon" />
        <span className="filter-select__value">{triggerLabel}</span>
        <Icon name="chevronDown" size={13} className="filter-select__chevron" />
      </button>
      {open && (
        <div className="popover-panel period-picker" role="dialog" aria-label="Escolher período">
          <Segmented
            ariaLabel="Atalhos de período"
            value={mode === 'custom' ? 'custom' : preset}
            options={[...QUICK_PRESETS, { value: 'custom', label: 'Personalizado' }]}
            onChange={(value) => (value === 'custom' ? setMode('custom') : applyPreset(value))}
          />

          {mode === 'custom' ? (
            <>
              <div className="field">
                <label className="field__label">De</label>
                <input className="input" type="date" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label">Até</label>
                <input className="input" type="date" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
              </div>
              <div className="row row--between">
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => setOpen(false)}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => {
                    onCustom(draftFrom, draftTo)
                    setOpen(false)
                  }}
                >
                  Aplicar
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="period-picker__year-nav">
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => setViewYear((y) => y - 1)}
                  aria-label="Ano anterior"
                >
                  <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}>
                    <Icon name="chevronRight" size={14} />
                  </span>
                </button>
                <strong>{viewYear}</strong>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => setViewYear((y) => y + 1)}
                  aria-label="Próximo ano"
                >
                  <Icon name="chevronRight" size={14} />
                </button>
              </div>
              <div className="period-picker__grid">
                {MONTHS_SHORT.map((label, i) => {
                  const period = `${viewYear}-${String(i + 1).padStart(2, '0')}`
                  const isSelected = period === selectedMonth
                  return (
                    <button
                      key={label}
                      type="button"
                      className={`period-picker__month${isSelected ? ' period-picker__month--active' : ''}`}
                      onClick={() => selectMonth(i)}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              <div className="row row--between">
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => setOpen(false)}>
                  Cancelar
                </button>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => applyPreset('mtd')}>
                  Mês atual
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
