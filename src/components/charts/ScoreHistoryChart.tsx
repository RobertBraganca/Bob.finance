import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts'
import { bps, period as fmtPeriod } from '../../lib/format'
import { themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame } from './frame'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../ui/chart'

export type ScorePoint = { period: string; scoreBps: number | null }

const chartConfig = {
  scoreBps: { label: 'Health Score' },
} satisfies ChartConfig

/**
 * Mesmo padrão do `SpendAreaChart` de `Daily.tsx` (Area Chart - Gradient,
 * shadcn/ui), a pedido do usuário (31/08/2026), pra toda série temporal de
 * uma cor só ler como a mesma família visual no app inteiro.
 *
 * Série histórica do Health Score — nunca persistida, cada ponto é uma
 * chamada de `healthScore(period)` recomputada (estudo de viabilidade #3,
 * 29/08/2026). Um mês sem dado (`scoreBps: null`) vira um buraco na área
 * (`connectNulls={false}`), nunca um zero — zero seria "nota péssima", null
 * é "sem indicador suficiente naquele mês", leituras opostas.
 */
export function ScoreHistoryChart({
  points,
  surface = 'paper',
  height = 220,
}: {
  points: ScorePoint[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = points.some((p) => p.scoreBps !== null)
  const gradientId = `score-history-area-${surface}`

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Sem histórico ainda"
      emptyBody="O Health Score aparece aqui assim que houver pelo menos um mês com indicador suficiente."
      table={{
        caption: 'Health Score por mês',
        rows: points,
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(row.period) },
          { header: 'Score', value: (row) => (row.scoreBps === null ? '-' : bps(row.scoreBps, 0)), align: 'right' },
        ],
      }}
    >
      <ChartContainer config={chartConfig} className="aspect-auto w-full chart__plot" style={{ minHeight: height }}>
        <AreaChart data={points} margin={{ left: 12, right: 12 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={theme.primary} stopOpacity={0.8} />
              <stop offset="95%" stopColor={theme.primary} stopOpacity={0.1} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={theme.grid} />
          <XAxis
            dataKey="period"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tick={{ fill: theme.axisText, fontSize: 11 }}
            tickFormatter={(value: string) => fmtPeriod(value)}
          />
          <ChartTooltip
            cursor={{ stroke: theme.axis, strokeWidth: 1 }}
            content={
              <ChartTooltipContent
                labelFormatter={(value) => fmtPeriod(String(value))}
                formatter={(value) => (
                  <div className="flex flex-1 items-center justify-between gap-4">
                    <span className="text-muted-foreground">Health Score</span>
                    <span className="font-mono font-medium tabular-nums">
                      {value === null ? 'sem dado' : bps(Number(value), 0)}
                    </span>
                  </div>
                )}
              />
            }
          />
          <Area
            dataKey="scoreBps"
            type="natural"
            fill={`url(#${gradientId})`}
            fillOpacity={0.4}
            stroke={theme.primary}
            connectNulls={false}
          />
        </AreaChart>
      </ChartContainer>
    </ChartFrame>
  )
}
