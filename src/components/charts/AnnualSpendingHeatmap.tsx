import { useState } from 'react'
import { money, MONTHS_SHORT, periodLong } from '../../lib/format'
import { themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { EmptyState } from '../ui'

export type AnnualHeatmapMonth = { period: string; expenseCents: number }

/**
 * Mesma ideia de `SpendingHeatmap`, um grau mais grosso: 12 células (mês do
 * ano) em vez de uma por dia — generalização de 07/09/2026 pro Mapa de
 * calor do Painel quando o período selecionado não é um único mês
 * (3m/6m/12m/ano/máximo), caso em que uma grade por DIA não tem um mês
 * único pra desenhar.
 */
export function AnnualSpendingHeatmap({ months, surface = 'paper' }: { months: AnnualHeatmapMonth[]; surface?: Surface }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const [hovered, setHovered] = useState<AnnualHeatmapMonth | null>(null)

  const activeMonths = months.filter((m) => m.expenseCents > 0)
  if (activeMonths.length === 0) {
    return (
      <EmptyState
        icon="calendar"
        title="Sem gasto confirmado ainda"
        body="O mapa de calor aparece aqui assim que houver pelo menos uma saída confirmada no ano."
      />
    )
  }

  const totalCents = activeMonths.reduce((sum, m) => sum + m.expenseCents, 0)
  const maxCents = Math.max(...months.map((m) => m.expenseCents))
  const busiestMonth = months.reduce((max, m) => (m.expenseCents > max.expenseCents ? m : max), months[0]!)

  const colorFor = (cents: number): string => {
    if (cents <= 0 || maxCents <= 0) return theme.sequential[0]!
    const step = Math.min(theme.sequential.length - 1, Math.round((cents / maxCents) * (theme.sequential.length - 1)))
    return theme.sequential[step]!
  }

  const labelFor = (period: string) => (MONTHS_SHORT[Number(period.slice(5, 7)) - 1] ?? period).toUpperCase()

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <span className="stat__label">Mapa de calor</span>
          <div className="stat__value">{money(totalCents)}</div>
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            Média mensal: {money(Math.round(totalCents / activeMonths.length))}
          </span>
        </div>
      </div>

      {/* Célula com altura FIXA, não aspect-ratio -- a largura continua
          esticando (`1fr`) até preencher o card, só a ALTURA que precisava
          encolher (ajuste de 08/09/2026, mesmo de `SpendingHeatmap`: uma
          tentativa anterior travou largura E altura, deixando um bloco
          pequeno colado à esquerda em vez de ocupar a linha inteira). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 3 }}>
        {months.map((m) => (
          <div key={m.period} style={{ display: 'grid', gap: 3 }}>
            <div className="muted" style={{ textAlign: 'center', fontSize: 'var(--text-2xs)', fontWeight: 600 }}>
              {labelFor(m.period)}
            </div>
            <div
              onMouseEnter={() => setHovered(m)}
              onMouseLeave={() => setHovered((current) => (current?.period === m.period ? null : current))}
              title={`${labelFor(m.period)}: ${money(m.expenseCents)}`}
              style={{
                height: 28,
                borderRadius: 'var(--r-sm)',
                background: m.expenseCents > 0 ? colorFor(m.expenseCents) : 'var(--surface-muted)',
                cursor: m.expenseCents > 0 ? 'pointer' : 'default',
                border: hovered?.period === m.period ? `2px solid ${theme.axisText}` : '2px solid transparent',
              }}
            />
          </div>
        ))}
      </div>

      {/* Sempre montado — mesmo bug de flicker corrigido em `SpendingHeatmap` (07/09/2026). */}
      <div style={{ padding: 'var(--sp-2) var(--sp-3)', borderRadius: 'var(--r-card)', background: 'var(--surface-muted)', minHeight: 44 }}>
        {hovered ? (
          <span className="row row--wrap" style={{ gap: 'var(--sp-2)', alignItems: 'baseline' }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>{periodLong(hovered.period)}</strong>
            <span className="tabular">{money(hovered.expenseCents)}</span>
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            Passe o mouse sobre um mês para ver o detalhe
          </span>
        )}
      </div>

      <div className="row row--between" style={{ fontSize: 'var(--text-2xs)' }}>
        <span className="row" style={{ gap: 4 }}>
          <span className="muted">Menos</span>
          {theme.sequential.map((color, i) => (
            <span key={i} style={{ width: 12, height: 12, borderRadius: 3, background: color, display: 'inline-block' }} />
          ))}
          <span className="muted">Mais</span>
        </span>
        <span className="muted">
          Maior gasto: <strong className="tabular">{money(busiestMonth.expenseCents)}</strong> em {labelFor(busiestMonth.period)}
        </span>
      </div>
    </div>
  )
}
