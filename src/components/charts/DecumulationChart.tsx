import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis } from 'recharts'
import { money, period as fmtPeriod } from '../../lib/format'
import { themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../ui/chart'

export type DecumulationPoint = { month: number; period: string; valueCents: number }

const chartConfig = {
  valueCents: { label: 'Patrimônio projetado' },
} satisfies ChartConfig

/**
 * Trajetória do patrimônio sob uma retirada mensal que o USUÁRIO propôs
 * (`decisions/0035`: o sistema nunca calcula a retirada, só mostra a
 * consequência da que foi informada). Mesmo Area Chart - Gradient das
 * demais séries do produto; o mês de esgotamento vira uma `ReferenceLine`
 * tracejada, nunca uma cor de veredito no gráfico inteiro — esgotar numa
 * data é um fato calculado, não uma nota de erro.
 */
export function DecumulationChart({
  series,
  depletionPeriod,
  surface = 'paper',
  height = 240,
}: {
  series: DecumulationPoint[]
  depletionPeriod: string | null
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const gradientId = `decumulation-area-${surface}`

  return (
    <ChartContainer config={chartConfig} className="aspect-auto w-full" style={{ height }}>
      <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
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
          minTickGap={40}
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
                  <span className="text-muted-foreground">Patrimônio</span>
                  <span className="font-mono font-medium tabular-nums">{money(Number(value))}</span>
                </div>
              )}
            />
          }
        />
        {depletionPeriod !== null && (
          <ReferenceLine
            x={depletionPeriod}
            stroke={theme.status.critical}
            strokeDasharray="4 4"
            label={{
              value: 'esgota aqui',
              position: 'insideTopRight',
              fill: theme.status.critical,
              fontSize: 11,
            }}
          />
        )}
        <Area
          dataKey="valueCents"
          type="natural"
          fill={`url(#${gradientId})`}
          fillOpacity={0.4}
          stroke={theme.primary}
        />
      </AreaChart>
    </ChartContainer>
  )
}
