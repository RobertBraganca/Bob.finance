import { useEffect, useId, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bps, bpsToInput, date as fmtDate, money, parsePercentInput } from '../../lib/format'
import { todayIso } from '../../lib/period'
import { lineTotalCents, proposalTotals, proposalValidUntil } from '@shared/proposals'
import { Button, Card, EmptyState, Segmented, SkeletonLines, TextArea, TextInput, useToast } from '../../components/ui'
import { PageHeader } from '../../components/shell/Shell'
import { ApproveProposalModal } from './ApproveProposalModal'
import { QuotePickerModal, ServiceItemModal } from './ServiceItemModal'
import { STATUS_LABEL, formatQuantity, type IssuerSettings, type ProposalDetail, type ProposalItem, type ProposalStatus } from './types'

type FormState = {
  title: string
  clientLabel: string
  status: ProposalStatus
  discount: string
  validityDays: string
  installments: string
  paymentTerms: string
  deliveryTerms: string
  notes: string
  items: ProposalItem[]
}

function fromDetail(detail: ProposalDetail): FormState {
  return {
    title: detail.title,
    clientLabel: detail.clientLabel,
    status: detail.status,
    discount: detail.discountBps ? bpsToInput(detail.discountBps) : '',
    validityDays: String(detail.validityDays),
    installments: String(detail.installments),
    paymentTerms: detail.paymentTerms ?? '',
    deliveryTerms: detail.deliveryTerms ?? '',
    notes: detail.notes ?? '',
    items: detail.items,
  }
}

const EMPTY: FormState = {
  title: '',
  clientLabel: '',
  status: 'draft',
  discount: '',
  validityDays: '',
  installments: '1',
  paymentTerms: '',
  deliveryTerms: '',
  notes: '',
  items: [],
}

/**
 * Novo orçamento e edição (decisions/0040, specs/service-proposals). Uma
 * página com endereço próprio, não um modal: dá para voltar, recarregar e
 * mandar o link. No computador, o card de investimento acompanha a rolagem.
 */
