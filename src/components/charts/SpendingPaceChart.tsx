import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, money } from '../../lib/format'
import { axisProps, gridProps, MARK, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, ChartTooltip } from './frame'

export type SpendingPacePoint = {
  dayOfMonth: number
  /** Gasto acumulado do mês corrente até este dia. `null` a partir de amanhã: nada aconteceu ainda, uma linha reta até zero mentiria. */
  currentCents: number | null
  /** Gasto acumulado do mês anterior até este dia — o mês fechou, então a série vai até o fim. */
  previousCents: number | null
}

/**
 * Item 7 do backlog de 07/09/2026: gasto acumulado do mês corrente (linha
 * sólida, só até hoje) contra o mesmo acumulado do mês anterior (linha
 * tracejada, mês inteiro), dia a dia. Mesmo dado de `analytics.ts#dailySeries`
 * que já alimenta o Diário, só que chamado duas vezes (mês atual e
 * anterior) e acumulado no cliente -- nenhuma soma corrida nova no
 * servidor.
 *
 * Tracejado para "mês anterior" segue o mesmo precedente de
 * `ProfitabilityChart.tsx` (benchmark tracejado, carteira sólida): a
 * SITUAÇÃO fixa/comparável fica tracejada, a que está em andamento fica
 * sólida.
 *
 * Só cobre um único mês -- quando o período do Painel não aponta pra um
 * único mês (3m/6m/12m/ano/máximo), `AnnualPaceChart` assume o card
 * (07/09/2026): "dia do mês" não tem período nenhum pra representar ali, e
 * a comparação vira mês a mês contra o ano passado, não mais acumulada.
 */
export function SpendingPaceChart({
  points,
  surface = 'paper',
}: {
  points: SpendingPacePoint[]
  surface?: Surface
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = points.some((p) => p.currentCents !== null || p.previousCents !== null)

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Sem gasto registrado ainda"
      emptyBody="O ritmo de gastos aparece aqui assim que houver pelo menos uma saída confirmada no mês."
      legend={[
        { label: 'Este mês', color: theme.primary, shape: 'line' },
        { label: 'Mês passado', color: theme.neutral, shape: 'line' },
      ]}
      table={{
        caption: 'Gasto acumulado por dia do mês',
        rows: points,
        columns: [
          { header: 'Dia', value: (row) => String(row.dayOfMonth) },
          { header: 'Este mês', value: (row) => (row.currentCents === null ? '-' : money(row.currentCents)), align: 'right' },
          { header: 'Mês passado', value: (row) => (row.previousCents === null ? '-' : money(row.previousCents)), align: 'right' },
        ],
      }}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={200}>
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="dayOfMonth" {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={56} {...axisProps(theme)} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null
              const point = payload[0]?.payload as SpendingPacePoint | undefined
              if (!point) return null
              const rows = [
                point.currentCents !== null ? { label: 'Este mês', value: money(point.currentCents), color: theme.primary } : null,
                point.previousCents !== null ? { label: 'Mês passado', value: money(point.previousCents), color: theme.neutral } : null,
              ].filter((r): r is { label: string; value: string; color: string } => r !== null)
              return <ChartTooltip title={`Dia ${label}`} rows={rows} />
            }}
          />
          <Line
            dataKey="previousCents"
            stroke={theme.neutral}
            strokeWidth={MARK.lineWidth}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="currentCents"
            stroke={theme.primary}
            strokeWidth={MARK.lineWidth}
            dot={false}
            activeDot={{ r: MARK.activeDotRadius }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
