/**
 * Negócios e clientes (docs/specs/clientes-e-negocios): o que é igual no
 * servidor e na tela, sem banco e sem relógio. Espelho em
 * supabase/functions/_shared/core/deals.ts.
 *
 * Cotação (7 status) e orçamento (agora 6) falam a mesma língua por estes
 * seis estágios. Valores em centavos, períodos em AAAA-MM.
 */

export const DEAL_STAGES = ['draft', 'sent', 'negotiating', 'paused', 'approved', 'rejected'] as const
export type DealStage = (typeof DEAL_STAGES)[number]

export const DEAL_STAGE_LABEL: Record<DealStage, string> = {
  draft: 'Rascunho',
  sent: 'Enviado',
  negotiating: 'Em negociação',
  paused: 'Pausado',
  approved: 'Aprovado',
  rejected: 'Recusado',
}

/** Mesmos tons dos selos: aprovado é o único desfecho bom, recusado o único ruim. */
export const DEAL_STAGE_TONE: Record<DealStage, 'neutral' | 'info' | 'warning' | 'good' | 'critical'> = {
  draft: 'neutral',
  sent: 'info',
  negotiating: 'warning',
  paused: 'neutral',
  approved: 'good',
  rejected: 'critical',
}

export type QuoteStatus = 'draft' | 'sent' | 'in_review' | 'needs_changes' | 'paused' | 'rejected' | 'approved'

/** "Em revisão" e "em ajuste" da cotação são o mesmo momento do negócio: em negociação. */
export function quoteStatusToStage(status: QuoteStatus): DealStage {
  if (status === 'in_review' || status === 'needs_changes') return 'negotiating'
  return status
}

/** O caminho de volta: "em negociação" vira "em revisão" (o primeiro dos dois). */
export function stageToQuoteStatus(stage: DealStage): QuoteStatus {
  return stage === 'negotiating' ? 'in_review' : stage
}

/* ------------------------------------------------------------------ *
 * Métricas por cliente
 * ------------------------------------------------------------------ */

