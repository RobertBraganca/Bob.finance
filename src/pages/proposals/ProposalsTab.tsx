import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bps, date as fmtDate, money } from '../../lib/format'
import { Button, Card, EmptyState, Icon, KpiTile, Modal, SkeletonLines, TextInput } from '../../components/ui'
import { ProposalStatusBadge } from './ProposalStatusBadge'
import { SORT_OPTIONS, STATUS_LABEL, type ProposalSort, type ProposalStatus, type ProposalSummary } from './types'

type ListResponse = { proposals: ProposalSummary[]; draftCount: number }
type SummaryResponse = {
  awaitingCents: number
  awaitingCount: number
  approvedYearCents: number
  year: number
  approvalRateBps: number | null
  decidedCount: number
}

const ALL_STATUSES: ProposalStatus[] = ['draft', 'sent', 'approved', 'rejected']

/**
 * Aba Orçamentos de Precificação (decisions/0040). Mesma linha de KPIs do
 * Painel, busca e "Filtrar e ordenar" numa linha de controle, e a lista em
 * tabela (cartões no celular). Filtro e ordem ficam no endereço
 * (`?status=sent,draft&ordem=value_desc`), então a lista filtrada é um link.
 */
export function ProposalsTab() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const statuses = (params.get('status') ?? '').split(',').filter((s): s is ProposalStatus =>
    (ALL_STATUSES as string[]).includes(s),
  )
  const sort = (SORT_OPTIONS.find((o) => o.value === params.get('ordem'))?.value ?? 'recent') as ProposalSort
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filtering, setFiltering] = useState(false)

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search.trim()), 250)
    return () => window.clearTimeout(id)
  }, [search])

  const list = useQuery({
    queryKey: ['proposals', debounced, statuses.join(','), sort],
    queryFn: () =>
      api.get<ListResponse>('/pricing/proposals', {
        q: debounced || undefined,
        status: statuses.length > 0 ? statuses.join(',') : undefined,
        sort,
      }),
    placeholderData: (previous) => previous,
  })
  const summary = useQuery({
    queryKey: ['proposals', 'summary'],
    queryFn: () => api.get<SummaryResponse>('/pricing/proposals/summary'),
  })

  const applyFilters = (nextStatuses: ProposalStatus[], nextSort: ProposalSort) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (nextStatuses.length > 0) next.set('status', nextStatuses.join(','))
        else next.delete('status')
        if (nextSort !== 'recent') next.set('ordem', nextSort)
        else next.delete('ordem')
        return next
      },
      { replace: true },
    )
  }

  const rows = list.data?.proposals ?? []
  const filtered = statuses.length > 0 || sort !== 'recent'
  const s = summary.data

  return (
    <div className="stack stack--loose">
      <div className="kpi-row kpi-row--3">
        <KpiTile
          accent
          label="Aguardando resposta"
          value={s ? money(s.awaitingCents) : '-'}
          foot={s ? <span>{s.awaitingCount === 1 ? '1 orçamento enviado' : `${s.awaitingCount} orçamentos enviados`}</span> : undefined}
          assumptions={{ formula: 'Soma do total dos orçamentos com status Enviado: o que está com o cliente, esperando resposta.' }}
        />
        <KpiTile
          label={s ? `Aprovados em ${s.year}` : 'Aprovados no ano'}
          value={s ? money(s.approvedYearCents) : '-'}
          tone={s && s.approvedYearCents > 0 ? 'up' : undefined}
          assumptions={{
            formula: 'Soma do valor aprovado dos orçamentos criados no ano corrente e que estão com status Aprovado.',
          }}
        />
        <KpiTile
          label="Taxa de aprovação"
          value={s?.approvalRateBps == null ? '-' : bps(s.approvalRateBps, 0)}
          foot={s ? <span>{s.decidedCount === 0 ? 'nenhum respondido ainda' : `de ${s.decidedCount} respondidos`}</span> : undefined}
          assumptions={{ formula: 'Aprovados ÷ (aprovados + recusados). Rascunhos e enviados ainda não contam.' }}
        />
      </div>

      <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
        <div className="search-field grow" style={{ minWidth: 220 }}>
          <Icon name="search" size={15} />
          <TextInput value={search} onChange={setSearch} placeholder="Título ou cliente" ariaLabel="Buscar por título ou cliente" />
        </div>
        <Button icon="filter" onClick={() => setFiltering(true)}>
          Filtrar e ordenar
          {filtered && <span className="badge badge--info" style={{ marginLeft: 4 }}>{statuses.length || 1}</span>}
        </Button>
      </div>

      <Card flush title="Orçamentos" subtitle={list.data ? `${rows.length} ${rows.length === 1 ? 'orçamento' : 'orçamentos'}` : undefined}>
        {list.isError ? (
          <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar os orçamentos agora. Tente novamente em instantes." />
        ) : !list.data ? (
          <div style={{ padding: 'var(--sp-5)' }}>
            <SkeletonLines lines={5} />
          </div>
        ) : rows.length === 0 ? (
          debounced || filtered ? (
            <EmptyState icon="search" title="Nada com esse filtro" body="Nenhum orçamento combina com a busca ou o filtro. Limpe para ver todos." />
          ) : (
            <EmptyState
              icon="file"
              title="Nenhum orçamento ainda"
              body="Monte o primeiro: cliente, serviços com preço e quantidade, desconto e condições. Depois é só compartilhar o PDF."
              action={
                <Button icon="plus" onClick={() => navigate('/precificacao/orcamentos/novo')}>
                  Criar primeiro orçamento
                </Button>
              }
            />
          )
        ) : (
          <div className="table-wrap">
            <table className="table table--stack-mobile table--stack-compact table--clickable">
              <thead>
                <tr>
                  <th scope="col">Orçamento</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="table__num">Serviços</th>
                  <th scope="col">Atualizado</th>
                  <th scope="col" className="table__num">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr
                    key={p.id}
                    tabIndex={0}
                    onClick={() => navigate(`/precificacao/orcamentos/${p.id}`)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') navigate(`/precificacao/orcamentos/${p.id}`)
                    }}
                    aria-label={`${p.title}, ${p.clientLabel}, ${STATUS_LABEL[p.status]}, ${money(p.totalCents)}`}
                  >
                    <td data-label="__lead">
                      <span style={{ minWidth: 0 }}>
                        <strong style={{ fontWeight: 600 }}>{p.title}</strong>
                        <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                          {p.numberLabel} · {p.clientLabel}
                        </span>
                      </span>
                    </td>
                    <td data-label="__trail">
                      <ProposalStatusBadge status={p.status} />
                    </td>
                    <td className="table__num" data-label="Serviços">{p.itemCount}</td>
                    <td data-label="Atualizado">{fmtDate(p.updatedAt.slice(0, 10))}</td>
                    <td className="table__num" data-label="Total">
                      <strong className="tabular">{money(p.totalCents)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {filtering && (
        <ProposalFilterModal
          statuses={statuses}
          sort={sort}
          onClose={() => setFiltering(false)}
          onApply={(nextStatuses, nextSort) => {
            applyFilters(nextStatuses, nextSort)
            setFiltering(false)
          }}
        />
      )}
    </div>
  )
}

function ProposalFilterModal({
  statuses,
  sort,
  onClose,
  onApply,
}: {
  statuses: ProposalStatus[]
  sort: ProposalSort
  onClose: () => void
  onApply: (statuses: ProposalStatus[], sort: ProposalSort) => void
}) {
  const [picked, setPicked] = useState<Set<ProposalStatus>>(new Set(statuses))
  const [order, setOrder] = useState<ProposalSort>(sort)

  return (
    <Modal
      title="Filtrar e ordenar"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={() => onApply([], 'recent')}>
            Limpar filtros
          </Button>
          <Button variant="primary" icon="check" onClick={() => onApply([...picked], order)}>
            Aplicar
          </Button>
        </>
      }
    >
      <div className="stack">
        <fieldset className="stack stack--tight" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="stat__label" style={{ marginBottom: 'var(--sp-2)' }}>
            Status
          </legend>
          {ALL_STATUSES.map((status) => (
            <label key={status} className="row" style={{ gap: 'var(--sp-3)', minHeight: 36, cursor: 'pointer' }}>
              <input
                type="checkbox"
                className="checkbox"
                checked={picked.has(status)}
                onChange={(event) =>
                  setPicked((current) => {
                    const next = new Set(current)
                    if (event.target.checked) next.add(status)
                    else next.delete(status)
                    return next
                  })
                }
              />
              <ProposalStatusBadge status={status} />
            </label>
          ))}
        </fieldset>
        <hr className="divider" />
        <fieldset className="stack stack--tight" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="stat__label" style={{ marginBottom: 'var(--sp-2)' }}>
            Ordenação
          </legend>
          {SORT_OPTIONS.map((option) => (
            <label key={option.value} className="row" style={{ gap: 'var(--sp-3)', minHeight: 36, cursor: 'pointer' }}>
              <input
                type="radio"
                className="radio"
                name="proposal-sort"
                checked={order === option.value}
                onChange={() => setOrder(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      </div>
    </Modal>
  )
}
