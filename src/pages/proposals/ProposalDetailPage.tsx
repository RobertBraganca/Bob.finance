import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { supabase } from '../../lib/supabaseClient'
import { bps, date as fmtDate, money } from '../../lib/format'
import { lineTotalCents } from '@shared/proposals'
import { Button, Card, ConfirmDeleteModal, EmptyState, SkeletonLines, useToast } from '../../components/ui'
import { PageHeader } from '../../components/shell/Shell'
import { ApproveProposalModal } from './ApproveProposalModal'
import { ProposalStatusBadge } from './ProposalStatusBadge'
import { formatQuantity, type IssuerSettings, type ProposalDetail } from './types'

/** Baixa a logo do bucket privado por um link de dois minutos. Falhou: o PDF sai sem ela. */
async function loadLogo(path: string | null) {
  if (!path) return null
  const signed = await supabase.storage.from('proposal-assets').createSignedUrl(path, 120)
  if (signed.error || !signed.data) return null
  const response = await fetch(signed.data.signedUrl)
  if (!response.ok) return null
  const type: 'png' | 'jpg' = /\.png$/i.test(path) || response.headers.get('content-type')?.includes('png') ? 'png' : 'jpg'
  return { bytes: await response.arrayBuffer(), type }
}

/**
 * Detalhe do orçamento (decisions/0040). A ação principal muda com o
 * status: rascunho compartilha (e vira enviado), enviado aprova, aprovado
 * compartilha de novo e mostra as receitas geradas, recusado duplica.
 */
