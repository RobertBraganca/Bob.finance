import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * A compact trigger (same pill chrome as FilterSelect) that opens a small
 * floating panel with the two date fields, instead of two full-width date
 * inputs sitting inline in the filter row — those pushed the header onto
 * a second line and didn't match any other control's shape.
 */
export function DateRangePopover({
  icon,
  label,
  from,
  to,
  onApply,
}: {
  icon: IconName
  label: string
  from: string
  to: string
  onApply: (from: string, to: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draftFrom, setDraftFrom] = useState(from)
  const [draftTo, setDraftTo] = useState(to)
  const anchorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraftFrom(from)
    setDraftTo(to)
  }, [from, to])

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

  return (
    <div className="popover-anchor" ref={anchorRef}>
      <button type="button" className="filter-select" onClick={() => setOpen((v) => !v)}>
        <Icon name={icon} size={14} className="filter-select__icon" />
        <span className="filter-select__value">{label}</span>
        <Icon name="chevronDown" size={13} className="filter-select__chevron" />
      </button>
      {open && (
        <div className="popover-panel" role="dialog" aria-label="Escolher período">
          <div className="field">
            <label className="field__label">De</label>
            <input className="input" type="date" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">Até</label>
            <input className="input" type="date" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
          </div>
          <div className="row row--between" style={{ marginTop: 'var(--sp-1)' }}>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                onApply(draftFrom, draftTo)
                setOpen(false)
              }}
            >
              Aplicar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