/** Mês AAAA-MM somado (n pode ser negativo). */
function shiftPeriod(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** Meses fechados que formam o MRR de cada cliente recorrente. */
export const MRR_WINDOW_MONTHS = 3
/** Meses diferentes com receita a partir dos quais o cliente conta como recorrente. */
export const RECURRING_MIN_MONTHS = 3
/** Negócios aprovados a partir dos quais o cliente conta como recorrente. */
export const RECURRING_MIN_DEALS = 2

export type ClientMetricsInput = {
  /** mês corrente (AAAA-MM), em America/Sao_Paulo */
  currentPeriod: string
  /** marcado pelo usuário */
  flaggedRecurring: boolean
  /** situação "Contrato encerrado": o histórico fica, mas não há receita recorrente a esperar */
  contractEnded?: boolean
  /** receita que de fato entrou, por mês */
  realizedByPeriod: Map<string, number>
  /** receita a receber ligada ao cliente (pendências) */
  pendingCents: number
  /** valores dos negócios aprovados (orçamentos e cotações) */
  approvedDealCents: number[]
  rejectedDeals: number
  /** valor em aberto: enviado, em negociação ou pausado */
  openPipelineCents: number
  lastRevenueOn: string | null
}

export type ClientMetrics = {
  ltvRealizedCents: number
  /** realizado + a receber */
  ltvForecastCents: number
  monthsWithRevenue: number
  isRecurring: boolean
  /** por que conta como recorrente; null quando não conta */
  recurringReason: 'flag' | 'months' | 'deals' | null
  /** média dos últimos MRR_WINDOW_MONTHS meses fechados; só para recorrente */
  mrrCents: number
  /** receita dos últimos 12 meses fechados (base da concentração) */
  last12Cents: number
  approvedDeals: number
  avgTicketCents: number | null
  /** aprovados ÷ (aprovados + recusados); null sem nenhum decidido */
  approvalRateBps: number | null
  openPipelineCents: number
  lastRevenueOn: string | null
}

export function computeClientMetrics(input: ClientMetricsInput): ClientMetrics {
  let realized = 0
  let months = 0
  for (const cents of input.realizedByPeriod.values()) {
    realized += cents
    if (cents > 0) months += 1
  }
  const approvedDeals = input.approvedDealCents.length
  // Contrato encerrado: deixa de ser recorrente e o MRR zera; LTV e histórico continuam.
  const recurringReason: ClientMetrics['recurringReason'] = input.contractEnded
    ? null
    : input.flaggedRecurring
    ? 'flag'
    : months >= RECURRING_MIN_MONTHS
      ? 'months'
      : approvedDeals >= RECURRING_MIN_DEALS
        ? 'deals'
        : null

  // Só meses FECHADOS: o mês corrente ainda está entrando e puxaria a média para baixo.
  let windowSum = 0
  for (let i = 1; i <= MRR_WINDOW_MONTHS; i++) windowSum += input.realizedByPeriod.get(shiftPeriod(input.currentPeriod, -i)) ?? 0
  let last12 = 0
  for (let i = 1; i <= 12; i++) last12 += input.realizedByPeriod.get(shiftPeriod(input.currentPeriod, -i)) ?? 0

  const decided = approvedDeals + input.rejectedDeals
  return {
    ltvRealizedCents: realized,
    ltvForecastCents: realized + input.pendingCents,
    monthsWithRevenue: months,
    isRecurring: recurringReason !== null,
    recurringReason,
    mrrCents: recurringReason !== null ? Math.round(windowSum / MRR_WINDOW_MONTHS) : 0,
    last12Cents: last12,
    approvedDeals,
    avgTicketCents: approvedDeals > 0 ? Math.round(input.approvedDealCents.reduce((s, c) => s + c, 0) / approvedDeals) : null,
    approvalRateBps: decided > 0 ? Math.round((approvedDeals / decided) * 10_000) : null,
    openPipelineCents: input.openPipelineCents,
    lastRevenueOn: input.lastRevenueOn,
  }
}

export type ClientsOverview = {
  activeClients: number
  leads: number
  recurringClients: number
  mrrCents: number
  ltvRealizedCents: number
  avgLtvCents: number | null
  /** cliente com a maior receita nos últimos 12 meses e a fatia dele; null sem receita */
  concentration: { clientId: number; name: string; shareBps: number } | null
  openPipelineCents: number
}

/** Soma da carteira. Clientes arquivados ficam fora; lead não conta como cliente ativo; contrato encerrado conta no LTV, não no MRR (as métricas dele já vêm sem recorrência). */
export function summarizeClients(
  rows: Array<{ id: number; name: string; kind: 'lead' | 'company' | 'person'; status: 'active' | 'inactive' | 'ended' | 'archived'; metrics: ClientMetrics }>,
): ClientsOverview {
  const live = rows.filter((r) => r.status !== 'archived')
  const customers = live.filter((r) => r.kind !== 'lead')
  const withRevenue = customers.filter((r) => r.metrics.ltvRealizedCents > 0)
  const ltv = customers.reduce((s, r) => s + r.metrics.ltvRealizedCents, 0)
  const total12 = live.reduce((s, r) => s + r.metrics.last12Cents, 0)
  const top = [...live].sort((a, b) => b.metrics.last12Cents - a.metrics.last12Cents)[0]
  return {
    activeClients: customers.filter((r) => r.status === 'active').length,
    leads: live.filter((r) => r.kind === 'lead').length,
    recurringClients: live.filter((r) => r.metrics.isRecurring).length,
    mrrCents: live.reduce((s, r) => s + r.metrics.mrrCents, 0),
    ltvRealizedCents: ltv,
    avgLtvCents: withRevenue.length > 0 ? Math.round(ltv / withRevenue.length) : null,
    concentration:
      top && total12 > 0 && top.metrics.last12Cents > 0
        ? { clientId: top.id, name: top.name, shareBps: Math.round((top.metrics.last12Cents / total12) * 10_000) }
        : null,
    openPipelineCents: live.reduce((s, r) => s + r.metrics.openPipelineCents, 0),
  }
}

/**
 * Qual cliente pagou este lançamento, pelo nome do pagador na descrição. O nome
 * mais longo vence ("kleber de mello" antes de "kleber"), para dois clientes com
 * nomes parecidos não se confundirem. `descriptionNorm` e os nomes já chegam
 * normalizados (minúsculas, sem acento).
 */
export function matchPayer(descriptionNorm: string, aliases: Array<{ clientId: number; alias: string }>): number | null {
  let best: { clientId: number; length: number } | null = null
  for (const a of aliases) {
    if (a.alias.length >= 3 && descriptionNorm.includes(a.alias) && (!best || a.alias.length > best.length)) {
      best = { clientId: a.clientId, length: a.alias.length }
    }
  }
  return best?.clientId ?? null
}
