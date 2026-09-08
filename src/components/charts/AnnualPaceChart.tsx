import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, money, MONTHS_SHORT } from '../../lib/format'
import { axisProps, gridProps, MARK, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'

export type AnnualPacePoint = {
  /** Mês do ano, 1-12. */
  monthIndex: number
  /** Gasto do mês corrente. `null` a partir do mês seguinte: ainda não aconteceu. */
  currentCents: number | null
  /** Gasto do mesmo mês no ano passado — já fechou, sempre um número. */
  previousCents: number
}

/**
 * Generalização de 07/09/2026 do Ritmo de gastos pra quando o período do
 * Painel não aponta pra um único mês (3m/6m/12m/ano/máximo) — ver
 * `SpendingPaceChart`. Correção no mesmo dia: a primeira versão comparava
 * o ACUMULADO do ano (uma linha subindo o ano inteiro), mas o pedido era
 * mês a mês contra o mesmo mês do ano passado — duas colunas por mês, não
 * uma linha corrida, porque aqui não existe "acumulado" nenhum: cada mês
 * é seu próprio total, comparado ao mesmo mês do ano anterior.
 */
export function AnnualPaceChart({
  points,
  surface = 'paper',
  currentLabel = 'Este ano',
  previousLabel = 'Ano passado',
}: {
  points: AnnualPacePoint[]
  surface?: Surface
  currentLabel?: string
  previousLabel?: string
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = points.some((p) => (p.currentCents ?? 0) > 0 || p.previousCents > 0)
  const fmtMonth = (value: number) => MONTHS_SHORT[value - 1] ?? String(value)

  const Tip = makeTooltip<AnnualPacePoint>((point) => ({
    title: fmtMonth(point.monthIndex),
    rows: [
      point.currentCents !== null ? { label: currentLabel, value: money(point.currentCents), color: theme.primary } : null,
      { label: previousLabel, value: money(point.previousCents), color: theme.neutral },
    ].filter((r): r is { label: string; value: string; color: string } => r !== null),
  }))

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Sem gasto registrado ainda"
      emptyBody="O ritmo de gastos aparece aqui assim que houver pelo menos uma saída confirmada no ano."
      legend={[
        { label: currentLabel, color: theme.primary, shape: 'block' },
        { label: previousLabel, color: theme.neutral, shape: 'block' },
      ]}
      table={{
        caption: 'Gasto por mês, ano corrente contra o anterior',
        rows: points,
        columns: [
          { header: 'Mês', value: (row) => fmtMonth(row.monthIndex) },
          { header: currentLabel, value: (row) => (row.currentCents === null ? '-' : money(row.currentCents)), align: 'right' },
          { header: previousLabel, value: (row) => money(row.previousCents), align: 'right' },
        ],
      }}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={140}>
        <BarChart data={points} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barGap={MARK.surfaceGap}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="monthIndex" tickFormatter={fmtMonth} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={56} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          <Bar dataKey="previousCents" name={previousLabel} fill={theme.neutral} maxBarSize={MARK.barMaxWidth} radius={MARK.barRadius} />
          <Bar dataKey="currentCents" name={currentLabel} fill={theme.primary} maxBarSize={MARK.barMaxWidth} radius={MARK.barRadius} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
