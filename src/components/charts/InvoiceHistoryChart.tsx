import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, money, date as fmtDate } from '../../lib/format'
import { MARK, axisProps, gridProps, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'

export type InvoiceHistoryPoint = { closingOn: string; amountCents: number; transactionCount: number }

/** Uma barra por ciclo de fatura fechado — item 7 do backlog de 07/09/2026. */
export function InvoiceHistoryChart({
  points,
  surface = 'paper',
  height = 220,
}: {
  points: InvoiceHistoryPoint[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = points.length > 0

  const Tip = makeTooltip<InvoiceHistoryPoint>((point) => ({
    title: `Fechada em ${fmtDate(point.closingOn)}`,
    rows: [
      { label: 'Fatura', value: money(point.amountCents), color: theme.expense },
      { label: 'Lançamentos', value: String(point.transactionCount) },
    ],
  }))

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Nenhuma fatura fechada ainda"
      emptyBody="Depois de ligar compras a este cartão, cada ciclo fechado aparece aqui."
      table={{
        caption: 'Faturas fechadas por ciclo',
        rows: points,
        columns: [
          { header: 'Fechamento', value: (row) => fmtDate(row.closingOn) },
          { header: 'Lançamentos', value: (row) => row.transactionCount, align: 'right' },
          { header: 'Fatura', value: (row) => money(row.amountCents), align: 'right' },
        ],
      }}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <BarChart data={points} margin={{ top: 18, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="closingOn" tickFormatter={(v: string) => fmtDate(v)} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={46} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          <Bar
            dataKey="amountCents"
            name="Fatura"
            fill={theme.expense}
            maxBarSize={MARK.barMaxWidth}
            radius={MARK.barRadius}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
