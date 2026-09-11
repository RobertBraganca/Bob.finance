import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, money, period as fmtPeriod } from '../../lib/format'
import { axisProps, gridProps, MARK, seriesColor, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'
import { CategoryRing, type Slice } from './CategoryRing'

export type ProventoDistributionSlice = { assetId: number; ticker: string | null; name: string; totalCents: number; shareBps: number }

/**
 * Distribuição de proventos por ativo, últimos 12 meses — mesmo componente
 * de anel usado por "Ativos na carteira" e "Cotações por status": cor por
 * POSIÇÃO da fatia, nunca por hash do nome, pelo mesmo motivo já corrigido
 * em `AssetClassRing` (09/09/2026) — duas fatias reais podem colidir no
 * mesmo índice de hash e pintar a mesma cor.
 */
export function ProventosDistributionRing({
  slices,
  surface = 'paper',
  height = 220,
}: {
  slices: ProventoDistributionSlice[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const mapped: Slice[] = slices
    .filter((s) => s.totalCents > 0)
    .map((s, index) => ({
      categoryId: s.assetId,
      name: s.ticker ?? s.name,
      color: seriesColor(theme, index),
      amountCents: s.totalCents,
      shareBps: s.shareBps,
      transactionCount: 0,
    }))

  return (
    <CategoryRing
      slices={mapped}
      surface={surface}
      totalLabel="Recebido (12 meses)"
      countLabel="Pagamentos"
      height={height}
    />
  )
}

export type ProventoEvolutionPoint = { period: string; paidCents: number; pendingCents: number }

/** "2026-06" (mensal) ou "2026" (anual) — `period()` de `format.ts` só entende o primeiro formato. */
const formatBucket = (bucket: string, granularity: 'monthly' | 'annual') =>
  granularity === 'annual' ? bucket : fmtPeriod(bucket)

/**
 * Evolução de proventos: pago x a receber, lado a lado por período — a
 * única visão desta área que mostra as duas séries juntas, porque é a
 * pergunta que ela responde. Em todo outro card de Proventos, "a receber"
 * fica de fora das somas (nunca finge que já entrou na conta).
 */
export function ProventosEvolutionChart({
  data,
  granularity,
  surface = 'paper',
  height = 260,
}: {
  data: ProventoEvolutionPoint[]
  granularity: 'monthly' | 'annual'
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const pendingColor = theme.series[1]!
  const hasData = data.some((d) => d.paidCents > 0 || d.pendingCents > 0)

  const Tip = makeTooltip<ProventoEvolutionPoint>((point) => ({
    title: formatBucket(point.period, granularity),
    rows: [
      { label: 'Recebidos', value: money(point.paidCents), color: theme.income },
      { label: 'A receber', value: money(point.pendingCents), color: pendingColor },
    ],
  }))

  return (
    <ChartFrame
      legend={[
        { label: 'Proventos recebidos', color: theme.income, shape: 'block' },
        { label: 'Proventos a receber', color: pendingColor, shape: 'block' },
      ]}
      isEmpty={!hasData}
      emptyTitle="Nenhum provento no período"
      emptyBody="Registre um lançamento de provento na aba Lançamentos ou pelo botão desta tela."
      table={{
        rows: data.filter((d) => d.paidCents > 0 || d.pendingCents > 0),
        columns: [
          { header: granularity === 'annual' ? 'Ano' : 'Mês', value: (row) => formatBucket(row.period, granularity) },
          { header: 'Recebidos', value: (row) => money(row.paidCents), align: 'right' },
          { header: 'A receber', value: (row) => money(row.pendingCents), align: 'right' },
        ],
      }}
      note="Recebidos é o que já entrou na conta; a receber é o que foi lançado com data de pagamento futura."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <BarChart data={data} margin={{ top: 18, right: 8, bottom: 4, left: 0 }} barGap={MARK.surfaceGap}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={(v: string) => formatBucket(v, granularity)} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={46} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          <Bar dataKey="paidCents" name="Recebidos" fill={theme.income} radius={MARK.barRadius} />
          <Bar dataKey="pendingCents" name="A receber" fill={pendingColor} radius={MARK.barRadius} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
