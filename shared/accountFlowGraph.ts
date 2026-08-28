/**
 * Turns the paired account-to-account edges into the node/link graph a
 * Sankey can lay out.
 *
 * TWO COLUMNS, NOT ONE. Each account gets up to two nodes: one on the
 * source side and one on the target side, even though it is the same
 * account. That is not a stylistic choice, it is what makes the graph
 * acyclic: in this ledger EVERY pair of accounts that moves money moves it
 * in both directions (PJ sends pró-labore to PF, PF occasionally sends back),
 * so a single-node-per-account model would produce a cycle for every pair
 * and no Sankey layout can order that.
 *
 * The colour and the label follow the ACCOUNT, so the same account reads as
 * the same thing on both sides; only its position differs.
 *
 * Pure and dependency-free on purpose: `scripts/verify.ts` checks the graph
 * invariants against the real pairing output without rendering anything.
 */

export type FlowEdge = {
  fromAccountId: number
  fromName: string
  toAccountId: number
  toName: string
  amountCents: number
  count: number
}

export type FlowGraphNode = {
  /** the label recharts reads through `nameKey` */
  name: string
  accountId: number
  side: 'source' | 'target'
  /** everything this node sends (source side) or receives (target side) */
  totalCents: number
  /** how many paired legs make up that total */
  count: number
}

export type FlowGraphLink = {
  /** index into `nodes`, as recharts' Sankey requires */
  source: number
  target: number
  /** recharts reads the thickness from here; integer cents, never a float */
  value: number
  fromAccountId: number
  toAccountId: number
  fromName: string
  toName: string
  amountCents: number
  count: number
}

export type FlowGraph = { nodes: FlowGraphNode[]; links: FlowGraphLink[] }

/**
 * `edges` must be the PAIRED edges only. Unpaired legs have no counterpart
 * by definition, so they have no direction to draw and never enter the
 * graph; they stay in their own list (see the "pernas sem par" section).
 */
export function buildAccountFlowGraph(edges: readonly FlowEdge[]): FlowGraph {
  const nodes: FlowGraphNode[] = []
  const sourceIndex = new Map<number, number>()
  const targetIndex = new Map<number, number>()

  const nodeFor = (
    side: 'source' | 'target',
    accountId: number,
    name: string,
  ): number => {
    const index = side === 'source' ? sourceIndex : targetIndex
    const existing = index.get(accountId)
    if (existing !== undefined) return existing
    const created = nodes.length
    nodes.push({ name, accountId, side, totalCents: 0, count: 0 })
    index.set(accountId, created)
    return created
  }

  const links: FlowGraphLink[] = []

  for (const edge of edges) {
    // A zero-value edge has no thickness to draw and would divide by zero in
    // the layout. The pairing never produces one, but the graph should not
    // depend on that.
    if (edge.amountCents <= 0) continue

    const source = nodeFor('source', edge.fromAccountId, edge.fromName)
    const target = nodeFor('target', edge.toAccountId, edge.toName)

    nodes[source]!.totalCents += edge.amountCents
    nodes[source]!.count += edge.count
    nodes[target]!.totalCents += edge.amountCents
    nodes[target]!.count += edge.count

    links.push({
      source,
      target,
      value: edge.amountCents,
      fromAccountId: edge.fromAccountId,
      toAccountId: edge.toAccountId,
      fromName: edge.fromName,
      toName: edge.toName,
      amountCents: edge.amountCents,
      count: edge.count,
    })
  }

  return { nodes, links }
}

/** Every distinct account in the graph, for the legend. */
export function accountsInGraph(graph: FlowGraph): Array<{ accountId: number; name: string }> {
  const seen = new Map<number, string>()
  for (const node of graph.nodes) if (!seen.has(node.accountId)) seen.set(node.accountId, node.name)
  return [...seen.entries()].map(([accountId, name]) => ({ accountId, name }))
}
