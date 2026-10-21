import type { DealStage } from '@shared/deals'

/** Um negócio como `/pricing/deals` devolve: orçamento ou cotação, no mesmo formato. */
export type DealKind = 'proposal' | 'quote'

export type Deal = {
  kind: DealKind
  id: number
  numberLabel: string | null
  title: string
  clientLabel: string
  clientId: number | null
  clientName: string | null
  stage: DealStage
  rawStatus: string
  valueCents: number
  createdAt: string
  updatedAt: string
}

export type DealsSummary = {
  openCents: number
  openCount: number
  approvedYearCents: number
  year: number
  approvalRateBps: number | null
  decidedCount: number
  byStage: Record<DealStage, { count: number; valueCents: number }>
  assumptions: { emAberto: string; aprovadoNoAno: string; taxa: string }
}

export const DEAL_KIND_LABEL: Record<DealKind, string> = { proposal: 'Orçamento', quote: 'Cotação' }
