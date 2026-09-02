import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Rectangle,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { axisMoney, bps, money, period as fmtPeriod, signedPoints } from '../../lib/format'
import {
  MARK,
  axisProps,
  gridProps,
  seriesColor,
  themeFor,
  type ChartTheme,
  type Surface,
} from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, ChartTooltip, makeTooltip, surfaceRing } from './frame'
import { CategoryRing } from './CategoryRing'

/* ================================================================== *
 * Portfolio value vs contributed capital.
 * Both are reais, so ONE axis — the gap between the lines IS the gain,
 * which is exactly what the reader is here to see.
 * ================================================================== */
export type PerformancePoint = {
  period: string
  contributedCents: number
  valueCents: number
  gainCents: number
}

export function PortfolioPerformanceChart({
  data,
  surface = 'paper',
  height = 250,
}: {
  data: PerformancePoint[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = data.some((d) => d.valueCents > 0 || d.contributedCents > 0)

  const Tip = makeTooltip<PerformancePoint>((point) => ({
    title: fmtPeriod(point.period),
    rows: [
      { label: 'Valor de mercado', value: money(point.valueCents), color: theme.series[0]! },
      { label: 'Capital aportado', value: money(point.contributedCents), color: theme.neutral },
      { label: 'Ganho', value: money(point.gainCents) },
    ],
  }))

  return (
    <ChartFrame
      legend={[
        { label: 'Valor de mercado', color: theme.series[0]! },
        { label: 'Capital aportado', color: theme.neutral },
      ]}
      isEmpty={!hasData}
      emptyTitle="Nenhuma posição registrada"
      emptyBody="Cadastre ativos e aportes para acompanhar o valor da carteira contra o capital investido."
      table={{
        caption: 'Valor da carteira contra capital aportado',
        rows: data,
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(row.period) },
          { header: 'Aportado', value: (row) => money(row.contributedCents), align: 'right' },
          { header: 'Valor', value: (row) => money(row.valueCents), align: 'right' },
          { header: 'Ganho', value: (row) => money(row.gainCents), align: 'right' },
        ],
      }}
      note="A distância entre as duas linhas é o ganho real: o que a carteira rendeu além do que foi depositado."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <LineChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={fmtPeriod} minTickGap={36} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={48} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ stroke: theme.axis, strokeWidth: 1 }} />
          <Line
            type="monotone"
            dataKey="contributedCents"
            stroke={theme.neutral}
            strokeWidth={MARK.lineWidth}
            dot={false}
            activeDot={{ r: MARK.activeDotRadius, ...surfaceRing(theme) }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="valueCents"
            stroke={theme.series[0]}
            strokeWidth={MARK.lineWidth}
            dot={false}
            activeDot={{ r: MARK.activeDotRadius, ...surfaceRing(theme) }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/* ================================================================== *
 * Allocation: actual share vs target share, per asset class.
 * Horizontal bars because the category names are long, with a target
 * tick on each row. One unit (% of portfolio), one axis.
 * ================================================================== */
export type AllocationSlice = {
  assetClass: string
  label: string
  valueCents: number
  actualBps: number
  targetBps: number | null
  driftBps: number | null
  rebalanceCents: number | null
}

/**
 * One row: the real allocation as a bar, the configured target as a tick on
 * THAT row, and the gap between them as text.
 *
 * The target used to be a `<ReferenceLine x>`, which spans the full plot
 * height — with seven classes that drew seven vertical lines across every
 * bar, and nothing said which line belonged to which class. A mark that
 * describes one row has to be drawn inside that row.
 *
 * The tick position comes from `background`, the full-width band recharts
 * hands the shape for this row, so it is exact even when the actual
 * allocation is 0% and the bar has no width to measure from.
 */
type AllocationRowProps = {
  x: number
  y: number
  width: number
  height: number
  payload: AllocationSlice
  background?: { x: number; width: number }
}

function AllocationRow({ x, y, width, height, payload, background, theme }: AllocationRowProps & { theme: ChartTheme }) {
  const target = payload.targetBps
  const trackX = background?.x ?? x
  const trackWidth = background?.width ?? width
  const targetX = target === null ? null : trackX + (trackWidth * target) / 10_000
  const tickOverhang = 3

  return (
    <g>
      <Rectangle x={x} y={y} width={width} height={height} fill={theme.series[0]} radius={MARK.barRadiusH} />
      {targetX !== null && (
        <rect
          x={targetX - 1}
          y={y - tickOverhang}
          width={2}
          height={height + tickOverhang * 2}
          fill={theme.axisText}
        />
      )}
      {payload.driftBps !== null && (
        <text
          x={trackX + trackWidth + 6}
          y={y + height / 2}
          dominantBaseline="middle"
          textAnchor="start"
          fill={theme.axisText}
          fontSize={10}
          /* Neutral on purpose: the number states the distance from the
             user's own policy, it does not grade it. See decisions/0010. */
        >
          {signedPoints(payload.driftBps, 1)}
        </text>
      )}
    </g>
  )
}

export function AllocationChart({
  slices,
  surface = 'paper',
}: {
  slices: AllocationSlice[]
  surface?: Surface
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = slices.some((s) => s.valueCents > 0 || (s.targetBps ?? 0) > 0)
  const height = Math.max(140, slices.length * 38 + 40)

  const AllocTip = makeTooltip<AllocationSlice>((slice) => ({
    title: slice.label,
    rows: [
      { label: 'Valor', value: money(slice.valueCents), color: theme.series[0]! },
      { label: 'Atual', value: bps(slice.actualBps) },
      { label: 'Meta', value: slice.targetBps === null ? '-' : bps(slice.targetBps) },
      {
        // A gap between two percentages is measured in points, not in %.
        label: 'Desvio',
        value: slice.driftBps === null ? '-' : signedPoints(slice.driftBps),
      },
    ],
  }))

  return (
    <ChartFrame
      legend={[
        { label: 'Alocação atual', color: theme.series[0]!, shape: 'block' },
        { label: 'Meta', color: theme.axisText },
      ]}
      isEmpty={!hasData}
      emptyTitle="Sem alocação para comparar"
      emptyBody="Cadastre ativos e defina uma alocação-alvo por classe para ver o desvio."
      table={{
        caption: 'Alocação atual contra a meta',
        rows: slices,
        columns: [
          { header: 'Classe', value: (row) => row.label },
          { header: 'Valor', value: (row) => money(row.valueCents), align: 'right' },
          { header: 'Atual', value: (row) => bps(row.actualBps), align: 'right' },
          { header: 'Meta', value: (row) => (row.targetBps === null ? '-' : bps(row.targetBps)), align: 'right' },
          {
            header: 'Ajuste',
            value: (row) =>
              row.rebalanceCents === null
                ? '-'
                : `${row.rebalanceCents > 0 ? '+' : ''}${money(row.rebalanceCents)}`,
            align: 'right',
          },
        ],
      }}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <BarChart
          data={slices}
          layout="vertical"
          margin={{ top: 6, right: 56, bottom: 4, left: 4 }}
        >
          <CartesianGrid {...gridProps(theme)} vertical horizontal={false} />
          <XAxis
            type="number"
            domain={[0, 10_000]}
            tickFormatter={(v: number) => `${Math.round(v / 100)}%`}
            {...axisProps(theme)}
          />
          <YAxis type="category" dataKey="label" width={124} {...axisProps(theme)} />
          <Tooltip content={<AllocTip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          {/* Bar, target tick and drift all drawn per row — see AllocationRow. */}
          <Bar
            dataKey="actualBps"
            maxBarSize={MARK.barMaxWidth}
            background={{ fill: 'transparent' }}
            shape={(props: unknown) => <AllocationRow {...(props as AllocationRowProps)} theme={theme} />}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/* ================================================================== *
 * Carteira atual x carteira objetivo — mesmo dado do AllocationChart
 * acima (actualBps/targetBps por classe), uma segunda leitura visual em
 * barra dupla lado a lado em vez de barra + marca. Não é um cálculo novo,
 * ver `specs/investments`, "Aba Lançamentos e gráficos de carteira objetivo".
 * ================================================================== */
export function AllocationVsTargetChart({
  slices,
  surface = 'paper',
}: {
  slices: AllocationSlice[]
  surface?: Surface
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = slices.some((s) => s.valueCents > 0 || (s.targetBps ?? 0) > 0)

  const Tip = makeTooltip<AllocationSlice>((slice) => ({
    title: slice.label,
    rows: [
      { label: 'Carteira atual', value: bps(slice.actualBps), color: theme.series[0]! },
      {
        label: 'Carteira objetivo',
        value: slice.targetBps === null ? 'sem meta configurada' : bps(slice.targetBps),
        color: theme.series[1]!,
      },
    ],
  }))

  return (
    <ChartFrame
      legend={[
        { label: 'Carteira atual', color: theme.series[0]!, shape: 'block' },
        { label: 'Carteira objetivo', color: theme.series[1]!, shape: 'block' },
      ]}
      isEmpty={!hasData}
      emptyTitle="Sem alocação para comparar"
      emptyBody="Cadastre ativos e defina uma política de alocação por classe para ver as duas carteiras lado a lado."
      table={{
        caption: 'Carteira atual contra carteira objetivo, por classe',
        rows: slices,
        columns: [
          { header: 'Classe', value: (row) => row.label },
          { header: 'Atual', value: (row) => bps(row.actualBps), align: 'right' },
          { header: 'Objetivo', value: (row) => (row.targetBps === null ? '-' : bps(row.targetBps)), align: 'right' },
        ],
      }}
      note="Mesmo número do card 'Alocação por classe', uma segunda leitura visual, lado a lado por classe."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={280}>
        <BarChart data={slices} margin={{ top: 12, right: 12, bottom: 24, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="label" interval={0} angle={-20} textAnchor="end" height={56} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => `${Math.round(v / 100)}%`} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          <Bar dataKey="actualBps" fill={theme.series[0]} maxBarSize={MARK.barMaxWidth} radius={MARK.barRadius} />
          <Bar dataKey="targetBps" fill={theme.series[1]} maxBarSize={MARK.barMaxWidth} radius={MARK.barRadius} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/* ================================================================== *
 * Evolução do Patrimônio — stacked bar: capital aplicado (base) +
 * ganho de capital (stacked on top). Same "gap is the story" idea as
 * PortfolioPerformanceChart, in bar form for a period-by-period read
 * instead of a running line. Aplicado stays neutral (a fact, not a
 * signal); ganho takes the app's own gain colour, same hue the "pos"
 * utility class and every Delta already use for a positive result.
 * ================================================================== */
type SignedBarProps = {
  x: number
  y: number
  width: number
  height: number
  payload: PerformancePoint
}

/**
 * The gain segment, coloured and rounded by its sign. A single `radius`
 * number would round all four corners, which is wrong where the segment
 * meets the capital below it; the rounded edge belongs only on the far side
 * of the zero line, and that side flips when the month closes at a loss.
 */
function SignedGainBar({ x, y, width, height, payload, theme }: SignedBarProps & { theme: ChartTheme }) {
  const negative = payload.gainCents < 0
  return (
    <Rectangle
      x={x}
      y={y}
      width={width}
      height={height}
      fill={negative ? theme.status.critical : theme.status.good}
      radius={negative ? MARK.barRadiusDown : MARK.barRadius}
    />
  )
}

export function PortfolioEvolutionChart({
  data,
  surface = 'paper',
  height = 260,
}: {
  data: PerformancePoint[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = data.some((d) => d.valueCents > 0 || d.contributedCents > 0)
  // A month closing below what was put in is a real state of this portfolio,
  // not an edge case: it drives both the colour of the segment and whether
  // the legend needs to explain a second one.
  const hasLoss = data.some((d) => d.gainCents < 0)

  const Tip = makeTooltip<PerformancePoint>((point) => ({
    title: fmtPeriod(point.period),
    rows: [
      { label: 'Valor aplicado', value: money(point.contributedCents), color: theme.neutral },
      {
        label: point.gainCents < 0 ? 'Perda de capital' : 'Ganho de capital',
        value: money(point.gainCents),
        color: point.gainCents < 0 ? theme.status.critical : theme.status.good,
      },
      { label: 'Valor total', value: money(point.valueCents) },
    ],
  }))

  return (
    <ChartFrame
      legend={[
        { label: 'Valor aplicado', color: theme.neutral, shape: 'block' },
        { label: 'Ganho de capital', color: theme.status.good, shape: 'block' },
        ...(hasLoss ? [{ label: 'Perda de capital', color: theme.status.critical, shape: 'block' as const }] : []),
      ]}
      isEmpty={!hasData}
      emptyTitle="Nenhuma posição registrada"
      emptyBody="Cadastre ativos e aportes para acompanhar a evolução do patrimônio."
      table={{
        caption: 'Evolução do patrimônio',
        rows: data,
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(row.period) },
          { header: 'Aplicado', value: (row) => money(row.contributedCents), align: 'right' },
          { header: 'Ganho', value: (row) => money(row.gainCents), align: 'right' },
          { header: 'Total', value: (row) => money(row.valueCents), align: 'right' },
        ],
      }}
    >
      {/*
        Stacked BY SIGN. `stackOffset="sign"` is what makes a losing month
        readable: the capital stays above the zero line and the loss hangs
        below it, instead of being silently netted out of the stack the way a
        plain stacked bar does. 12 of the 24 months in this ledger close
        below what was put in, so this is the normal case here, not a
        defensive branch.
      */}
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <BarChart data={data} stackOffset="sign" margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={fmtPeriod} minTickGap={36} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={48} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          {/* The baseline the signs are read against. */}
          <ReferenceLine y={0} stroke={theme.axis} strokeWidth={1} />
          <Bar dataKey="contributedCents" stackId="patrimonio" fill={theme.neutral} maxBarSize={MARK.barMaxWidth} />
          <Bar
            dataKey="gainCents"
            stackId="patrimonio"
            maxBarSize={MARK.barMaxWidth}
            shape={(props: unknown) => <SignedGainBar {...(props as SignedBarProps)} theme={theme} />}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/* ================================================================== *
 * Ativos na Carteira — composition at a glance. Reuses the exact
 * CategoryRing pattern built for spending categories: a donut is only
 * honest for part-to-whole, so it always ships with the ranked list of
 * exact values, and the tail folds into "Outras" past 4 segments.
 * ================================================================== */
export function AssetClassRing({
  slices,
  surface = 'paper',
  height = 220,
}: {
  slices: AllocationSlice[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const mapped = slices
    .filter((s) => s.valueCents > 0)
    .map((s) => ({
      categoryId: null,
      name: s.label,
      color: seriesColor(theme, s.assetClass),
      amountCents: s.valueCents,
      shareBps: s.actualBps,
      transactionCount: 0,
    }))

  /* Padding angle + rounded ends, the recharts "pie with gap and rounded
     corners" shape. Only this ring asks for it: the dashboard's category
     rings routinely carry a sub-1% slice, and a 5° gap with rounded caps
     eats a segment that thin. Here the smallest class is still legible. */
  return (
    <CategoryRing
      slices={mapped}
      surface={surface}
      totalLabel="Patrimônio"
      height={height}
      paddingAngle={5}
      cornerRadius={6}
    />
  )
}

/* ================================================================== *
 * Goal projection — planned contributions compounding to a target.
 * ================================================================== */
export type GoalProjectionPoint = {
  month: number
  period: string
  baselineCents: number
  projectedCents: number
  contributedCents: number
}

export function GoalProjectionChart({
  data,
  targetCents,
  surface = 'paper',
  height = 240,
}: {
  data: GoalProjectionPoint[]
  targetCents: number
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = data.length > 1

  const Tip = makeTooltip<GoalProjectionPoint>((point) => ({
    title: `${fmtPeriod(point.period)} · mês ${point.month}`,
    rows: [
      { label: 'Projetado', value: money(point.projectedCents), color: theme.series[0]! },
      { label: 'Sem novos aportes', value: money(point.baselineCents), color: theme.neutral },
      { label: 'Total aportado', value: money(point.contributedCents) },
    ],
  }))

  return (
    <ChartFrame
      legend={[
        { label: 'Com aportes planejados', color: theme.series[0]! },
        { label: 'Sem novos aportes', color: theme.neutral },
      ]}
      isEmpty={!hasData}
      emptyTitle="Configure a meta"
      emptyBody="Defina valor-alvo, data e aporte mensal para ver a trajetória projetada."
      table={{
        caption: 'Projeção da meta',
        rows: data.filter((_, i) => i % 6 === 0),
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(row.period) },
          { header: 'Aportado', value: (row) => money(row.contributedCents), align: 'right' },
          { header: 'Projetado', value: (row) => money(row.projectedCents), align: 'right' },
        ],
      }}
      note="Projeção determinística com retorno esperado constante: uma referência de planejamento, não uma previsão de mercado."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <LineChart data={data} margin={{ top: 16, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={fmtPeriod} minTickGap={44} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={48} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ stroke: theme.axis, strokeWidth: 1 }} />
          {targetCents > 0 && (
            <ReferenceLine
              y={targetCents}
              stroke={theme.status.good}
              strokeWidth={1.5}
              label={{
                value: `meta ${axisMoney(targetCents)}`,
                position: 'insideTopLeft',
                fill: theme.axisText,
                fontSize: 11,
              }}
            />
          )}
          <Line
            type="monotone"
            dataKey="baselineCents"
            stroke={theme.neutral}
            strokeWidth={MARK.lineWidth}
            dot={false}
            activeDot={{ r: MARK.activeDotRadius, ...surfaceRing(theme) }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="projectedCents"
            stroke={theme.series[0]}
            strokeWidth={MARK.lineWidth}
            dot={false}
            activeDot={{ r: MARK.activeDotRadius, ...surfaceRing(theme) }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
