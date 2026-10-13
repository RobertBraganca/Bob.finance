import type { AssumptionBag } from '../components/ui'
import { period as fmtPeriod } from './format'

/** O que `/financial-health/net-worth` devolve (decisions/0045): patrimônio pessoal, empresa à parte. */
export type NetWorth = {
  balanceCents: number
  investmentsCents: number
  illiquidCents: number
  financialCents: number
  /** "Quanto você deve" pessoal: dívidas + cartões pessoais */
  debtCents: number
  debtBreakdown: { debtsCents: number; cardsCents: number }
  /** patrimônio PESSOAL: contas pessoais + investimentos − dívida */
  liquidityCents: number
  company: { accountName: string | null; balanceCents: number; cardsCents: number; withdrawableCents: number | null } | null
  assumptions: AssumptionBag
}

export type HistorySource = 'foto' | 'reconstruído'

/** Quais meses do histórico são foto gravada e quais são reconstruídos (decisions/0045). */
export function historyNote(points: Array<{ period: string; source?: HistorySource }> | undefined): string {
  if (!points || points.length === 0) return ''
  const firstPhoto = points.find((p) => p.source === 'foto')
  if (!firstPhoto) return 'Ainda sem foto mensal: todos os meses são reconstruídos com os dados de hoje.'
  const before = points.filter((p) => p.period < firstPhoto.period).length
  return before > 0
    ? `Foto mensal desde ${fmtPeriod(firstPhoto.period)}; os ${before} meses antes dela são reconstruídos.`
    : 'Todos os meses são fotos gravadas no fim do mês.'
}
