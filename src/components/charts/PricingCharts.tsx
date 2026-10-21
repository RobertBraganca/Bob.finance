import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisMoney, bps, money, period as fmtPeriod } from '../../lib/format'
import { MARK, axisProps, gridProps, themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'
import { CategoryRing, type Slice } from './CategoryRing'

export type DealFunnelStage = {
  key: string
  label: string
  count: number
  shareBps: number
  dropFromPreviousCount: number
}

export type DealStageSlice = {
  status: string
  count: number
  recommendedCents: number
  actualCents: number
  shareBps: number
}

export type DealPeriodPoint = {
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
  // Estágio unificado (specs/clientes-e-negocios): o mesmo âmbar do selo "Em negociação".
  negotiating: 'var(--status-warning)',
  in_review: 'var(--seq-600)',
  needs_changes: 'var(--status-warning)',
  // Pausada não é veredito nem etapa do caminho de aprovação — é o
  // caminho simplesmente parado. Fecha a rampa sequencial (mais escuro
  // que in_review), em vez de brigar por um hue reservado que não é dela.
  paused: 'var(--seq-700)',
  rejected: 'var(--status-critical)',
  approved: 'var(--status-good)',
}

const STATUS_ORDER = ['draft', 'sent', 'negotiating', 'in_review', 'needs_changes', 'paused', 'rejected', 'approved']

/**
 * Rosca de cotações por status, sobre o mesmo componente de anel que
 * "Gastos por categoria" e "Composição da dívida" já usam — mesma
 * espessura, mesma lista ranqueada, mesmo tooltip.
 *
 * O valor de cada fatia é a CONTAGEM, não o dinheiro: "quantas cotações
 * estão em cada estado" é a pergunta do card. O valor recomendado de cada
 * status vai no tooltip, porque é contexto, não a medida.
 */
export function DealStageRing({
  slices,
  labels,
  surface = 'paper',
  height = 220,
}: {
  slices: DealStageSlice[]
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
      totalLabel="Valor"
      countLabel="Negócios"
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
export function DealSentVsApprovedChart({
  data,
  surface = 'paper',
  height = 240,
}: {
  data: DealPeriodPoint[]
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const hasData = data.some((d) => d.sentCents > 0 || d.approvedCents > 0)

  const Tip = makeTooltip<DealPeriodPoint>((point) => ({
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
        { label: 'Enviado', color: theme.income, shape: 'block' },
        { label: 'Aprovado', color: theme.expense, shape: 'block' },
      ]}
      isEmpty={!hasData}
      emptyTitle="Nenhum negócio no período"
      emptyBody="Orçamentos e cotações enviados aparecem aqui, no mês em que foram criados."
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
      note="Enviado soma os orçamentos e cotações que saíram do rascunho; aprovado, o valor fechado dos aprovados. Um negócio aprovado conta no mês em que foi criado, porque a data de aprovação não fica no documento."
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <BarChart data={data} margin={{ top: 18, right: 8, bottom: 4, left: 0 }} barGap={MARK.surfaceGap}>
          <CartesianGrid {...gridProps(theme)} />
          <XAxis dataKey="period" tickFormatter={fmtPeriod} {...axisProps(theme)} />
          <YAxis tickFormatter={(v: number) => axisMoney(v)} width={46} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          <Bar isAnimationActive={false} dataKey="sentCents" name="Enviado" fill={theme.income} radius={MARK.barRadius} />
          <Bar isAnimationActive={false} dataKey="approvedCents" name="Aprovado" fill={theme.expense} radius={MARK.barRadius} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/**
 * Funil de negócios: Criados -> Enviados -> Com retorno -> Aprovados, em
 * barras horizontais na mesma gramática do resto do app (moldura, grade,
 * eixo, tooltip e tabela de `ChartFrame`, como `AllocationChart`), não mais
 * em barras desenhadas à mão. As etapas do caminho seguem a rampa
 * sequencial da rosca (do claro ao escuro, na ordem em que o negócio anda) e
 * só "Aprovados" leva o verde de desfecho bom, para cor e estágio lerem igual
 * nos dois cards lado a lado.
 *
 * As etapas são inferidas do estágio atual (não existe log de transição), e
 * "Criados" só aparece quando há rascunho: sem nenhum, ele repetiria
 * "Enviados" e a primeira barra não diria nada.
 */
const FUNNEL_COLOR: Record<string, string> = {
  created: 'var(--seq-300)',
  sent: 'var(--seq-450)',
  negotiated: 'var(--seq-600)',
  approved: 'var(--status-good)',
}

export function DealFunnelChart({ stages, surface = 'paper' }: { stages: DealFunnelStage[]; surface?: Surface }) {
  const theme = themeFor(useEffectiveSurface(surface))
  const created = stages.find((s) => s.key === 'created')
  const sent = stages.find((s) => s.key === 'sent')
  const rows = created && sent && created.count === sent.count ? stages.filter((s) => s.key !== 'created') : stages
  const base = rows[0]?.count ?? 0
  const data = rows.map((s) => ({ ...s, ofBaseBps: base > 0 ? Math.round((s.count / base) * 10_000) : 0 }))
  const hasData = stages.some((s) => s.count > 0)
  // Alto o bastante para parear com a rosca ao lado (as duas ficam na mesma linha do Painel).
  const height = Math.max(260, data.length * 64 + 40)

  const Tip = makeTooltip<(typeof data)[number]>((row) => ({
    title: row.label,
    rows: [
      { label: 'Negócios', value: String(row.count), color: FUNNEL_COLOR[row.key] },
      { label: `Do total de ${rows[0]?.label.toLowerCase() ?? ''}`, value: bps(row.ofBaseBps, 0) },
      ...(row.dropFromPreviousCount > 0 ? [{ label: 'Pararam na etapa anterior', value: String(row.dropFromPreviousCount) }] : []),
    ],
  }))

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Nenhum negócio ainda"
      emptyBody="Crie um orçamento ou salve uma cotação para o funil aparecer aqui."
      table={{
        caption: 'Negócios por etapa do funil',
        rows: data,
        columns: [
          { header: 'Etapa', value: (row) => row.label },
          { header: 'Negócios', value: (row) => String(row.count), align: 'right' },
          { header: `Do total de ${rows[0]?.label.toLowerCase() ?? ''}`, value: (row) => bps(row.ofBaseBps, 0), align: 'right' },
          { header: 'Pararam na etapa anterior', value: (row) => String(row.dropFromPreviousCount), align: 'right' },
        ],
      }}
      note={`Etapas inferidas do estágio atual, não de um histórico.${rows.length < stages.length ? ' Sem rascunhos, "Criados" seria igual a "Enviados" e fica de fora.' : ''} Com retorno: em negociação, pausado, aprovado ou recusado.`}
    >
      <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 6, right: 64, bottom: 4, left: 4 }}>
          <CartesianGrid {...gridProps(theme)} vertical horizontal={false} />
          <XAxis
            type="number"
            domain={[0, Math.max(1, base)]}
            ticks={[...new Set([0, Math.round(base / 2), Math.max(1, base)])]}
            allowDecimals={false}
            {...axisProps(theme)}
          />
          <YAxis type="category" dataKey="label" width={96} {...axisProps(theme)} />
          <Tooltip content={<Tip />} cursor={{ fill: theme.grid, opacity: 0.45 }} />
          <Bar isAnimationActive={false} dataKey="count" maxBarSize={MARK.barMaxWidth} radius={MARK.barRadius}>
            {data.map((row) => (
              <Cell key={row.key} fill={FUNNEL_COLOR[row.key] ?? theme.primary} />
            ))}
            <LabelList
              dataKey="ofBaseBps"
              position="right"
              formatter={(value: unknown) => bps(Number(value), 0)}
              fill={theme.axisText}
              fontSize={11}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
