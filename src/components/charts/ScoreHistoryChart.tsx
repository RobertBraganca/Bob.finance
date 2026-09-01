import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { bps, period as fmtPeriod } from '../../lib/format'
import { axisProps, gridProps, MARK, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'

export type ScorePoint = { period: string; scoreBps: number | null }

const Tip = makeTooltip<ScorePoint>((point) => ({
  title: fmtPeriod(point.period),
  rows: [{ label: 'Health Score', value: point.scoreBps === null ? 'sem dado' : bps(point.scoreBps, 0) }],
}))

/**
 * Série histórica do Health Score — nunca persistida, cada ponto é uma
 * chamada de `healthScore(period)` recomputada (estudo de viabilidade #3,
 * 29/08/2026). Um mês sem dado (`scoreBps: null`) vira um buraco na linha
 * (`connectNulls={false}`), nunca um zero — zero seria "nota péssima",
 * null é "sem indicador suficiente naquele mês", leituras opostas.
 */
export function ScoreHistoryChart({ points, surface = 'paper' }: { points: ScorePoint[]; surface?: Surface }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = points.some((p) => p.scoreBps !== null)

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
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={(p: string) => fmtPeriod(p)} {...axisProps(theme)} />
          <YAxis
            domain={[0, 10_000]}
            tickFormatter={(v: number) => bps(v, 0)}
            width={48}
            {...axisProps(theme)}
          />
          <Tooltip content={<Tip />} />
          <Line
            dataKey="scoreBps"
            stroke={theme.primary}
            strokeWidth={MARK.lineWidth}
            dot={{ r: MARK.dotRadius, fill: theme.primary, ...surfaceRingFor(theme) }}
            activeDot={{ r: MARK.activeDotRadius }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

function surfaceRingFor(theme: ReturnType<typeof themeFor>) {
  return { stroke: theme.surface, strokeWidth: 2 }
}
