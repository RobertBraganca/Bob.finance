import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, money, period as fmtPeriod } from '../../lib/format'
import { axisProps, gridProps, MARK, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip, surfaceRing } from './frame'

export type NetWorthPoint = { period: string; netWorthCents: number; source?: 'foto' | 'reconstruído' }

/** Variação de um mês para o seguinte; sem base positiva (patrimônio zerado ou negativo) a porcentagem não diz nada. */
function change(prev: number, curr: number): number | null {
  return prev > 0 ? (curr - prev) / prev : null
}

export type NetWorthGrowth = {
  /** o último mês contra o anterior */
  lastMonth: number | null
  /** média mensal composta da janela: (último ÷ primeiro)^(1/meses) − 1 */
  monthlyAverage: number | null
  /** a janela inteira, do primeiro ao último ponto */
  total: number | null
  months: number
  /** meses que cresceram, dos que dá para comparar */
  upMonths: number
  comparable: number
}

/**
 * Quanto o patrimônio cresce por mês. A média é composta, não aritmética:
 * +10% e depois −10% não é "média 0%", é perder 1%. Só entra na conta o
 * trecho em que o patrimônio é positivo nas pontas.
 */
export function netWorthGrowth(points: NetWorthPoint[]): NetWorthGrowth {
  const changes = points.slice(1).map((p, i) => change(points[i]!.netWorthCents, p.netWorthCents))
  const comparable = changes.filter((c): c is number => c !== null)
  const first = points[0]
  const last = points.at(-1)
  const months = points.length - 1
  const total = first && last && months > 0 ? change(first.netWorthCents, last.netWorthCents) : null
  const monthlyAverage = total !== null && last!.netWorthCents > 0 ? Math.pow(1 + total, 1 / months) - 1 : null
  return {
    lastMonth: changes.at(-1) ?? null,
    monthlyAverage,
    total,
    months,
    upMonths: comparable.filter((c) => c > 0).length,
    comparable: comparable.length,
  }
}

export const fmtGrowth = (value: number | null, digits = 1) =>
  value === null ? '-' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value * 100).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`

type Row = NetWorthPoint & { growth: number | null }

const Tip = makeTooltip<Row>((point) => ({
  title: fmtPeriod(point.period),
  rows: [
    { label: 'Patrimônio', value: money(point.netWorthCents) },
    { label: 'No mês', value: fmtGrowth(point.growth) },
    ...(point.source ? [{ label: 'Origem', value: point.source === 'foto' ? 'foto do mês' : 'reconstruído' }] : []),
  ],
}))

/**
 * Série histórica de patrimônio líquido — nunca persistida, cada ponto
 * reconstitui saldo, investimentos e dívida naquela data (estudo de
 * viabilidade #8, 29/08/2026), o mesmo cálculo de "Patrimônio consolidado",
 * só que no passado em vez de hoje. Cada ponto mostra também quanto o mês
 * cresceu sobre o anterior.
 */
export function NetWorthHistoryChart({ points, surface = 'paper' }: { points: NetWorthPoint[]; surface?: Surface }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = points.length > 0
  const rows: Row[] = points.map((p, i) => ({ ...p, growth: i === 0 ? null : change(points[i - 1]!.netWorthCents, p.netWorthCents) }))

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Sem histórico ainda"
      emptyBody="O patrimônio líquido aparece aqui assim que houver pelo menos um mês de dados."
      table={{
        caption: 'Patrimônio líquido por mês',
        rows,
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(row.period) },
          { header: 'Patrimônio líquido', value: (row) => money(row.netWorthCents), align: 'right' },
          { header: 'No mês', value: (row) => fmtGrowth(row.growth), align: 'right' },
        ],
      }}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={200}>
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
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
