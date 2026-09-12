import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, bps, money, period as fmtPeriod } from '../../lib/format'
import { MARK, axisProps, gridProps, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'
import { CategoryRing, type Slice } from './CategoryRing'

export type QuoteFunnelStage = {
  key: string
  label: string
  count: number
  shareBps: number
  dropFromPreviousCount: number
}

export type QuoteStatusSlice = {
  status: string
  count: number
  recommendedCents: number
  actualCents: number
  shareBps: number
}

export type QuotePeriodPoint = {
  period: string
  sentCents: number
  sentCount: number
  approvedCents: number
  approvedCount: number
  conversionBps: number | null
}

/**
 * Cor de cada status na rosca.
 *
 * A divisão não é decorativa: as três primeiras são ETAPAS de um mesmo
 * caminho e recebem passos da rampa sequencial de marca (azul, do claro ao
 * escuro, na ordem em que a cotação anda); as três últimas são VEREDITOS e
 * recebem as cores de status reservadas. Assim a rosca diz, só pela cor,
 * o que é percurso e o que é desfecho.
 *
 * Medido em 02/09/2026: cada uma das seis passa 3:1 contra o papel branco
 * (3,02 / 5,74 / 12,87 / 4,48 / 4,00 / 4,21). Entre os azuis VIZINHOS a
 * separação fica abaixo de 3:1 — 1,9 entre os dois primeiros —, o que é o
 * máximo que uma rampa de matiz único permite sem invadir os hues
 * reservados. Isso é aceitável aqui porque `CategoryRing` sempre desenha a
 * lista ranqueada nomeada ao lado do anel: a cor nunca é o único
 * diferenciador (1.4.1), e o número exato está escrito.
 */
const STATUS_COLOR: Record<string, string> = {
  draft: 'var(--seq-300)',
  sent: 'var(--seq-450)',
  in_review: 'var(--seq-600)',
  needs_changes: 'var(--status-warning)',
  // Pausada não é veredito nem etapa do caminho de aprovação — é o
  // caminho simplesmente parado. Fecha a rampa sequencial (mais escuro
  // que in_review), em vez de brigar por um hue reservado que não é dela.
  paused: 'var(--seq-700)',
  rejected: 'var(--status-critical)',
  approved: 'var(--status-good)',
}

const STATUS_ORDER = ['draft', 'sent', 'in_review', 'needs_changes', 'paused', 'rejected', 'approved']

/**
 * Rosca de cotações por status, sobre o mesmo componente de anel que
 * "Gastos por categoria" e "Composição da dívida" já usam — mesma
 * espessura, mesma lista ranqueada, mesmo tooltip.
 *
 * O valor de cada fatia é a CONTAGEM, não o dinheiro: "quantas cotações
 * estão em cada estado" é a pergunta do card. O valor recomendado de cada
 * status vai no tooltip, porque é contexto, não a medida.
 */
export function QuoteStatusRing({
  slices,
  labels,
  surface = 'paper',
  height = 220,
}: {
  slices: QuoteStatusSlice[]
  labels: Record<string, string>
  surface?: Surface
  height?: number
}) {
  const ordered = [...slices].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  )

  /**
   * A participação é recalculada aqui sobre DINHEIRO, e não reaproveitada
   * do serviço, que a calcula sobre contagem. O ângulo da fatia sai de
   * `amountCents`; usar um `shareBps` de outra base faria o percentual
   * escrito discordar do desenho — dois status com o mesmo número de
   * cotações e valores muito diferentes mostrariam fatias diferentes com o
   * mesmo "33%".
   */
  const totalCents = ordered.reduce((sum, s) => sum + s.recommendedCents, 0)

  const ringSlices: Slice[] = ordered.map((s, i) => ({
    categoryId: i,
    name: labels[s.status] ?? s.status,
    color: STATUS_COLOR[s.status] ?? 'var(--neutral-mark)',
    /**
     * A fatia mede DINHEIRO (preço recomendado), não contagem. Duas
     * razões: o anel formata `amountCents` como moeda e não aceita outra
     * unidade, e numa página de precificação "R$ 3.013 em revisão contra
     * R$ 674 aprovado" responde mais do que "2 contra 1". A contagem não
     * se perde — vai no tooltip e na tabela, como "Cotações".
     */
    amountCents: s.recommendedCents,
    shareBps: totalCents > 0 ? Math.round((s.recommendedCents / totalCents) * 10_000) : 0,
    transactionCount: s.count,
  }))

  return (
    <CategoryRing
      slices={ringSlices}
      surface={surface}
      height={height}
      totalLabel="Recomendado"
      countLabel="Cotações"
      paddingAngle={1.2}
    />
  )
}

/**
 * Enviado x aprovado por mês — colunas pareadas, a mesma gramática do
 * gráfico de Entradas e saídas da Visão geral: duas séries em reais no
 * MESMO eixo, sem segundo eixo y (o app não tem nenhum), grade e eixos
 * pelos mesmos helpers de tema.
 *
 * Duas ressalvas que o tooltip e o rodapé do card carregam, porque o dado
 * não permite esconder:
 *
 *  - "Enviado" é o preço RECOMENDADO das cotações que saíram do rascunho,
 *    o único valor que toda cotação tem. "Aprovado" é o valor FECHADO.
 *    Então a conversão compara o que se pediu com o que se aceitou, que é
 *    a pergunta útil, mas não é "receita prevista x realizada".
 *  - Uma cotação aprovada é contada no mês em que foi CRIADA, não no mês
 *    em que fechou: não existe coluna de data de aprovação.
 */
