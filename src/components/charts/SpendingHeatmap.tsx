import { useState } from 'react'
import { money } from '../../lib/format'
import { themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { EmptyState } from '../ui'

export type HeatmapDay = { day: string; expenseCents: number; transactionCount: number }

const WEEKDAY_LETTERS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']

/**
 * Item 8 do backlog de 07/09/2026: mapa de calor por dia do mês, gasto
 * confirmado sombreado pela intensidade. Mesmo dado de
 * `analytics.ts#dailySeries` que já alimenta o Diário e o Ritmo de gastos
 * (item 7) -- nenhum endpoint novo.
 *
 * Nenhum gráfico do projeto usa Recharts para uma grade de calendário
 * (não existe primitivo pronto pra isso na biblioteca) -- é uma grade
 * HTML simples, na mesma linha de `Sparkline` em `components/ui/index.tsx`
 * (SVG à mão porque não há tooltip/eixo/legenda de Recharts a reaproveitar
 * aqui, só que esta usa `<div>`s por ser uma grade, não um traçado).
 *
 * A paleta é a sequencial que o projeto já valida
 * (`chartTheme.ts#sequential`, mesma escala de `--seq-*`): índice 0 já
 * nasce "quase a cor da superfície" tanto no claro quanto no escuro, então
 * usar o MESMO índice pro dia de menor gasto em qualquer tema não pede
 * nenhuma lógica extra de inversão aqui.
 */
export function SpendingHeatmap({ days, surface = 'paper' }: { days: HeatmapDay[]; surface?: Surface }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const [hovered, setHovered] = useState<HeatmapDay | null>(null)

  const confirmedDays = days.filter((d) => d.transactionCount > 0)
  if (confirmedDays.length === 0) {
    return (
      <EmptyState
        icon="calendar"
        title="Sem gasto confirmado ainda"
        body="O mapa de calor aparece aqui assim que houver pelo menos uma saída confirmada no mês."
      />
    )
  }

  const totalCents = confirmedDays.reduce((sum, d) => sum + d.expenseCents, 0)
  const maxCents = Math.max(...days.map((d) => d.expenseCents))
  const busiestDay = days.reduce((max, d) => (d.expenseCents > max.expenseCents ? d : max), days[0]!)

  // Índice 0-7 na escala sequencial, proporcional ao maior gasto do mês --
  // nunca ao maior gasto HISTÓRICO, porque um mês de referência diferente
  // mudaria a cor de um dia que não mudou de valor nenhum.
  const colorFor = (cents: number): string => {
    if (cents <= 0 || maxCents <= 0) return theme.sequential[0]!
    const step = Math.min(theme.sequential.length - 1, Math.round((cents / maxCents) * (theme.sequential.length - 1)))
    return theme.sequential[step]!
  }

  const firstWeekday = new Date(`${days[0]!.day}T00:00:00Z`).getUTCDay()
  const leadingBlanks = Array.from({ length: firstWeekday }, () => null)
  const cells: Array<HeatmapDay | null> = [...leadingBlanks, ...days]

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <span className="stat__label">Mapa de calor</span>
          <div className="stat__value">{money(totalCents)}</div>
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            Média diária: {money(Math.round(totalCents / confirmedDays.length))}
          </span>
        </div>
      </div>

      {/* maxWidth trava o tamanho da célula num calendário pequeno e denso
          -- sem isso, `1fr` esticava cada célula até a largura inteira do
          card, e um mapa de calor não precisa da mesma presença visual de
          um gráfico (achado de 08/09/2026). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3, maxWidth: 240 }}>
        {WEEKDAY_LETTERS.map((letter, i) => (
          <div
            key={i}
            className="muted"
            style={{ textAlign: 'center', fontSize: 'var(--text-2xs)', fontWeight: 600 }}
          >
            {letter}
          </div>
        ))}
        {cells.map((cell, i) =>
          cell === null ? (
            <div key={`blank-${i}`} />
          ) : (
            <div
              key={cell.day}
              onMouseEnter={() => setHovered(cell)}
              onMouseLeave={() => setHovered((current) => (current?.day === cell.day ? null : current))}
              title={`${cell.day}: ${money(cell.expenseCents)}`}
              style={{
                aspectRatio: '1',
                borderRadius: 'var(--r-sm)',
                background: cell.transactionCount > 0 ? colorFor(cell.expenseCents) : 'var(--surface-muted)',
                cursor: cell.transactionCount > 0 ? 'pointer' : 'default',
                border: hovered?.day === cell.day ? `2px solid ${theme.axisText}` : '2px solid transparent',
              }}
            />
          ),
        )}
      </div>

      {/*
        Sempre montado (nunca `{hovered && ...}`) — bug corrigido em
        07/09/2026: o painel só existia no DOM enquanto `hovered` não era
        nulo, então mover o mouse por células vizinhas (mouseleave da
        célula antiga, mouseenter da nova) piscava esse bloco inteiro
        entrando e saindo do layout, empurrando o que vem depois pra cima
        e pra baixo a cada troca de célula. Mantendo o container fixo e
        só trocando o CONTEÚDO de dentro, a altura nunca muda.
      */}
      <div style={{ padding: 'var(--sp-2) var(--sp-3)', borderRadius: 'var(--r-card)', background: 'var(--surface-muted)', minHeight: 44 }}>
        {hovered ? (
          <span className="row row--wrap" style={{ gap: 'var(--sp-2)', alignItems: 'baseline' }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>
              {new Date(`${hovered.day}T00:00:00Z`).toLocaleDateString('pt-BR', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                // Sem isto, `toLocaleDateString` converte pro fuso LOCAL do
                // navegador antes de formatar — em UTC-3 (America/Sao_Paulo),
                // meia-noite UTC vira 21h do dia ANTERIOR, e a legenda mostrava
                // um dia (e um dia-da-semana) inteiro errado, sempre um a
                // menos (achado de 07/09/2026). O grid acima já usa
                // `getUTCDay()` para posicionar as células — este `timeZone`
                // faz a legenda concordar com a mesma leitura UTC.
                timeZone: 'UTC',
              })}
            </strong>
            <span className="tabular">{money(hovered.expenseCents)}</span>
            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              {hovered.transactionCount} transação(ões)
            </span>
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            Passe o mouse sobre um dia para ver o detalhe
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
          Maior gasto: <strong className="tabular">{money(busiestDay.expenseCents)}</strong> dia{' '}
          {Number(busiestDay.day.slice(-2))}
        </span>
      </div>
    </div>
  )
}
