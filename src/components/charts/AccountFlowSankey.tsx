import { useMemo, useState } from 'react'
import { ResponsiveContainer, Sankey, Tooltip } from 'recharts'
import { money } from '../../lib/format'
import { seriesColor, themeFor, type ChartTheme, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, ChartTooltip } from './frame'
import { Icon } from '../ui/Icon'
import {
  accountsInGraph,
  buildAccountFlowGraph,
  type FlowEdge,
  type FlowGraphLink,
  type FlowGraphNode,
} from '@shared/accountFlowGraph'

/**
 * Where the money actually went between the user's own accounts.
 *
 * This replaced a radar of entradas/saídas per account. The radar compared
 * shapes; it could not show the one thing this feature is about, which is
 * the PAIRING: which account sent to which. The pairing already exists in
 * `services/transfers.ts` (an edge per ordered pair, with the leg count) and
 * the radar was collapsing it back down to a per-account total in order to
 * have axes to draw.
 *
 * Two behaviours differ from the radar, both on purpose:
 *
 *  - Unpaired legs are NOT drawn. They have no counterpart, so they have no
 *    direction; the radar folded them into the per-account totals, which a
 *    diagram of "from where to where" cannot honestly do. They keep their own
 *    list below, and the summary line still reports their value.
 *  - Each account can appear twice, once per column. See the note in
 *    `shared/accountFlowGraph.ts`: every account pair here moves money both
 *    ways, so one node per account would make the graph cyclic.
 */

export type FlowNode = { id: number; name: string; institution: string; kind: string }
export type { FlowEdge }
export type LooseLeg = {
  accountId: number
  accountName: string
  direction: 'out' | 'in'
  institution: string | null
  amountCents: number
  count: number
}

/** Colour follows the account, so the same account matches across columns. */
const colorOf = (theme: ChartTheme, accountId: number) => seriesColor(theme, accountId)

