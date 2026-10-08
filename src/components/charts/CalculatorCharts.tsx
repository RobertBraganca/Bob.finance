import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, money } from '../../lib/format'
import { MARK, axisProps, gridProps, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'
import type { GrowthPoint, IncomePoint } from '@shared/calculators'

/**
 * Gráficos das Calculadoras de Investimentos. Os pontos já chegam afinados
 * por `chartPoints` (mês a mês até 3 anos, depois um por ano), então o rótulo
 * do eixo diz "mês" ou "ano" conforme o passo.
 */
function stepLabel(points: Array<{ month: number }>) {
  const yearly = (points.at(-1)?.month ?? 0) > 36
  return (month: number) => (yearly ? (month % 12 === 0 ? `ano ${month / 12}` : `mês ${month}`) : `mês ${month}`)
}

/** Acumulação: o que foi investido (neutro) com os juros por cima (verde), e a linha do alvo, se houver. */
export function GrowthChart({
  points,
  targetCents,
  surface = 'paper',
  height = 280,
}: {
  points: GrowthPoint[]
  targetCents?: number | null
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const label = stepLabel(points)
  const Tip = makeTooltip<GrowthPoint>((p) => ({
    title: label(p.month),
    rows: [
      { label: 'Investido', value: money(p.investedCents), color: theme.neutral },
      { label: 'Juros', value: money(p.interestCents), color: theme.status.good },
      { label: 'Total', value: money(p.valueCents) },
    ],
  }))

  return (
    <ChartFrame
      legend={[
        { label: 'Investido', color: theme.neutral, shape: 'block' },
        { label: 'Juros', color: theme.status.good, shape: 'block' },
      ]}
      isEmpty={points.length < 2}
      emptyTitle="Preencha os campos"
      emptyBody="Com valor, taxa e prazo, a evolução aparece aqui."
      table={{
        caption: 'Evolução do valor acumulado',
        rows: points,
        columns: [
          { header: 'Período', value: (row) => label(row.month) },
          { header: 'Investido', value: (row) => money(row.investedCents), align: 'right' },
          { header: 'Juros', value: (row) => money(row.interestCents), align: 'right' },
          { header: 'Total', value: (row) => money(row.valueCents), align: 'right' },
        ],
      }}
      note="Simulação com taxa constante e aporte no fim de cada mês: uma referência, não uma previsão de rentabilidade."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <BarChart data={points} margin={{ top: 16, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="month" tickFormatter={label} minTickGap={28} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={52} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          {targetCents ? (
            <ReferenceLine
              y={targetCents}
              stroke={theme.axisText}
              strokeDasharray="5 4"
              label={{ value: `alvo ${money(targetCents)}`, position: 'insideTopLeft', fill: theme.axisText, fontSize: 11 }}
            />
          ) : null}
          <Bar dataKey="investedCents" stackId="v" fill={theme.neutral} maxBarSize={MARK.barMaxWidth} isAnimationActive={false} />
          <Bar dataKey="interestCents" stackId="v" fill={theme.status.good} maxBarSize={MARK.barMaxWidth} radius={MARK.barRadius} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/** Renda: o saldo mês a mês sob a retirada informada. */
export function BalanceChart({ points, surface = 'paper', height = 280 }: { points: IncomePoint[]; surface?: Surface; height?: number }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const label = stepLabel(points)
  const Tip = makeTooltip<IncomePoint>((p) => ({
    title: label(p.month),
    rows: [
      { label: 'Saldo', value: money(p.balanceCents), color: theme.series[0]! },
      { label: 'Retirado até aqui', value: money(p.withdrawnCents) },
      { label: 'Juros até aqui', value: money(p.interestCents) },
    ],
  }))

  return (
    <ChartFrame
      isEmpty={points.length < 2}
      emptyTitle="Preencha os campos"
      emptyBody="Com valor, retirada, taxa e prazo, o saldo mês a mês aparece aqui."
      table={{
        caption: 'Saldo sob a retirada mensal',
        rows: points,
        columns: [
          { header: 'Período', value: (row) => label(row.month) },
          { header: 'Saldo', value: (row) => money(row.balanceCents), align: 'right' },
          { header: 'Retirado', value: (row) => money(row.withdrawnCents), align: 'right' },
          { header: 'Juros', value: (row) => money(row.interestCents), align: 'right' },
        ],
      }}
      note="Simulação com taxa constante e retirada no fim de cada mês: uma referência, não uma previsão de rentabilidade."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <AreaChart data={points} margin={{ top: 16, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="month" tickFormatter={label} minTickGap={28} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={52} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ stroke: theme.axis, strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="balanceCents"
            stroke={theme.series[0]}
            fill={theme.series[0]}
            fillOpacity={0.14}
            strokeWidth={MARK.lineWidth}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
