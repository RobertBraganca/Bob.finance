import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Icon } from './Icon'

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

export type DropdownOption<T> = { value: T; label: string }
export type DropdownGroup<T> = { label?: string; options: DropdownOption<T>[] }

/**
 * The listbox behind every dropdown in the app (Select, FilterSelect,
 * CategorySelect). A native `<select>` renders its open popup with the
 * browser/OS's own chrome, not this app's CSS — Firefox ignores `<option>`
 * styling entirely, and Chromium only partially respects it, so the
 * row spacing ("respiro") a dropdown needs can't be delivered reliably
 * through a native popup. This draws the panel itself instead, so every
 * browser gets the same padding, and keeps the keyboard behaviour a
 * native `<select>` gave for free: Up/Down/Home/End/Enter/Escape and
 * type-to-jump.
 */
export function DropdownSelect<T extends string | number>({
  groups,
  value,
  onChange,
  placeholder,
  ariaLabel,
  panelClassName,
  panelMinWidth,
  renderTrigger,
}: {
  groups: DropdownGroup<T>[]
  value: T | null
  onChange: (value: T | null) => void
  /** shown as the first, always-present row when set — selecting it calls onChange(null) */
  placeholder?: string
  ariaLabel?: string
  panelClassName?: string
  /** panel defaults to at least the trigger's own width; pass a fixed px value to widen it beyond that (e.g. a narrow pill trigger with long option labels) */
  panelMinWidth?: number
  renderTrigger: (ctx: { open: boolean; label: string; triggerProps: TriggerProps }) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [typeahead, setTypeahead] = useState('')

  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups])
  const currentFlatIndex = flat.findIndex((o) => o.value === value)
  // -1 stands for the placeholder row (only reachable when placeholder is set).
  const [highlighted, setHighlighted] = useState(currentFlatIndex)

  useEffect(() => {
    if (open) setHighlighted(currentFlatIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (event: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const el = panelRef.current?.querySelector('[data-highlighted="true"]') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, highlighted])

  useEffect(() => {
    if (typeahead === '') return
    const timer = setTimeout(() => setTypeahead(''), 700)
    return () => clearTimeout(timer)
  }, [typeahead])

  const commit = (index: number) => {
    if (index === -1) onChange(null)
    else {
      const opt = flat[index]
      if (opt) onChange(opt.value)
    }
    setOpen(false)
    triggerRef.current?.focus()
  }

  const minIndex = placeholder !== undefined ? -1 : 0
  const clamp = (i: number) => Math.max(minIndex, Math.min(flat.length - 1, i))

  const jumpByTypeahead = (buffer: string) => {
    const needle = buffer.toLowerCase()
    const startAt = highlighted + 1
    const ordered = [...flat.slice(startAt), ...flat.slice(0, startAt)]
    const match = ordered.find((o) => o.label.toLowerCase().startsWith(needle))
    if (match) setHighlighted(flat.indexOf(match))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setOpen(true)
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setHighlighted((i) => clamp(i + 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setHighlighted((i) => clamp(i - 1))
        break
      case 'Home':
        event.preventDefault()
        setHighlighted(minIndex)
        break
      case 'End':
        event.preventDefault()
        setHighlighted(flat.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(highlighted)
        break
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const next = typeahead + event.key
          setTypeahead(next)
          jumpByTypeahead(next)
        }
    }
  }

  const currentLabel = flat.find((o) => o.value === value)?.label ?? placeholder ?? ''

  let flatIndex = -1

  return (
    <div
      className="dropdown-anchor"
      ref={anchorRef}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!anchorRef.current?.contains(event.relatedTarget as Node)) setOpen(false)
      }}
    >
      {renderTrigger({
        open,
        label: currentLabel,
        triggerProps: {
          ref: triggerRef,
          type: 'button',
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-label': ariaLabel,
          onClick: () => setOpen((v) => !v),
        },
      })}
      {open && (
        <div
          className={cx('dropdown-panel', panelClassName)}
          role="listbox"
          aria-label={ariaLabel}
          ref={panelRef}
          style={panelMinWidth ? { minWidth: panelMinWidth } : undefined}
        >
          {placeholder !== undefined && (
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              data-highlighted={highlighted === -1}
              className={cx(
                'dropdown-option',
                'dropdown-option--placeholder',
                value === null && 'dropdown-option--selected',
                highlighted === -1 && 'dropdown-option--highlighted',
              )}
              onMouseEnter={() => setHighlighted(-1)}
              onClick={() => commit(-1)}
            >
              {placeholder}
            </button>
          )}
          {groups.map((group, gi) => (
            <div key={group.label ?? gi} role="group" aria-label={group.label}>
              {group.label && <div className="dropdown-group-label">{group.label}</div>}
              {group.options.map((option) => {
                const idx = ++flatIndex
                const selected = option.value === value
                const isHighlighted = idx === highlighted
                return (
                  <button
                    key={String(option.value)}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-highlighted={isHighlighted}
                    className={cx(
                      'dropdown-option',
                      selected && 'dropdown-option--selected',
                      isHighlighted && 'dropdown-option--highlighted',
                    )}
                    onMouseEnter={() => setHighlighted(idx)}
                    onClick={() => commit(idx)}
                  >
                    <span className="truncate">{option.label}</span>
                    {selected && <Icon name="check" size={13} className="dropdown-option__check" />}
                  </button>
                )
              })}
            </div>
          ))}
          {flat.length === 0 && placeholder === undefined && (
            <div className="dropdown-option dropdown-option--empty">Nada disponível</div>
          )}
        </div>
      )}
    </div>
  )
}

type TriggerProps = {
  ref: Ref<HTMLButtonElement>
  type: 'button'
  'aria-haspopup': 'listbox'
  'aria-expanded': boolean
  'aria-label': string | undefined
  onClick: () => void
}
