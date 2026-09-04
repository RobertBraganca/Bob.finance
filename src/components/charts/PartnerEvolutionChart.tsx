import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, money, period as fmtPeriod } from '../../lib/format'
import { axisProps, gridProps, MARK, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, ChartTooltip, surfaceRing, type LegendEntry } from './frame'

export type PartnerEvolutionPoint = {
  period: string
  totalCents: number
  byPlatform: Record<string, number>
}

export type PartnerEvolutionData = {
  points: PartnerEvolutionPoint[]
  platforms: Array<{ id: number; name: string }>
}

/**
 * Uma linha por plataforma, saldo ACUMULADO ao fim de cada mês — mesmo
 * desenho de "Evolução do patrimônio" (`NetWorthHistoryChart`): linha,
 * grade horizontal, sem animação, dot com anel da superfície.
 *
 * A paleta categórica do BOB.OS tem QUATRO cores e o comentário de
 * `chartTheme.ts` é explícito: "Do not add a 5th colour: a 5th series
 * folds into Outros". O usuário já citou quatro plataformas (Wbuy,
 * Hostinger, Nuvemshop, Adobe) e disse que há mais para cadastrar, então
 * esse limite ia ser atingido — daí o dobramento acontecer aqui, por
 * saldo atual, em vez de a quinta plataforma pegar uma cor inventada.
 * "Outros" usa o neutro do tema, que não é uma cor de série.
 */
const MAX_SERIES = 4
const OTHERS_KEY = 'outros'

export function PartnerEvolutionChart({
  data,
  surface = 'paper',
}: {
  data: PartnerEvolutionData
  surface?: Surface
}) {
  const theme = themeFor(useEffectiveSurface(surface))

  const { rows, series } = useMemo(() => {
    const { points, platforms } = data
    const last = points[points.length - 1]

    // O ranking sai do ÚLTIMO ponto (saldo de hoje), não da soma da série:
    // é a leitura que a lista de plataformas ao lado também mostra, então
    // as duas concordam sobre quem são as quatro maiores.
    const ranked = [...platforms].sort(
      (a, b) => (last?.byPlatform[String(b.id)] ?? 0) - (last?.byPlatform[String(a.id)] ?? 0),
    )
    const shown = ranked.slice(0, MAX_SERIES)
    const folded = ranked.slice(MAX_SERIES)

    const series: Array<LegendEntry & { key: string }> = shown.map((platform, index) => ({
      key: String(platform.id),
      label: platform.name,
      color: theme.series[index % theme.series.length]!,
      shape: 'line' as const,
    }))
    if (folded.length > 0) {
      series.push({
        key: OTHERS_KEY,
        label: `Outros (${folded.length})`,
        color: theme.neutral,
        shape: 'line' as const,
      })
    }

    const rows = points.map((point) => {
      const row: Record<string, number | string> = { period: point.period, totalCents: point.totalCents }
      for (const platform of shown) row[String(platform.id)] = point.byPlatform[String(platform.id)] ?? 0
      if (folded.length > 0) {
        row[OTHERS_KEY] = folded.reduce((sum, p) => sum + (point.byPlatform[String(p.id)] ?? 0), 0)
      }
      return row
    })

    return { rows, series }
  }, [data, theme])

  // Uma série que é zero em TODOS os meses não tem forma para mostrar: a
  // linha fica colada no eixo e só rouba uma cor da paleta.
  const drawn = series.filter((s) => rows.some((row) => Number(row[s.key] ?? 0) !== 0))
  const hasData = rows.length > 0 && drawn.length > 0

  const Tip = useMemo(
    () =>
      function Tip(props: { active?: boolean; label?: unknown; payload?: Array<{ payload: Record<string, number | string> }> }) {
        if (!props.active || !props.payload || props.payload.length === 0) return null
        const row = props.payload[0]?.payload
        if (!row) return null
        return (
          <ChartTooltip
            title={fmtPeriod(String(row.period))}
            rows={[
              ...drawn.map((s) => ({
                label: s.label,
                value: money(Number(row[s.key] ?? 0)),
                color: s.color,
              })),
              { label: 'Total acumulado', value: money(Number(row.totalCents ?? 0)) },
            ]}
          />
        )
      },
    [drawn],
  )

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Sem histórico ainda"
      emptyBody="A evolução aparece aqui depois do primeiro lançamento de comissão."
      legend={drawn.map(({ label, color, shape }) => ({ label, color, shape }))}
      note="Saldo acumulado ao fim de cada mês: comissões lançadas menos saques já realizados."
      table={{
        caption: 'Saldo acumulado por plataforma, mês a mês',
        rows,
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(String(row.period)) },
          ...drawn.map((s) => ({
            header: s.label,
            value: (row: Record<string, number | string>) => money(Number(row[s.key] ?? 0)),
            align: 'right' as const,
          })),
          {
            header: 'Total',
            value: (row: Record<string, number | string>) => money(Number(row.totalCents ?? 0)),
            align: 'right' as const,
          },
        ],
      }}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={200}>
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={(p: string) => fmtPeriod(p)} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={56} {...axisProps(theme)} />
          <Tooltip content={<Tip />} />
          {drawn.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={MARK.lineWidth}
              dot={{ r: MARK.dotRadius, fill: s.color, ...surfaceRing(theme) }}
              activeDot={{ r: MARK.activeDotRadius }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
