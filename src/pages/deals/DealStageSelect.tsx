import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { DEAL_STAGES, DEAL_STAGE_LABEL, DEAL_STAGE_TONE, type DealStage } from '@shared/deals'
import { ConfirmDeleteModal, Select, useToast } from '../../components/ui'
import { ApproveProposalModal } from '../proposals/ApproveProposalModal'
import type { ProposalDetail } from '../proposals/types'
import { ApproveQuoteModal, type Quote } from '../Pricing'
import type { Deal } from './types'

/**
 * Estágio do negócio direto na lista ou no quadro (specs/clientes-e-negocios,
 * fases 1 e 4), para orçamento e cotação com os mesmos seis estágios.
 *
 * **Aprovado** nunca é um clique solto: abre o modal de aprovação do próprio
 * documento, porque aprovar grava receitas no extrato. **Sair de Aprovado**
 * pede confirmação: no orçamento, as receitas pendentes saem (e, se alguma já
 * entrou na conta, o servidor recusa, então avisamos antes); na cotação, a
 * receita fica e só o estágio muda.
 *
 * Fica dentro de linha ou cartão clicável: o envoltório segura clique e
 * teclado (o menu abre em portal, mas o evento do React sobe pela árvore).
 */
export function DealStageSelect({ deal }: { deal: Deal }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [approvingProposal, setApprovingProposal] = useState<ProposalDetail | null>(null)
  const [approvingQuote, setApprovingQuote] = useState<Quote | null>(null)
  const [leaving, setLeaving] = useState<{ to: DealStage; pending: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const label = deal.kind === 'proposal' ? (deal.numberLabel ?? 'O orçamento') : `A cotação de ${deal.clientLabel}`

  const setStage = useMutation({
    mutationFn: (stage: DealStage) => api.post<Deal>(`/pricing/deals/${deal.kind}/${deal.id}/stage`, { stage }),
    onSuccess: (_, stage) => {
      toast(`${label}: ${DEAL_STAGE_LABEL[stage].toLowerCase()}`)
      if (deal.stage === 'approved') {
        // Sair de Aprovado pode tirar receitas do extrato: tudo fica velho.
        queryClient.invalidateQueries()
      } else {
        for (const key of ['deals', 'proposals', 'pricing-quotes', 'pricing-quote-analytics', 'clients', 'client', 'proposal']) {
          queryClient.invalidateQueries({ queryKey: [key] })
        }
      }
      setLeaving(null)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao mudar o estágio', 'error'),
  })

  const load = async <T,>(fetcher: () => Promise<T>): Promise<T | null> => {
    setLoading(true)
    try {
      return await fetcher()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'falha ao abrir o negócio', 'error')
      return null
    } finally {
      setLoading(false)
    }
  }
  const proposalDetail = () => load(() => api.get<ProposalDetail>(`/pricing/proposals/${deal.id}`))
  const quoteRow = () =>
    load(async () => {
      const { quotes } = await queryClient.fetchQuery({
        queryKey: ['pricing-quotes'],
        queryFn: () => api.get<{ quotes: Quote[] }>('/pricing/quotes'),
      })
      const found = quotes.find((q) => q.id === deal.id)
      if (!found) throw new Error('cotação não encontrada')
      return found
    })

  const pick = async (next: DealStage | null) => {
    if (!next || next === deal.stage || setStage.isPending || loading) return
    if (next === 'approved') {
      if (deal.kind === 'proposal') {
        const detail = await proposalDetail()
        if (detail) setApprovingProposal(detail)
      } else {
        const quote = await quoteRow()
        if (quote) setApprovingQuote(quote)
      }
      return
    }
    if (deal.stage === 'approved') {
      if (deal.kind === 'proposal') {
        const detail = await proposalDetail()
        if (!detail) return
        const received = detail.receivables.filter((r) => !r.pending).length
        if (received > 0) {
          toast(
            `${received === 1 ? 'Uma receita deste orçamento já entrou na conta' : `${received} receitas deste orçamento já entraram na conta`}: ajuste ou exclua em Lançamentos antes de tirar de Aprovado.`,
            'error',
          )
          return
        }
        setLeaving({ to: next, pending: detail.receivables.length })
      } else {
        setLeaving({ to: next, pending: 0 })
      }
      return
    }
    setStage.mutate(next)
  }

  const toLabel = leaving ? DEAL_STAGE_LABEL[leaving.to].toLowerCase() : ''

  return (
    <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} style={{ display: 'inline-flex' }}>
      <Select
        value={deal.stage}
        ariaLabel={`Estágio de ${deal.title}`}
        className={`select--pill select--${DEAL_STAGE_TONE[deal.stage]}`}
        options={DEAL_STAGES.map((value) => ({ value, label: DEAL_STAGE_LABEL[value] }))}
        onChange={(value) => void pick(value)}
      />
      {approvingProposal && <ApproveProposalModal proposal={approvingProposal} onClose={() => setApprovingProposal(null)} />}
      {approvingQuote && <ApproveQuoteModal quote={approvingQuote} onClose={() => setApprovingQuote(null)} />}
      {leaving && (
        <ConfirmDeleteModal
          title={deal.kind === 'proposal' ? `Voltar ${label} para ${toLabel}?` : `Tirar a cotação de ${deal.clientLabel} de aprovada?`}
          body={
            deal.kind === 'proposal'
              ? leaving.pending === 0
                ? 'Este orçamento não tem receita a receber no extrato. Para aprovar de novo, use o menu ou o detalhe.'
                : `${leaving.pending === 1 ? 'A receita a receber sai' : `As ${leaving.pending} receitas a receber saem`} do extrato. Para aprovar de novo, use o menu ou o detalhe.`
              : `Ela passa para ${toLabel}. A receita que a aprovação criou continua no extrato; para aprovar de novo, exclua antes essa receita em Lançamentos (senão ela ficaria duplicada).`
          }
          confirmLabel={`Mudar para ${toLabel}`}
          pending={setStage.isPending}
          onCancel={() => setLeaving(null)}
          onConfirm={() => setStage.mutate(leaving.to)}
        />
      )}
    </span>
  )
}
