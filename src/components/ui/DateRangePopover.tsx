import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * Close-on-outside-click + close-on-Escape, shared by every popover panel
 * anchored to a `.popover-anchor` trigger (this file and PeriodPickerPopover,
 * which used to each carry an identical copy of this effect).
 *
 * Escape ALSO returns focus to the trigger button (auditoria de
 * acessibilidade de 26/09/2026): sem isto, um usuário de teclado fechava o
 * painel e perdia a posição, com o foco caindo em `<body>`. Um clique fora
 * não devolve o foco de propósito -- a pessoa já mirou em outra coisa, e
 * puxar o foco de volta pro gatilho brigaria com esse clique.
 */
export function usePopoverDismiss(open: boolean, anchorRef: RefObject<HTMLElement | null>, onDismiss: () => void) {
  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) onDismiss()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss()
        anchorRef.current?.querySelector<HTMLElement>('button')?.focus()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, anchorRef, onDismiss])
}

/**
 * The "De"/"Até" date field pair plus Cancelar/Aplicar footer — identical in
 * this popover and in PeriodPickerPopover's "Personalizado" mode. Kept here,
 * not duplicated, so a future change to this block (validation, a third
 * field) only happens once.
 */
export function DateRangeFields({
  from,
  to,
  onFromChange,
  onToChange,
  onCancel,
  onApply,
  applyLabel = 'Aplicar',
}: {
  from: string
  to: string
  onFromChange: (value: string) => void
  onToChange: (value: string) => void
  onCancel: () => void
  onApply: () => void
  applyLabel?: string
}) {
  const fromFieldId = useId()
  const toFieldId = useId()
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={fromFieldId}>De</label>
        <input id={fromFieldId} className="input" type="date" value={from} onChange={(e) => onFromChange(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={toFieldId}>Até</label>
        <input id={toFieldId} className="input" type="date" value={to} onChange={(e) => onToChange(e.target.value)} />
      </div>
      <div className="row row--between" style={{ marginTop: 'var(--sp-1)' }}>
        <button type="button" className="btn btn--quiet btn--sm" onClick={onCancel}>
          Cancelar
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={onApply}>
          {applyLabel}
        </button>
      </div>
    </>
  )
}

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

  usePopoverDismiss(open, anchorRef, () => setOpen(false))

  return (
    <div className="popover-anchor" ref={anchorRef}>
      <button type="button" className="filter-select" onClick={() => setOpen((v) => !v)}>
        <Icon name={icon} size={14} className="filter-select__icon" />
        <span className="filter-select__value">{label}</span>
        <Icon name="chevronDown" size={13} className="filter-select__chevron" />
      </button>
      {open && (
        <div className="popover-panel" role="dialog" aria-label="Escolher período">
          <DateRangeFields
            from={draftFrom}
            to={draftTo}
            onFromChange={setDraftFrom}
            onToChange={setDraftTo}
            onCancel={() => setOpen(false)}
            onApply={() => {
              onApply(draftFrom, draftTo)
              setOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
}
