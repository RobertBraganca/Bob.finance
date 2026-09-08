import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, date as fmtDate, money } from '../../lib/format'
import { axisProps, gridProps, MARK, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip, surfaceRing } from './frame'

export type DebtTrendPoint = { asOf: string; balanceCents: number }

const Tip = makeTooltip<DebtTrendPoint>((point) => ({
  title: fmtDate(point.asOf),
  rows: [{ label: 'Saldo total', value: money(point.balanceCents) }],
}))

/**
 * Item 1 do backlog de 07/09/2026: saldo total medido ao longo do tempo,
 * mesmo padrão visual de `NetWorthHistoryChart` (mesma forma de problema
 * -- uma série de valor por data), só trocando período por data exata,
 * porque `debt_snapshots` grava por dia, não por mês.
 *
 * Um ponto por data em que ALGUMA dívida teve o saldo medido
 * (`debt.ts#debtTrend`) -- registrar saldo manualmente ou pagar/usar uma
 * parcela (agora que ambos gravam snapshot, ver `recordPaymentSnapshot`)
 * são as duas fontes.
 */
export function DebtHistoryChart({ points, surface = 'paper' }: { points: DebtTrendPoint[]; surface?: Surface }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = points.length > 1

  /**
   * Eixo de TEMPO de verdade, não categórico — bug corrigido em 07/09/2026.
   * `NetWorthHistoryChart` usa `dataKey="period"` (um mês, sempre, mesmo
   * espaçamento por construção) e este componente copiou o mesmo padrão
   * categórico pra uma série de datas EXATAS de snapshot, que não nasce
   * igualmente espaçada — `debt_snapshots` só ganha uma linha nova em
   * pagamento/uso/registro manual, então dois pontos vizinhos podem estar
   * a 1 dia ou a 2 meses de distância um do outro. Num eixo categórico os
   * dois casos desenham o MESMO espaço na tela, escondendo exatamente o
   * "evolução ao longo dos meses" que este gráfico existe pra mostrar — à
   * medida que os pagamentos mensais forem confirmados nos próximos
   * meses (cada um já grava snapshot, ver `recordPaymentSnapshot`), um
   * eixo categórico continuaria empilhando tudo colado, sem comunicar
   * que o tempo passou.
   */
  const chartData = points.map((p) => ({ ...p, asOfMs: Date.parse(`${p.asOf}T00:00:00Z`) }))

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Ainda sem histórico suficiente"
      emptyBody="A evolução aparece aqui a partir do segundo registro de saldo, pagamento ou uso de alguma dívida."
      table={{
        caption: 'Saldo total de dívidas por data',
        rows: points,
        columns: [
          { header: 'Data', value: (row) => fmtDate(row.asOf) },
          { header: 'Saldo total', value: (row) => money(row.balanceCents), align: 'right' },
        ],
      }}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={200}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis
            dataKey="asOfMs"
            type="number"
            domain={['dataMin', 'dataMax']}
            scale="time"
            tickFormatter={(ms: number) => fmtDate(new Date(ms).toISOString().slice(0, 10))}
            {...axisProps(theme)}
          />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={56} {...axisProps(theme)} />
          <Tooltip content={<Tip />} />
          <Line
            dataKey="balanceCents"
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
