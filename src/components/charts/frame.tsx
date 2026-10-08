import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { EmptyState } from '../ui'
import type { ChartTheme } from '../../lib/chartTheme'

/**
 * Every chart in this app is wrapped in a frame that guarantees three
 * things the chart itself cannot:
 *
 *  1. A LEGEND whenever there are two or more series — identity is never
 *     carried by colour alone. A single series gets no legend box: the
 *     title already names what is plotted.
 *  2. A TABLE VIEW twin. Tooltips enhance, they never gate: every value
 *     is reachable without hovering, and without seeing colour.
 *  3. A designed EMPTY STATE, so a fresh install shows an explanation
 *     rather than an axis with nothing on it.
 */

export type LegendEntry = { label: string; color: string; shape?: 'line' | 'block' | 'dash' }

export type TableColumn<T> = {
  header: string
  value: (row: T) => ReactNode
  align?: 'left' | 'right'
}

export function ChartFrame<T>({
  legend,
  note,
  isEmpty,
  emptyTitle,
  emptyBody,
  emptyAction,
  table,
  ariaLabel,
  children,
}: {
  legend?: LegendEntry[]
  note?: ReactNode
  isEmpty?: boolean
  emptyTitle?: string
  emptyBody?: string
  emptyAction?: ReactNode
  table?: { rows: T[]; columns: Array<TableColumn<T>>; caption?: string }
  /** Nome do gráfico para leitor de tela. Sem ele, vale a legenda da tabela gêmea. */
  ariaLabel?: string
  children: ReactNode
}) {
  const [showTable, setShowTable] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const label = ariaLabel ?? table?.caption

  /*
   * O Recharts desenha o <svg> com `role="application"` e sem nome, então o
   * leitor de tela anunciava só "aplicativo" (revisão de Investimentos de
   * 03/10/2026, 7 gráficos). O SVG nasce depois da medição do
   * ResponsiveContainer, por isso o observer: rotula quando ele aparece.
   */
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !label) return
    const apply = () => {
      body.querySelectorAll('svg.recharts-surface').forEach((svg) => {
        if (svg.getAttribute('aria-label') !== label) svg.setAttribute('aria-label', label)
      })
    }
    apply()
    // Só reage quando entra um <svg> novo: hover e tooltip mexem no subtree
    // o tempo todo, e varrer o DOM a cada um era trabalho à toa.
    const observer = new MutationObserver((mutations) => {
      const addedSvg = mutations.some((m) =>
        Array.from(m.addedNodes).some((node) => node instanceof Element && (node.matches('svg') || node.querySelector('svg') !== null)),
      )
      if (addedSvg) apply()
    })
    observer.observe(body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [label, showTable])

  if (isEmpty) {
    return (
      <EmptyState
        icon="sparkle"
        title={emptyTitle ?? 'Sem dados no período'}
        body={emptyBody}
        action={emptyAction}
      />
    )
  }

  return (
    <div className="chart">
      {(legend && legend.length > 1) || table ? (
        <div className="row row--between row--wrap" style={{ gap: 'var(--sp-3)' }}>
          {legend && legend.length > 1 ? (
            <div className="chart__legend">
              {legend.map((entry) => (
                <span key={entry.label} className="chart__legend-item">
                  <span
                    className={`chart__legend-key${entry.shape === 'block' ? ' chart__legend-key--block' : entry.shape === 'dash' ? ' chart__legend-key--dash' : ''}`}
                    style={entry.shape === 'dash' ? { color: entry.color } : { background: entry.color }}
                  />
                  {entry.label}
                </span>
              ))}
            </div>
          ) : (
            <span />
          )}
          {table && (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => setShowTable((v) => !v)}
              aria-pressed={showTable}
            >
              <Icon name="list" size={13} />
              {showTable ? 'Ver gráfico' : 'Ver tabela'}
            </button>
          )}
        </div>
      ) : null}

      <div className="chart__body" ref={bodyRef}>
        {showTable && table ? (
          <div className="scroll-x" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="table">
              {table.caption && <caption className="sr-only">{table.caption}</caption>}
              <thead>
                <tr>
                  {table.columns.map((column) => (
                    <th
                      key={column.header}
                      scope="col"
                      style={column.align === 'right' ? { textAlign: 'right' } : undefined}
                    >
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, index) => (
                  <tr key={index}>
                    {table.columns.map((column) => (
                      <td
                        key={column.header}
                        className={column.align === 'right' ? 'table__num' : undefined}
                      >
                        {column.value(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>

      {note && <p className="chart__note">{note}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Shared tooltip. Recharts hands us its payload shape loosely typed;
 * this narrows it once so no chart has to.
 * ------------------------------------------------------------------ */
export type TooltipRow = { label: string; value: string; color?: string }

export function ChartTooltip({ title, rows }: { title: string; rows: TooltipRow[] }) {
  return (
    <div className="tooltip">
      <div className="tooltip__title">{title}</div>
      {rows.map((row) => (
        <div key={row.label} className="tooltip__row">
          <span className="row" style={{ gap: 6 }}>
            {row.color && <span className="dot" style={{ background: row.color, width: 7, height: 7 }} />}
            {row.label}
          </span>
          <span className="tooltip__value">{row.value}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Recharts wants a component for `content`; this adapter lets each chart
 * declare only how to turn a payload into rows.
 */
export function makeTooltip<TPayload = Record<string, unknown>>(
  render: (payload: TPayload, label: string) => { title: string; rows: TooltipRow[] } | null,
) {
  return function Tooltip(props: { active?: boolean; payload?: Array<{ payload: TPayload }>; label?: unknown }) {
    if (!props.active || !props.payload || props.payload.length === 0) return null
    const first = props.payload[0]
    if (!first) return null
    const result = render(first.payload, String(props.label ?? ''))
    if (!result) return null
    return <ChartTooltip title={result.title} rows={result.rows} />
  }
}

/** A 2px ring in the surface colour keeps overlapping dots legible. */
export const surfaceRing = (theme: ChartTheme) => ({
  stroke: theme.surface,
  strokeWidth: 2,
})
