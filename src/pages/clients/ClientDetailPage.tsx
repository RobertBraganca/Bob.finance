import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bps, date as fmtDate, money, period as fmtPeriod } from '../../lib/format'
import { DEAL_STAGE_LABEL, DEAL_STAGE_TONE } from '@shared/deals'
import { PageHeader } from '../../components/shell/Shell'
import { Button, Card, ConfirmDeleteModal, EmptyState, Field, Icon, KpiTile, Modal, SkeletonLines, TextInput, useToast } from '../../components/ui'
import { EditQuoteModal, type Quote } from '../Pricing'
import { ClientFormModal } from './ClientFormModal'
import { TransactionPickerModal } from './TransactionPickerModal'
import {
  CLIENT_KIND_LABEL,
  CLIENT_STATUS_BADGE,
  CLIENT_STATUS_LABEL,
  RECURRING_REASON_LABEL,
  REVENUE_VIA_LABEL,
  type ClientContact,
  type ClientDetail,
  type PayerSuggestion,
} from './types'

const STAGE_BADGE: Record<string, string> = {
  neutral: 'badge',
  info: 'badge badge--info',
  warning: 'badge badge--warning',
  good: 'badge badge--good',
  critical: 'badge badge--critical',
}

/**
 * Ficha do cliente (docs/specs/clientes-e-negocios, fases 2 e 3): os números
 * dele (LTV realizado e previsto, MRR, ticket e taxa de aprovação), contatos,
 * os nomes com que paga no extrato, os negócios e as receitas ligadas.
 */
