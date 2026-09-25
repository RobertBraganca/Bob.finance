import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { bps, money, points } from './format'
import type { AssumptionBag } from '../components/ui/Assumptions'

/* ================================================================== *
 * Insights: avisos temporários e dispensáveis sobre o mês corrente,
 * antes soltos no topo do Painel (`Insights()` em Dashboard.tsx) e
 * movidos para cá em 25/09/2026 a pedido do usuário, para viverem atrás
 * de um sino de notificações único (`NotificationsBell`) em vez de
 * competir por espaço com o resto da tela.
 *
 * Três fontes, cada uma já existia antes desta junção:
 *  - `HomeBanner` (`/home/banners`, goals.ts): teto de gasto geral/
 *    categoria, concentração de categoria, tendência vs. mês anterior.
 *  - `RiskRule` (`/financial-health/risk-radar`): mesmas regras do Radar
 *    de risco da tela Saúde financeira, aqui só as que estão fora da
 *    faixa (`outsideRange`) ou excedem positivamente.
 *  - O item MANUAL do checklist de fechamento mensal
 *    (`/financial-health/closing-checklist`), quando ainda não revisado.
 *
 * Nenhuma fórmula nova: as três rotas já existiam, cada regra já carrega
 * `assumptions`, e nada aqui vira recomendação — Radar de risco e
 * checklist continuam Observação, exatamente como já são nas próprias
 * telas (decisions/0010).
 * ================================================================== */

export type HomeBannerSeverity = 'good' | 'warning' | 'critical'

export type HomeBanner = { id: string; severity: HomeBannerSeverity; assumptions: AssumptionBag } & (
  | { kind: 'spend_cap_exceeded'; spentCents: number; capCents: number }
  | { kind: 'spend_cap_at_risk'; projectedCents: number; capCents: number }
  | { kind: 'category_cap_exceeded'; categoryName: string; spentCents: number; capCents: number }
  | { kind: 'category_cap_at_risk'; categoryName: string; spentCents: number; capCents: number }
  | { kind: 'category_concentration'; categoryName: string; shareBps: number }
  | { kind: 'trend_up'; deltaBps: number }
  | { kind: 'trend_down'; deltaBps: number }
)

export type RiskRule = {
  key: string
  label: string
  valueBps: number
  thresholdBps: number
  unit: 'share' | 'points'
  direction: 'above' | 'below'
  outsideRange: boolean
  exceedsPositively: boolean
  assumptions: AssumptionBag
}

export type ClosingChecklistItem = { key: string; label: string; kind: 'auto' | 'manual'; done: boolean; detail: string }
export type ClosingChecklist = { period: string; items: ClosingChecklistItem[]; reviewedAt: string | null }

export type InsightSeverity = HomeBannerSeverity | 'neutral'

/** Uma forma comum pras três fontes renderizarem no mesmo `Alert`, sem un-cast em cada uso. */
export type InsightItem = {
  id: string
  severity: InsightSeverity
  title: string
  description: string
  assumptions: AssumptionBag
  /** só o Radar de risco e o lembrete de fechamento apontam pra fora do Painel — os banners de gasto já estão na própria tela. */
  linkTo?: string
}

/**
 * Título curto (escaneável) + descrição com o detalhe/números — mesma
 * composição que a própria doc do shadcn usa em todo exemplo (nunca só
 * AlertDescription sozinha: o CSS do componente assume um grid de 2
 * linhas, ícone ocupando as duas via row-span — sem AlertTitle a grade
 * não fecha e o layout sai torto). Moeda/percentual sempre formatados
 * aqui, nunca no backend.
 */
