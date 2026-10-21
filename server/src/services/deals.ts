import { db, type DbExecutor } from '../db/client'
import { clients, projectQuotes, serviceProposalItems, serviceProposals } from '../db/schema'
import { asc, eq, inArray } from 'drizzle-orm'
import { addMonths, periodRange, todayIso } from '../core/dates'
import { normalizeDescription } from '../core/normalize'
import { formatProposalNumber, proposalTotals } from '../core/proposals'
import { DEAL_STAGES, quoteStatusToStage, stageToQuoteStatus, type DealStage, type QuoteStatus } from '../core/deals'
import { PricingError, setQuoteStatus } from './pricing'
import { setProposalStatus } from './proposals'

/**
 * Negócios (docs/specs/clientes-e-negocios, fase 4): cotações e orçamentos
 * numa lista só, com os seis estágios de `shared/deals.ts`. Não cria uma
 * tabela nova: cada negócio continua sendo a cotação ou o orçamento que já
 * existe, e mudar o estágio chama a mesma regra de cada um (aprovar nunca é
 * por aqui, porque grava receitas no extrato; vai pela aprovação).
 */

export type DealKind = 'proposal' | 'quote'

export type Deal = {
  kind: DealKind
  id: number
  /** "#0002" no orçamento; null na cotação */
  numberLabel: string | null
  title: string
  /** o nome no documento (texto livre) */
  clientLabel: string
  clientId: number | null
  clientName: string | null
  stage: DealStage
  /** o status próprio do documento (a cotação tem "em revisão" e "em ajuste") */
  rawStatus: string
  valueCents: number
  createdAt: string
  updatedAt: string
}

export type DealFilter = { q?: string; kind?: DealKind; stages?: DealStage[]; clientId?: number }

