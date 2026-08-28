import { useState } from 'react'
import { money, date as fmtDate, weekdayLabel, weekdayOf } from '../../lib/format'
import { heatmapScale, heatmapStep, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame } from './frame'

export type DayPoint = { day: string; expenseCents: number; transactionCount: number }

type Cell = DayPoint | null

/**
 * A calendar grid, one square per day of the month — dom-sáb across, one
 * row per week, exactly the shape a physical calendar has. A day with no
 * spend is flat neutral gray, never confusable with "a little"; every day
 * that DID spend sits on the same blue sequential ramp the rest of the app
 * uses for a neutral "more data" quantity (`heatmapStep`, `lib/chartTheme`).
 *
 * Replaces an area-sized treemap (rectangles scaled to the day's amount)
 * that traded away the calendar's day-of-week position for a magnitude
 * that read as "confusing, no contrast" in practice — a uniform grid of
 * colour is the more legible trade for this data (a handful of distinct
 * amounts, not a continuous range worth spending pixels on).
 */
export function SpendHeatmap({
  days,
  surface = 'slab',
  today,
  onSelectDay,
}: {
  days: DayPoint[]
  surface?: Surface
  today?: string
  onSelectDay?: (day: string) => void
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  // Hover shows it live; click/focus PINS it, so a tap on touch (no hover
  // at all) or a keyboard tab-through both land on the same readout.
  const [active, setActive] = useState<DayPoint | null>(null)

  const max = Math.max(0, ...days.map((d) => d.expenseCents))
  const hasData = days.length > 0

  // Pad to a whole number of weeks: blank cells before day 1 so the first
  // real day lands in its true weekday column, and after the last day so
  // every row is a full 7-wide week (an incomplete last row would read as
  // missing data instead of "the month just ended here").
  const leadingBlanks = days.length > 0 ? weekdayOf(days[0]!.day) : 0
  const cells: Cell[] = [...Array(leadingBlanks).fill(null), ...days]
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Nenhum gasto registrado"
      emptyBody="Cada quadrado é um dia, mais escuro quanto mais foi gasto. Comece com um lançamento rápido ou importe um extrato."
      table={{
        caption: 'Gasto por dia',
        rows: days.filter((d) => d.expenseCents > 0),
        columns: [
          { header: 'Dia', value: (row) => fmtDate(row.day) },
          { header: 'Lançamentos', value: (row) => row.transactionCount, align: 'right' },
          { header: 'Gasto', value: (row) => money(row.expenseCents), align: 'right' },
        ],
      }}
    >
      <div className="heatmap__detail">
        {active ? (
          <>
            <strong>{fmtDate(active.day)}</strong> — {money(active.expenseCents)}
            <span className="muted"> · {active.transactionCount} lançamento(s)</span>
          </>
        ) : (
          <span className="muted">Passe o mouse ou toque em um dia para ver o valor gasto</span>
        )}
      </div>

      <div className="heatmap__grid">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} className="heatmap__weekday">
            {weekdayLabel(i)}
          </span>
        ))}
        {cells.map((cell, index) => {
          if (!cell) return <span key={index} className="heatmap__cell heatmap__cell--empty" aria-hidden="true" />
          const isToday = cell.day === today
          return (
            <button
              key={cell.day}
              type="button"
              className="heatmap__cell"
              style={{
                background: heatmapStep(theme, cell.expenseCents, max),
                cursor: onSelectDay ? 'pointer' : 'default',
                boxShadow: isToday ? `inset 0 0 0 2px ${theme.primary}` : undefined,
              }}
              aria-label={`${fmtDate(cell.day)}: ${money(cell.expenseCents)}, ${cell.transactionCount} lançamento(s)`}
              onMouseEnter={() => setActive(cell)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(cell)}
              onBlur={() => setActive(null)}
              onClick={() => {
                setActive(cell)
                onSelectDay?.(cell.day)
              }}
            />
          )
        })}
      </div>

      <div className="heatmap__scale">
        <span>menos</span>
        {heatmapScale(theme).map((step, index) => (
          <span key={index} className="heatmap__scale-step" style={{ background: step }} />
        ))}
        <span>mais</span>
      </div>
    </ChartFrame>
  )
}
