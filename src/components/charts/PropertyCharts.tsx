import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, money } from '../../lib/format'
import { MARK, axisProps, gridProps, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'
import type { BalancePoint, PlanPoint } from '@shared/propertyPlan'

/**
 * Gráficos do plano de imóvel. Os pontos chegam afinados por `thinSeries`
 * (mês a mês até 3 anos, depois um por ano).
 */
function stepLabel(points: Array<{ month: number }>) {
  const yearly = (points.at(-1)?.month ?? 0) > 36
  return (month: number) => (month === 0 ? 'hoje' : yearly && month % 12 === 0 ? `ano ${month / 12}` : `mês ${month}`)
}

/**
 * Até a compra: o dinheiro juntado sobe e o necessário também (o imóvel
 * valoriza). A série termina no mês da compra, então o cruzamento é a
 * ponta direita do gráfico; não precisa de marca própria.
 */
export function AccumulationChart({
  points,
  surface = 'paper',
  height = 260,
}: {
  points: PlanPoint[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const label = stepLabel(points)
  const Tip = makeTooltip<PlanPoint>((p) => ({
    title: label(p.month),
    rows: [
      { label: 'Juntado', value: money(p.savedCents), color: theme.status.good },
      { label: 'Necessário', value: money(p.needCents), color: theme.axisText },
    ],
  }))
  return (
    <ChartFrame
      legend={[
        { label: 'Juntado', color: theme.status.good, shape: 'line' },
        { label: 'Necessário', color: theme.axisText, shape: 'dash' },
      ]}
      isEmpty={points.length < 2}
      emptyTitle="Compra possível agora"
      emptyBody="O dinheiro separado já cobre entrada, custos e reserva."
      table={{
        caption: 'Dinheiro juntado e necessário até a compra',
        rows: points,
        columns: [
          { header: 'Período', value: (row) => label(row.month) },
          { header: 'Juntado', value: (row) => money(row.savedCents), align: 'right' },
          { header: 'Necessário', value: (row) => money(row.needCents), align: 'right' },
        ],
      }}
      note="Taxas constantes: rendimento do dinheiro e valorização do imóvel. Uma referência, não uma previsão."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <LineChart data={points} margin={{ top: 16, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="month" tickFormatter={label} minTickGap={28} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={52} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ stroke: theme.axis, strokeWidth: 1 }} />
          <Line type="monotone" dataKey="needCents" stroke={theme.axisText} strokeDasharray="5 4" strokeWidth={MARK.lineWidth} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="savedCents" stroke={theme.status.good} strokeWidth={MARK.lineWidth} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/** Depois da compra: o saldo devedor no SAC (cai em linha reta) e no Price (cai devagar no começo). */
export function DebtBalanceChart({ points, surface = 'paper', height = 260 }: { points: BalancePoint[]; surface?: Surface; height?: number }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const label = (month: number) => (month === 0 ? 'compra' : `ano ${Math.round(month / 12)}`)
  const sacColor = theme.series[0]!
  const priceColor = theme.series[1] ?? theme.neutral
  const Tip = makeTooltip<BalancePoint>((p) => ({
    title: label(p.month),
    rows: [
      { label: 'SAC', value: money(p.sacCents), color: sacColor },
      { label: 'Price', value: money(p.priceCents), color: priceColor },
    ],
  }))
  return (
    <ChartFrame
      legend={[
        { label: 'SAC', color: sacColor, shape: 'line' },
        { label: 'Price', color: priceColor, shape: 'line' },
      ]}
      isEmpty={points.length < 2}
      emptyTitle="Sem financiamento"
      emptyBody="Com entrada de 100%, não há saldo devedor."
      table={{
        caption: 'Saldo devedor depois da compra',
        rows: points,
        columns: [
          { header: 'Período', value: (row) => label(row.month) },
          { header: 'SAC', value: (row) => money(row.sacCents), align: 'right' },
          { header: 'Price', value: (row) => money(row.priceCents), align: 'right' },
        ],
      }}
      note="Taxa constante, sem correção do saldo por TR ou IPCA."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <LineChart data={points} margin={{ top: 16, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="month" tickFormatter={label} minTickGap={28} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={52} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ stroke: theme.axis, strokeWidth: 1 }} />
          <Line type="monotone" dataKey="priceCents" stroke={priceColor} strokeWidth={MARK.lineWidth} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="sacCents" stroke={sacColor} strokeWidth={MARK.lineWidth} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