export async function listDeals(filter: DealFilter = {}, executor: DbExecutor = db): Promise<Deal[]> {
  const clientRows = await executor.select({ id: clients.id, name: clients.name }).from(clients)
  const clientName = new Map(clientRows.map((c) => [c.id, c.name] as const))
  const deals: Deal[] = []

  if (filter.kind !== 'quote') {
    const proposals = await executor.select().from(serviceProposals).orderBy(asc(serviceProposals.id))
    const ids = proposals.map((p) => p.id)
    const items = ids.length > 0 ? await executor.select().from(serviceProposalItems).where(inArray(serviceProposalItems.proposalId, ids)) : []
    const itemsBy = new Map<number, typeof items>()
    for (const item of items) {
      const list = itemsBy.get(item.proposalId)
      if (list) list.push(item)
      else itemsBy.set(item.proposalId, [item])
    }
    for (const p of proposals) {
      const { totalCents } = proposalTotals(itemsBy.get(p.id) ?? [], p.discountBps)
      deals.push({
        kind: 'proposal',
        id: p.id,
        numberLabel: formatProposalNumber(p.number),
        title: p.title,
        clientLabel: p.clientLabel,
        clientId: p.clientId,
        clientName: p.clientId !== null ? (clientName.get(p.clientId) ?? null) : null,
        stage: p.status as DealStage,
        rawStatus: p.status,
        valueCents: p.status === 'approved' ? (p.approvedAmountCents ?? totalCents) : totalCents,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })
    }
  }

  if (filter.kind !== 'proposal') {
    const quotes = await executor.select().from(projectQuotes).orderBy(asc(projectQuotes.id))
    for (const q of quotes) {
      deals.push({
        kind: 'quote',
        id: q.id,
        numberLabel: null,
        title: q.clientLabel,
        clientLabel: q.clientLabel,
        clientId: q.clientId,
        clientName: q.clientId !== null ? (clientName.get(q.clientId) ?? null) : null,
        stage: quoteStatusToStage(q.status as QuoteStatus),
        rawStatus: q.status,
        valueCents: q.actualPriceCents ?? q.recommendedPriceCents,
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
      })
    }
  }

  const q = filter.q ? normalizeDescription(filter.q) : ''
  return deals
    .filter(
      (d) =>
        (!filter.stages || filter.stages.length === 0 || filter.stages.includes(d.stage)) &&
        (filter.clientId === undefined || d.clientId === filter.clientId) &&
        (!q || normalizeDescription(`${d.title} ${d.clientLabel} ${d.clientName ?? ''} ${d.numberLabel ?? ''}`).includes(q)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Os números do topo, somando cotações e orçamentos: em aberto (enviado e em
 * negociação), aprovado no ano (pela data de criação, como a aba Orçamentos já
 * fazia) e a taxa de aprovação entre os decididos.
 */
export async function dealsSummary(executor: DbExecutor = db) {
  const all = await listDeals({}, executor)
  const year = todayIso().slice(0, 4)
  const byStage = Object.fromEntries(DEAL_STAGES.map((s) => [s, { count: 0, valueCents: 0 }])) as Record<DealStage, { count: number; valueCents: number }>
  let approvedYearCents = 0
  for (const d of all) {
    byStage[d.stage].count += 1
    byStage[d.stage].valueCents += d.valueCents
    if (d.stage === 'approved' && d.createdAt.startsWith(year)) approvedYearCents += d.valueCents
  }
  const decided = byStage.approved.count + byStage.rejected.count
  return {
    openCents: byStage.sent.valueCents + byStage.negotiating.valueCents,
    openCount: byStage.sent.count + byStage.negotiating.count,
    approvedYearCents,
    year: Number(year),
    approvalRateBps: decided > 0 ? Math.round((byStage.approved.count / decided) * 10_000) : null,
    decidedCount: decided,
    byStage,
    assumptions: {
      emAberto: 'soma de cotações e orçamentos enviados ou em negociação',
      aprovadoNoAno: 'valor fechado dos aprovados criados no ano corrente',
      taxa: 'aprovados ÷ (aprovados + recusados), cotações e orçamentos juntos',
    },
  }
}

/**
 * Painel de Precificação: as três leituras que a aba Cotações fazia só com
 * cotações (estágio, mês e funil), agora com orçamentos e cotações juntos.
 *
 * Mesmas limitações de antes, declaradas em `assumptions`: o documento guarda
 * o estágio ATUAL, não o histórico, então o funil é inferido ("para estar
 * aprovado, foi enviado"); e o mês é o de criação, porque não existe data de
 * aprovação gravada no documento.
 */
export async function dealsAnalytics(monthsBack = 12, executor: DbExecutor = db) {
  const all = await listDeals({}, executor)
  const total = all.length

  const byStage = DEAL_STAGES.map((stage) => {
    const own = all.filter((d) => d.stage === stage)
    const valueCents = own.reduce((sum, d) => sum + d.valueCents, 0)
    return { status: stage, count: own.length, recommendedCents: valueCents, actualCents: valueCents, shareBps: total > 0 ? Math.round((own.length / total) * 10_000) : 0 }
  }).filter((slice) => slice.count > 0)

  const current = todayIso().slice(0, 7)
  const first = addMonths(current, -(monthsBack - 1))
  const byPeriod = periodRange(first, current).map((period) => {
    const own = all.filter((d) => d.createdAt.slice(0, 7) === period)
    const sent = own.filter((d) => d.stage !== 'draft')
    const approved = own.filter((d) => d.stage === 'approved')
    const sentCents = sent.reduce((sum, d) => sum + d.valueCents, 0)
    const approvedCents = approved.reduce((sum, d) => sum + d.valueCents, 0)
    return {
      period,
      sentCents,
      sentCount: sent.length,
      approvedCents,
      approvedCount: approved.length,
      conversionBps: sentCents > 0 ? Math.round((approvedCents / sentCents) * 10_000) : null,
    }
  })

  const beyondSent: DealStage[] = ['negotiating', 'paused', 'approved', 'rejected']
  const steps = [
    { key: 'created', label: 'Criados', count: total },
    { key: 'sent', label: 'Enviados', count: all.filter((d) => d.stage !== 'draft').length },
    { key: 'negotiated', label: 'Com retorno', count: all.filter((d) => beyondSent.includes(d.stage)).length },
    { key: 'approved', label: 'Aprovados', count: all.filter((d) => d.stage === 'approved').length },
  ]
  const funnel = steps.map((s, i) => ({
    ...s,
    shareBps: total > 0 ? Math.round((s.count / total) * 10_000) : 0,
    dropFromPreviousCount: i === 0 ? 0 : Math.max(0, steps[i - 1]!.count - s.count),
  }))

  return {
    byStage,
    byPeriod,
    funnel,
    totalCount: total,
    assumptions: {
      formula: 'cotações e orçamentos juntos, agrupados por estágio, por mês de criação e por etapa acumulada do funil',
      negociosConsiderados: total,
      janela: `${monthsBack} meses, de ${first} a ${current}`,
      valor: 'orçamento: o total (o valor aprovado, quando aprovado); cotação: o valor fechado, ou o recomendado se ainda não fechou',
      funilEInferido: 'o documento guarda o estágio atual, não o histórico: "chegou até a etapa" é inferido (para estar aprovado, foi enviado). O funil não diz quantos voltaram atrás',
      mesDeCriacao: 'um negócio aprovado conta no mês em que foi criado, porque a data de aprovação não fica no documento',
    },
  }
}

/**
 * Muda o estágio de um negócio pela regra do próprio documento. Aprovar é
 * recusado aqui de propósito: gera receitas e pede conta e data. `null` quando
 * o documento não existe (a rota responde 404).
 */
export async function setDealStage(kind: DealKind, id: number, stage: DealStage) {
  if (stage === 'approved') throw new PricingError('para aprovar, use a aprovação: ela gera as receitas e pede a conta e a data')
  if (kind === 'proposal') {
    const updated = await setProposalStatus(id, stage)
    if (!updated) return null
  } else {
    const updated = await setQuoteStatus(id, stageToQuoteStatus(stage))
    if (!updated) return null
  }
  return (await listDeals({ kind })).find((d) => d.id === id) ?? null
}
