import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { axisMoney, bps, money, monthsLabel, period as fmtPeriod } from '../../lib/format'
import { MARK, axisProps, gridProps, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip, surfaceRing } from './frame'
import { Icon } from '../ui/Icon'

/* ================================================================== *
 * Paydown projection — two scenarios, same unit, ONE axis.
 * ================================================================== */
export type ProjectionPoint = {
  month: number
  period: string
  baselineCents: number | null
  acceleratedCents: number | null
}

export function DebtProjectionChart({
  data,
  surface = 'paper',
  height = 260,
  extraMonthlyCents,
  strategy = 'avalanche',
}: {
  data: ProjectionPoint[]
  surface?: Surface
  height?: number
  /** a nota diz para qual dívida vai o extra; antes dizia sempre "avalanche" */
  strategy?: 'avalanche' | 'snowball'
  extraMonthlyCents: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = data.some((d) => (d.baselineCents ?? 0) > 0)
  const accelerated = extraMonthlyCents > 0

  const Tip = makeTooltip<ProjectionPoint>((point) => {
    const rows = [
      {
        label: 'Pagamento atual',
        value: point.baselineCents === null ? 'quitado' : money(point.baselineCents),
        color: accelerated ? theme.neutral : theme.series[0]!,
      },
    ]
    if (accelerated) {
      rows.push({
        label: 'Com aporte extra',
        value: point.acceleratedCents === null ? 'quitado' : money(point.acceleratedCents),
        color: theme.series[0]!,
      })
    }
    return { title: `${fmtPeriod(point.period)} · mês ${point.month}`, rows }
  })

  return (
    <ChartFrame
      legend={
        accelerated
          ? [
              { label: 'Pagamento atual', color: theme.neutral },
              { label: 'Com aporte extra', color: theme.series[0]! },
            ]
          : [{ label: 'Pagamento atual', color: theme.series[0]! }]
      }
      isEmpty={!hasData}
      emptyTitle="Nenhuma dívida cadastrada"
      emptyBody="Cadastre cartões, empréstimos ou financiamentos para projetar a trajetória até a quitação."
      table={{
        caption: 'Saldo projetado por mês',
        rows: data.filter((_, i) => i % 3 === 0),
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(row.period) },
          {
            header: 'Pagamento atual',
            value: (row) => (row.baselineCents === null ? '-' : money(row.baselineCents)),
            align: 'right',
          },
          {
            header: 'Com aporte extra',
            value: (row) => (row.acceleratedCents === null ? '-' : money(row.acceleratedCents)),
            align: 'right',
          },
        ],
      }}
      note={`Projeção com juros compostos sobre o saldo, pagamentos programados e o extra direcionado ${strategy === 'snowball' ? 'à dívida de menor saldo (bola de neve)' : 'à dívida mais cara (avalanche)'}.`}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <LineChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis
            dataKey="period"
            tickFormatter={fmtPeriod}
            interval="preserveStartEnd"
            minTickGap={44}
            {...axisProps(theme)}
          />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={48} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ stroke: theme.axis, strokeWidth: 1 }} />
          {/* Emphasis: when there is an extra contribution, the baseline
              recedes to the de-emphasis grey and the scenario carries the hue. */}
          <Line
            type="monotone"
            dataKey="baselineCents"
            stroke={accelerated ? theme.neutral : theme.series[0]}
            strokeWidth={MARK.lineWidth}
            dot={false}
            activeDot={{ r: MARK.activeDotRadius, ...surfaceRing(theme) }}
            connectNulls={false}
            isAnimationActive={false}
          />
          {accelerated && (
            <Line
              type="monotone"
              dataKey="acceleratedCents"
              stroke={theme.series[0]}
              strokeWidth={MARK.lineWidth}
              dot={false}
              activeDot={{ r: MARK.activeDotRadius, ...surfaceRing(theme) }}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/* ================================================================== *
 * Debt-service gauge — one ratio against a limit, so an ARC METER.
 * The unfilled track is a lighter step of the same ramp; severity comes
 * from the status palette and always ships with an icon and a label.
 * ================================================================== */
export type GaugeBand = {
  /** limite superior da faixa, em bps; a primeira faixa que couber vence */
  maxBps: number
  label: string
  tone: 'good' | 'warning' | 'serious' | 'critical'
}

const DTI_BANDS: GaugeBand[] = [
  { maxBps: 2000, label: 'Saudável', tone: 'good' },
  { maxBps: 3600, label: 'Atenção', tone: 'warning' },
  { maxBps: 5000, label: 'Comprometido', tone: 'serious' },
  { maxBps: Infinity, label: 'Crítico', tone: 'critical' },
]

/**
 * Uso de limite de cartão. Os cortes são os mesmos de `capUsageState`
 * (`components/ui`), para o arco e qualquer badge do mesmo número nunca
 * discordarem — um teto é sobre não passar, então aqui MAIOR é pior.
 */
export const CARD_USAGE_BANDS: GaugeBand[] = [
  { maxBps: 8000, label: 'Com folga', tone: 'good' },
  { maxBps: 10_000, label: 'Apertado', tone: 'warning' },
  { maxBps: Infinity, label: 'Estourado', tone: 'critical' },
]

export function DebtServiceGauge({
  ratioBps,
  surface = 'slab',
  caption,
  bands = DTI_BANDS,
  emptyTitle = 'Sem renda para comparar',
  emptyBody = 'Importe extratos com entradas para calcular o comprometimento da renda.',
}: {
  ratioBps: number | null
  surface?: Surface
  caption?: string
  /** Faixas de cor e rótulo; o default é comprometimento de renda. */
  bands?: GaugeBand[]
  emptyTitle?: string
  emptyBody?: string
}) {
  const theme = themeFor(useEffectiveSurface(surface))

  if (ratioBps === null) {
    return (
      <div className="empty" style={{ minHeight: 150 }}>
        <span className="empty__title">{emptyTitle}</span>
        <p className="empty__body">{emptyBody}</p>
      </div>
    )
  }

  const band = bands.find((b) => ratioBps <= b.maxBps)!
  const fill = theme.status[band.tone]
  const clamped = Math.max(0, Math.min(1, ratioBps / 10_000))

  // 240-degree arc, opening at the bottom.
  const size = 168
  const stroke = 14
  const radius = (size - stroke) / 2
  const startAngle = 150
  const sweep = 240
  const cx = size / 2
  const cy = size / 2

  const point = (angle: number) => {
    const rad = (angle * Math.PI) / 180
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) }
  }

  const arcPath = (fromAngle: number, toAngle: number) => {
    const from = point(fromAngle)
    const to = point(toAngle)
    const large = Math.abs(toAngle - fromAngle) > 180 ? 1 : 0
    return `M ${from.x} ${from.y} A ${radius} ${radius} 0 ${large} 1 ${to.x} ${to.y}`
  }

  const endAngle = startAngle + sweep * clamped

  return (
    <div className="stack" style={{ alignItems: 'center', gap: 'var(--sp-2)' }}>
      <div style={{ position: 'relative', width: size, height: size * 0.82 }}>
        <svg width={size} height={size} style={{ overflow: 'visible' }}>
          {/* Track: a lighter step of the same ramp, so state reads across
              the whole arc rather than only where it is filled. */}
          <path
            d={arcPath(startAngle, startAngle + sweep)}
            fill="none"
            stroke={theme.sequential[1]}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
          {clamped > 0.001 && (
            <path
              d={arcPath(startAngle, endAngle)}
              fill="none"
              stroke={fill}
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          )}
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            paddingTop: 6,
          }}
        >
          <div>
            <div className="numeral" style={{ fontSize: 'var(--text-xl)' }}>
              {bps(ratioBps)}
            </div>
            <div className="row" style={{ gap: 4, justifyContent: 'center', marginTop: 2 }}>
              <span style={{ color: fill, display: 'grid', placeItems: 'center' }}>
                <Icon
                  name={band.tone === 'good' ? 'check' : band.tone === 'critical' ? 'x' : 'alert'}
                  size={12}
                  strokeWidth={2.4}
                />
              </span>
              <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>{band.label}</span>
            </div>
          </div>
        </div>
      </div>
      {caption && (
        <p className="chart__note" style={{ textAlign: 'center', maxWidth: '30ch' }}>
          {caption}
        </p>
      )}
    </div>
  )
}

