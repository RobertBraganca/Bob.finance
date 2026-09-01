import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts'
import { money, period as fmtPeriod } from '../../lib/format'
import { themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame } from './frame'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../ui/chart'

export type NetWorthPoint = { period: string; netWorthCents: number }

const chartConfig = {
  netWorthCents: { label: 'Patrimônio líquido' },
} satisfies ChartConfig

/**
 * Mesmo padrão do `SpendAreaChart` de `Daily.tsx` (Area Chart - Gradient,
 * shadcn/ui), a pedido do usuário (31/08/2026), pra toda série temporal de
 * uma cor só ler como a mesma família visual no app inteiro.
 *
 * Série histórica de patrimônio líquido — nunca persistida, cada ponto
 * reconstitui saldo, investimentos e dívida naquela data (estudo de
 * viabilidade #8, 29/08/2026), o mesmo cálculo de "Patrimônio consolidado",
 * só que no passado em vez de hoje.
 */
export function NetWorthHistoryChart({
  points,
  surface = 'paper',
  height = 220,
}: {
  points: NetWorthPoint[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = points.length > 0
  const gradientId = `net-worth-history-area-${surface}`

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Sem histórico ainda"
      emptyBody="O patrimônio líquido aparece aqui assim que houver pelo menos um mês de dados."
      table={{
        caption: 'Patrimônio líquido por mês',
        rows: points,
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(row.period) },
          { header: 'Patrimônio líquido', value: (row) => money(row.netWorthCents), align: 'right' },
        ],
      }}
    >
      <ChartContainer config={chartConfig} className="aspect-auto w-full" style={{ height }}>
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
                    <span className="text-muted-foreground">Patrimônio líquido</span>
                    <span className="font-mono font-medium tabular-nums">{money(Number(value))}</span>
                  </div>
                )}
              />
            }
          />
          <Area
            dataKey="netWorthCents"
            type="natural"
            fill={`url(#${gradientId})`}
            fillOpacity={0.4}
            stroke={theme.primary}
          />
        </AreaChart>
      </ChartContainer>
    </ChartFrame>
  )
}
