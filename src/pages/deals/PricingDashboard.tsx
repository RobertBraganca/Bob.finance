import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bps, money } from '../../lib/format'
import { DEAL_STAGE_LABEL } from '@shared/deals'
import {
  DealFunnelChart,
  DealSentVsApprovedChart,
  DealStageRing,
  type DealFunnelStage,
  type DealPeriodPoint,
  type DealStageSlice,
} from '../../components/charts/PricingCharts'
import { Bento, Button, Card, EmptyState, KpiTile, SkeletonLines } from '../../components/ui'
import type { ClientsResponse } from '../clients/types'
import { useServiceCatalog } from '../services/useServiceCatalog'
import type { DealsSummary } from './types'

type DealsAnalytics = {
  byStage: DealStageSlice[]
  byPeriod: DealPeriodPoint[]
  funnel: DealFunnelStage[]
  totalCount: number
  assumptions: Record<string, unknown>
}

/**
 * Painel de Precificação (aba padrão): o resumo de cima, antes da lista. Os
 * gráficos que eram da aba Cotações, agora com orçamentos e cotações juntos,
 * mais os maiores clientes e os serviços que mais renderam. Só observa
 * (decisions/0010): nada aqui diz o que fazer.
 */
export function PricingDashboard() {
  const navigate = useNavigate()
  const summary = useQuery({
    queryKey: ['deals', 'summary'],
    queryFn: () => api.get<DealsSummary>('/pricing/deals/summary'),
  })
  const analytics = useQuery({
    queryKey: ['deals', 'analytics'],
    queryFn: () => api.get<DealsAnalytics>('/pricing/deals/analytics'),
  })
  const clients = useQuery({
    queryKey: ['clients', '', 'all'],
    queryFn: () => api.get<ClientsResponse>('/pricing/clients'),
  })
  const services = useServiceCatalog()

  const s = summary.data
  const o = clients.data?.overview
  const a = analytics.data

  const topClients = [...(clients.data?.clients ?? [])]
    .filter((c) => c.metrics.ltvForecastCents > 0)
    .sort((x, y) => y.metrics.ltvForecastCents - x.metrics.ltvForecastCents)
    .slice(0, 5)
  const topServices = [
    ...(services.data?.services ?? []).map((sv) => ({ key: `s-${sv.id}`, name: sv.name, catalogued: true, ...sv.stats })),
    ...(services.data?.uncatalogued ?? []).map((u) => ({ key: `u-${u.title}`, name: u.title, catalogued: false, ...u })),
  ]
    .filter((sv) => sv.revenueCents > 0)
    .sort((x, y) => y.revenueCents - x.revenueCents)
    .slice(0, 5)
  const maxClient = Math.max(1, ...topClients.map((c) => c.metrics.ltvForecastCents))
  const maxService = Math.max(1, ...topServices.map((sv) => sv.revenueCents))

  return (
    <div className="stack stack--loose">
      <div className="kpi-row">
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
        <KpiTile
          label="MRR"
          value={o ? money(o.mrrCents) : '-'}
          foot={o ? <span>{o.recurringClients === 1 ? '1 cliente recorrente' : `${o.recurringClients} clientes recorrentes`}</span> : undefined}
          assumptions={{ formula: clients.data?.assumptions.mrr ?? '', recorrente: clients.data?.assumptions.recorrente ?? '' }}
        />
      </div>

      <Bento>
        <Card span={6} title="Funil de negócios" subtitle="Quantos avançam de etapa em etapa" assumptions={a?.assumptions}>
          {analytics.isError ? (
            <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar o funil agora." />
          ) : !a ? (
            <SkeletonLines lines={4} />
          ) : (
            <DealFunnelChart stages={a.funnel} surface="paper" />
          )}
        </Card>

        <Card span={6} title="Valor por estágio" subtitle="Onde está o dinheiro dos negócios, estágio a estágio" assumptions={a?.assumptions}>
          {analytics.isError ? (
            <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar o resumo agora." />
          ) : !a ? (
            <SkeletonLines lines={4} />
          ) : a.totalCount === 0 ? (
            <EmptyState icon="info" title="Nenhum negócio ainda" body="Crie um orçamento ou salve uma cotação para ele aparecer aqui." />
          ) : (
            <>
              <DealStageRing slices={a.byStage} labels={DEAL_STAGE_LABEL} surface="paper" />
              {a.totalCount < 10 && (
                <p className="chart__note">
                  {a.totalCount} negócios no total. Com menos de dez, a proporção muda muito a cada novo: leia como retrato de agora, não como
                  tendência.
                </p>
              )}
            </>
          )}
        </Card>

        <Card span={12} title="Enviado x aprovado" subtitle="Quanto foi proposto e quanto foi fechado, mês a mês" assumptions={a?.assumptions}>
          {analytics.isError ? (
            <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar o resumo agora." />
          ) : !a ? (
            <SkeletonLines lines={4} />
          ) : (
            <DealSentVsApprovedChart data={a.byPeriod} surface="paper" />
          )}
        </Card>

        <Card
          span={6}
          title="Maiores clientes"
          subtitle="O que entrou mais o que está a receber, por cliente"
          assumptions={{ formula: clients.data?.assumptions.ltv ?? '' }}
          actions={
            <Button variant="quiet" size="sm" onClick={() => navigate('/precificacao?aba=clientes')}>
              Ver clientes
            </Button>
          }
        >
          {clients.isError ? (
            <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar os clientes agora." />
          ) : !clients.data ? (
            <SkeletonLines lines={4} />
          ) : topClients.length === 0 ? (
            <EmptyState icon="user" title="Nenhuma receita ligada a clientes" body="Ligue orçamentos e os nomes do extrato aos clientes para eles aparecerem aqui." />
          ) : (
            <RankList
              rows={topClients.map((c) => ({
                key: String(c.id),
                label: c.name,
                detail:
                  c.metrics.ltvForecastCents > c.metrics.ltvRealizedCents
                    ? `${money(c.metrics.ltvRealizedCents)} recebido · ${money(c.metrics.ltvForecastCents - c.metrics.ltvRealizedCents)} a receber`
                    : `${money(c.metrics.ltvRealizedCents)} recebido`,
                valueCents: c.metrics.ltvForecastCents,
                share: c.metrics.ltvForecastCents / maxClient,
                onOpen: () => navigate(`/precificacao/clientes/${c.id}`),
              }))}
            />
          )}
        </Card>

        <Card
          span={6}
          title="Serviços que mais renderam"
          subtitle="Nos orçamentos aprovados, com a fatia de cada item no valor fechado"
          assumptions={{ base: services.data?.assumptions.base ?? '', receita: services.data?.assumptions.receita ?? '' }}
          actions={
            <Button variant="quiet" size="sm" onClick={() => navigate('/precificacao?aba=servicos')}>
              Ver serviços
            </Button>
          }
        >
          {services.isError ? (
            <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar os serviços agora." />
          ) : !services.data ? (
            <SkeletonLines lines={4} />
          ) : topServices.length === 0 ? (
            <EmptyState icon="layers" title="Nenhum serviço vendido ainda" body="Os itens dos orçamentos aprovados aparecem aqui." />
          ) : (
            <RankList
              rows={topServices.map((sv) => ({
                key: sv.key,
                label: sv.name,
                detail: `${sv.timesSold === 1 ? '1 venda' : `${sv.timesSold} vendas`}${sv.catalogued ? '' : ' · fora do catálogo'}`,
                valueCents: sv.revenueCents,
                share: sv.revenueCents / maxService,
              }))}
            />
          )}
        </Card>
      </Bento>
    </div>
  )
}

/** Lista ranqueada com barra proporcional ao maior: o número exato vai escrito, a barra só dá a escala. */
function RankList({
  rows,
}: {
  rows: Array<{ key: string; label: string; detail: string; valueCents: number; share: number; onOpen?: () => void }>
}) {
  return (
    <ol className="rank-list">
      {rows.map((row) => {
        const body = (
          <>
            <span className="row row--between" style={{ gap: 'var(--sp-2)', alignItems: 'baseline' }}>
              <span style={{ minWidth: 0 }}>
                <strong className="rank-list__label">{row.label}</strong>
                <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                  {row.detail}
                </span>
              </span>
              <strong className="tabular">{money(row.valueCents)}</strong>
            </span>
            <span className="rank-list__track" aria-hidden="true">
              <span className="rank-list__bar" style={{ width: `${Math.max(2, row.share * 100)}%` }} />
            </span>
          </>
        )
        return (
          <li key={row.key}>
            {row.onOpen ? (
              <button type="button" className="rank-list__item rank-list__item--link" onClick={row.onOpen}>
                {body}
              </button>
            ) : (
              <div className="rank-list__item">{body}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