export function QuoteSentVsApprovedChart({
  data,
  surface = 'paper',
  height = 240,
}: {
  data: QuotePeriodPoint[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = data.some((d) => d.sentCents > 0 || d.approvedCents > 0)

  const Tip = makeTooltip<QuotePeriodPoint>((point) => ({
    title: fmtPeriod(point.period),
    rows: [
      {
        label: `Enviado (${point.sentCount})`,
        value: money(point.sentCents),
        color: theme.income,
      },
      {
        label: `Aprovado (${point.approvedCount})`,
        value: money(point.approvedCents),
        color: theme.expense,
      },
      {
        label: 'Conversão',
        value: point.conversionBps === null ? 'nada enviado' : bps(point.conversionBps, 0),
      },
    ],
  }))

  return (
    <ChartFrame
      legend={[
        { label: 'Enviado (recomendado)', color: theme.income, shape: 'block' },
        { label: 'Aprovado (fechado)', color: theme.expense, shape: 'block' },
      ]}
      isEmpty={!hasData}
      emptyTitle="Nenhuma cotação no período"
      emptyBody="Salve uma cotação em Simular para ela aparecer aqui."
      table={{
        rows: data.filter((d) => d.sentCount > 0 || d.approvedCount > 0),
        columns: [
          { header: 'Mês', value: (row) => fmtPeriod(row.period) },
          { header: 'Enviado', value: (row) => money(row.sentCents), align: 'right' },
          { header: 'Aprovado', value: (row) => money(row.approvedCents), align: 'right' },
          {
            header: 'Conversão',
            value: (row) => (row.conversionBps === null ? '-' : bps(row.conversionBps, 0)),
            align: 'right',
          },
        ],
      }}
      note="Enviado é o preço recomendado das cotações que saíram do rascunho; aprovado é o valor fechado. Uma cotação aprovada conta no mês em que foi criada, porque a data de aprovação não é registrada."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <BarChart data={data} margin={{ top: 18, right: 8, bottom: 4, left: 0 }} barGap={MARK.surfaceGap}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={fmtPeriod} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={46} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          <Bar dataKey="sentCents" name="Enviado" fill={theme.income} radius={MARK.barRadius} />
          <Bar dataKey="approvedCents" name="Aprovado" fill={theme.expense} radius={MARK.barRadius} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/**
 * Funil de propostas: Criadas -> Enviadas -> Em análise ou além -> Aprovadas.
 * `services/pricing.ts#quoteAnalytics` já calcula essas 4 etapas por
 * inferência de status (não existe log de transição) desde sempre — só
 * nunca tinha um lugar na tela (achado de 09/09/2026, ao reorganizar
 * Precificação). Barra à mão, não Recharts: sem eixo/grade/tooltip
 * cartesiano para justificar a biblioteca, mesma linha de `SpendingHeatmap`.
 */
export function QuoteFunnelChart({ stages, surface = 'paper' }: { stages: QuoteFunnelStage[]; surface?: Surface }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = stages.some((s) => s.count > 0)
  const maxCount = Math.max(1, ...stages.map((s) => s.count))

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Nenhuma cotação ainda"
      emptyBody="Salve uma cotação para o funil aparecer aqui."
      table={{
        caption: 'Cotações por etapa do funil',
        rows: stages,
        columns: [
          { header: 'Etapa', value: (row) => row.label },
          { header: 'Cotações', value: (row) => String(row.count), align: 'right' },
          { header: 'Participação', value: (row) => bps(row.shareBps, 0), align: 'right' },
          { header: 'Queda desde a etapa anterior', value: (row) => String(row.dropFromPreviousCount), align: 'right' },
        ],
      }}
      note="Etapas inferidas do status atual de cada cotação, não de um histórico de transições. Uma cotação que já foi rejeitada e depois reaprovada conta como aprovada, não como reprovada no caminho."
    >
      <div className="stack stack--tight">
        {stages.map((stage, i) => (
          <div key={stage.key} className="stack" style={{ gap: 4 }}>
            <div className="row row--between" style={{ fontSize: 'var(--text-sm)' }}>
              <span>{stage.label}</span>
              <span className="tabular">
                <strong>{stage.count}</strong>
                <span className="muted"> · {bps(stage.shareBps, 0)}</span>
              </span>
            </div>
            <div
              style={{
                height: 10,
                borderRadius: 999,
                background: 'var(--surface-muted)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${maxCount > 0 ? (stage.count / maxCount) * 100 : 0}%`,
                  background: theme.primary,
                  borderRadius: 999,
                }}
              />
            </div>
            {i > 0 && stage.dropFromPreviousCount > 0 && (
              <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                {stage.dropFromPreviousCount} não passaram desta etapa
              </span>
            )}
          </div>
        ))}
      </div>
    </ChartFrame>
  )
}
