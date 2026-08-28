import { ResponsiveContainer, Tooltip, Treemap } from 'recharts'
import type { TreemapNode } from 'recharts/types/chart/Treemap'
import { money, date as fmtDate } from '../../lib/format'
import { intensityScale, intensityStep, themeFor, type ChartTheme, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'

export type DayPoint = { day: string; expenseCents: number; transactionCount: number }

type TreemapDatum = { name: string; value: number; day: string; transactionCount: number }

/**
 * Magnitude by AREA, not just colour — a treemap instead of the calendar
 * grid this replaced. A day twice as expensive draws a rectangle twice as
 * big, which reads faster than two shades of the same blue, especially for
 * the small, frequent amounts most days actually have. The trade-off is
 * explicit: this drops the calendar's day-of-week position, which is why
 * the day-of-month still labels every cell big enough to hold it, and the
 * table view (same as before) is the position-preserving fallback.
 * Zero-gasto days carry no area and are left out, same as the table
 * already did.
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

  const nonZero = days.filter((d) => d.expenseCents > 0)
  const max = Math.max(0, ...nonZero.map((d) => d.expenseCents))
  const hasData = max > 0

  const data: TreemapDatum[] = nonZero.map((d) => ({
    name: fmtDate(d.day),
    value: d.expenseCents,
    day: d.day,
    transactionCount: d.transactionCount,
  }))

  const Tip = makeTooltip<TreemapDatum>((point) => ({
    title: point.name,
    rows: [
      { label: 'Gasto', value: money(point.value), color: intensityStep(theme, point.value, max) },
      { label: 'Lançamentos', value: String(point.transactionCount) },
    ],
  }))

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Nenhum gasto registrado"
      emptyBody="Cada retângulo é um dia, do tamanho do quanto foi gasto. Comece com um lançamento rápido ou importe um extrato."
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
      <ResponsiveContainer width="100%" height={280}>
        <Treemap
          data={data}
          dataKey="value"
          nameKey="name"
          aspectRatio={4 / 3}
          isAnimationActive={false}
          stroke={theme.surface}
          content={(props) => (
            <DayCell
              {...(props as unknown as TreemapNode & TreemapDatum)}
              theme={theme}
              max={max}
              isToday={(props as unknown as TreemapDatum).day === today}
              onSelectDay={onSelectDay}
            />
          )}
        >
          <Tooltip content={<Tip />} />
        </Treemap>
      </ResponsiveContainer>

      <div className="heatmap__scale">
        <span>menos</span>
        {intensityScale(theme).map((step, index) => (
          <span key={index} className="heatmap__scale-step" style={{ background: step }} />
        ))}
        <span>mais</span>
      </div>
    </ChartFrame>
  )
}

/** One rectangle. Recharts hands raw x/y/width/height in the container's own SVG units, plus whatever fields `data` carried. */
function DayCell(
  props: TreemapNode &
    TreemapDatum & {
      theme: ChartTheme
      max: number
      isToday: boolean
      onSelectDay?: (day: string) => void
    },
) {
  const { x, y, width, height, value, day, transactionCount, theme, max, isToday, onSelectDay } = props
  // Recharts calls `content` for every node in the computed tree, starting
  // with the synthetic root that wraps the whole chart area — it has none
  // of `data`'s own fields (no `day`), only x/y/width/height. Only the
  // leaves (one per day) are real content to draw.
  if (width <= 0 || height <= 0 || !day) return null

  const fill = intensityStep(theme, value, max)
  const dayNumber = day.slice(8, 10).replace(/^0/, '')
  const canLabelDay = width >= 20 && height >= 16
  const canLabelValue = width >= 52 && height >= 34

  return (
    <g
      onClick={() => onSelectDay?.(day)}
      style={{ cursor: onSelectDay ? 'pointer' : 'default' }}
      aria-label={`${fmtDate(day)}: ${money(value)}, ${transactionCount} lançamento(s)`}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={fill}
        stroke={theme.surface}
        strokeWidth={2}
        rx={3}
      />
      {isToday && (
        <rect
          x={x + 1.5}
          y={y + 1.5}
          width={Math.max(0, width - 3)}
          height={Math.max(0, height - 3)}
          fill="none"
          stroke={theme.primary}
          strokeWidth={2}
          rx={2}
        />
      )}
      {canLabelDay && (
        <text
          x={x + 6}
          y={y + 16}
          fontSize={11}
          fontWeight={600}
          fill={theme.axisText}
          style={{ pointerEvents: 'none' }}
        >
          {dayNumber}
        </text>
      )}
      {canLabelValue && (
        <text
          x={x + 6}
          y={y + height - 8}
          fontSize={11}
          fill={theme.axisText}
          style={{ pointerEvents: 'none' }}
        >
          {money(value)}
        </text>
      )}
    </g>
  )
}
