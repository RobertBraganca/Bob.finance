import { useMemo, useState } from 'react'
import { money, dateShort } from '../../lib/format'
import { themeFor, type ChartTheme, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame } from './frame'
import type { DayPoint } from './SpendAreaChart'

const CELL = 14
const GAP = 3
/** domingo primeiro, mesma convenção de calendário do `Date.getUTCDay()`. */
const WEEKDAY_LABELS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
/** Só alterna 3 rótulos (seg/qua/sex), mesmo espírito do "Mon/Wed/Fri" de um heatmap de contribuições. */
const SHOWN_WEEKDAYS = new Set([1, 3, 5])

type WeekCell = DayPoint | null

function parseIsoDate(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return { y, m, d }
}

/** Aritmética de data em UTC puro — nunca lê o fuso do navegador, evita o dia deslizar num timezone positivo. */
function addDaysUtc(y: number, m: number, d: number, delta: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + delta))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

function weekdayUtc(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

function isoOf({ y, m, d }: { y: number; m: number; d: number }): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Reagrupa a série diária (já ordenada, um `DayPoint` por dia do mês) em
 * semanas de domingo a sábado, preenchendo com `null` os dias fora do mês
 * que sobram nas pontas da primeira/última semana — mesmo formato de grade
 * de um heatmap de contribuições, só que escopado ao mês selecionado em vez
 * do ano inteiro.
 */
function buildWeeks(days: DayPoint[]): { weeks: WeekCell[][]; maxCents: number } {
  if (days.length === 0) return { weeks: [], maxCents: 0 }
  const byDay = new Map(days.map((d) => [d.day, d]))
  const first = days[0]!.day
  const last = days[days.length - 1]!.day
  const { y, m, d } = parseIsoDate(first)
  const gridStart = addDaysUtc(y, m, d, -weekdayUtc(y, m, d))

  const weeks: WeekCell[][] = []
  let cursor = gridStart
  let cursorIso = isoOf(cursor)
  while (cursorIso <= last) {
    const week: WeekCell[] = []
    for (let i = 0; i < 7; i++) {
      cursorIso = isoOf(cursor)
      const inRange = cursorIso >= first && cursorIso <= last
      week.push(inRange ? (byDay.get(cursorIso) ?? { day: cursorIso, expenseCents: 0, transactionCount: 0 }) : null)
      cursor = addDaysUtc(cursor.y, cursor.m, cursor.d, 1)
    }
    weeks.push(week)
  }
  const maxCents = Math.max(0, ...days.map((d) => d.expenseCents))
  return { weeks, maxCents }
}

/** Intensidade = um hue só, do claro pro escuro (rampa sequencial), nunca arco-íris. Zero é "nada", não "pouco" — cor neutra própria, fora da rampa. */
function colorFor(cents: number, maxCents: number, theme: ChartTheme): string {
  if (cents <= 0 || maxCents <= 0) return theme.grid
  const ratio = cents / maxCents
  const steps = theme.sequential
  const index = Math.min(steps.length - 1, Math.max(0, Math.ceil(ratio * steps.length) - 1))
  return steps[index]!
}

/**
 * Termômetro de gastos — mesma série diária do "Intensidade por dia"
 * (`SpendAreaChart`), como grade de calendário em vez de curva contínua
 * (pedido do usuário, 01/09/2026, inspirado num heatmap de contribuições
 * estilo GitHub). Segunda leitura da MESMA série, não um dado novo: aqui o
 * eixo é dia-da-semana × semana, então responde "que dia da semana pesa
 * mais", pergunta que a curva contínua não separa por natureza.
 */
export function DailyHeatmap({ days, surface = 'paper' }: { days: DayPoint[]; surface?: Surface }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const [hovered, setHovered] = useState<DayPoint | null>(null)
  const hasData = days.some((d) => d.expenseCents > 0)
  const { weeks, maxCents } = useMemo(() => buildWeeks(days), [days])

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Nenhum gasto registrado"
      emptyBody="O termômetro aparece aqui assim que houver lançamentos no período."
      table={{
        caption: 'Gasto por dia',
        rows: days.filter((d) => d.expenseCents > 0),
        columns: [
          { header: 'Dia', value: (row) => dateShort(row.day) },
          { header: 'Lançamentos', value: (row) => row.transactionCount, align: 'right' },
          { header: 'Gasto', value: (row) => money(row.expenseCents), align: 'right' },
        ],
      }}
    >
      <div className="stack" style={{ gap: 'var(--sp-3)' }}>
        <div className="row" style={{ gap: GAP, alignItems: 'flex-start' }}>
          <div className="stack" style={{ gap: GAP, flex: 'none' }}>
            {WEEKDAY_LABELS.map((label, i) => (
              <span
                key={label}
                style={{
                  height: CELL,
                  lineHeight: `${CELL}px`,
                  fontSize: 10,
                  color: theme.axisText,
                  visibility: SHOWN_WEEKDAYS.has(i) ? 'visible' : 'hidden',
                }}
              >
                {label}
              </span>
            ))}
          </div>
          <div className="row" style={{ gap: GAP }}>
            {weeks.map((week, wi) => (
              <div key={wi} className="stack" style={{ gap: GAP }}>
                {week.map((cell, di) =>
                  cell === null ? (
                    <div key={di} style={{ width: CELL, height: CELL }} />
                  ) : (
                    <button
                      key={di}
                      type="button"
                      onMouseEnter={() => setHovered(cell)}
                      onFocus={() => setHovered(cell)}
                      onMouseLeave={() => setHovered(null)}
                      onBlur={() => setHovered(null)}
                      aria-label={`${dateShort(cell.day)}: ${money(cell.expenseCents)}, ${cell.transactionCount} lançamento(s)`}
                      style={{
                        width: CELL,
                        height: CELL,
                        borderRadius: 3,
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        background: colorFor(cell.expenseCents, maxCents, theme),
                      }}
                    />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="row row--between" style={{ fontSize: 'var(--text-xs)', color: theme.axisText, gap: 'var(--sp-3)' }}>
          <span>
            {hovered
              ? `${dateShort(hovered.day)} · ${money(hovered.expenseCents)} · ${hovered.transactionCount} lançamento(s)`
              : 'Passe o mouse (ou navegue com Tab) sobre um dia'}
          </span>
          <span className="row" style={{ gap: 4, flex: 'none' }}>
            Menos
            <span style={{ width: 10, height: 10, borderRadius: 2, background: theme.grid }} />
            {theme.sequential.map((c) => (
              <span key={c} style={{ width: 10, height: 10, borderRadius: 2, background: c }} />
            ))}
            Mais
          </span>
        </div>
      </div>
    </ChartFrame>
  )
}
