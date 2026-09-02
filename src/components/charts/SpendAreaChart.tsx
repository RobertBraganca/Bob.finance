import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts'
import { money, dateShort } from '../../lib/format'
import { MARK, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame } from './frame'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../ui/chart'

export type DayPoint = { day: string; expenseCents: number; transactionCount: number }

const chartConfig = {
  expenseCents: { label: 'Gasto' },
} satisfies ChartConfig

/**
 * Area Chart - Gradient (shadcn/ui), a pedido do usuário (29/08/2026) —
 * troca a grade-calendário anterior por uma curva contínua do gasto diário,
 * mesmo modelo do `chart-area-gradient` do registro shadcn, mas em cima do
 * `ChartFrame`/tema de cores já usados por todo gráfico do app (a cor é
 * `theme.expense`, não a `--chart-2` genérica do shadcn) — o card/título
 * continua vindo de fora (`Slab` em `Daily.tsx`), então nada de `Card`/
 * `CardHeader` aqui dentro, que dobraria o cabeçalho.
 */
export function SpendAreaChart({
  days,
  surface = 'slab',
  height = 220,
}: {
  days: DayPoint[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = days.some((d) => d.expenseCents > 0)
  const gradientId = `spend-area-${surface}`

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Nenhum gasto registrado"
      emptyBody="O gasto de cada dia aparece aqui assim que houver lançamentos no período."
      table={{
        caption: 'Gasto por dia',
        rows: days.filter((d) => d.expenseCents > 0),
        columns: [
          { header: 'Dia', value: (row) => dateShort(row.day) },
          { header: 'Lançamentos', value: (row) => row.transactionCount, align: 'right' },
          { header: 'Gasto', value: (row) => money(row.expenseCents), align: 'right' },
        ],
      }}
    >
      <ChartContainer config={chartConfig} className="aspect-auto w-full chart__plot chart__plot--basis" style={{ height }}>
        <AreaChart data={days} margin={{ left: 12, right: 12 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={theme.expense} stopOpacity={0.8} />
              <stop offset="95%" stopColor={theme.expense} stopOpacity={0.1} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={theme.grid} />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tick={{ fill: theme.axisText, fontSize: 11 }}
            tickFormatter={(value: string) => value.slice(8, 10)}
          />
          <ChartTooltip
            cursor={{ stroke: theme.axis, strokeWidth: 1 }}
            content={
              <ChartTooltipContent
                labelFormatter={(value, payload) =>
                  `${dateShort(String(value))} · ${payload[0]?.payload.transactionCount ?? 0} lançamento(s)`
                }
                formatter={(value) => (
                  <div className="flex flex-1 items-center justify-between gap-4">
                    <span className="text-muted-foreground">Gasto</span>
                    <span className="font-mono font-medium tabular-nums">{money(Number(value))}</span>
                  </div>
                )}
              />
            }
          />
          <Area
            dataKey="expenseCents"
            type="natural"
            fill={`url(#${gradientId})`}
            fillOpacity={0.4}
            strokeWidth={MARK.lineWidth}
            /*
              Convencao do app, que estes tres graficos nao seguiam: o
              Recharts anima area por um clipPath que comeca em width 0, e
              quando a animacao nao progride a area fica recortada a zero e
              NAO PINTA - geometria e cor corretas, nada na tela. Foi o que
              segurou o Health Score depois de eu corrigir a altura
              (02/09/2026). Os outros seis arquivos de grafico ja desligam.
            */
            isAnimationActive={false}
            stroke={theme.expense}
          />
        </AreaChart>
      </ChartContainer>
    </ChartFrame>
  )
}