function bannerContent(b: HomeBanner): { title: string; description: string } {
  switch (b.kind) {
    case 'spend_cap_exceeded':
      return {
        title: 'Teto de gasto do mês estourado',
        description: `${money(b.spentCents)} de um teto de ${money(b.capCents)}.`,
      }
    case 'spend_cap_at_risk':
      return {
        title: 'No ritmo de estourar o teto do mês',
        description: `Projeção de fechamento: ${money(b.projectedCents)}, acima do teto de ${money(b.capCents)}.`,
      }
    case 'category_cap_exceeded':
      return {
        title: `Categoria ${b.categoryName} passou do teto`,
        description: `${money(b.spentCents)} de ${money(b.capCents)} usados este mês.`,
      }
    case 'category_cap_at_risk':
      return {
        title: `Categoria ${b.categoryName} no ritmo de passar do teto`,
        description: `${money(b.spentCents)} de ${money(b.capCents)} já usados este mês.`,
      }
    case 'category_concentration':
      return {
        title: `Categoria ${b.categoryName} concentra o gasto do mês`,
        description: `Representa ${bps(b.shareBps, 0)} do total gasto este mês.`,
      }
    case 'trend_up':
      return {
        title: 'Seus gastos estão subindo',
        description: `No ritmo atual, a projeção deste mês é ${bps(b.deltaBps, 0)} maior que o mês passado.`,
      }
    case 'trend_down':
      return {
        title: 'Seus gastos estão em queda',
        description: `No ritmo atual, ${bps(Math.abs(b.deltaBps), 0)} menores que no mês passado.`,
      }
  }
}

/**
 * "Fora da faixa" e "acima da folga" viram Observação aqui do mesmo jeito
 * que já são na própria tela de Saúde financeira (`RiskRow`) — mesma
 * frase, sem duplicar a régua de bom/ruim em dois lugares.
 */
function riskRuleContent(r: RiskRule): { title: string; description: string } {
  const format = r.unit === 'points' ? points : bps
  const comparison = r.direction === 'above' ? 'acima de' : 'abaixo de'
  return {
    title: r.label,
    description: `${format(r.valueBps)}, seu limite: ${comparison} ${format(r.thresholdBps)}.`,
  }
}

function dismissedInsightsKey() {
  // Por data (não um "nunca mais") — mesmo padrão de chave usada em
  // outros lugares deste projeto para "hoje" (new Date().toISOString()).
  return `bob-finance:dismissed-banners:${new Date().toISOString().slice(0, 10)}`
}

export function useInsights() {
  const currentPeriod = new Date().toISOString().slice(0, 7)

  const bannersQuery = useQuery({
    queryKey: ['home-banners'],
    queryFn: () => api.get<{ banners: HomeBanner[] }>('/home/banners'),
  })
  const riskQuery = useQuery({
    queryKey: ['dashboard-risk-radar', currentPeriod],
    queryFn: () => api.get<{ rules: RiskRule[] }>('/financial-health/risk-radar', { period: currentPeriod }),
  })
  const checklistQuery = useQuery({
    queryKey: ['dashboard-closing-checklist', currentPeriod],
    queryFn: () => api.get<ClosingChecklist>('/financial-health/closing-checklist', { period: currentPeriod }),
  })

  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(dismissedInsightsKey())
      return raw ? new Set(JSON.parse(raw)) : new Set()
    } catch {
      return new Set()
    }
  })

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev).add(id)
      try {
        localStorage.setItem(dismissedInsightsKey(), JSON.stringify([...next]))
      } catch {
        // localStorage indisponível (modo privado, etc.) — a dispensa só dura a sessão.
      }
      return next
    })
  }

  const items: InsightItem[] = []

  for (const b of bannersQuery.data?.banners ?? []) {
    const { title, description } = bannerContent(b)
    items.push({ id: b.id, severity: b.severity, title, description, assumptions: b.assumptions })
  }

  for (const r of riskQuery.data?.rules ?? []) {
    if (!r.outsideRange && !r.exceedsPositively) continue
    const { title, description } = riskRuleContent(r)
    items.push({
      id: `risk-${r.key}`,
      severity: r.exceedsPositively ? 'good' : 'warning',
      title,
      description,
      assumptions: r.assumptions,
      linkTo: '/saude',
    })
  }

  const closingItem = checklistQuery.data?.items.find((i) => i.kind === 'manual')
  if (closingItem && !closingItem.done) {
    items.push({
      id: 'closing-checklist',
      severity: 'neutral',
      title: 'Fechamento do mês ainda não revisado',
      description: closingItem.detail,
      assumptions: { formula: 'item manual do checklist de fechamento mensal', origem: 'specs/financial-health' },
      linkTo: '/saude',
    })
  }

  const rank: Record<InsightSeverity, number> = { critical: 0, warning: 1, neutral: 2, good: 3 }
  const visible = items.filter((i) => !dismissed.has(i.id)).sort((a, b) => rank[a.severity] - rank[b.severity])

  return {
    items: visible,
    dismiss,
    isLoading: bannersQuery.isLoading || riskQuery.isLoading || checklistQuery.isLoading,
  }
}