export function ProposalFormPage() {
  const { id } = useParams()
  const proposalId = id ? Number(id) : null
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()

  const detail = useQuery({
    queryKey: ['proposals', 'detail', proposalId],
    queryFn: () => api.get<ProposalDetail>(`/pricing/proposals/${proposalId}`),
    enabled: proposalId !== null,
  })
  const issuer = useQuery({
    queryKey: ['proposals', 'issuer'],
    queryFn: () => api.get<IssuerSettings>('/pricing/proposal-issuer'),
  })
  const clients = useQuery({
    queryKey: ['proposals', 'client-suggestions'],
    queryFn: () => api.get<{ clients: string[] }>('/pricing/proposals/client-suggestions'),
    staleTime: 5 * 60_000,
  })

  const [form, setForm] = useState<FormState | null>(proposalId === null ? EMPTY : null)
  const [initial, setInitial] = useState<FormState | null>(proposalId === null ? EMPTY : null)
  const [editingIndex, setEditingIndex] = useState<number | 'new' | null>(null)
  const [pickingQuote, setPickingQuote] = useState(false)
  const [approving, setApproving] = useState<ProposalDetail | null>(null)
  const ids = { title: useId(), client: useId(), clients: useId(), validity: useId(), installments: useId(), payment: useId(), delivery: useId(), notes: useId(), discount: useId() }

  // Carrega o orçamento uma vez; daí em diante o formulário é a fonte.
  useEffect(() => {
    if (detail.data && form === null) {
      const state = fromDetail(detail.data)
      setForm(state)
      setInitial(state)
    }
  }, [detail.data, form])

  const dirty = form !== null && initial !== null && JSON.stringify(form) !== JSON.stringify(initial)
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const discountBps = form ? Math.min(10_000, Math.max(0, parsePercentInput(form.discount) ?? 0)) : 0
  const totals = useMemo(() => proposalTotals(form?.items ?? [], discountBps), [form?.items, discountBps])
  const wasApproved = detail.data?.status === 'approved'
  const locked = wasApproved && form?.status === 'approved'
  const validityDays = Number(form?.validityDays) || issuer.data?.defaultValidityDays || 15

  const save = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('formulário vazio')
      if (!form.title.trim()) throw new Error('Dê um título ao orçamento.')
      if (!form.clientLabel.trim()) throw new Error('Informe o cliente.')
      // "Aprovado" não se escolhe direto: salva como está e abre a aprovação.
      const wantsApproval = form.status === 'approved' && !wasApproved
      const status = form.status === 'approved' ? undefined : form.status
      const body = {
        title: form.title,
        clientLabel: form.clientLabel,
        ...(status ? { status } : {}),
        ...(locked ? {} : { discountBps, items: form.items }),
        validityDays,
        installments: Math.max(1, Math.floor(Number(form.installments) || 1)),
        paymentTerms: form.paymentTerms.trim() || null,
        deliveryTerms: form.deliveryTerms.trim() || null,
        notes: form.notes.trim() || null,
      }
      const saved =
        proposalId === null
          ? await api.post<ProposalDetail>('/pricing/proposals', body)
          : await api.patch<ProposalDetail>(`/pricing/proposals/${proposalId}`, body)
      return { saved, wantsApproval }
    },
    onSuccess: ({ saved, wantsApproval }) => {
      setInitial(form)
      queryClient.invalidateQueries({ queryKey: ['proposals'] })
      if (wasApproved && saved.status !== 'approved') queryClient.invalidateQueries()
      if (wantsApproval) {
        setApproving(saved)
        return
      }
      toast(proposalId === null ? 'Orçamento criado' : 'Orçamento salvo')
      navigate(`/precificacao/orcamentos/${saved.id}`, { replace: true })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const update = (patch: Partial<FormState>) => setForm((current) => (current ? { ...current, ...patch } : current))
  const cancel = () => {
    if (dirty && !window.confirm('Sair sem salvar? As alterações deste orçamento serão perdidas.')) return
    navigate(proposalId === null ? '/precificacao' : `/precificacao/orcamentos/${proposalId}`)
  }

  const title = proposalId === null ? 'Novo orçamento' : detail.data ? `Editar ${detail.data.numberLabel}` : 'Editar orçamento'

  if (proposalId !== null && detail.isError) {
    return (
      <>
        <PageHeader title="Orçamento" />
        <div className="page">
          <Card>
            <EmptyState icon="alert" title="Orçamento não encontrado" body="Ele pode ter sido excluído." />
          </Card>
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={title}
        subtitle={form?.clientLabel ? form.clientLabel : 'Cliente, serviços, desconto e condições'}
        actions={
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" icon="arrowLeft" onClick={cancel}>
              Voltar
            </Button>
            <Button variant="primary" icon="check" onClick={() => save.mutate()} loading={save.isPending} disabled={!form}>
              Salvar
            </Button>
          </div>
        }
      />
      <div className="page">
        {!form ? (
          <Card>
            <SkeletonLines lines={6} />
          </Card>
        ) : (
          <div className="proposal-form">
            <div className="stack stack--loose" style={{ minWidth: 0 }}>
              <Card title="Informações gerais">
                <div className="stack">
                  <div className="field">
                    <label className="field__label" htmlFor={ids.title}>
                      Título
                    </label>
                    <TextInput id={ids.title} value={form.title} onChange={(title) => update({ title })} placeholder="ex. Desenvolvimento de aplicativo de loja online" />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={ids.client}>
                      Cliente
                    </label>
                    <TextInput id={ids.client} value={form.clientLabel} onChange={(clientLabel) => update({ clientLabel })} placeholder="Nome da empresa ou pessoa" list={ids.clients} />
                    <datalist id={ids.clients}>
                      {(clients.data?.clients ?? []).map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </div>
                </div>
              </Card>

              <Card title="Status">
                <Segmented
                  ariaLabel="Status do orçamento"
                  className="segmented--nav"
                  value={form.status}
                  onChange={(status) => update({ status })}
                  options={(['draft', 'sent', 'approved', 'rejected'] as ProposalStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
                />
                {form.status === 'approved' && !wasApproved && (
                  <p className="chart__note" style={{ margin: 0 }}>
                    Ao salvar, abre a aprovação: conta, vencimento e parcelas das receitas a receber.
                  </p>
                )}
                {wasApproved && form.status !== 'approved' && (
                  <p className="field__error" style={{ margin: 0 }}>
                    Ao salvar, as receitas ainda pendentes deste orçamento serão apagadas. Se alguma já foi recebida, a mudança é recusada.
                  </p>
                )}
              </Card>

              <Card
                title="Serviços incluídos"
                subtitle={locked ? 'Aprovado: volte o status para mudar serviços e desconto' : undefined}
                flush
              >
                <div style={{ padding: '0 var(--sp-5)' }}>
                  {form.items.length === 0 ? (
                    <p className="muted" style={{ fontSize: 'var(--text-sm)', padding: 'var(--sp-4) 0' }}>
                      Nenhum serviço ainda. Adicione um, ou traga o preço de uma cotação salva.
                    </p>
                  ) : (
                    form.items.map((item, index) => (
                      <div key={index} className="proposal-item">
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
                        {locked ? (
                          <span />
                        ) : (
                          <Button variant="quiet" size="sm" icon="pencil" title={`Editar ${item.title}`} onClick={() => setEditingIndex(index)} />
                        )}
                      </div>
                    ))
                  )}
                </div>
                {!locked && (
                  <div className="row row--wrap" style={{ gap: 'var(--sp-2)', padding: 'var(--sp-4) var(--sp-5) var(--sp-5)' }}>
                    <Button icon="plus" onClick={() => setEditingIndex('new')}>
                      Adicionar serviço
                    </Button>
                    <Button variant="quiet" icon="calculator" onClick={() => setPickingQuote(true)}>
                      Trazer de uma cotação
                    </Button>
                  </div>
                )}
              </Card>

              <Card title="Condições">
                <div className="stack">
                  <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
                    <div className="field" style={{ flex: '1 1 160px' }}>
                      <label className="field__label" htmlFor={ids.validity}>
                        Validade (dias)
                      </label>
                      <TextInput id={ids.validity} value={form.validityDays} onChange={(validityDays) => update({ validityDays })} placeholder={String(issuer.data?.defaultValidityDays ?? 15)} numeral />
                      <span className="field__hint">
                        válido até {fmtDate(proposalValidUntil(detail.data?.createdAt ?? todayIso(), validityDays))}
                      </span>
                    </div>
                    <div className="field" style={{ flex: '1 1 120px' }}>
                      <label className="field__label" htmlFor={ids.installments}>
                        Parcelas
                      </label>
                      <TextInput id={ids.installments} value={form.installments} onChange={(installments) => update({ installments })} numeral />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={ids.payment}>
                      Condições de pagamento
                    </label>
                    <TextInput id={ids.payment} value={form.paymentTerms} onChange={(paymentTerms) => update({ paymentTerms })} placeholder="ex. 50% na aprovação, 50% na entrega" />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={ids.delivery}>
                      Prazo de entrega
                    </label>
                    <TextInput id={ids.delivery} value={form.deliveryTerms} onChange={(deliveryTerms) => update({ deliveryTerms })} placeholder="ex. 30 dias úteis após a aprovação" />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={ids.notes}>
                      Observações
                    </label>
                    <TextArea id={ids.notes} value={form.notes} onChange={(notes) => update({ notes })} placeholder="O que não está incluído, número de revisões, etc." />
                  </div>
                </div>
              </Card>
            </div>

            <aside className="proposal-form__aside">
              <Card title="Investimento">
                <div className="kv">
                  <span className="kv__k">Subtotal</span>
                  <span className="kv__v">
                    <span className="muted" style={{ fontWeight: 400, marginRight: 8 }}>
                      {totals.itemCount === 1 ? '1 serviço' : `${totals.itemCount} serviços`}
                    </span>
                    {money(totals.subtotalCents)}
                  </span>
                </div>
                <div className="row row--between" style={{ gap: 'var(--sp-3)' }}>
                  <label className="field__label" htmlFor={ids.discount} style={{ margin: 0 }}>
                    Desconto (%)
                  </label>
                  <div style={{ width: 96 }}>
                    {locked ? (
                      <span className="tabular">{bps(discountBps, 1)}</span>
                    ) : (
                      <TextInput id={ids.discount} value={form.discount} onChange={(discount) => update({ discount })} placeholder="0" numeral />
                    )}
                  </div>
                </div>
                {totals.discountCents > 0 && (
                  <div className="kv">
                    <span className="kv__k">Desconto</span>
                    <span className="kv__v neg">− {money(totals.discountCents)}</span>
                  </div>
                )}
                <hr className="divider" />
                <div className="row row--between">
                  <span className="stat__label">Valor total</span>
                  <span className="stat__value" style={{ fontSize: 'var(--text-xl)' }}>
                    {money(totals.totalCents)}
                  </span>
                </div>
                {totals.discountCents > 0 && (
                  <span className="muted tabular" style={{ textAlign: 'right', textDecoration: 'line-through', fontSize: 'var(--text-xs)' }}>
                    {money(totals.subtotalCents)}
                  </span>
                )}
              </Card>
              <div className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end', marginTop: 'var(--sp-4)' }}>
                <Button variant="quiet" onClick={cancel}>
                  Cancelar
                </Button>
                <Button variant="primary" icon="check" onClick={() => save.mutate()} loading={save.isPending}>
                  Salvar
                </Button>
              </div>
            </aside>
          </div>
        )}
      </div>

      {editingIndex !== null && form && (
        <ServiceItemModal
          item={editingIndex === 'new' ? null : form.items[editingIndex]!}
          onClose={() => setEditingIndex(null)}
          onDelete={
            editingIndex === 'new'
              ? undefined
              : () => {
                  update({ items: form.items.filter((_, i) => i !== editingIndex) })
                  setEditingIndex(null)
                }
          }
          onSave={(item) => {
            update({
              items: editingIndex === 'new' ? [...form.items, item] : form.items.map((current, i) => (i === editingIndex ? item : current)),
            })
            setEditingIndex(null)
          }}
        />
      )}
      {pickingQuote && form && (
        <QuotePickerModal
          onClose={() => setPickingQuote(false)}
          onPick={(item) => {
            update({ items: [...form.items, item] })
            setPickingQuote(false)
          }}
        />
      )}
      {approving && (
        <ApproveProposalModal
          proposal={approving}
          onClose={() => {
            setApproving(null)
            navigate(`/precificacao/orcamentos/${approving.id}`, { replace: true })
          }}
        />
      )}
    </>
  )
}