export function ProposalDetailPage() {
  const { id } = useParams()
  const proposalId = Number(id)
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [approving, setApproving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const detail = useQuery({
    queryKey: ['proposals', 'detail', proposalId],
    queryFn: () => api.get<ProposalDetail>(`/pricing/proposals/${proposalId}`),
  })
  const issuer = useQuery({
    queryKey: ['proposals', 'issuer'],
    queryFn: () => api.get<IssuerSettings>('/pricing/proposal-issuer'),
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['proposals'] })

  // Esta tela existe para mandar o PDF: o gerador (pesado, carregado sob
  // demanda) começa a baixar quando o navegador fica ocioso, e o
  // "Compartilhar" não espera o download depois do clique.
  useEffect(() => {
    if (!detail.data) return
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500))
    const handle = idle(() => {
      void import('../../lib/proposalPdf')
    })
    return () => (window.cancelIdleCallback ?? window.clearTimeout)(handle)
  }, [detail.data])

  const share = useMutation({
    mutationFn: async () => {
      const proposal = detail.data!
      const settings = issuer.data ?? (await api.get<IssuerSettings>('/pricing/proposal-issuer'))
      if (!settings.businessName) return { outcome: 'missing-issuer' as const }
      const [{ buildProposalPdf, proposalFileName }, { shareOrDownload }, logo] = await Promise.all([
        import('../../lib/proposalPdf'),
        import('../../lib/shareFile'),
        loadLogo(settings.logoPath).catch(() => null),
      ])
      const bytes = await buildProposalPdf(proposal, settings, logo)
      const outcome = await shareOrDownload(bytes, proposalFileName(proposal), `Orçamento ${proposal.numberLabel}: ${proposal.title}`)
      if (outcome !== 'cancelled' && proposal.status === 'draft') {
        await api.post(`/pricing/proposals/${proposal.id}/mark-sent`)
      }
      return { outcome, logoMissing: !!settings.logoPath && !logo }
    },
    onSuccess: (result) => {
      if (result.outcome === 'missing-issuer') {
        toast('Preencha os dados do seu negócio para o cabeçalho do PDF', 'error')
        navigate('/precificacao?aba=parametros')
        return
      }
      if (result.outcome === 'cancelled') return
      refresh()
      toast(
        `${result.outcome === 'shared' ? 'PDF compartilhado' : 'PDF baixado'}${detail.data?.status === 'draft' ? ' · marcado como enviado' : ''}${result.logoMissing ? ' · a logo não carregou' : ''}`,
      )
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao gerar o PDF', 'error'),
  })

  const setStatus = useMutation({
    mutationFn: (status: 'draft' | 'sent' | 'rejected') => api.post<ProposalDetail>(`/pricing/proposals/${proposalId}/status`, { status }),
    onSuccess: (_, status) => {
      toast(status === 'rejected' ? 'Marcado como recusado' : 'Status atualizado')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao mudar o status', 'error'),
  })

  const duplicate = useMutation({
    mutationFn: () => api.post<ProposalDetail>(`/pricing/proposals/${proposalId}/duplicate`),
    onSuccess: (copy) => {
      toast(`Cópia criada: ${copy.numberLabel}`)
      refresh()
      navigate(`/precificacao/orcamentos/${copy.id}`)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao duplicar', 'error'),
  })

  const remove = useMutation({
    mutationFn: () => api.del(`/pricing/proposals/${proposalId}`),
    onSuccess: () => {
      toast('Orçamento excluído')
      queryClient.invalidateQueries()
      navigate('/precificacao')
    },
    onError: (error) => {
      setDeleting(false)
      toast(error instanceof Error ? error.message : 'falha ao excluir', 'error')
    },
  })

  const p = detail.data

  if (detail.isError) {
    return (
      <>
        <PageHeader title="Orçamento" />
        <div className="page">
          <Card>
            <EmptyState
              icon="alert"
              title="Orçamento não encontrado"
              body="Ele pode ter sido excluído."
              action={<Button onClick={() => navigate('/precificacao')}>Voltar aos orçamentos</Button>}
            />
          </Card>
        </div>
      </>
    )
  }

  const shareButton = (primary: boolean) => (
    <Button variant={primary ? 'primary' : 'ghost'} icon="send" onClick={() => share.mutate()} loading={share.isPending} disabled={!p || p.items.length === 0}>
      Compartilhar
    </Button>
  )

  return (
    <>
      <PageHeader
        title={p ? `Orçamento ${p.numberLabel}` : 'Orçamento'}
        subtitle={p ? p.clientLabel : undefined}
        actions={
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" icon="arrowLeft" onClick={() => navigate('/precificacao')}>
              Orçamentos
            </Button>
            {p && <ProposalStatusBadge status={p.status} />}
          </div>
        }
      />
      <div className="page">
        {!p ? (
          <Card>
            <SkeletonLines lines={6} />
          </Card>
        ) : (
          <div className="proposal-form">
            <div className="stack stack--loose" style={{ minWidth: 0 }}>
              <Card>
                <div className="stack">
                  <h2 className="display" style={{ fontSize: 'var(--text-xl)', margin: 0 }}>
                    {p.title}
                  </h2>
                  <div className="kpi-row kpi-row--3" style={{ gap: 'var(--sp-3)' }}>
                    {[
                      ['Cliente', p.clientLabel],
                      ['Criado em', fmtDate(p.createdAt.slice(0, 10))],
                      ['Válido até', fmtDate(p.validUntil)],
                    ].map(([label, value]) => (
                      <div key={label} className="stack stack--tight" style={{ minWidth: 0 }}>
                        <span className="stat__label">{label}</span>
                        <span style={{ fontWeight: 600 }}>{value}</span>
                      </div>
                    ))}
                  </div>
                  <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                    Atualizado em {fmtDate(p.updatedAt.slice(0, 10))}
                    {p.sentAt ? ` · enviado em ${fmtDate(p.sentAt.slice(0, 10))}` : ''}
                  </span>
                </div>
              </Card>

              <Card title="Serviços incluídos" flush>
                <div style={{ padding: '0 var(--sp-5) var(--sp-3)' }}>
                  {p.items.length === 0 ? (
                    <p className="muted" style={{ fontSize: 'var(--text-sm)', padding: 'var(--sp-4) 0' }}>
                      Nenhum serviço ainda. Edite o orçamento para adicionar.
                    </p>
                  ) : (
                    p.items.map((item, index) => (
                      <div key={item.id ?? index} className="proposal-item" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                        <span style={{ minWidth: 0 }}>
                          <strong style={{ fontWeight: 600 }}>{item.title}</strong>
                          {item.description && <span className="proposal-item__desc">{item.description}</span>}
                        </span>
                        <span className="proposal-item__value">
                          <strong className="tabular">{money(lineTotalCents(item))}</strong>
                          <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                            {formatQuantity(item.quantity)} × {money(item.unitPriceCents)}
                          </span>
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </Card>

              {(p.paymentTerms || p.deliveryTerms || p.notes || p.installments > 1) && (
                <Card title="Condições">
                  <div className="stack">
                    {(p.paymentTerms || p.installments > 1) && (
                      <div className="stack stack--tight">
                        <span className="stat__label">Pagamento</span>
                        <span>{[p.installments > 1 ? `Em ${p.installments} parcelas.` : null, p.paymentTerms].filter(Boolean).join(' ')}</span>
                      </div>
                    )}
                    {p.deliveryTerms && (
                      <div className="stack stack--tight">
                        <span className="stat__label">Prazo de entrega</span>
                        <span>{p.deliveryTerms}</span>
                      </div>
                    )}
                    {p.notes && (
                      <div className="stack stack--tight">
                        <span className="stat__label">Observações</span>
                        <span style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</span>
                      </div>
                    )}
                  </div>
                </Card>
              )}

              {p.receivables.length > 0 && (
                <Card title="Receitas geradas" subtitle="Criadas na aprovação; a pendente é baixada quando o pagamento chega pelo extrato" flush>
                  <div style={{ padding: '0 var(--sp-5) var(--sp-3)' }}>
                    {p.receivables.map((r) => (
                      <div key={r.id} className="proposal-item" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto auto' }}>
                        <span style={{ minWidth: 0 }}>
                          <strong style={{ fontWeight: 500 }}>{fmtDate(r.postedOn)}</strong>
                          <span className="proposal-item__desc">{r.description}</span>
                        </span>
                        <span className={r.pending ? 'badge' : 'badge badge--good'}>{r.pending ? 'A receber' : 'Recebida'}</span>
                        <strong className="tabular proposal-item__value">{money(r.amountCents)}</strong>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>

            <aside className="proposal-form__aside stack">
              <Card title="Investimento">
                <div className="kv">
                  <span className="kv__k">Subtotal · {p.itemCount === 1 ? '1 serviço' : `${p.itemCount} serviços`}</span>
                  <span className="kv__v">{money(p.subtotalCents)}</span>
                  {p.discountCents > 0 && (
                    <>
                      <span className="kv__k">
                        Desconto <span className="badge badge--good">{bps(p.discountBps, p.discountBps % 100 === 0 ? 0 : 1)} off</span>
                      </span>
                      <span className="kv__v neg">− {money(p.discountCents)}</span>
                    </>
                  )}
                </div>
                <hr className="divider" />
                <div className="row row--between">
                  <span className="stat__label">Investimento total</span>
                  <span className="stat__value" style={{ fontSize: 'var(--text-xl)' }}>
                    {money(p.totalCents)}
                  </span>
                </div>
              </Card>

              <div className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
                <Button variant="quiet" icon="trash" title="Excluir orçamento" onClick={() => setDeleting(true)} />
                <Button variant="quiet" icon="copy" title="Duplicar orçamento" onClick={() => duplicate.mutate()} disabled={duplicate.isPending} />
                <Button variant="quiet" icon="pencil" title="Editar orçamento" onClick={() => navigate(`/precificacao/orcamentos/${p.id}/editar`)} />
                <span className="grow" />
                {p.status === 'draft' && shareButton(true)}
                {p.status === 'sent' && (
                  <>
                    {shareButton(false)}
                    <Button variant="ghost" icon="x" onClick={() => setStatus.mutate('rejected')} loading={setStatus.isPending}>
                      Recusado
                    </Button>
                    <Button variant="primary" icon="check" onClick={() => setApproving(true)}>
                      Marcar como aprovado
                    </Button>
                  </>
                )}
                {p.status === 'approved' && shareButton(true)}
                {p.status === 'rejected' && (
                  <Button variant="primary" icon="copy" onClick={() => duplicate.mutate()} loading={duplicate.isPending}>
                    Duplicar
                  </Button>
                )}
              </div>
              {p.items.length === 0 && (
                <p className="chart__note" style={{ margin: 0, textAlign: 'right' }}>
                  Inclua pelo menos um serviço para compartilhar.
                </p>
              )}
            </aside>
          </div>
        )}
      </div>

      {approving && p && <ApproveProposalModal proposal={p} onClose={() => setApproving(false)} />}
      {deleting && p && (
        <ConfirmDeleteModal
          title={`Excluir o orçamento ${p.numberLabel}?`}
          body={
            p.receivables.some((r) => r.pending)
              ? 'As receitas ainda a receber deste orçamento também saem. Não pode ser desfeito.'
              : 'Não pode ser desfeito.'
          }
          confirmLabel="Excluir orçamento"
          pending={remove.isPending}
          onCancel={() => setDeleting(false)}
          onConfirm={() => remove.mutate()}
        />
      )}
    </>
  )
}
