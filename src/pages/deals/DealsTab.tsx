import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bps, date as fmtDate, money } from '../../lib/format'
import { DEAL_STAGES, DEAL_STAGE_LABEL, type DealStage } from '@shared/deals'
import { Button, Card, EmptyState, Icon, KpiTile, Segmented, Select, SkeletonLines, TextInput } from '../../components/ui'
import { EditQuoteModal, type Quote } from '../Pricing'
import { DealStageSelect } from './DealStageSelect'
import { DEAL_KIND_LABEL, type Deal, type DealKind, type DealsSummary } from './types'

type KindFilter = 'all' | DealKind
type View = 'lista' | 'quadro'

/**
 * Aba Negócios (specs/clientes-e-negocios, fase 4): orçamentos e cotações numa
 * lista só, com os mesmos seis estágios, em tabela ou em quadro por estágio.
 * Tipo, estágio e vista ficam no endereço (`?tipo=quote&estagio=sent&vista=quadro`),
 * então a lista filtrada é um link.
 */
export function DealsTab({ onNewQuote }: { onNewQuote: () => void }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const kind: KindFilter = params.get('tipo') === 'proposal' || params.get('tipo') === 'quote' ? (params.get('tipo') as DealKind) : 'all'
  const view: View = params.get('vista') === 'quadro' ? 'quadro' : 'lista'
  const stageParam = params.get('estagio')
  const stage: DealStage | null = DEAL_STAGES.includes(stageParam as DealStage) ? (stageParam as DealStage) : null
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [editingQuote, setEditingQuote] = useState<Quote | null>(null)

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250)
    return () => window.clearTimeout(t)
  }, [search])

  const setParam = (key: string, value: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )

  const list = useQuery({
    queryKey: ['deals', debounced, kind, view === 'quadro' ? null : stage],
    queryFn: () =>
      api.get<{ deals: Deal[] }>('/pricing/deals', {
        q: debounced || undefined,
        kind: kind === 'all' ? undefined : kind,
        // No quadro todos os estágios aparecem, em colunas.
        stage: view === 'lista' && stage ? stage : undefined,
      }),
    placeholderData: (previous) => previous,
  })
  const summary = useQuery({
    queryKey: ['deals', 'summary'],
    queryFn: () => api.get<DealsSummary>('/pricing/deals/summary'),
  })
  const quotes = useQuery({
    queryKey: ['pricing-quotes'],
    queryFn: () => api.get<{ quotes: Quote[] }>('/pricing/quotes'),
  })

  const open = (deal: Deal) => {
    if (deal.kind === 'proposal') return navigate(`/precificacao/orcamentos/${deal.id}`)
    const quote = quotes.data?.quotes.find((q) => q.id === deal.id)
    if (quote) setEditingQuote(quote)
  }

  const rows = list.data?.deals ?? []
  const s = summary.data
  const filtered = Boolean(debounced) || kind !== 'all' || (view === 'lista' && stage !== null)

  return (
    <div className="stack stack--loose">
      <div className="kpi-row kpi-row--3">
        <KpiTile
          accent
          label="Em aberto"
          value={s ? money(s.openCents) : '-'}
          foot={s ? <span>{s.openCount === 1 ? '1 negócio enviado ou em negociação' : `${s.openCount} negócios enviados ou em negociação`}</span> : undefined}
          assumptions={{ formula: s?.assumptions.emAberto ?? '' }}
        />
        <KpiTile
          label={s ? `Aprovados em ${s.year}` : 'Aprovados no ano'}
          value={s ? money(s.approvedYearCents) : '-'}
          tone={s && s.approvedYearCents > 0 ? 'up' : undefined}
          assumptions={{ formula: s?.assumptions.aprovadoNoAno ?? '' }}
        />
        <KpiTile
          label="Taxa de aprovação"
          value={s?.approvalRateBps == null ? '-' : bps(s.approvalRateBps, 0)}
          foot={s ? <span>{s.decidedCount === 0 ? 'nenhum respondido ainda' : `de ${s.decidedCount} respondidos`}</span> : undefined}
          assumptions={{ formula: s?.assumptions.taxa ?? '' }}
        />
      </div>

      <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
        <div className="search-field grow" style={{ minWidth: 220 }}>
          <Icon name="search" size={15} />
          <TextInput value={search} onChange={setSearch} placeholder="Título, número ou cliente" ariaLabel="Buscar negócios" />
        </div>
        <Segmented
          ariaLabel="Tipo de negócio"
          value={kind}
          onChange={(next) => setParam('tipo', next === 'all' ? null : next)}
          options={[
            { value: 'all', label: 'Todos' },
            { value: 'proposal', label: 'Orçamentos' },
            { value: 'quote', label: 'Cotações' },
          ]}
        />
        {view === 'lista' && (
          <div style={{ minWidth: 180 }}>
            <Select
              ariaLabel="Filtrar por estágio"
              value={stage ?? 'all'}
              options={[{ value: 'all', label: 'Todos os estágios' }, ...DEAL_STAGES.map((value) => ({ value, label: DEAL_STAGE_LABEL[value] }))]}
              onChange={(next) => setParam('estagio', !next || next === 'all' ? null : next)}
            />
          </div>
        )}
        <Segmented
          ariaLabel="Vista"
          value={view}
          onChange={(next) => setParam('vista', next === 'lista' ? null : next)}
          options={[
            { value: 'lista', label: 'Lista' },
            { value: 'quadro', label: 'Quadro' },
          ]}
        />
      </div>

      {list.isError ? (
        <Card>
          <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar os negócios agora. Tente de novo em instantes." />
        </Card>
      ) : !list.data ? (
        <Card>
          <SkeletonLines lines={5} />
        </Card>
      ) : rows.length === 0 && !filtered ? (
        <Card>
          <EmptyState
            icon="file"
            title="Nenhum negócio ainda"
            body="Monte um orçamento com serviços e condições, ou calcule o preço de um projeto numa cotação. Os dois aparecem aqui, do rascunho à aprovação."
            action={
              <div className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'center' }}>
                <Button icon="plus" onClick={() => navigate('/precificacao/orcamentos/novo')}>
                  Novo orçamento
                </Button>
                <Button icon="sparkle" onClick={onNewQuote}>
                  Calcular preço
                </Button>
              </div>
            }
          />
        </Card>
      ) : view === 'quadro' ? (
        <DealBoard deals={rows} onOpen={open} />
      ) : (
        <Card flush title="Negócios" subtitle={`${rows.length} ${rows.length === 1 ? 'negócio' : 'negócios'}`}>
          {rows.length === 0 ? (
            <EmptyState icon="search" title="Nada com esse filtro" body="Nenhum negócio combina com a busca ou o filtro. Limpe para ver todos." />
          ) : (
            <div className="table-wrap">
              <table className="table table--stack-mobile table--stack-compact table--clickable">
                <thead>
                  <tr>
                    <th scope="col">Negócio</th>
                    <th scope="col">Estágio</th>
                    <th scope="col">Cliente</th>
                    <th scope="col">Atualizado</th>
                    <th scope="col" className="table__num">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr
                      key={`${d.kind}-${d.id}`}
                      tabIndex={0}
                      onClick={() => open(d)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') open(d)
                      }}
                      aria-label={`${DEAL_KIND_LABEL[d.kind]} ${d.title}, ${DEAL_STAGE_LABEL[d.stage]}, ${money(d.valueCents)}`}
                    >
                      <td data-label="__lead">
                        <span style={{ minWidth: 0 }}>
                          <strong style={{ fontWeight: 600 }}>{d.title}</strong>
                          <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                            {DEAL_KIND_LABEL[d.kind]}
                            {d.numberLabel ? ` · ${d.numberLabel}` : ''}
                          </span>
                        </span>
                      </td>
                      <td data-label="__trail">
                        <DealStageSelect deal={d} />
                      </td>
                      <td data-label="Cliente">
                        {d.clientName ? (
                          d.clientName
                        ) : d.kind === 'proposal' ? (
                          <>
                            {d.clientLabel}
                            <span className="muted" style={{ display: 'block', fontSize: 'var(--text-2xs)' }}>fora da lista de clientes</span>
                          </>
                        ) : (
                          <span className="muted">sem cliente da lista</span>
                        )}
                      </td>
                      <td data-label="Atualizado">{fmtDate(d.updatedAt.slice(0, 10))}</td>
                      <td className="table__num" data-label="Valor">
                        <strong className="tabular">{money(d.valueCents)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {editingQuote && <EditQuoteModal quote={editingQuote} onClose={() => setEditingQuote(null)} />}
    </div>
  )
}

/** Quadro por estágio: rola de lado no celular, uma coluna por estágio. */
function DealBoard({ deals, onOpen }: { deals: Deal[]; onOpen: (deal: Deal) => void }) {
  return (
    <div className="deal-board" role="list" aria-label="Negócios por estágio">
      {DEAL_STAGES.map((stage) => {
        const column = deals.filter((d) => d.stage === stage)
        const total = column.reduce((sum, d) => sum + d.valueCents, 0)
        return (
          <section key={stage} className="deal-board__col" role="listitem" aria-label={`${DEAL_STAGE_LABEL[stage]}: ${column.length}`}>
            <header className="deal-board__head">
              <span>
                {DEAL_STAGE_LABEL[stage]} <span className="muted">{column.length}</span>
              </span>
              <span className="tabular muted" style={{ fontWeight: 500 }}>{money(total)}</span>
            </header>
            {column.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--text-xs)', margin: 0 }}>Nada aqui.</p>
            ) : (
              column.map((d) => (
                <article key={`${d.kind}-${d.id}`} className="deal-card">
                  <button type="button" className="deal-card__open" onClick={() => onOpen(d)}>
                    <span className="deal-card__title">{d.title}</span>
                    <span className="deal-card__meta">
                      {DEAL_KIND_LABEL[d.kind]}
                      {d.numberLabel ? ` · ${d.numberLabel}` : ''}
                      {d.clientName ? ` · ${d.clientName}` : d.kind === 'proposal' ? ` · ${d.clientLabel}` : ''}
                    </span>
                  </button>
                  <div className="row row--between" style={{ gap: 'var(--sp-2)' }}>
                    <strong className="tabular" style={{ fontSize: 'var(--text-sm)' }}>{money(d.valueCents)}</strong>
                    <DealStageSelect deal={d} />
                  </div>
                </article>
              ))
            )}
          </section>
        )
      })}
    </div>
  )
}