export function ClientDetailPage() {
  const { id: rawId } = useParams()
  const id = Number(rawId)
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [contact, setContact] = useState<ClientContact | 'new' | null>(null)
  const [aliasDraft, setAliasDraft] = useState('')
  const [editingQuote, setEditingQuote] = useState<Quote | null>(null)
  const openQuote = async (quoteId: number) => {
    try {
      const { quotes } = await queryClient.fetchQuery({
        queryKey: ['pricing-quotes'],
        queryFn: () => api.get<{ quotes: Quote[] }>('/pricing/quotes'),
      })
      const found = quotes.find((q) => q.id === quoteId)
      if (found) setEditingQuote(found)
      else toast('cotação não encontrada', 'error')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'falha ao abrir a cotação', 'error')
    }
  }

  const detail = useQuery({
    queryKey: ['client', id],
    queryFn: () => api.get<ClientDetail>(`/pricing/clients/${id}`),
    enabled: Number.isFinite(id),
  })
  const suggestions = useQuery({
    queryKey: ['client', id, 'payer-suggestions'],
    queryFn: () => api.get<{ suggestions: PayerSuggestion[] }>(`/pricing/clients/${id}/payer-suggestions`),
    enabled: Number.isFinite(id),
  })
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['client', id] })
    queryClient.invalidateQueries({ queryKey: ['clients'] })
  }

  const remove = useMutation({
    mutationFn: () => api.del(`/pricing/clients/${id}`),
    onSuccess: () => {
      toast('Cliente excluído')
      queryClient.invalidateQueries({ queryKey: ['clients'] })
      queryClient.invalidateQueries({ queryKey: ['deals'] })
      navigate('/precificacao?aba=clientes')
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })
  const addAlias = useMutation({
    mutationFn: (alias: string) => api.post(`/pricing/clients/${id}/aliases`, { alias }),
    onSuccess: () => {
      setAliasDraft('')
      toast('Nome ligado: as entradas dele passam a contar para este cliente')
      refresh()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao ligar o nome', 'error'),
  })
  const [pickingTransactions, setPickingTransactions] = useState(false)
  const [showAllRevenue, setShowAllRevenue] = useState(false)
  const unlinkTransaction = useMutation({
    mutationFn: (transactionId: number) => api.del(`/pricing/clients/${id}/transactions/${transactionId}`),
    onSuccess: () => {
      toast('Lançamento desligado do cliente')
      refresh()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao desligar o lançamento', 'error'),
  })
  const removeAlias = useMutation({
    mutationFn: (aliasId: number) => api.del(`/pricing/clients/${id}/aliases/${aliasId}`),
    onSuccess: () => refresh(),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover o nome', 'error'),
  })
  const removeContact = useMutation({
    mutationFn: (contactId: number) => api.del(`/pricing/clients/${id}/contacts/${contactId}`),
    onSuccess: () => refresh(),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover o contato', 'error'),
  })

  const c = detail.data
  if (detail.isError) {
    return (
      <>
        <PageHeader title="Cliente" />
        <div className="page">
          <Card>
            <EmptyState
              icon="alert"
              title="Cliente não encontrado"
              body="Ele pode ter sido excluído."
              action={<Button onClick={() => navigate('/precificacao?aba=clientes')}>Voltar aos clientes</Button>}
            />
          </Card>
        </div>
      </>
    )
  }

  const m = c?.metrics
  const pendingCents = m ? m.ltvForecastCents - m.ltvRealizedCents : 0
  const last12 = (c?.monthlyRevenue ?? []).slice(-12)

  return (
    <>
      <PageHeader
        title={c ? c.name : 'Cliente'}
        subtitle={c ? [CLIENT_KIND_LABEL[c.kind], c.segment].filter(Boolean).join(' · ') : undefined}
        actions={
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" icon="arrowLeft" onClick={() => navigate('/precificacao?aba=clientes')}>
              Clientes
            </Button>
            {c && (
              <>
                <Button icon="pencil" onClick={() => setEditing(true)}>
                  Editar
                </Button>
                <Button variant="primary" icon="plus" onClick={() => navigate(`/precificacao/orcamentos/novo?cliente=${c.id}`)}>
                  Novo orçamento
                </Button>
              </>
            )}
          </div>
        }
      />
      <div className="page">
        {!c || !m ? (
          <Card>
            <SkeletonLines lines={6} />
          </Card>
        ) : (
          <div className="stack stack--loose">
            <div className="kpi-row">
              <KpiTile
                accent
                label="LTV realizado"
                value={money(m.ltvRealizedCents)}
                foot={
                  <span>
                    {m.monthsWithRevenue === 0 ? 'nada entrou ainda' : m.monthsWithRevenue === 1 ? 'receita em 1 mês' : `receita em ${m.monthsWithRevenue} meses`}
                  </span>
                }
                assumptions={{ formula: 'Receitas que de fato entraram: as geradas pelos orçamentos e cotações deste cliente e as entradas com um dos nomes no extrato dele.' }}
              />
              <KpiTile
                label="A receber"
                value={money(pendingCents)}
                foot={<span>previsto total {money(m.ltvForecastCents)}</span>}
                assumptions={{ formula: 'Receitas pendentes ligadas ao cliente (parcelas de orçamentos aprovados ainda não recebidas).' }}
              />
              <KpiTile
                label="MRR"
                value={m.isRecurring ? money(m.mrrCents) : '-'}
                foot={<span>{m.recurringReason ? `recorrente: ${RECURRING_REASON_LABEL[m.recurringReason]}` : 'não é recorrente'}</span>}
                assumptions={{ formula: 'Para cliente recorrente, a média da receita dos 3 últimos meses fechados.' }}
              />
              <KpiTile
                label="Taxa de aprovação"
                value={m.approvalRateBps == null ? '-' : bps(m.approvalRateBps, 0)}
                foot={<span>{m.avgTicketCents != null ? `ticket médio ${money(m.avgTicketCents)}` : 'nenhum negócio aprovado ainda'}</span>}
                assumptions={{ formula: 'Aprovados ÷ (aprovados + recusados), cotações e orçamentos juntos; o ticket médio é o valor médio dos aprovados.' }}
              />
            </div>

            <div className="grid-2">
              <Card title="Dados" actions={<span className={CLIENT_STATUS_BADGE[c.status]}>{CLIENT_STATUS_LABEL[c.status]}</span>}>
                <dl className="kv-list">
                  {[
                    ['E-mail', c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : null],
                    ['Telefone', c.phone ? <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}>{c.phone}</a> : null],
                    ['CPF ou CNPJ', c.document],
                    ['Site', c.website ? <a href={c.website.startsWith('http') ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer">{c.website}</a> : null],
                    ['Origem', c.source],
                    ['Desde', fmtDate(c.createdAt.slice(0, 10))],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="kv">
                      <span className="kv__k">{label}</span>
                      <span className="kv__v">{value ?? <span className="muted">-</span>}</span>
                    </div>
                  ))}
                </dl>
                {c.description && <p style={{ fontSize: 'var(--text-sm)', whiteSpace: 'pre-wrap' }}>{c.description}</p>}
              </Card>

              <Card
                title="Contatos"
                subtitle={c.contacts.length === 0 ? 'Quem você procura neste cliente' : undefined}
                actions={
                  <Button size="sm" icon="plus" onClick={() => setContact('new')}>
                    Contato
                  </Button>
                }
              >
                {c.contacts.length === 0 ? (
                  <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>Nenhum contato cadastrado.</p>
                ) : (
                  <ul className="stack stack--tight">
                    {c.contacts.map((ct) => (
                      <li key={ct.id} className="row row--between" style={{ gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
                        <span style={{ minWidth: 0 }}>
                          <strong style={{ fontWeight: 600 }}>{ct.name}</strong>
                          {ct.isPrimary && <span className="badge badge--info" style={{ marginLeft: 6 }}>Principal</span>}
                          <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                            {[ct.role, ct.email, ct.phone].filter(Boolean).join(' · ') || 'sem dados de contato'}
                          </span>
                        </span>
                        <span className="row" style={{ gap: 2 }}>
                          <Button variant="quiet" size="sm" icon="pencil" title={`Editar ${ct.name}`} onClick={() => setContact(ct)} />
                          <Button variant="quiet" size="sm" icon="trash" title={`Remover ${ct.name}`} onClick={() => removeContact.mutate(ct.id)} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <Card
              title="Nomes no extrato"
              subtitle="Com que nome este cliente paga. As entradas com esse nome passam a contar no LTV, mesmo sem orçamento."
              actions={
                <Button size="sm" icon="list" onClick={() => setPickingTransactions(true)}>
                  Escolher lançamentos
                </Button>
              }
            >
              <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                {c.aliases.length === 0 && <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>Nenhum nome ligado ainda.</span>}
                {c.aliases.map((a) => (
                  <span key={a.id} className="badge" style={{ gap: 6 }}>
                    {a.alias}
                    <button type="button" className="link-button" aria-label={`Desligar o nome ${a.alias}`} onClick={() => removeAlias.mutate(a.id)}>
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                ))}
              </div>
              <form
                className="row row--wrap"
                style={{ gap: 'var(--sp-2)', alignItems: 'flex-end' }}
                onSubmit={(event) => {
                  event.preventDefault()
                  if (aliasDraft.trim()) addAlias.mutate(aliasDraft.trim())
                }}
              >
                <div className="grow" style={{ minWidth: 220 }}>
                  <Field label="Ligar um nome">
                    {(fieldId) => <TextInput id={fieldId} value={aliasDraft} onChange={setAliasDraft} placeholder="ex. KLEBER DE MELLO TRISTAO" />}
                  </Field>
                </div>
                <Button type="submit" icon="plus" loading={addAlias.isPending} disabled={!aliasDraft.trim()}>
                  Ligar
                </Button>
              </form>
              {(suggestions.data?.suggestions ?? []).length > 0 && (
                <div className="stack stack--tight">
                  <span className="stat__label">Quem pagou e ainda não está ligado a ninguém</span>
                  <ul className="stack stack--tight">
                    {suggestions.data!.suggestions.slice(0, 6).map((s) => (
                      <li key={s.alias} className="row row--between" style={{ gap: 'var(--sp-2)' }}>
                        <span style={{ minWidth: 0 }}>
                          <strong style={{ fontWeight: 600 }}>{s.alias}</strong>
                          {s.looksLikeClient && <span className="badge badge--info" style={{ marginLeft: 6 }}>parece este cliente</span>}
                          <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                            {s.count === 1 ? '1 entrada' : `${s.count} entradas`} · {money(s.totalCents)}
                          </span>
                        </span>
                        <Button size="sm" icon="check" onClick={() => addAlias.mutate(s.alias)} disabled={addAlias.isPending}>
                          É deste cliente
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>

            <Card flush title="Negócios" subtitle={c.deals.length === 0 ? undefined : `${c.deals.length} ${c.deals.length === 1 ? 'negócio' : 'negócios'}`}>
              {c.deals.length === 0 ? (
                <EmptyState
                  icon="file"
                  title="Nenhum negócio ligado"
                  body="Crie um orçamento para este cliente, ou escolha o cliente ao editar uma cotação ou um orçamento."
                />
              ) : (
                <div className="table-wrap">
                  <table className="table table--stack-mobile table--stack-compact table--clickable">
                    <thead>
                      <tr>
                        <th scope="col">Negócio</th>
                        <th scope="col">Estágio</th>
                        <th scope="col" className="table__num">Valor</th>
                        <th scope="col">Atualizado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.deals.map((d) => {
                        const open = () => (d.kind === 'proposal' ? navigate(`/precificacao/orcamentos/${d.id}`) : void openQuote(d.id))
                        return (
                          <tr key={`${d.kind}-${d.id}`} tabIndex={0} onClick={open} onKeyDown={(event) => event.key === 'Enter' && open()}>
                            <td data-label="__lead">
                              <span style={{ minWidth: 0 }}>
                                <strong style={{ fontWeight: 600 }}>{d.title}</strong>
                                <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                                  {d.kind === 'proposal' ? 'Orçamento' : 'Cotação'}
                                </span>
                              </span>
                            </td>
                            <td data-label="__trail">
                              <span className={STAGE_BADGE[DEAL_STAGE_TONE[d.stage]]}>{DEAL_STAGE_LABEL[d.stage]}</span>
                            </td>
                            <td className="table__num" data-label="Valor">
                              <strong className="tabular">{money(d.valueCents)}</strong>
                            </td>
                            <td data-label="Atualizado">{fmtDate(d.updatedAt.slice(0, 10))}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <div className="grid-2">
              <Card title="Receita por mês" subtitle="O que entrou de fato, mês a mês">
                {last12.length === 0 ? (
                  <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
                    Nenhuma receita ligada ainda. Ligue os nomes com que o cliente paga, ou aprove um orçamento dele.
                  </p>
                ) : (
                  <ul className="stack stack--tight">
                    {last12.map((row) => (
                      <li key={row.period} className="row row--between">
                        <span>{fmtPeriod(row.period)}</span>
                        <strong className="tabular">{money(row.cents)}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card
                title="Receitas ligadas"
                subtitle="As mais recentes, e por onde cada uma foi ligada"
                actions={
                  <Button size="sm" icon="plus" onClick={() => setPickingTransactions(true)}>
                    Escolher
                  </Button>
                }
              >
                {c.revenue.length === 0 ? (
                  <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
                    Nada ainda. Escolha os lançamentos deste cliente no extrato, ligue um nome de pagador ou aprove um orçamento dele.
                  </p>
                ) : (
                  <>
                    <ul className="stack stack--tight">
                      {(showAllRevenue ? c.revenue : c.revenue.slice(0, 12)).map((r) => (
                        <li key={r.id} className="row row--between" style={{ gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: 'block', overflowWrap: 'anywhere', fontSize: 'var(--text-sm)' }}>{r.description}</span>
                            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                              {fmtDate(r.postedOn)} · {REVENUE_VIA_LABEL[r.via]}
                              {r.pending ? ' · a receber' : ''}
                            </span>
                          </span>
                          <span className="row" style={{ gap: 2, flexShrink: 0 }}>
                            <strong className={`tabular ${r.pending ? 'muted' : 'pos'}`}>{money(r.amountCents)}</strong>
                            {r.via === 'manual' && (
                              <Button
                                variant="quiet"
                                size="sm"
                                icon="x"
                                title="Desligar este lançamento do cliente"
                                onClick={() => unlinkTransaction.mutate(r.id)}
                                disabled={unlinkTransaction.isPending}
                              />
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {c.revenue.length > 12 && (
                      <Button variant="quiet" size="sm" onClick={() => setShowAllRevenue((v) => !v)}>
                        {showAllRevenue ? 'Mostrar só as 12 mais recentes' : `Mostrar todas (${c.revenue.length})`}
                      </Button>
                    )}
                  </>
                )}
              </Card>
            </div>

            <div>
              <Button variant="danger" icon="trash" onClick={() => setDeleting(true)}>
                Excluir cliente
              </Button>
            </div>
          </div>
        )}
      </div>

      {editing && c && <ClientFormModal client={c} onClose={() => setEditing(false)} />}
      {editingQuote && <EditQuoteModal quote={editingQuote} onClose={() => setEditingQuote(null)} />}
      {pickingTransactions && c && <TransactionPickerModal clientId={c.id} clientName={c.name} onClose={() => setPickingTransactions(false)} />}
      {contact && c && <ContactModal clientId={c.id} contact={contact === 'new' ? null : contact} onClose={() => setContact(null)} onSaved={refresh} />}
      {deleting && c && (
        <ConfirmDeleteModal
          title={`Excluir ${c.name}?`}
          body="Contatos e nomes no extrato saem junto. Cotações e orçamentos continuam, com o nome escrito neles, só deixam de estar ligados ao cliente. Para guardar o histórico, prefira arquivar (Editar, Situação)."
          confirmLabel="Excluir cliente"
          pending={remove.isPending}
          onCancel={() => setDeleting(false)}
          onConfirm={() => remove.mutate()}
        />
      )}
    </>
  )
}

function ContactModal({
  clientId,
  contact,
  onClose,
  onSaved,
}: {
  clientId: number
  contact: ClientContact | null
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [name, setName] = useState(contact?.name ?? '')
  const [role, setRole] = useState(contact?.role ?? '')
  const [email, setEmail] = useState(contact?.email ?? '')
  const [phone, setPhone] = useState(contact?.phone ?? '')
  const [isPrimary, setIsPrimary] = useState(contact?.isPrimary ?? false)
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), role: role.trim() || null, email: email.trim() || null, phone: phone.trim() || null, isPrimary }
      return contact ? api.patch(`/pricing/clients/${clientId}/contacts/${contact.id}`, body) : api.post(`/pricing/clients/${clientId}/contacts`, body)
    },
    onSuccess: () => {
      toast(contact ? 'Contato atualizado' : 'Contato adicionado')
      onSaved()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar o contato', 'error'),
  })
  const emailInvalid = email.trim() !== '' && !/^\S+@\S+\.\S+$/.test(email.trim())
  return (
    <Modal
      title={contact ? `Editar ${contact.name}` : 'Novo contato'}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={!name.trim() || emailInvalid} loading={save.isPending}>
            {contact ? 'Salvar contato' : 'Adicionar contato'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Nome">{(id) => <TextInput id={id} value={name} onChange={setName} />}</Field>
        <Field label="Cargo">{(id) => <TextInput id={id} value={role} onChange={setRole} placeholder="ex. marketing, financeiro" />}</Field>
        <div className="form-grid">
          <Field label="E-mail" error={emailInvalid ? 'Confira o e-mail.' : null}>
            {(id) => <TextInput id={id} type="email" value={email} onChange={setEmail} />}
          </Field>
          <Field label="Telefone">{(id) => <TextInput id={id} type="tel" value={phone} onChange={setPhone} />}</Field>
        </div>
        <label className="row" style={{ gap: 'var(--sp-2)', cursor: 'pointer', minHeight: 44 }}>
          <input type="checkbox" className="checkbox" checked={isPrimary} onChange={(event) => setIsPrimary(event.target.checked)} />
          <span style={{ fontSize: 'var(--text-sm)' }}>Contato principal</span>
        </label>
      </div>
    </Modal>
  )
}
