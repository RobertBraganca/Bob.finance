import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { date, dateShort } from '../../lib/format'
import { axisProps, gridProps, MARK, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip, surfaceRing } from './frame'

export type BasketChartPoint = { tripId: number; purchasedOn: string; index: number | null; matched: number; total: number }

const fmtIndex = (v: number | null) => (v === null ? '-' : v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }))

/**
 * Índice da cesta de mercado (docs/specs/lista-de-compras): a primeira compra
 * vale 100 e cada compra seguinte mostra quanto custariam hoje as mesmas
 * quantidades daquela primeira. Só o preço move a linha; levar mais ou menos
 * não. A linha de 100 é a referência.
 */
export function BasketIndexChart({ points, surface = 'paper' }: { points: BasketChartPoint[]; surface?: Surface }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const rows = points.filter((p) => p.index !== null)
  const Tip = makeTooltip<BasketChartPoint>((p) => ({
    title: date(p.purchasedOn),
    rows: [
      { label: 'Índice', value: fmtIndex(p.index) },
      { label: 'Produtos comparados', value: `${p.matched} de ${p.total}` },
    ],
  }))

  return (
    <ChartFrame
      isEmpty={rows.length < 2}
      emptyTitle="Precisa de duas compras"
      emptyBody="O índice compara cada compra com a primeira. Ele aparece a partir da segunda compra concluída com preços."
      table={{
        caption: 'Índice da cesta por compra (primeira compra = 100)',
        rows,
        columns: [
          { header: 'Compra', value: (r) => date(r.purchasedOn) },
          { header: 'Índice', value: (r) => fmtIndex(r.index), align: 'right' },
          { header: 'Produtos comparados', value: (r) => `${r.matched} de ${r.total}`, align: 'right' },
        ],
      }}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={200}>
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="purchasedOn" tickFormatter={(d: string) => dateShort(d)} {...axisProps(theme)} />
          <YAxis domain={['auto', 'auto']} tickFormatter={(v: number) => fmtIndex(v)} width={44} {...axisProps(theme)} />
          <ReferenceLine y={100} stroke={theme.neutral} strokeDasharray="4 4" />
          <Tooltip content={<Tip />} />
          <Line
            dataKey="index"
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
