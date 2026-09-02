import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { axisMoney, money, period as fmtPeriod, dateShort as fmtDateShort } from '../../lib/format'
import { MARK, axisProps, gridProps, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'

export type MonthlyPoint = {
  period: string
  incomeCents: number
  expenseCents: number
  netCents: number
}

/**
 * Two distinct series, so this is a grouped column chart with CATEGORICAL
 * colour — slots 1 and 2 (blue/orange). Deliberately not green/red: those
 * are reserved status hues and are the worst possible pair for
 * colour-vision deficiency.
 *
 * Both series are reais on one axis. There is no second y-axis anywhere in
 * this app.
 */
export function IncomeExpenseChart({
  data,
  surface = 'paper',
  height = 260,
  granularity = 'month',
}: {
  data: MonthlyPoint[]
  surface?: Surface
  height?: number
  /** 'day' when the selected period is short enough that a bar per day beats one bar for the whole month. */
  granularity?: 'month' | 'day'
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = data.some((d) => d.incomeCents > 0 || d.expenseCents > 0)
  const lastPeriod = data[data.length - 1]?.period
  const fmtAxis = granularity === 'day' ? fmtDateShort : fmtPeriod

  const Tip = makeTooltip<MonthlyPoint>((point) => ({
    title: fmtAxis(point.period),
    rows: [
      { label: 'Entradas', value: money(point.incomeCents), color: theme.income },
      { label: 'Saídas', value: money(point.expenseCents), color: theme.expense },
      { label: 'Resultado', value: money(point.netCents) },
    ],
  }))

  return (
    <ChartFrame
      legend={[
        { label: 'Entradas', color: theme.income, shape: 'block' },
        { label: 'Saídas', color: theme.expense, shape: 'block' },
      ]}
      isEmpty={!hasData}
      emptyTitle="Nenhum lançamento no período"
      emptyBody="Importe um extrato em CSV para ver entradas e saídas mês a mês."
      table={{
        caption: granularity === 'day' ? 'Entradas e saídas por dia' : 'Entradas e saídas por mês',
        rows: data,
        columns: [
          { header: granularity === 'day' ? 'Dia' : 'Mês', value: (row) => fmtAxis(row.period) },
          { header: 'Entradas', value: (row) => money(row.incomeCents), align: 'right' },
          { header: 'Saídas', value: (row) => money(row.expenseCents), align: 'right' },
          { header: 'Resultado', value: (row) => money(row.netCents), align: 'right' },
        ],
      }}
      note="Transferências entre contas próprias e pagamentos de fatura ficam fora dos dois lados, para não contar o mesmo gasto duas vezes."
    >
      {/* Height includes the x-axis band, so the axis labels are never
          clipped into a nested scrollbar. */}
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <BarChart data={data} margin={{ top: 18, right: 8, bottom: 4, left: 0 }} barGap={MARK.surfaceGap}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={fmtAxis} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={46} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          <Bar
            dataKey="incomeCents"
            name="Entradas"
            fill={theme.income}
            maxBarSize={MARK.barMaxWidth}
            radius={MARK.barRadius}
          />
          <Bar
            dataKey="expenseCents"
            name="Saídas"
            fill={theme.expense}
            maxBarSize={MARK.barMaxWidth}
            radius={MARK.barRadius}
          >
            {/* Label only the newest column: a value on every bar is noise. */}
            <LabelList
              dataKey="expenseCents"
              position="top"
              offset={8}
              content={(props: { x?: number | string; y?: number | string; width?: number | string; index?: number }) => {
                const index = props.index ?? -1
                const point = data[index]
                if (!point || point.period !== lastPeriod || point.expenseCents === 0) return null
                const x = Number(props.x ?? 0) + Number(props.width ?? 0) / 2
                const y = Number(props.y ?? 0) - 7
                return (
                  <text
                    x={x}
                    y={y}
                    textAnchor="middle"
                    fill={theme.axisText}
                    fontSize={11}
                    fontWeight={600}
                  >
                    {axisMoney(point.expenseCents)}
                  </text>
                )
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