export function AccountFlowSankey({
  edges,
  loose,
  totals,
  surface = 'paper',
  height = 360,
}: {
  nodes?: FlowNode[]
  edges: FlowEdge[]
  loose: LooseLeg[]
  totals: { internalCents: number; internalCount: number; looseCents: number; looseCount: number; pairedBps: number }
  surface?: Surface
  height?: number
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const [showLoose, setShowLoose] = useState(false)

  const graph = useMemo(() => buildAccountFlowGraph(edges), [edges])
  const accounts = useMemo(() => accountsInGraph(graph), [graph])

  const data = useMemo(
    () => ({
      nodes: graph.nodes.map((node) => ({ ...node, color: colorOf(theme, node.accountId) })),
      links: graph.links.map((link) => ({ ...link, color: colorOf(theme, link.fromAccountId) })),
    }),
    [graph, theme],
  )

  return (
    <ChartFrame
      legend={accounts.map((account) => ({
        label: account.name,
        color: colorOf(theme, account.accountId),
        shape: 'block' as const,
      }))}
      isEmpty={graph.links.length === 0}
      emptyTitle="Sem transferências pareadas no período"
      emptyBody="Assim que uma saída de uma conta encontrar a entrada correspondente em outra, o caminho do dinheiro aparece aqui."
      table={{
        caption: 'Transferências pareadas, por origem e destino',
        rows: graph.links,
        columns: [
          { header: 'De', value: (row) => row.fromName },
          { header: 'Para', value: (row) => row.toName },
          { header: 'Pernas', value: (row) => `${row.count}x`, align: 'right' },
          { header: 'Valor', value: (row) => money(row.amountCents), align: 'right' },
        ],
      }}
      /* The summary line is unchanged from the radar: same source of truth,
         same wording, only the drawing above it changed. */
      note={
        totals.looseCount > 0
          ? `${money(totals.internalCents)} pareados em ${totals.internalCount} transferências (${(totals.pairedBps / 100).toFixed(0)}% das pernas de transferência). ${money(totals.looseCents)} em ${totals.looseCount} pernas não encontraram uma contraparte no período, normalmente por faltar o extrato do outro lado, ou por serem pagamentos a instituições fora da carteira.`
          : `${money(totals.internalCents)} pareados em ${totals.internalCount} transferências.`
      }
    >
      <ResponsiveContainer width="100%" height={height}>
        <Sankey
          data={data}
          nameKey="name"
          nodePadding={22}
          nodeWidth={12}
          iterations={64}
          margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          node={(props) => <FlowNodeShape {...props} theme={theme} />}
          link={<FlowLinkShape />}
        >
          <Tooltip content={<FlowTooltip theme={theme} />} />
        </Sankey>
      </ResponsiveContainer>

      {loose.length > 0 && (
        <div>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => setShowLoose((v) => !v)}
            aria-pressed={showLoose}
          >
            <Icon name={showLoose ? 'chevronDown' : 'chevronRight'} size={13} />
            {showLoose ? 'Ocultar' : 'Ver'} pernas sem par ({loose.length})
          </button>
          {showLoose && (
            <ul className="ranked" style={{ marginTop: 'var(--sp-2)' }}>
              {loose.slice(0, 12).map((leg, i) => (
                <li key={i} className="ranked__item" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}>
                  <span className="truncate">
                    {leg.accountName} {leg.direction === 'out' ? '→' : '←'}{' '}
                    {leg.institution ?? 'instituição não identificada'}
                  </span>
                  <span className="ranked__share">{leg.count}x</span>
                  <span className="ranked__value">{money(leg.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ChartFrame>
  )
}

type RenderedNode = FlowGraphNode & { color: string }

/**
 * The node bar plus its account name. The label sits outside the column it
 * belongs to (right of the source bars, left of the target bars) so it never
 * overlaps a ribbon.
 */
function FlowNodeShape(props: { theme: ChartTheme } & Record<string, unknown>) {
  // Recharts types the render prop against its own SankeyNode; the fields
  // this app put on the datum survive the layout pass but not the type.
  const { x, y, width, height, payload, theme } = props as unknown as {
    x: number
    y: number
    width: number
    height: number
    payload: RenderedNode
    theme: ChartTheme
  }
  const isSource = payload.side === 'source'
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={payload.color} rx={2} />
      <text
        x={isSource ? x + width + 8 : x - 8}
        y={y + height / 2}
        textAnchor={isSource ? 'start' : 'end'}
        dominantBaseline="middle"
        fill={theme.axisText}
        fontSize={11}
      >
        {payload.name}
      </text>
    </g>
  )
}

/**
 * The ribbon. Thickness is `linkWidth`, which recharts derives from the
 * link's `value` (integer cents), so the drawn width is proportional to the
 * paired amount in that direction.
 */
function FlowLinkShape(props: unknown) {
  const {
    sourceX,
    targetX,
    sourceY,
    targetY,
    sourceControlX,
    targetControlX,
    linkWidth,
    payload,
  } = props as {
    sourceX: number
    targetX: number
    sourceY: number
    targetY: number
    sourceControlX: number
    targetControlX: number
    linkWidth: number
    payload: { color?: string }
  }

  return (
    <path
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={payload.color ?? '#a1a1aa'}
      strokeWidth={linkWidth}
      strokeOpacity={0.34}
      style={{ transition: 'stroke-opacity 120ms ease' }}
      onMouseEnter={(event) => event.currentTarget.setAttribute('stroke-opacity', '0.62')}
      onMouseLeave={(event) => event.currentTarget.setAttribute('stroke-opacity', '0.34')}
    />
  )
}

/**
 * Recharts hands a Sankey tooltip either a node or a link. Everything the
 * link row needs travels on the link datum itself, so this never has to
 * resolve indices back to nodes.
 */
function FlowTooltip({
  active,
  payload,
  theme,
}: {
  active?: boolean
  payload?: Array<{ payload?: unknown }>
  theme: ChartTheme
}) {
  if (!active || !payload || payload.length === 0) return null
  const datum = payload[0]?.payload as Partial<FlowGraphLink & RenderedNode & { payload?: unknown }> | undefined
  // Recharts nests the original datum one level deeper for Sankey.
  const item = (datum && 'fromName' in datum) || (datum && 'side' in datum)
    ? datum
    : ((datum?.payload ?? {}) as Partial<FlowGraphLink & RenderedNode>)
  if (!item) return null

  if ('fromName' in item && item.fromName !== undefined) {
    const link = item as FlowGraphLink
    return (
      <ChartTooltip
        title={`${link.fromName} para ${link.toName}`}
        rows={[
          { label: 'Valor pareado', value: money(link.amountCents), color: colorOf(theme, link.fromAccountId) },
          { label: 'Pernas', value: `${link.count}` },
        ]}
      />
    )
  }

  if ('side' in item && item.side !== undefined) {
    const node = item as RenderedNode
    return (
      <ChartTooltip
        title={node.name}
        rows={[
          {
            label: node.side === 'source' ? 'Enviado no período' : 'Recebido no período',
            value: money(node.totalCents),
            color: colorOf(theme, node.accountId),
          },
          { label: 'Pernas', value: `${node.count}` },
        ]}
      />
    )
  }

  return null
}