export function PayoffSummary({
  months,
  interestCents,
  monthsSaved,
  interestSavedCents,
  payoffPeriod,
}: {
  months: number | null
  interestCents: number
  monthsSaved: number | null
  interestSavedCents: number
  /** o mês em que a última dívida acaba (YYYY-MM) */
  payoffPeriod?: string | null
}) {
  return (
    <div className="kv">
      <span className="kv__k">Tempo até quitar</span>
      <span className="kv__v">{monthsLabel(months)}</span>
      {payoffPeriod && (
        <>
          <span className="kv__k">Livre das dívidas em</span>
          <span className="kv__v">{fmtPeriodLongLocal(payoffPeriod)}</span>
        </>
      )}
      <span className="kv__k">Juros totais no caminho</span>
      <span className="kv__v">{money(interestCents)}</span>
      {monthsSaved !== null && monthsSaved > 0 && (
        <>
          <span className="kv__k">Meses economizados</span>
          <span className="kv__v pos">{monthsSaved}</span>
        </>
      )}
      {interestSavedCents > 0 && (
        <>
          <span className="kv__k">Juros economizados</span>
          <span className="kv__v pos">{money(interestSavedCents)}</span>
        </>
      )}
    </div>
  )
}

const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
/** "2028-03" → "março de 2028" (sem depender do formatador da página). */
function fmtPeriodLongLocal(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  return `${MONTHS_LONG[m - 1] ?? ''} de ${y}`
}

