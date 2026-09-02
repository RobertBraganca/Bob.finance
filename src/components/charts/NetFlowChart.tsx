import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { axisMoney, money, period as fmtPeriod } from '../../lib/format'
import { MARK, axisProps, gridProps, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip, surfaceRing } from './frame'

export type NetFlowPoint = { period: string; netCents: number; cumulativeCents: number }

/**
 * One series, so: no legend box (the card title names it), a 2px line with
 * a 10%-opacity wash, and a single direct label at the endpoint. A zero
 * baseline is drawn because the sign is the whole point.
 */
export function NetFlowChart({
  data,
  surface = 'slab',
  height = 190,
  mode = 'cumulative',
}: {
  data: NetFlowPoint[]
  surface?: Surface
  height?: number
  mode?: 'cumulative' | 'monthly'
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const key = mode === 'cumulative' ? 'cumulativeCents' : 'netCents'
  const hasData = data.some((d) => d.netCents !== 0)
  const last = data[data.length - 1]

  const Tip = makeTooltip<NetFlowPoint>((point) => ({
    title: fmtPeriod(point.period),
    rows: [
      { label: 'Resultado do mês', value: money(point.netCents), color: theme.primary },
      { label: 'Acumulado', value: money(point.cumulativeCents) },
    ],
  }))

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Sem fluxo para mostrar"
      emptyBody="O resultado mês a mês aparece aqui depois da primeira importação."
      table={{
        caption: 'Resultado líquido por mês',
        rows: data,
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(row.period) },
          { header: 'Resultado', value: (row) => money(row.netCents), align: 'right' },
          { header: 'Acumulado', value: (row) => money(row.cumulativeCents), align: 'right' },
        ],
      }}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <AreaChart data={data} margin={{ top: 14, right: 46, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id={`netflow-${surface}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.primary} stopOpacity={MARK.areaOpacity * 2.4} />
              <stop offset="100%" stopColor={theme.primary} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={fmtPeriod} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={46} {...axisProps(theme)} />
          <ReferenceLine y={0} stroke={theme.axis} strokeWidth={1} />
          <Tooltip content={<Tip />} cursor={{ stroke: theme.axis, strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey={key}
            stroke={theme.primary}
            strokeWidth={MARK.lineWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill={`url(#netflow-${surface})`}
            dot={false}
            activeDot={{ r: MARK.activeDotRadius, fill: theme.primary, ...surfaceRing(theme) }}
            isAnimationActive={false}
            /* One direct label, at the endpoint. A value on every point
               would be noise and would go unread. */
            label={(props: { x?: number | string; y?: number | string; index?: number }) => {
              if (!last || props.index !== data.length - 1) return <g />
              return (
                <text
                  x={Number(props.x ?? 0) + 8}
                  y={Number(props.y ?? 0) + 4}
                  fill={theme.axisText}
                  fontSize={11}
                  fontWeight={600}
                >
                  {axisMoney(mode === 'cumulative' ? last.cumulativeCents : last.netCents)}
                </text>
              )
            }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
