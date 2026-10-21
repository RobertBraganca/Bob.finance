import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bps, date as fmtDate, money } from '../../lib/format'
import { Button, Card, EmptyState, Icon, KpiTile, Segmented, SkeletonLines, TextInput } from '../../components/ui'
import { ClientFormModal } from './ClientFormModal'
import { CLIENT_KIND_LABEL, CLIENT_STATUS_BADGE, CLIENT_STATUS_LABEL, type ClientKind, type ClientsResponse } from './types'

type KindFilter = 'all' | ClientKind | 'recurring'

/**
 * Aba Clientes de Precificação (docs/specs/clientes-e-negocios, fases 2 e 3):
 * a carteira com LTV, recorrência e MRR lidos do dinheiro que de fato entrou.
 * Só observa (decisions/0010): nada aqui diz em qual cliente focar.
 */
export function ClientsTab({ creating, onCreate, onCloseCreate }: { creating: boolean; onCreate: () => void; onCloseCreate: () => void }) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filter, setFilter] = useState<KindFilter>('all')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  const list = useQuery({
    queryKey: ['clients', debounced, filter],
    queryFn: () =>
      api.get<ClientsResponse>('/pricing/clients', {
        q: debounced || undefined,
        kind: filter === 'all' || filter === 'recurring' ? undefined : filter,
        recurring: filter === 'recurring' ? 'true' : undefined,
      }),
    placeholderData: (previous) => previous,
  })
  const o = list.data?.overview
  const rows = list.data?.clients ?? []

  return (
    <div className="stack stack--loose">
      <div className="kpi-row">
        <KpiTile
          accent
          label="MRR"
          value={o ? money(o.mrrCents) : '-'}
          foot={o ? <span>{o.recurringClients === 1 ? '1 cliente recorrente' : `${o.recurringClients} clientes recorrentes`}</span> : undefined}
          assumptions={{ formula: list.data?.assumptions.mrr ?? '', recorrente: list.data?.assumptions.recorrente ?? '' }}
        />
        <KpiTile
          label="LTV realizado"
          value={o ? money(o.ltvRealizedCents) : '-'}
          foot={o?.avgLtvCents != null ? <span>média de {money(o.avgLtvCents)} por cliente com receita</span> : undefined}
          assumptions={{ formula: list.data?.assumptions.ltv ?? '' }}
        />
        <KpiTile
          label="Clientes ativos"
          value={o ? String(o.activeClients) : '-'}
          foot={o ? <span>{o.leads === 1 ? '1 lead' : `${o.leads} leads`} · {money(o.openPipelineCents)} em aberto</span> : undefined}
          assumptions={{ formula: 'Clientes (empresa ou pessoa) com situação Ativo. Leads contam à parte; em aberto soma os negócios enviados, em negociação e pausados.' }}
        />
        <KpiTile
          label="Concentração"
          value={o?.concentration ? bps(o.concentration.shareBps, 0) : '-'}
          foot={o?.concentration ? <span>da receita dos últimos 12 meses é de {o.concentration.name}</span> : <span>sem receita ligada a clientes ainda</span>}
          assumptions={{ formula: list.data?.assumptions.concentracao ?? '' }}
        />
      </div>

      <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
        <div className="search-field grow" style={{ minWidth: 220 }}>
          <Icon name="search" size={15} />
          <TextInput value={search} onChange={setSearch} placeholder="Nome, e-mail, segmento ou contato" ariaLabel="Buscar clientes" />
        </div>
        <Segmented
          ariaLabel="Filtrar clientes"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Todos' },
            { value: 'company', label: 'Empresas' },
            { value: 'person', label: 'Pessoas' },
            { value: 'lead', label: 'Leads' },
            { value: 'recurring', label: 'Recorrentes' },
          ]}
        />
      </div>

      <Card flush title="Clientes" subtitle={list.data ? `${rows.length} ${rows.length === 1 ? 'cliente' : 'clientes'}` : undefined}>
        {list.isError ? (
          <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar os clientes agora. Tente de novo em instantes." />
        ) : !list.data ? (
          <div style={{ padding: 'var(--sp-5)' }}>
            <SkeletonLines lines={5} />
          </div>
        ) : rows.length === 0 ? (
          debounced || filter !== 'all' ? (
            <EmptyState icon="search" title="Nada com esse filtro" body="Nenhum cliente combina com a busca ou o filtro. Limpe para ver todos." />
          ) : (
            <EmptyState
              icon="user"
              title="Nenhum cliente ainda"
              body="Cadastre leads e clientes com contato, e-mail e descrição, e ligue cada orçamento a um deles para ver LTV, recorrência e MRR."
              action={
                <Button icon="plus" onClick={onCreate}>
                  Cadastrar primeiro cliente
                </Button>
              }
            />
          )
        ) : (
          <div className="table-wrap">
            <table className="table table--stack-mobile table--stack-compact table--clickable">
              <thead>
                <tr>
                  <th scope="col">Cliente</th>
                  <th scope="col">Situação</th>
                  <th scope="col" className="table__num">LTV realizado</th>
                  <th scope="col" className="table__num">Previsto</th>
                  <th scope="col" className="table__num">MRR</th>
                  <th scope="col">Último recebimento</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    tabIndex={0}
                    onClick={() => navigate(`/precificacao/clientes/${c.id}`)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') navigate(`/precificacao/clientes/${c.id}`)
                    }}
                    aria-label={`${c.name}, ${CLIENT_KIND_LABEL[c.kind]}, LTV ${money(c.metrics.ltvRealizedCents)}`}
                  >
                    <td data-label="__lead">
                      <span style={{ minWidth: 0 }}>
                        <strong style={{ fontWeight: 600 }}>{c.name}</strong>
                        <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                          {CLIENT_KIND_LABEL[c.kind]}
                          {c.segment ? ` · ${c.segment}` : ''}
                          {c.primaryContact ? ` · ${c.primaryContact.name}` : ''}
                          {c.dealCount > 0 ? ` · ${c.dealCount === 1 ? '1 negócio' : `${c.dealCount} negócios`}` : ''}
                        </span>
                      </span>
                    </td>
                    <td data-label="__trail">
                      <span className="row" style={{ gap: 'var(--sp-1)', flexWrap: 'wrap' }}>
                        <span className={CLIENT_STATUS_BADGE[c.status]}>{CLIENT_STATUS_LABEL[c.status]}</span>
                        {c.metrics.isRecurring && <span className="badge badge--info">Recorrente</span>}
                      </span>
                    </td>
                    <td className="table__num" data-label="LTV realizado">
                      <strong className="tabular">{money(c.metrics.ltvRealizedCents)}</strong>
                    </td>
                    <td className="table__num muted" data-label="Previsto">{money(c.metrics.ltvForecastCents)}</td>
                    <td className="table__num" data-label="MRR">{c.metrics.mrrCents > 0 ? money(c.metrics.mrrCents) : <span className="muted">-</span>}</td>
                    <td data-label="Último recebimento">{c.metrics.lastRevenueOn ? fmtDate(c.metrics.lastRevenueOn) : <span className="muted">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && <ClientFormModal onClose={onCloseCreate} onSaved={(client) => navigate(`/precificacao/clientes/${client.id}`)} />}
    </div>
  )
}
