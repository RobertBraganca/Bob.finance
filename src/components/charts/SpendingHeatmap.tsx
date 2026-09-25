import { useState } from 'react'
import { money, moneyCompactPlain } from '../../lib/format'
import { textOnFill, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { EmptyState } from '../ui'

export type HeatmapDay = { day: string; expenseCents: number; transactionCount: number }

// Abreviação de 3 letras em vez de uma só (ajuste de 25/09/2026, a pedido do
// usuário) — mais legível que "D S T Q Q S S", que exige já saber a ordem
// dos dias da semana de cor pra decifrar.
const WEEKDAY_LABELS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']

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
  // Toque fixa o detalhe (mouse não existe em touch, então só `hovered`
  // nunca mostrava nada no celular) — clicar de novo no mesmo dia desmarca.
  const [selected, setSelected] = useState<HeatmapDay | null>(null)
  const shown = hovered ?? selected

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
  const noSpendDays = days.length - confirmedDays.length
  const avgPerActiveDayCents = Math.round(totalCents / confirmedDays.length)

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
        </div>
      </div>

      {/* Célula com altura FIXA, não aspect-ratio -- a largura continua
          esticando (`1fr`) até preencher o card (era isso que já estava
          certo), só a ALTURA que precisava encolher (ajuste de 08/09/2026:
          uma tentativa anterior travou largura E altura, deixando um bloco
          pequeno colado à esquerda em vez de ocupar a linha inteira). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
        {WEEKDAY_LABELS.map((label, i) => (
          <div
            key={i}
            className="muted"
            style={{ textAlign: 'center', fontSize: 'var(--text-2xs)', fontWeight: 600 }}
          >
            {label}
          </div>
        ))}
        {cells.map((cell, i) => {
          if (cell === null) return <div key={`blank-${i}`} />

          const hasSpend = cell.transactionCount > 0
          const fill = hasSpend ? colorFor(cell.expenseCents) : 'var(--surface-muted)'
          // A cor do texto segue a cor de FUNDO real da célula, nunca um
          // token fixo do tema: só a célula com gasto tem um fundo
          // arbitrário vindo de dado (`textOnFill`); a célula sem gasto
          // fica na leitura padrão do app (`--ink-3`, discreta de propósito).
          const textColor = hasSpend ? textOnFill(fill) : 'var(--ink-3)'
          const dayNumber = Number(cell.day.slice(-2))

          return (
            <div
              key={cell.day}
              role={hasSpend ? 'button' : undefined}
              tabIndex={hasSpend ? 0 : undefined}
              onMouseEnter={() => setHovered(cell)}
              onMouseLeave={() => setHovered((current) => (current?.day === cell.day ? null : current))}
              onClick={() => {
                if (!hasSpend) return
                setSelected((current) => (current?.day === cell.day ? null : cell))
              }}
              onKeyDown={(e) => {
                if (!hasSpend) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelected((current) => (current?.day === cell.day ? null : cell))
                }
              }}
              title={`${cell.day}: ${money(cell.expenseCents)}`}
              style={{
                height: 44,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1,
                borderRadius: 'var(--r-sm)',
                background: fill,
                color: textColor,
                cursor: hasSpend ? 'pointer' : 'default',
                border: shown?.day === cell.day ? `2px solid ${theme.axisText}` : '2px solid transparent',
              }}
            >
              <span style={{ fontSize: 'var(--text-2xs)', lineHeight: 1, opacity: hasSpend ? 0.85 : 1 }}>
                {dayNumber}
              </span>
              {hasSpend && (
                <span className="tabular" style={{ fontSize: 'var(--text-2xs)', lineHeight: 1, fontWeight: 700 }}>
                  {moneyCompactPlain(cell.expenseCents)}
                </span>
              )}
            </div>
          )
        })}
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
        {shown ? (
          <span className="row row--wrap" style={{ gap: 'var(--sp-2)', alignItems: 'baseline' }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>
              {new Date(`${shown.day}T00:00:00Z`).toLocaleDateString('pt-BR', {
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
            <span className="tabular">{money(shown.expenseCents)}</span>
            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              {shown.transactionCount} transação(ões)
            </span>
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            Toque ou passe o mouse sobre um dia para ver o detalhe
          </span>
        )}
      </div>

      {/* 3 estatísticas fixas (ajuste de 25/09/2026, a pedido do usuário) —
          antes só "maior gasto" aparecia, e enfiado dentro da legenda de
          cores. Mesmo grid de 3 colunas usado em outros cards de resumo do
          projeto. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--sp-3)' }}>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted" style={{ fontSize: 'var(--text-2xs)', fontWeight: 600 }}>
            Média por dia
          </span>
          <span className="tabular" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
            {money(avgPerActiveDayCents)}
          </span>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted" style={{ fontSize: 'var(--text-2xs)', fontWeight: 600 }}>
            Maior dia
          </span>
          <span className="tabular" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
            {new Date(`${busiestDay.day}T00:00:00Z`).toLocaleDateString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
              timeZone: 'UTC',
            })}{' '}
            · {money(busiestDay.expenseCents)}
          </span>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted" style={{ fontSize: 'var(--text-2xs)', fontWeight: 600 }}>
            Dias sem saída
          </span>
          <span className="tabular" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
            {noSpendDays}
          </span>
        </div>
      </div>

      <div className="row" style={{ fontSize: 'var(--text-2xs)', gap: 4 }}>
        <span className="muted">Menos</span>
        {theme.sequential.map((color, i) => (
          <span key={i} style={{ width: 12, height: 12, borderRadius: 3, background: color, display: 'inline-block' }} />
        ))}
        <span className="muted">Mais</span>
      </div>
    </div>
  )
}
