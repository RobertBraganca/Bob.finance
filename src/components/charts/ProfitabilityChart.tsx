import { useEffect, useMemo, useState } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { period as fmtPeriod } from '../../lib/format'
import { MARK, axisProps, gridProps, themeFor, type ChartTheme, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'

export type MonthlyReturnPoint = { period: string; returnBps: number | null }

const SERIES_ORDER = ['portfolio', 'CDI', 'IPCA', 'IBOV', 'IFIX', 'SMLL', 'IDIV', 'IVVB11'] as const
type SeriesKey = (typeof SERIES_ORDER)[number]

const seriesColor = (theme: ChartTheme, key: SeriesKey): string => {
  switch (key) {
    case 'portfolio':
      return theme.primary
    case 'CDI':
      return theme.neutral
    case 'IPCA':
      return theme.series[3]! // purple
    case 'IBOV':
      return theme.series[1]! // pink
    case 'IFIX':
      return theme.series[2]! // green
    case 'SMLL':
      return theme.status.warning
    case 'IDIV':
      return theme.status.serious
    case 'IVVB11':
      return theme.status.critical
  }
}

type IndexPoint = { period: string; bandBase?: number; bandOver?: number; bandUnder?: number } & Partial<
  Record<SeriesKey, number>
>

/**
 * Turns monthly % returns into a cumulative index (base 100 on the
 * portfolio's first month), which is what makes lines comparable at a
 * glance — a raw monthly-% chart would just be noise crossing zero. A
 * month with no return on record carries the index flat rather than
 * breaking the line: for the ETF-proxied benchmarks that's the honest
 * state (BRAPI's free plan only ever covers ~3 months back), not a
 * fabricated flat return.
 */
function buildIndexSeries(
  portfolio: MonthlyReturnPoint[],
  benchmarks: Record<string, MonthlyReturnPoint[]>,
): IndexPoint[] {
  const firstPeriod = portfolio.find((p) => p.returnBps !== null)?.period ?? portfolio[0]?.period
  if (!firstPeriod) return []

  const periods = portfolio.map((p) => p.period).filter((period) => period >= firstPeriod)
  const byKeyByPeriod = new Map<SeriesKey, Map<string, number | null>>()
  byKeyByPeriod.set('portfolio', new Map(portfolio.map((p) => [p.period, p.returnBps])))
  for (const code of Object.keys(benchmarks)) {
    byKeyByPeriod.set(code as SeriesKey, new Map(benchmarks[code]!.map((p) => [p.period, p.returnBps])))
  }

  const running = new Map<SeriesKey, number>()
  for (const key of byKeyByPeriod.keys()) running.set(key, 100)

  return periods.map((period) => {
    const point: IndexPoint = { period }
    for (const [key, series] of byKeyByPeriod) {
      const returnBps = series.get(period)
      if (returnBps !== undefined && returnBps !== null) {
        running.set(key, running.get(key)! * (1 + returnBps / 10_000))
      }
      point[key] = Math.round(running.get(key)! * 100) / 100
    }
    // Stacked-area trick: Recharts has no "fill between two lines" primitive,
    // so the band is a transparent floor (the lower of the two) plus a
    // coloured sliver stacked on top, split into "over" vs "under" so each
    // can take its own colour instead of one flat fill.
    if (point.portfolio !== undefined && point.CDI !== undefined) {
      const base = Math.min(point.portfolio, point.CDI)
      const diff = Math.abs(point.portfolio - point.CDI)
      point.bandBase = base
      point.bandOver = point.portfolio >= point.CDI ? diff : 0
      point.bandUnder = point.portfolio < point.CDI ? diff : 0
    }
    return point
  })
}

export function ProfitabilityChart({
  portfolio,
  benchmarks,
  benchmarkLabels,
  defaultVisible = ['portfolio', 'CDI'],
  surface = 'paper',
  height = 340,
}: {
  portfolio: MonthlyReturnPoint[]
  benchmarks: Record<string, MonthlyReturnPoint[]>
  benchmarkLabels: Record<string, string>
  /** Every other series starts hidden behind the legend — 8 overlapping
   * lines by default reads as noise, not a comparison. */
  defaultVisible?: string[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const availableKeys = SERIES_ORDER.filter((key) => key === 'portfolio' || benchmarks[key]?.length)
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(availableKeys.filter((key) => !defaultVisible.includes(key))),
  )
  /**
   * Which series is currently raised to the front.
   *
   * With eight cumulative indices starting from the same base 100, the lines
   * spend most of the chart inside a narrow band, overlapping each other.
   * Whichever one happens to be declared last wins every crossing, and the
   * reader has no way to follow a specific one. Hovering a legend entry (or
   * the line itself) re-sorts the render order so that series draws last,
   * and dims the rest — the recharts "dynamic z-index" pattern.
   */
  const [raised, setRaised] = useState<SeriesKey | null>(null)

  // Re-derive when the caller changes which benchmark to emphasise (the
  // "Comparar com" selector above) rather than only on first mount.
  useEffect(() => {
    setHidden(new Set(availableKeys.filter((key) => !defaultVisible.includes(key))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultVisible.join(',')])

  const data = useMemo(() => buildIndexSeries(portfolio, benchmarks), [portfolio, benchmarks])
  const hasData = data.length > 1

  /**
   * The Y domain, hugging the visible data instead of starting at zero.
   *
   * This is an INDEX chart: every series starts at base 100 and no index
   * ever approaches zero, so a zero baseline spent about 70% of the plot
   * height on empty space and crushed all eight lines into a thin band at
   * the top. The zero-baseline rule protects magnitude encodings (bars,
   * areas), where the mark's length has to be proportional to the value; on
   * a ratio line the meaningful reference is 100, and that is what the
   * ReferenceLine below anchors so the truncated axis is stated, not hidden.
   *
   * Hidden series are excluded on purpose: a series the user switched off
   * should not go on stretching the scale for the ones they kept.
   */
  const domain = useMemo<[number, number]>(() => {
    const visible = availableKeys.filter((key) => !hidden.has(key))
    const values = data.flatMap((point) =>
      visible.map((key) => point[key]).filter((v): v is number => typeof v === 'number'),
    )
    // Base 100 is always in frame, so "above or below where it started" stays
    // readable even when every visible series is on one side of it.
    const min = Math.min(100, ...values)
    const max = Math.max(100, ...values)
    const pad = Math.max(2, (max - min) * 0.12)
    const step = 5
    return [Math.floor((min - pad) / step) * step, Math.ceil((max + pad) / step) * step]
  }, [data, availableKeys.join(','), hidden])

  /** Declaration order, with the raised series moved last so it paints on top. */
  const paintOrder = useMemo(
    () =>
      raised === null
        ? availableKeys
        : [...availableKeys.filter((key) => key !== raised), raised],
    // availableKeys is derived from props on every render; joining it keeps
    // the memo honest without depending on a new array identity each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [availableKeys.join(','), raised],
  )

  const labelFor = (key: SeriesKey) => (key === 'portfolio' ? 'Carteira' : benchmarkLabels[key] ?? key)

  const Tip = makeTooltip<IndexPoint>((point, label) => ({
    title: fmtPeriod(label),
    rows: availableKeys
      .filter((key) => !hidden.has(key) && point[key] !== undefined)
      .map((key) => ({ label: labelFor(key), value: `${point[key]!.toFixed(1)}`, color: seriesColor(theme, key) })),
  }))

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Sem histórico suficiente ainda"
      emptyBody="A comparação aparece a partir do segundo mês com aportes registrados."
      table={{
        caption: 'Índice acumulado (base 100) por mês',
        rows: data,
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(row.period) },
          ...availableKeys.map((key) => ({
            header: labelFor(key),
            value: (row: IndexPoint) => (row[key] !== undefined ? row[key]!.toFixed(1) : '—'),
            align: 'right' as const,
          })),
        ],
      }}
      note="Índices via ETF que replica cada um (IBOV≈BOVA11, IFIX≈XFIX11, SMLL≈SMAL11, IDIV≈DIVO11) só cobrem os últimos meses no plano gratuito da BRAPI — o histórico completo se acumula a cada atualização. CDI e IPCA vêm completos desde já (Banco Central)."
    >
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={fmtPeriod} {...axisProps(theme)} />
          {/*
            `allowDataOverflow` has to be ON. The CDI band below is drawn as
            stacked Areas whose transparent floor stacks up from 0, so recharts
            counts 0 as real data and grows the domain back down to it,
            silently undoing the domain above. With overflow allowed the
            domain is honoured and the floor is simply clipped, which is
            invisible anyway because it is transparent.
          */}
          <YAxis width={44} domain={domain} allowDataOverflow {...axisProps(theme)} />
          {/* The axis no longer starts at zero, so the base has to be visible:
              this is the line every series departs from. */}
          <ReferenceLine
            y={100}
            stroke={theme.axis}
            strokeDasharray="2 4"
            label={{ value: 'base 100', position: 'insideBottomLeft', fill: theme.axisText, fontSize: 10 }}
          />
          <Tooltip content={<Tip />} />
          {/*
            A custom legend rendered from the STABLE SERIES_ORDER. Recharts
            derives its default legend from the children, and the children
            below get re-sorted to control paint order, so the default legend
            would reshuffle its entries under the cursor exactly while being
            hovered.
          */}
          <Legend
            content={() => (
              <ul className="zlegend">
                {availableKeys.map((key) => {
                  const isHidden = hidden.has(key)
                  const isRaised = raised === key
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        className="zlegend__item"
                        aria-pressed={!isHidden}
                        title={isHidden ? `Mostrar ${labelFor(key)}` : `Ocultar ${labelFor(key)}`}
                        style={{
                          textDecoration: isHidden ? 'line-through' : undefined,
                          opacity: isHidden ? 0.5 : raised !== null && !isRaised ? 0.45 : 1,
                          fontWeight: isRaised ? 600 : 400,
                          color: isHidden ? theme.axisText : seriesColor(theme, key),
                        }}
                        onMouseEnter={() => !isHidden && setRaised(key)}
                        onMouseLeave={() => setRaised(null)}
                        onFocus={() => !isHidden && setRaised(key)}
                        onBlur={() => setRaised(null)}
                        onClick={() =>
                          setHidden((current) => {
                            const next = new Set(current)
                            if (next.has(key)) next.delete(key)
                            else next.add(key)
                            return next
                          })
                        }
                      >
                        <span
                          className="zlegend__key"
                          style={{ background: seriesColor(theme, key) }}
                          aria-hidden="true"
                        />
                        {labelFor(key)}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          />
          {!hidden.has('CDI') && !hidden.has('portfolio') && (
            <>
              <Area
                dataKey="bandBase"
                stackId="band"
                stroke="none"
                fill="transparent"
                legendType="none"
                isAnimationActive={false}
                tooltipType="none"
              />
              <Area
                dataKey="bandOver"
                stackId="band"
                stroke="none"
                fill={theme.status.good}
                fillOpacity={0.16}
                legendType="none"
                isAnimationActive={false}
                tooltipType="none"
              />
              <Area
                dataKey="bandUnder"
                stackId="band"
                stroke="none"
                fill={theme.status.critical}
                fillOpacity={0.12}
                legendType="none"
                isAnimationActive={false}
                tooltipType="none"
              />
            </>
          )}
          {/*
            Paint order IS the z-index in an SVG chart: the last child wins
            every overlap. Sorting the raised series to the end is what puts
            it on top; `key` keeps React moving the same nodes instead of
            remounting them, so no line flickers while the order changes.
          */}
          {paintOrder.map((key, position) => {
            const isRaised = raised === key
            const dimmed = raised !== null && !isRaised
            return (
              <Line
                /*
                 * The POSITION is part of the key on purpose. Recharts 3
                 * registers its graphical items in its own store and does not
                 * repaint them just because the JSX children were reordered,
                 * so a stable key leaves the SVG order untouched and the
                 * raised line stays underneath. Keying by position forces the
                 * reconciliation that actually moves the node. Safe here only
                 * because animation is off: with it on, the remount would
                 * replay the draw-in on every hover.
                 */
                key={`${key}-${position}`}
                dataKey={key}
                name={labelFor(key)}
                stroke={seriesColor(theme, key)}
                strokeWidth={
                  isRaised
                    ? MARK.lineWidth + 1.5
                    : key === 'portfolio'
                      ? MARK.lineWidth + 1
                      : MARK.lineWidth
                }
                // Dimming the others is what makes the reordering readable:
                // without it, "on top" is invisible wherever nothing crosses.
                strokeOpacity={dimmed ? 0.25 : 1}
                strokeDasharray={key === 'CDI' ? '4 3' : undefined}
                dot={false}
                activeDot={isRaised ? { r: MARK.activeDotRadius } : false}
                hide={hidden.has(key)}
                connectNulls
                isAnimationActive={false}
                onMouseEnter={() => setRaised(key)}
                onMouseLeave={() => setRaised(null)}
                style={{ cursor: 'pointer' }}
              />
            )
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
