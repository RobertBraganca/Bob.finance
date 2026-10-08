import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, money, period as fmtPeriod } from '../../lib/format'
import { MARK, axisProps, gridProps, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'

type Point = { period: string; revenueCents: number; withdrawalsCents: number; personalSpentCents: number }

/**
 * 12 meses da empresa: o faturamento oscila (barras), e as retiradas e os
 * gastos pessoais (linhas) mostram se o que sai da PJ acompanha o que a vida
 * pessoal pede. Só observado, sem projeção.
 */
export function CompanySeriesChart({ points, surface = 'paper', height = 260 }: { points: Point[]; surface?: Surface; height?: number }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const withdrawalsColor = theme.series[0]!
  const spentColor = theme.expense
  const Tip = makeTooltip<Point>((p) => ({
    title: fmtPeriod(p.period),
    rows: [
      { label: 'Faturamento', value: money(p.revenueCents), color: theme.neutral },
      { label: 'Retiradas', value: money(p.withdrawalsCents), color: withdrawalsColor },
      { label: 'Gastos pessoais', value: money(p.personalSpentCents), color: spentColor },
    ],
  }))
  return (
    <ChartFrame
      legend={[
        { label: 'Faturamento', color: theme.neutral, shape: 'block' },
        { label: 'Retiradas', color: withdrawalsColor, shape: 'line' },
        { label: 'Gastos pessoais', color: spentColor, shape: 'dash' },
      ]}
      isEmpty={points.every((p) => p.revenueCents === 0 && p.withdrawalsCents === 0)}
      emptyTitle="Sem movimento na PJ"
      emptyBody="Com o extrato da conta da empresa, os 12 meses aparecem aqui."
      table={{
        caption: 'Faturamento, retiradas e gastos pessoais por mês',
        rows: points,
        columns: [
          { header: 'Mês', value: (r) => fmtPeriod(r.period) },
          { header: 'Faturamento', value: (r) => money(r.revenueCents), align: 'right' },
          { header: 'Retiradas', value: (r) => money(r.withdrawalsCents), align: 'right' },
          { header: 'Gastos pessoais', value: (r) => money(r.personalSpentCents), align: 'right' },
        ],
      }}
      note="Retiradas: o que saiu da PJ para as suas contas pessoais. Gastos pessoais: os do Orçamento, sem as TAGs fora do orçamento."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <ComposedChart data={points} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={fmtPeriod} minTickGap={24} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={52} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          <Bar dataKey="revenueCents" fill={theme.neutral} maxBarSize={MARK.barMaxWidth} radius={MARK.barRadius} isAnimationActive={false} />
          <Line type="monotone" dataKey="withdrawalsCents" stroke={withdrawalsColor} strokeWidth={MARK.lineWidth} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="personalSpentCents" stroke={spentColor} strokeDasharray="5 4" strokeWidth={MARK.lineWidth} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