/* ================================================================== *
 * Calendário de saída (specs/debt-v2): 6 meses, barras empilhadas por
 * origem (cada dívida e cada cartão), com a renda típica na tabela.
 * ================================================================== */
export type ExitMonth = {
  period: string
  debtCents: number
  cardCents: number
  totalCents: number
  incomeShareBps: number | null
  bySource: Record<string, number>
  ends: string[]
}

export function ExitCalendarChart({
  months,
  sources,
  incomeCents,
  surface = 'paper',
  height = 260,
}: {
  months: ExitMonth[]
  sources: Array<{ key: string; label: string; kind: 'debt' | 'card' }>
  incomeCents: number
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const used = sources.filter((s) => months.some((m) => (m.bySource[s.key] ?? 0) > 0))
  const colorOf = (i: number) => theme.series[i % theme.series.length]!
  const rows = months.map((m) => ({ ...m, ...Object.fromEntries(used.map((s) => [s.key, m.bySource[s.key] ?? 0])) }))
  const Tip = makeTooltip<(typeof rows)[number]>((m) => ({
    title: fmtPeriod(m.period),
    rows: [
      ...used.filter((s) => (m.bySource[s.key] ?? 0) > 0).map((s) => ({ label: s.label, value: money(m.bySource[s.key] ?? 0), color: colorOf(used.indexOf(s)) })),
      { label: 'Total', value: money(m.totalCents) },
      { label: 'Da renda típica', value: m.incomeShareBps === null ? '-' : bps(m.incomeShareBps, 0) },
    ],
  }))
  return (
    <ChartFrame
      legend={used.map((s, i) => ({ label: s.label, color: colorOf(i), shape: 'block' as const }))}
      isEmpty={used.length === 0}
      emptyTitle="Nada a pagar nos próximos meses"
      emptyBody="Sem parcelas de dívida nem fatura de cartão ligado nos próximos 6 meses."
      table={{
        caption: 'Calendário de saída, mês a mês',
        rows: months,
        columns: [
          { header: 'Mês', value: (m) => fmtPeriod(m.period) + (m.ends.length ? ` (termina: ${m.ends.join(', ')})` : '') },
          { header: 'Dívidas', value: (m) => money(m.debtCents), align: 'right' },
          { header: 'Cartões', value: (m) => money(m.cardCents), align: 'right' },
          { header: 'Total', value: (m) => money(m.totalCents), align: 'right' },
          { header: incomeCents > 0 ? `de ${money(incomeCents)}` : 'Da renda', value: (m) => (m.incomeShareBps === null ? '-' : bps(m.incomeShareBps, 0)), align: 'right' },
        ],
      }}
      note="Dívidas pelo cronograma; cartões ligados ao Open Finance pela fatura aberta e pelas parcelas já lançadas. Compras novas no cartão ainda não aparecem."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <BarChart data={rows} margin={{ top: 16, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={(v: string) => fmtPeriod(v)} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={52} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          {used.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="out"
              fill={colorOf(i)}
              maxBarSize={MARK.barMaxWidth * 2}
              radius={i === used.length - 1 ? MARK.barRadius : undefined}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
