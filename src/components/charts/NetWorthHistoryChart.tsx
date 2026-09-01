import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, money, period as fmtPeriod } from '../../lib/format'
import { axisProps, gridProps, MARK, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip, surfaceRing } from './frame'

export type NetWorthPoint = { period: string; netWorthCents: number }

const Tip = makeTooltip<NetWorthPoint>((point) => ({
  title: fmtPeriod(point.period),
  rows: [{ label: 'Patrimônio líquido', value: money(point.netWorthCents) }],
}))

/**
 * Série histórica de patrimônio líquido — nunca persistida, cada ponto
 * reconstitui saldo, investimentos e dívida naquela data (estudo de
 * viabilidade #8, 29/08/2026), o mesmo cálculo de "Patrimônio consolidado",
 * só que no passado em vez de hoje.
 */
export function NetWorthHistoryChart({ points, surface = 'paper' }: { points: NetWorthPoint[]; surface?: Surface }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = points.length > 0

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
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={(p: string) => fmtPeriod(p)} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={56} {...axisProps(theme)} />
          <Tooltip content={<Tip />} />
          <Line
            dataKey="netWorthCents"
            stroke={theme.primary}
            strokeWidth={MARK.lineWidth}
            dot={{ r: MARK.dotRadius, fill: theme.primary, ...surfaceRing(theme) }}
            activeDot={{ r: MARK.activeDotRadius }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
