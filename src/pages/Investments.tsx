import { useId, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { invalidateInvestmentData } from '../lib/invalidate'
import { todayIso } from '../lib/period'
import { telemetry } from '../lib/telemetry'
import {
  bps,
  bpsToInput,
  centsToInput,
  money,
  monthsLabel,
  parseMoneyInput,
  parsePercentInput,
  period as fmtPeriod,
  quantity as fmtQuantity,
  signedBps,
  signedPoints,
  date as fmtDate,
} from '../lib/format'
import {
  Assumptions,
  Bento,
  Button,
  Card,
  ConfirmDeleteModal,
  EmptyState,
  FilterSelect,
  HeroFigure,
  Icon,
  KpiTile,
  Meter,
  Modal,
  PageSkeleton,
  Segmented,
  Select,
  Slab,
  SkeletonBlock,
  SkeletonLines,
  StatTile,
  StatusBadge,
  targetProgressState,
  TextInput,
  useToast,
  type AssumptionBag,
  type IconName,
  type MeterState,
} from '../components/ui'
import { PageHeader } from '../components/shell/Shell'
import {
  AllocationChart,
  AssetClassRing,
  GoalProjectionChart,
  PortfolioEvolutionChart,
  type AllocationSlice,
  type PerformancePoint,
} from '../components/charts/InvestmentCharts'
import { ProfitabilityChart } from '../components/charts/ProfitabilityChart'
import { DateRangePopover } from '../components/ui/DateRangePopover'
import { GoalModal, type Goal, type Projection } from '../components/ui/GoalModal'
import { AposentadoriaTab } from './Aposentadoria'
import { ProventosTab } from './Proventos'

/** Only these classes trade on B3 the way BRAPI understands — mirrors the server's set. */
const QUOTABLE_CLASSES = new Set(['stocks', 'fii'])

export type Position = {
  assetId: number
  name: string
  ticker: string | null
  assetClass: string
  assetClassLabel: string
  quantity: number
  contributedCents: number
  avgUnitPriceCents: number
  lastUnitPriceCents: number | null
  lastPricedOn: string | null
  marketValueCents: number
  dividendsCents: number
  gainCents: number
  gainBps: number | null
  note: number | null
  answeredCriteria: number
  totalCriteria: number
  countsTowardReserve: boolean
}

type PortfolioResponse = {
  positions: Position[]
  marketValueCents: number
  contributedCents: number
  dividendsCents: number
  gainCents: number
  gainBps: number | null
  assetCount: number
  unpricedCount: number
  allocation: AllocationSlice[]
  performance: Array<{ period: string; contributedCents: number; valueCents: number; gainCents: number }>
  goals: Goal[]
  assetClasses: Array<{ value: string; label: string }>
  /** Sem imobilizado: só o que pode receber meta de alocação. */
  allocatableAssetClasses: Array<{ value: string; label: string }>
  goalPurposes: Array<{ value: string; label: string }>
}

type InvestmentsTab = 'portfolio' | 'contribute' | 'goals' | 'profitability' | 'ledger' | 'proventos' | 'retirement'

/**
 * A aba vive no endereço (`?aba=metas`): antes ela era só estado da tela,
 * então recarregar voltava para Carteira e nenhuma aba podia ser guardada
 * ou compartilhada como link (revisão de 03/10/2026).
 */
const TAB_SLUG: Record<InvestmentsTab, string> = {
  portfolio: 'carteira',
  contribute: 'aportar',
  ledger: 'movimentacoes',
  proventos: 'proventos',
  goals: 'metas',
  profitability: 'rentabilidade',
  retirement: 'aposentadoria',
}
const SLUG_TAB = Object.fromEntries(Object.entries(TAB_SLUG).map(([tab, slug]) => [slug, tab])) as Record<
  string,
  InvestmentsTab
>

const INVESTMENTS_SKELETON_CARDS: Array<{ span: 6 | 12; variant: 'lines' | 'stats' | 'block'; height?: number }> = [
  { span: 12, variant: 'stats', height: 120 },
  { span: 6, variant: 'block', height: 300 },
  { span: 6, variant: 'block', height: 300 },
]

export function InvestmentsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: InvestmentsTab = SLUG_TAB[searchParams.get('aba') ?? ''] ?? 'portfolio'
  const setTab = (next: InvestmentsTab) =>
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current)
        if (next === 'portfolio') params.delete('aba')
        else params.set('aba', TAB_SLUG[next])
        return params
      },
      { replace: true },
    )
  const [assetModal, setAssetModal] = useState(false)
  const [tradeModal, setTradeModal] = useState(false)
  const [tradePreset, setTradePreset] = useState<string | null>(null)
  const [allocModal, setAllocModal] = useState(false)
  const [criteriaModal, setCriteriaModal] = useState<{ assetId: number; name: string; assetClass: string } | null>(
    null,
  )
  const [tradeHistory, setTradeHistory] = useState<{ label: string; assetIds: number[] } | null>(null)

  const portfolio = useQuery({
    queryKey: ['investments'],
    queryFn: () => api.get<PortfolioResponse>('/investments'),
  })

  const data = portfolio.data

  return (
    <>
      {/* A navegação das seções mora no cabeçalho, no lugar onde o Painel põe o
          filtro de período: fica presa no topo ao rolar e a página abre direto
          nos números (revisão de design de 04/10/2026). */}
      <PageHeader
        title="Investimentos"
        subtitle="Carteira, aportes, metas e proventos"
        filters={
          <Segmented
            ariaLabel="Seção"
            className="segmented--nav"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'portfolio', label: 'Carteira' },
              { value: 'contribute', label: 'Aportar' },
              { value: 'ledger', label: 'Movimentações' },
              { value: 'proventos', label: 'Proventos' },
              // Sem número até carregar: "Metas (0)" aparecia antes de "Metas (3)".
              { value: 'goals', label: data ? `Metas (${data.goals.length})` : 'Metas' },
              { value: 'profitability', label: 'Rentabilidade' },
              { value: 'retirement', label: 'Aposentadoria' },
            ]}
          />
        }
        actions={
          /* "Atualizar cotações" foi para o card "Meus ativos", onde as
             cotações aparecem: no cabeçalho ele surgia atrasado (depende
             da carteira carregada) e, com mais dois botões, ocupava 193px
             do topo do telefone. */
          <div className="row">
            <Button icon="plus" onClick={() => setAssetModal(true)} title="Novo ativo">
              {/* No telefone estreito o rótulo some da tela (fica para o
                  leitor de tela) e os dois botões cabem numa linha só. */}
              <span className="btn__label--collapse">Novo ativo</span>
            </Button>
            <Button
              variant="primary"
              icon="trending"
              onClick={() => setTradeModal(true)}
              disabled={(data?.assetCount ?? 0) === 0}
            >
              Registrar operação
            </Button>
          </div>
        }
      />

      {/* `key={tab}`: cada troca de seção remonta o painel e a entrada
          (`.tab-panel`) roda de novo, um único movimento curto. */}
      <div className="page stack stack--loose tab-panel" key={tab}>
        {!data ? (
          <PageSkeleton cards={INVESTMENTS_SKELETON_CARDS} />
        ) : data.assetCount === 0 ? (
          <Bento>
            <Slab span={12} accent>
              <div className="stack" style={{ maxWidth: '62ch' }}>
                <span className="stat__label">Carteira vazia</span>
                <h2 className="display" style={{ fontSize: 'var(--text-xl)' }}>
                  Cadastre um ativo e o primeiro aporte
                </h2>
                <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-base)' }}>
                  As posições são derivadas dos aportes, nunca guardadas como saldo, então corrigir
                  um lançamento antigo corrige a carteira inteira. O valor de mercado vem das
                  cotações que você registra; sem cotação, o custo médio é usado como referência
                  honesta.
                </p>
                <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
                  <Button variant="primary" icon="plus" onClick={() => setAssetModal(true)}>
                    Cadastrar ativo
                  </Button>
                </div>
              </div>
            </Slab>
          </Bento>
        ) : tab === 'portfolio' ? (
          <PortfolioTab
            data={data}
            onOpenAlloc={() => setAllocModal(true)}
            onOpenCriteria={(payload) => setCriteriaModal(payload)}
            onAddTrade={(assetClass) => {
              setTradePreset(assetClass)
              setTradeModal(true)
            }}
            onViewTrades={(label, assetIds) => setTradeHistory({ label, assetIds })}
          />
        ) : tab === 'contribute' ? (
          <ContributionPlanner goals={data.goals} />
        ) : tab === 'ledger' ? (
          <LedgerTab positions={data.positions} />
        ) : tab === 'proventos' ? (
          <ProventosTab positions={data.positions} classes={data.assetClasses} />
        ) : tab === 'profitability' ? (
          <ProfitabilityTab />
        ) : tab === 'retirement' ? (
          <AposentadoriaTab />
        ) : (
          <GoalsEnvironment goals={data.goals} goalPurposes={data.goalPurposes} />
        )}
      </div>

      {assetModal && <AssetModal classes={data?.assetClasses ?? []} onClose={() => setAssetModal(false)} />}
      {tradeModal && (
        <TradeModal
          classes={data?.assetClasses ?? []}
          positions={data?.positions ?? []}
          initialAssetClass={tradePreset}
          onClose={() => {
            setTradeModal(false)
            setTradePreset(null)
          }}
        />
      )}
      {allocModal && (
        <AllocationModal
          classes={data?.allocatableAssetClasses ?? []}
          current={data?.allocation ?? []}
          onClose={() => setAllocModal(false)}
        />
      )}
      {criteriaModal && (
        <CriteriaModal
          assetId={criteriaModal.assetId}
          name={criteriaModal.name}
          assetClass={criteriaModal.assetClass}
          onClose={() => setCriteriaModal(null)}
        />
      )}
      {tradeHistory && (
        <TradeHistoryModal
          label={tradeHistory.label}
          assetIds={tradeHistory.assetIds}
          onClose={() => setTradeHistory(null)}
        />
      )}
    </>
  )
}

/**
 * Loops one BRAPI request per quotable position — the free plan allows
 * exactly one ticker per call, so "refresh all" is sequential server-side,
 * never a single batched request. Hidden entirely when there's nothing
 * with a ticker to refresh.
 */
function RefreshAllQuotesButton({ hasQuotable }: { hasQuotable: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const refresh = useMutation({
    mutationFn: () => api.post<{ results: QuoteRefreshResult[] }>('/investments/quotes/refresh-all'),
    onSuccess: ({ results }) => {
      const updated = results.filter((r) => r.status === 'updated').length
      const errors = results.filter((r) => r.status === 'error')
      invalidateInvestmentData(queryClient)
      const firstError = errors[0]
      if (!firstError) {
        toast(`${updated} cotação(ões) atualizada(s) via BRAPI`)
      } else {
        toast(`${updated} atualizadas, ${errors.length} falharam (${firstError.error})`, 'error')
      }
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao consultar BRAPI', 'error'),
  })

  if (!hasQuotable) return null

  return (
    <Button icon="refresh" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
      Atualizar cotações
    </Button>
  )
}

/**
 * The resistance note as a compact badge — colour communicates the band
 * (saudável / atenção / veto), but the number and the "x/y respondidas"
 * label always travel with it, per the rule that status never rides on
 * colour alone. Unscored shows a neutral "—", inviting a click rather
 * than looking like a zero.
 */
function NoteBadge({
  note,
  answered,
  total,
  onClick,
}: {
  note: number | null
  answered: number
  total: number
  onClick: () => void
}) {
  const tone = note === null ? 'default' : note >= 7 ? 'good' : note >= 4 ? 'warning' : 'critical'
  const label = note === null ? '-' : String(note)
  const title =
    total === 0
      ? 'Nenhum critério cadastrado para esta classe ainda'
      : note === null
        ? `Sem nota, responda os ${total} critérios`
        : `Nota ${note}/10 · ${answered} de ${total} critérios respondidos`

  return (
    <button
      type="button"
      className={`badge badge--btn ${tone === 'good' ? 'badge--good' : tone === 'warning' ? 'badge--warning' : tone === 'critical' ? 'badge--critical' : ''}`}
      style={{ minWidth: 34, justifyContent: 'center' }}
      onClick={onClick}
      title={title}
      aria-label={`${title}. Abrir critérios`}
    >
      {label}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * Portfolio tab — KPI dashboard (date-range + class filter, evolution
 * and composition charts) above "Meus ativos", grouped by class with
 * the detailed per-asset table folded inside each group.
 * ------------------------------------------------------------------ */
type SummaryRangePreset = 'since_start' | '12m' | '2y' | '5y' | '10y' | 'custom'

const SUMMARY_RANGE_OPTIONS: Array<{ value: SummaryRangePreset; label: string }> = [
  { value: 'since_start', label: 'Desde o início' },
  { value: '12m', label: '12 meses' },
  { value: '2y', label: '2 anos' },
  { value: '5y', label: '5 anos' },
  { value: '10y', label: '10 anos' },
  { value: 'custom', label: 'Data personalizada' },
]

const RANGE_MONTHS: Partial<Record<SummaryRangePreset, number>> = { '12m': 12, '2y': 24, '5y': 60, '10y': 120 }

/** `iso` shifted back `monthsBack` months, clamped to the target month's real last day. */
function shiftIso(iso: string, monthsBack: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const total = y * 12 + (m - 1) - monthsBack
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const lastDay = new Date(ny, nm, 0).getDate()
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`
}

type RangeSummaryResponse = {
  fromIso: string | null
  toIso: string
  assetClass: string | null
  valueCents: number
  contributedCents: number
  dividendsCents: number
  dividendsInRangeCents: number
  capitalGainCents: number
  capitalGainInRangeCents: number
  totalGainCents: number
  gainBpsAllTime: number | null
  gainBpsInRange: number | null
  valueGrowthBpsInRange: number | null
}

const ASSET_CLASS_ICON: Record<string, IconName> = {
  stocks: 'trending',
  fii: 'home',
  fixed_income: 'shield',
  treasury: 'landmark',
  crypto: 'sparkle',
  funds: 'layers',
  etf_intl: 'globe',
  cash: 'banknote',
  pension: 'clock',
  other: 'dots',
  illiquid: 'wallet',
}

function PortfolioTab({
  data,
  onOpenAlloc,
  onOpenCriteria,
  onAddTrade,
  onViewTrades,
}: {
  data: PortfolioResponse
  onOpenAlloc: () => void
  onOpenCriteria: (payload: { assetId: number; name: string; assetClass: string }) => void
  onAddTrade: (assetClass: string) => void
  onViewTrades: (label: string, assetIds: number[]) => void
}) {
  const [rangePreset, setRangePreset] = useState<SummaryRangePreset>('12m')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState(todayIso)
  const [classFilter, setClassFilter] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showTracked, setShowTracked] = useState(false)

  const anchorIso = customTo || todayIso()
  const toIso = rangePreset === 'custom' ? customTo || anchorIso : anchorIso
  const fromIso =
    rangePreset === 'since_start'
      ? null
      : rangePreset === 'custom'
        ? customFrom || null
        : shiftIso(toIso, RANGE_MONTHS[rangePreset] ?? 12)

  const summary = useQuery({
    queryKey: ['investment-summary', fromIso, toIso, classFilter],
    queryFn: () =>
      api.get<RangeSummaryResponse>('/investments/summary', {
        from: fromIso ?? undefined,
        to: toIso,
        assetClass: classFilter ?? undefined,
      }),
    // Troca de período ou de tipo: os números anteriores ficam na tela,
    // esmaecidos (ver o `opacity` do container), até os novos chegarem, em
    // vez de virarem "-" por um instante. Mesmo comportamento do Painel.
    placeholderData: (previous) => previous,
  })

  const performance = useQuery({
    queryKey: ['investment-performance', classFilter],
    queryFn: () =>
      api.get<{ performance: PerformancePoint[] }>('/investments/performance', {
        months: 1200,
        assetClass: classFilter ?? undefined,
      }),
  })

  const evolutionData = useMemo(() => {
    const rows = performance.data?.performance ?? []
    const fromPeriod = fromIso?.slice(0, 7) ?? null
    const toPeriod = toIso.slice(0, 7)
    return rows.filter((row) => (fromPeriod === null || row.period >= fromPeriod) && row.period <= toPeriod)
  }, [performance.data, fromIso, toIso])

  const rangeLabel = SUMMARY_RANGE_OPTIONS.find((option) => option.value === rangePreset)?.label ?? '12 meses'
  const classFilterLabel = classFilter ? (data.assetClasses.find((c) => c.value === classFilter)?.label ?? classFilter) : null

  /*
   * Com um tipo escolhido, TODO número do topo passa a ser daquele tipo. Antes
   * o card misturava "Patrimônio total" da carteira inteira com o "+41,1% no
   * período" só de Ações, lado a lado (revisão de 03/10/2026). Sem filtro, os
   * números continuam vindo de `/investments`, como sempre.
   */
  const scoped = classFilter ? summary.data : null
  const headline = scoped
    ? {
        valueCents: scoped.valueCents,
        contributedCents: scoped.contributedCents,
        gainCents: scoped.totalGainCents,
        capitalGainCents: scoped.capitalGainCents,
        dividendsCents: scoped.dividendsCents,
      }
    : classFilter
      ? null
      : {
          valueCents: data.marketValueCents,
          contributedCents: data.contributedCents,
          gainCents: data.gainCents,
          capitalGainCents: data.gainCents - data.dividendsCents,
          dividendsCents: data.dividendsCents,
        }

  const targetSumBps = data.allocation.reduce((sum, slice) => sum + (slice.targetBps ?? 0), 0)
  const deviation = useQuery({
    queryKey: ['allocation-deviation'],
    queryFn: () => api.get<{ assumptions: AssumptionBag }>('/investments/allocation-deviation'),
  })

  const groups = useMemo(() => {
    const byClass = new Map<string, Position[]>()
    for (const p of data.positions) {
      if (classFilter && p.assetClass !== classFilter) continue
      // Imobilizado tem tela própria (`/patrimonio`) desde 01/09/2026 e sai
      // de `allocation()` no servidor pelo mesmo motivo: não se rebalanceia
      // um bem físico. Mostrá-lo aqui deixaria a lista de classes em
      // desacordo com os cards de alocação logo acima, na mesma tela.
      if (p.assetClass === 'illiquid') continue
      const list = byClass.get(p.assetClass) ?? []
      list.push(p)
      byClass.set(p.assetClass, list)
    }
    return [...byClass.entries()]
      .map(([assetClass, rows]) => ({
        assetClass,
        label: rows[0]!.assetClassLabel,
        rows,
        heldCount: rows.filter((p) => p.quantity > 0).length,
        alloc: data.allocation.find((a) => a.assetClass === assetClass) ?? null,
      }))
      .sort(
        (a, b) =>
          b.rows.reduce((s, p) => s + p.marketValueCents, 0) - a.rows.reduce((s, p) => s + p.marketValueCents, 0),
      )
  }, [data.positions, data.allocation, classFilter])

  // "Meus ativos (45)" contava 38 ativos sem nenhuma cota. Classe sem posição
  // nenhuma vai para um bloco recolhido no fim; o título conta só posições.
  const heldGroups = groups.filter((g) => g.heldCount > 0)
  const trackedGroups = groups.filter((g) => g.heldCount === 0)
  const heldTotal = heldGroups.reduce((sum, g) => sum + g.heldCount, 0)
  const trackedTotal = groups.reduce((sum, g) => sum + g.rows.length - g.heldCount, 0)
  const hasQuotable = data.positions.some((p) => p.ticker && QUOTABLE_CLASSES.has(p.assetClass))
  const toggleGroup = (assetClass: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(assetClass)) next.delete(assetClass)
      else next.add(assetClass)
      return next
    })

  const gainBps = summary.data?.gainBpsInRange ?? null
  const allTimeBps = summary.data?.gainBpsAllTime ?? null
  const rangeShort = rangePreset === 'since_start' ? 'desde o início' : rangePreset === 'custom' ? 'no período' : rangeLabel.toLowerCase()
  const toneOf = (value: number | null | undefined) => (value == null || value === 0 ? undefined : value > 0 ? 'up' : 'down')

  return (
    // Mesmo esmaecimento do Painel enquanto um período novo carrega: os
    // números da tela continuam os anteriores até a resposta chegar.
    <div
      className="stack stack--loose"
      aria-busy={summary.isFetching || undefined}
      style={{ opacity: summary.isFetching && summary.data ? 0.72 : 1, transition: 'opacity 120ms' }}
    >
      {/* Filtros soltos, sem card cinza em volta: no Painel o filtro é uma
          linha de controle, não um bloco de conteúdo. */}
      <div className="row row--wrap row--between" style={{ gap: 'var(--sp-2)' }}>
        <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
          <FilterSelect
            icon="calendar"
            value={rangePreset}
            options={SUMMARY_RANGE_OPTIONS}
            onChange={(value) => setRangePreset(value ?? '12m')}
          />
          {rangePreset === 'custom' && (
            <DateRangePopover
              icon="calendar"
              label={customFrom && customTo ? `${fmtDate(customFrom)} a ${fmtDate(customTo)}` : 'Escolher datas'}
              from={customFrom || customTo}
              to={customTo}
              onApply={(from, to) => {
                setCustomFrom(from)
                setCustomTo(to)
              }}
            />
          )}
        </div>
        <FilterSelect
          icon="tags"
          value={classFilter}
          placeholder="Todos os tipos"
          options={data.assetClasses}
          onChange={setClassFilter}
        />
      </div>

      {/*
        A mesma linha de quatro números do Painel (04/10/2026), no lugar do
        card preto grande, do card de lucro e do card de três rentabilidades.
        A conta de cada número vai no ⓘ do rótulo: "Valor da carteira" não é
        o Patrimônio do app (sem imobilizado nem conta), a variação dele
        inclui os aportes, e a rentabilidade daqui é outra conta que a da aba
        Rentabilidade (revisão de 03/10/2026).
      */}
      <div className="kpi-row">
        <KpiTile
          accent
          label={classFilterLabel ? `Valor em ${classFilterLabel}` : 'Valor da carteira'}
          value={headline ? money(headline.valueCents) : '-'}
          delta={summary.data ? summary.data.valueGrowthBpsInRange : undefined}
          // "com aportes" mora no ⓘ: no rótulo da seta ele quebrava o card em três linhas.
          deltaLabel={RANGE_MONTHS[rangePreset] ? `em ${rangeShort}` : rangeShort}
          foot={headline ? <span>investido {money(headline.contributedCents)}</span> : undefined}
          assumptions={{
            formula:
              'Valor de mercado das posições: a última cotação registrada ou, sem cotação, o custo médio. Imobilizado e saldo em conta ficam de fora. A variação compara com o valor no início do período e inclui os aportes feitos nele, então não é rentabilidade.',
            ...(headline ? { valorCents: headline.valueCents, aportadoCents: headline.contributedCents } : {}),
          }}
        />
        <KpiTile
          label="Lucro total"
          value={headline ? money(headline.gainCents) : '-'}
          tone={toneOf(headline?.gainCents)}
          foot={
            headline ? (
              <span>
                capital {money(headline.capitalGainCents)} · proventos {money(headline.dividendsCents)}
              </span>
            ) : undefined
          }
          assumptions={{
            formula: 'Ganho de capital (valor de hoje menos o que foi aportado) mais todos os proventos recebidos.',
            ...(headline
              ? { ganhoDeCapitalCents: headline.capitalGainCents, proventosCents: headline.dividendsCents }
              : {}),
          }}
        />
        <KpiTile
          label={`Rentabilidade, ${rangeShort}`}
          value={gainBps === null ? '-' : signedBps(gainBps)}
          tone={toneOf(gainBps)}
          foot={allTimeBps === null ? undefined : <span>desde o início {signedBps(allTimeBps)}</span>}
          assumptions={{
            formula:
              'Ganho do período (valorização mais proventos, sem os aportes) dividido pelo valor da carteira no início do período. "Desde o início" divide o ganho total pelo valor aportado. A aba Rentabilidade encadeia o retorno de cada mês, uma conta diferente, por isso os números não batem.',
          }}
        />
        <KpiTile
          label={`Proventos, ${rangeShort}`}
          value={summary.data ? money(summary.data.dividendsInRangeCents) : '-'}
          tone={summary.data && summary.data.dividendsInRangeCents > 0 ? 'up' : undefined}
          foot={summary.data ? <span>{money(summary.data.dividendsCents)} desde o início</span> : undefined}
          assumptions={{
            formula: 'Dividendos e JSCP com data de pagamento dentro do período. Os que ainda vão pagar não entram.',
          }}
        />
      </div>

      <Bento>
        <Card
          span={6}
          title={classFilterLabel ? `Evolução de ${classFilterLabel}` : 'Evolução da carteira'}
          subtitle="Valor aplicado e ganho de capital, mês a mês"
        >
          {/* Esqueleto enquanto carrega: o estado vazio "Nenhuma posição
              registrada" aparecia por um instante com o valor já no topo. */}
          {!performance.data ? (
            <SkeletonBlock height={260} />
          ) : (
            <PortfolioEvolutionChart data={evolutionData} surface="paper" height={260} />
          )}
        </Card>
        <AllocationCard
          allocation={data.allocation}
          targetSumBps={targetSumBps}
          assumptions={deviation.data?.assumptions ?? null}
          onOpenAlloc={onOpenAlloc}
        />
      </Bento>

      <Bento>
        <ReserveCard positions={data.positions} />
        <BelowTargetCard allocation={data.allocation} targetSumBps={targetSumBps} onOpenAlloc={onOpenAlloc} />
      </Bento>

      <Card
        span={12}
        flush
        title={`Meus ativos (${heldTotal})`}
        subtitle={
          trackedTotal > 0
            ? `${heldTotal} com posição${classFilterLabel ? ` em ${classFilterLabel}` : ''} e ${trackedTotal} acompanhado${trackedTotal === 1 ? '' : 's'} sem cota`
            : undefined
        }
        actions={
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <RefreshAllQuotesButton hasQuotable={hasQuotable} />
            <Button size="sm" icon="target" onClick={onOpenAlloc}>
              Configurar % ideal
            </Button>
          </div>
        }
      >
        {data.unpricedCount > 0 && (
          <p className="field__hint" style={{ padding: 'var(--sp-3) var(--sp-5) 0' }}>
            <Icon name="info" size={12} /> {data.unpricedCount} ativo(s) sem cotação registrada; o valor
            mostrado é o custo médio.
          </p>
        )}
        <div className="stack stack--tight" style={{ padding: 'var(--sp-5)' }}>
          {heldGroups.length === 0 && (
            <EmptyState
              icon="wallet"
              title={classFilterLabel ? `Nenhuma posição em ${classFilterLabel}` : 'Nenhuma posição'}
              body="Os ativos cadastrados ainda não têm cotas. Registre uma compra para eles aparecerem aqui."
            />
          )}
          {[...heldGroups, ...(showTracked ? trackedGroups : [])].map((group) => (
            <AssetGroupCard
              key={group.assetClass}
              assetClass={group.assetClass}
              label={group.label}
              rows={group.rows}
              classes={data.assetClasses}
              actualBps={group.alloc?.actualBps ?? 0}
              targetBps={group.alloc?.targetBps ?? null}
              portfolioValueCents={data.marketValueCents}
              expanded={expanded.has(group.assetClass)}
              onToggle={() => toggleGroup(group.assetClass)}
              onOpenCriteria={onOpenCriteria}
              onAddTrade={() => onAddTrade(group.assetClass)}
              onViewTrades={() => onViewTrades(group.label, group.rows.map((r) => r.assetId))}
            />
          ))}
          {trackedGroups.length > 0 && (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              style={{ alignSelf: 'flex-start' }}
              aria-expanded={showTracked}
              onClick={() => setShowTracked((v) => !v)}
            >
              <Icon
                name="chevronDown"
                size={13}
                className={`group-head__chevron${showTracked ? ' group-head__chevron--open' : ''}`}
              />
              {showTracked ? 'Ocultar classes sem posição' : `Mostrar classes sem posição (${trackedGroups.map((g) => g.label).join(', ')})`}
            </button>
          )}
        </div>
      </Card>
    </div>
  )
}

type AllocationView = 'composition' | 'target'

/**
 * Alocação num card só, com o alternador no canto, como "Por tag" no Painel
 * (04/10/2026). Antes eram dois cards: a rosca "Ativos na carteira" e o
 * gráfico "Alocação por classe" de largura inteira, que já absorvera a tabela
 * de desvio (03/10/2026).
 *
 * Contra a meta: sua carteira hoje contra a política que você configurou,
 * por classe, e nada além disso. Nada aqui sugere ativo, classe ou operação:
 * `decisions/0010` e o raciocínio do Ofício-Circular CVM/SIN 2/2026
 * registrado lá. Um relatório gerencial da composição contra a política do
 * próprio cliente é outra coisa que consultoria, e a diferença mora em não
 * recomendar. A memória de cálculo do endpoint de desvio fica no ⓘ.
 */
function AllocationCard({
  allocation,
  targetSumBps,
  assumptions,
  onOpenAlloc,
}: {
  allocation: AllocationSlice[]
  targetSumBps: number
  assumptions: AssumptionBag | null
  onOpenAlloc: () => void
}) {
  const [view, setView] = useState<AllocationView>('composition')

  return (
    <Card
      span={6}
      title="Alocação"
      subtitle={
        view === 'composition' ? 'Por classe, hoje' : 'Barra: hoje · marca: meta · número: desvio em p.p.'
      }
      assumptions={view === 'target' ? assumptions : null}
      actions={
        <Segmented
          ariaLabel="Visão da alocação"
          value={view}
          onChange={setView}
          options={[
            { value: 'composition', label: 'Composição' },
            { value: 'target', label: 'Contra a meta' },
          ]}
        />
      }
    >
      {view === 'composition' ? (
        <AssetClassRing slices={allocation} surface="paper" height={200} />
      ) : (
        <>
          <AllocationChart slices={allocation} surface="paper" />
          <TargetSumNote targetSumBps={targetSumBps} />
        </>
      )}
      <div className="row row--wrap" style={{ marginTop: 'auto' }}>
        <button type="button" className="btn btn--quiet btn--sm" onClick={onOpenAlloc}>
          <Icon name="target" size={13} />
          Definir metas por classe
        </button>
      </div>
    </Card>
  )
}

/**
 * As metas por classe que não somam 100% deixam uma fatia da carteira sem
 * destino, e os cards que usam essas metas não diziam isso: o aviso só
 * aparecia dentro de "Definir metas" (revisão de 03/10/2026).
 */
function TargetSumNote({ targetSumBps }: { targetSumBps: number }) {
  if (targetSumBps === 0 || targetSumBps === 10_000) return null
  return (
    <p className="chart__note" style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
      <Icon name="info" size={12} />
      <span>
        As metas por classe somam {bps(targetSumBps, 0)}.{' '}
        {targetSumBps < 10_000
          ? `${bps(10_000 - targetSumBps, 0)} da carteira não têm classe de destino.`
          : `Passam de 100% em ${bps(targetSumBps - 10_000, 0)}.`}
      </span>
    </p>
  )
}

/* ------------------------------------------------------------------ *
 * Emergency reserve — priority zero ahead of any class in the
 * contribution waterfall. Target is a multiple of the real average
 * monthly expense (never a stored, staleable number); progress is the
 * market value of whichever assets the user flagged as reserve
 * holdings, toggled per-asset from the group table below.
 * ------------------------------------------------------------------ */
type ReserveStatus = {
  assetId: number | null
  multiple: number
  lookbackMonths: number
  monthlyLivingCostCents: number
  livingCostIsManual: boolean
  /** meses da janela com movimento que entraram na mediana */
  livingCostSampleMonths: number
  targetCents: number
  currentCents: number
  gapCents: number
  progressBps: number
}

const RESERVE_MULTIPLE_OPTIONS = [
  { value: '6', label: '6x' },
  { value: '12', label: '12x' },
  { value: '24', label: '24x' },
]

/**
 * "Necessário para atingir a meta": how much is still missing per class, in
 * reais, for the classes that are BELOW their configured target.
 *
 * This replaced a card that said "aportar R$X" or "reduzir R$Y". "Reduzir"
 * was the problem: the Diagrama do Cerrado never suggests selling to
 * rebalance, it only directs new money (see `specs/investments`, cascata de
 * aporte), so telling the user to reduce a position was the one surface in
 * the product contradicting the very method that inspired the feature, and
 * a Recommendation of the kind `decisions/0010` puts outside the product.
 * See `decisions/0011`.
 *
 * A class at or above its target is simply absent from the list. Not
 * "reduzir R$0", not a zero row: silence. The signed deviation is still
 * available next door, in the chart and in the desvio table.
 */
function BelowTargetCard({
  allocation,
  targetSumBps,
  onOpenAlloc,
}: {
  allocation: AllocationSlice[]
  targetSumBps: number
  onOpenAlloc: () => void
}) {
  const hasAnyTarget = allocation.some((slice) => slice.rebalanceCents !== null)
  const below = allocation.filter(
    (slice) => slice.rebalanceCents !== null && slice.rebalanceCents > 0,
  )

  return (
    <Card
      span={6}
      title="Necessário para atingir a meta"
      subtitle="Quanto ainda falta em cada classe abaixo da alocação configurada"
    >
      {!hasAnyTarget ? (
        <EmptyState
          icon="scale"
          title="Sem meta de alocação"
          body="Defina o percentual-alvo por classe para ver o quanto falta em cada uma."
          action={
            <Button variant="primary" size="sm" onClick={onOpenAlloc}>
              Definir alocação-alvo
            </Button>
          }
        />
      ) : below.length === 0 ? (
        <EmptyState
          icon="check"
          title="Nenhuma classe abaixo da meta"
          body="Toda classe com alocação-alvo configurada está na meta ou acima dela neste momento."
        />
      ) : (
        <div className="stack stack--tight">
          {/* Sem truncate (revisão de responsividade de 26/09/2026):
              "ETFs Internacionais" cortava num telefone, competindo com o
              desvio+valor na mesma linha — `row--wrap` deixa o valor cair
              pra linha de baixo em vez de espremer o nome da classe. */}
          {below.map((slice) => (
            <div key={slice.assetClass} className="row row--between row--wrap" style={{ rowGap: 'var(--sp-1)' }}>
              <span style={{ minWidth: 0 }}>{slice.label}</span>
              <span className="row" style={{ gap: 'var(--sp-3)' }}>
                <span className="muted tabular" style={{ fontSize: 'var(--text-xs)' }}>
                  {slice.driftBps === null ? '' : signedPoints(slice.driftBps)}
                </span>
                <span className="tabular" style={{ minWidth: 108, textAlign: 'right' }}>
                  {money(slice.rebalanceCents!)}
                </span>
              </span>
            </div>
          ))}
          {/* Simulação, never an instruction: same closing pattern the
              financial engine uses for its break-even card. */}
          <p className="chart__note">
            Considerando a alocação-alvo configurada, estes valores ainda seriam necessários em cada
            classe para alcançar a meta.
          </p>
          <TargetSumNote targetSumBps={targetSumBps} />
        </div>
      )}
    </Card>
  )
}

function ReserveCard({ positions }: { positions: Position[] }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editingCost, setEditingCost] = useState(false)
  const [costInput, setCostInput] = useState('')
  const [contributing, setContributing] = useState(false)
  const [viewingHistory, setViewingHistory] = useState(false)
  const costInputFieldId = useId()

  const reserve = useQuery({
    queryKey: ['investment-reserve'],
    queryFn: () => api.get<ReserveStatus>('/investments/reserve'),
  })

  const setMultiple = useMutation({
    mutationFn: (multiple: number) => api.put('/investments/reserve', { multiple }),
    onSuccess: () => {
      toast('Meta de reserva atualizada')
      invalidateInvestmentData(queryClient)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const setLivingCost = useMutation({
    mutationFn: (manualLivingCostCents: number | null) => api.put('/investments/reserve', { manualLivingCostCents }),
    onSuccess: (_, manualLivingCostCents) => {
      toast(manualLivingCostCents === null ? 'Voltou a usar a média calculada' : 'Custo de vida atualizado')
      invalidateInvestmentData(queryClient)
      setEditingCost(false)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const data = reserve.data
  const meterState = targetProgressState(data ? data.progressBps : null)
  // De que é feita a reserva: "Guardado" somava Caixa e cripto sem dizer,
  // e "minha reserva está onde?" não tinha resposta na tela.
  const holdings = positions
    .filter((p) => p.countsTowardReserve && p.marketValueCents > 0)
    .sort((a, b) => b.marketValueCents - a.marketValueCents)

  return (
    <Card
      span={6}
      title="Reserva de emergência"
      subtitle="Quanto do seu custo de vida já está guardado"
      actions={
        <Segmented
          ariaLabel="Meta de reserva"
          value={data ? String(data.multiple) : '6'}
          options={RESERVE_MULTIPLE_OPTIONS}
          onChange={(value) => setMultiple.mutate(Number(value))}
        />
      }
    >
      {!data ? (
        <SkeletonLines lines={4} />
      ) : (
        <div className="stack">
          {/* Um número grande só, o que já foi guardado. Meta e falta vão numa
              lista menor: "Falta R$ 28.981,00" em letra de destaque soava
              como cobrança ao lado de "Guardado R$ 1.065,08" (crítica de
              03/10/2026). */}
          <StatTile label="Guardado" value={money(data.currentCents)} large />
          <div className="kv">
            <span className="kv__k">Meta ({data.multiple}x o custo de vida)</span>
            <span className="kv__v">{money(data.targetCents)}</span>
            <span className="kv__k">Falta</span>
            <span className="kv__v">{data.gapCents === 0 ? 'Completa' : money(data.gapCents)}</span>
          </div>

          {!editingCost ? (
            <div className="row row--between" style={{ fontSize: 'var(--text-xs)' }}>
              <span className="muted">
                Custo de vida usado: <strong className="tabular">{money(data.monthlyLivingCostCents)}</strong>/mês
                {data.livingCostIsManual
                  ? ' (informado por você)'
                  : ` (mediana de ${data.livingCostSampleMonths} ${data.livingCostSampleMonths === 1 ? 'mês' : 'meses'} com movimento, janela de ${data.lookbackMonths})`}
              </span>
              <Button
                variant="quiet"
                size="sm"
                icon="pencil"
                onClick={() => {
                  setCostInput(centsToInput(data.monthlyLivingCostCents))
                  setEditingCost(true)
                }}
              >
                Ajustar
              </Button>
            </div>
          ) : (
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
              <div className="field" style={{ width: 180 }}>
                <label className="field__label" htmlFor={costInputFieldId}>Custo de vida mensal (R$)</label>
                <TextInput id={costInputFieldId} value={costInput} onChange={setCostInput} placeholder="0,00" numeral />
              </div>
              <Button
                variant="primary"
                size="sm"
                icon="check"
                onClick={() => setLivingCost.mutate(Math.abs(parseMoneyInput(costInput) ?? 0))}
                disabled={setLivingCost.isPending}
              >
                Salvar
              </Button>
              {data.livingCostIsManual && (
                <Button variant="ghost" size="sm" onClick={() => setLivingCost.mutate(null)} disabled={setLivingCost.isPending}>
                  Usar média calculada
                </Button>
              )}
              <Button variant="quiet" size="sm" onClick={() => setEditingCost(false)}>
                Cancelar
              </Button>
            </div>
          )}

          <Meter usedBps={data.progressBps} state={meterState} />
          {holdings.length > 0 && (
            <p className="chart__note">
              Composta por{' '}
              {holdings.map((p, i) => (
                <span key={p.assetId}>
                  {i > 0 && (i === holdings.length - 1 ? ' e ' : ', ')}
                  <strong className="tabular" style={{ fontWeight: 600 }}>
                    {p.name}
                  </strong>{' '}
                  ({p.assetClassLabel}) {money(p.marketValueCents)}
                </span>
              ))}
              .
            </p>
          )}
          <p className="chart__note">
            {data.gapCents > 0
              ? 'Enquanto a reserva não está completa, a simulação da aba Aportar destina o dinheiro novo a ela antes das classes. O que conta como reserva é marcado na coluna Reserva de Meus ativos.'
              : 'Reserva completa: a simulação da aba Aportar passa a dividir o dinheiro novo entre as classes, pelo alvo de cada uma.'}
          </p>
        </div>
      )}

      {/* Ações no rodapé, como os atalhos dos cards do Painel: no card de meia
          largura, com o seletor 6x/12x/24x, o cabeçalho não comportava os três. */}
      <div className="row row--wrap" style={{ gap: 'var(--sp-2)', marginTop: 'auto' }}>
        <Button size="sm" icon="plus" onClick={() => setContributing(true)}>
          Aportar na reserva
        </Button>
        {data?.assetId && (
          <Button variant="quiet" size="sm" icon="list" onClick={() => setViewingHistory(true)}>
            Movimentações
          </Button>
        )}
      </div>

      {contributing && <ReserveContributeModal onClose={() => setContributing(false)} />}
      {viewingHistory && data?.assetId && (
        <TradeHistoryModal
          label="reserva de emergência"
          assetIds={[data.assetId]}
          onClose={() => setViewingHistory(false)}
        />
      )}
    </Card>
  )
}

/**
 * The one-click path from "quanto falta" to an actual trade: posts
 * straight to the dedicated reserve asset (created on first use here),
 * so "Guardado" and the progress meter move immediately — no need to
 * go find the asset under Caixa in "Meus ativos" first.
 */
function ReserveContributeModal({
  onClose,
  initialAmountCents,
}: {
  onClose: () => void
  initialAmountCents?: number
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState(initialAmountCents ? centsToInput(initialAmountCents) : '')
  const [tradedOn, setTradedOn] = useState(todayIso)
  const amountFieldId = useId()
  const tradedOnFieldId = useId()

  const save = useMutation({
    mutationFn: () => {
      const amountCents = parseMoneyInput(amount)
      if (amountCents === null || amountCents === 0) throw new Error('informe o valor')
      return api.post('/investments/reserve/contribute', { amountCents: Math.abs(amountCents), tradedOn, kind })
    },
    onSuccess: () => {
      toast(kind === 'buy' ? 'Aporte registrado na reserva' : 'Retirada registrada na reserva')
      invalidateInvestmentData(queryClient)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title="Aportar na reserva de emergência"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending} loading={save.isPending}>
            {kind === 'buy' ? 'Registrar aporte' : 'Registrar retirada'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Segmented
          ariaLabel="Tipo"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'buy', label: 'Aportar' },
            { value: 'sell', label: 'Retirar' },
          ]}
        />
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={amountFieldId}>Valor (R$)</label>
            <TextInput id={amountFieldId} value={amount} onChange={setAmount} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={tradedOnFieldId}>Data</label>
            <TextInput id={tradedOnFieldId} value={tradedOn} onChange={setTradedOn} type="date" />
          </div>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Note-weighted share within the class, re-derived client-side from
 * data already on the page (positions + allocation) — the exact same
 * maths as `assetAllocationWithinClass` server-side, just without a
 * second round trip per expanded group.
 */
function withinClassSlices(
  rows: Position[],
  classValueCents: number,
  classTargetBps: number | null,
  portfolioValueCents: number,
): Map<number, { actualBps: number; targetBps: number | null; rebalanceCents: number | null }> {
  const noteSum = rows.reduce((sum, p) => sum + (p.note ?? 0), 0)
  const classTargetValueCents =
    classTargetBps === null ? null : Math.round((classTargetBps / 10_000) * portfolioValueCents)

  const map = new Map<number, { actualBps: number; targetBps: number | null; rebalanceCents: number | null }>()
  for (const p of rows) {
    const actualBps = classValueCents > 0 ? Math.round((p.marketValueCents / classValueCents) * 10_000) : 0
    const targetBps = p.note !== null && noteSum > 0 ? Math.round((p.note / noteSum) * 10_000) : null
    const targetValueCents =
      targetBps === null || classTargetValueCents === null
        ? null
        : Math.round((targetBps / 10_000) * classTargetValueCents)
    const rebalanceCents = targetValueCents === null ? null : targetValueCents - p.marketValueCents
    map.set(p.assetId, { actualBps, targetBps, rebalanceCents })
  }
  return map
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: number | null }) {
  const cls = tone === undefined || tone === null || tone === 0 ? '' : tone > 0 ? 'pos' : 'neg'
  return (
    <span className="stack" style={{ gap: 2, minWidth: 84 }}>
      <span className="stat__label" style={{ fontSize: 'var(--text-2xs)' }}>
        {label}
      </span>
      <span className={`tabular ${cls}`} style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
        {value}
      </span>
    </span>
  )
}

function AssetGroupCard({
  assetClass,
  label,
  rows,
  classes,
  actualBps,
  targetBps,
  portfolioValueCents,
  expanded,
  onToggle,
  onOpenCriteria,
  onAddTrade,
  onViewTrades,
}: {
  assetClass: string
  label: string
  rows: Position[]
  classes: Array<{ value: string; label: string }>
  actualBps: number
  targetBps: number | null
  portfolioValueCents: number
  expanded: boolean
  onToggle: () => void
  onOpenCriteria: (payload: { assetId: number; name: string; assetClass: string }) => void
  onAddTrade: () => void
  onViewTrades: () => void
}) {
  const classValueCents = rows.reduce((s, p) => s + p.marketValueCents, 0)
  const classContributedCents = rows.reduce((s, p) => s + p.contributedCents, 0)
  const classDividendsCents = rows.reduce((s, p) => s + p.dividendsCents, 0)
  const classGainCents = classValueCents - classContributedCents + classDividendsCents
  const variacaoBps =
    classContributedCents > 0
      ? Math.round(((classValueCents - classContributedCents) / classContributedCents) * 10_000)
      : null
  const rentabilidadeBps =
    classContributedCents > 0 ? Math.round((classGainCents / classContributedCents) * 10_000) : null
  const slices = withinClassSlices(rows, classValueCents, targetBps, portfolioValueCents)
  const held = rows.filter((p) => p.quantity > 0)
  const tracked = rows.filter((p) => p.quantity <= 0)
  const [showTracked, setShowTracked] = useState(held.length === 0)
  const visibleRows = showTracked ? [...held, ...tracked] : held

  return (
    <div className="card group-card">
      <button type="button" className="group-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="row" style={{ gap: 'var(--sp-3)', minWidth: 0 }}>
          <span className="icon-chip icon-chip--sm">
            <Icon name={ASSET_CLASS_ICON[assetClass] ?? 'wallet'} size={15} />
          </span>
          <strong className="truncate">{label}</strong>
        </span>
        <span className="row row--wrap group-head__stats">
          <MiniStat label="Com posição" value={tracked.length > 0 ? `${held.length} de ${rows.length}` : String(rows.length)} />
          <MiniStat label="Valor total" value={money(classValueCents)} />
          <MiniStat label="Variação" value={variacaoBps === null ? '-' : signedBps(variacaoBps, 2)} tone={variacaoBps} />
          <MiniStat
            label="Rentabilidade"
            value={rentabilidadeBps === null ? '-' : signedBps(rentabilidadeBps, 2)}
            tone={rentabilidadeBps}
          />
          <MiniStat
            label="% na carteira"
            value={`${bps(actualBps, 0)} / ${targetBps === null ? '-' : bps(targetBps, 0)}`}
          />
        </span>
        <Icon
          name="chevronDown"
          size={16}
          className={`group-head__chevron${expanded ? ' group-head__chevron--open' : ''}`}
        />
      </button>

      {expanded && (
        <>
          <div className="table-wrap">
            <table className="table table--stack-mobile table--stack-compact">
              <thead>
                <tr>
                  <th scope="col">Ativo</th>
                  <th scope="col" className="table__center" style={{ width: 70 }}>Nota</th>
                  <th scope="col" className="table__num">Qtd.</th>
                  <th scope="col" className="table__num">Preço médio</th>
                  <th scope="col" className="table__num">Cotação</th>
                  <th scope="col" className="table__num">Variação</th>
                  <th scope="col" className="table__num">Saldo</th>
                  <th scope="col" className="table__center">Reserva</th>
                  <th scope="col" className="table__num">% carteira</th>
                  <th scope="col" className="table__num">% ideal</th>
                  {/* "Comprar? Sim" soava como recomendação (`decisions/0010`):
                      a coluna mostra quanto falta até o % ideal, e só. */}
                  <th scope="col" className="table__num">Falta p/ ideal</th>
                  <th scope="col" style={{ width: 132 }}>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((position) => {
                  const slice = slices.get(position.assetId)
                  const hasPosition = position.quantity > 0
                  // Sem cota, preço médio e variação são de uma posição que
                  // já não existe (ex.: ALUP4 com 0 cotas e +27,35%).
                  const variacao =
                    hasPosition && position.lastUnitPriceCents !== null && position.avgUnitPriceCents > 0
                      ? Math.round(
                          ((position.lastUnitPriceCents - position.avgUnitPriceCents) /
                            position.avgUnitPriceCents) *
                            10_000,
                        )
                      : null
                  return (
                    <tr key={position.assetId} className={hasPosition ? undefined : 'row--tracked'}>
                      <td data-label="__lead">
                        <span>
                          <strong>{position.name}</strong>
                          {position.ticker && (
                            <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                              {' '}
                              · {position.ticker}
                            </span>
                          )}
                          {!hasPosition && (
                            <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                              {' '}
                              · sem posição
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="table__center" data-label="Nota">
                        <NoteBadge
                          note={position.note}
                          answered={position.answeredCriteria}
                          total={position.totalCriteria}
                          onClick={() =>
                            onOpenCriteria({
                              assetId: position.assetId,
                              name: position.name,
                              assetClass: position.assetClass,
                            })
                          }
                        />
                      </td>
                      <td className="table__num" data-label="Qtd.">{fmtQuantity(position.quantity)}</td>
                      <td className="table__num" data-label="Preço médio">
                        {hasPosition ? money(position.avgUnitPriceCents) : <span className="muted">-</span>}
                      </td>
                      <td className="table__num" data-label="Cotação">
                        {position.lastUnitPriceCents === null ? (
                          <span className="muted">-</span>
                        ) : (
                          money(position.lastUnitPriceCents)
                        )}
                      </td>
                      <td
                        className={`table__num ${variacao === null ? '' : variacao < 0 ? 'neg' : 'pos'}`}
                        data-label="Variação"
                      >
                        {variacao === null ? '-' : signedBps(variacao, 2)}
                      </td>
                      <td className="table__num" data-label="Saldo">{money(position.marketValueCents)}</td>
                      <td className="table__center" data-label="Reserva">
                        <ReserveToggle assetId={position.assetId} checked={position.countsTowardReserve} />
                      </td>
                      <td className="table__num" data-label="% carteira">{slice ? bps(slice.actualBps, 0) : '-'}</td>
                      <td className="table__num" data-label="% ideal">
                        {slice === undefined || slice.targetBps === null ? '-' : bps(slice.targetBps, 0)}
                      </td>
                      <td className="table__num" data-label="Falta p/ ideal">
                        {slice === undefined || slice.rebalanceCents === null || slice.rebalanceCents <= 0 ? (
                          <span className="muted">-</span>
                        ) : (
                          money(slice.rebalanceCents)
                        )}
                      </td>
                      <td data-label="__trail">
                        <div className="row-actions">
                          {position.ticker && QUOTABLE_CLASSES.has(position.assetClass) && (
                            <RefreshQuoteButton assetId={position.assetId} name={position.name} />
                          )}
                          <EditAssetButton
                            assetId={position.assetId}
                            name={position.name}
                            ticker={position.ticker}
                            assetClass={position.assetClass}
                            classes={classes}
                          />
                          <DeletePositionButton assetId={position.assetId} name={position.name} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="row row--between row--wrap" style={{ padding: 'var(--sp-4) var(--sp-5)', gap: 'var(--sp-2)' }}>
            <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
              <Button variant="ghost" size="sm" icon="list" onClick={onViewTrades}>
                Movimentações
              </Button>
              {tracked.length > 0 && held.length > 0 && (
                <Button variant="quiet" size="sm" onClick={() => setShowTracked((v) => !v)}>
                  {showTracked ? 'Ocultar sem posição' : `Mostrar ${tracked.length} sem posição`}
                </Button>
              )}
            </span>
            <Button size="sm" icon="plus" onClick={onAddTrade}>
              Registrar operação
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

type TradeRow = {
  id: number
  assetId: number
  assetName: string
  kind: string
  tradedOn: string
  quantity: number
  unitPriceCents: number
  feesCents: number
  dividendType: string | null
  exDate: string | null
}

const TRADE_KIND_LABEL: Record<string, string> = { buy: 'Compra', sell: 'Venda', dividend: 'Provento' }
/** JSCP tem 15% retido na fonte; Dividendos são isentos — só se aplica a lançamentos kind='dividend'. */
export const DIVIDEND_TYPE_LABEL: Record<string, string> = { dividendo: 'Dividendos', jscp: 'JSCP' }

/**
 * Aba "Lançamentos": tabela dedicada de `assetTrades` (compra/venda/provento
 * de qualquer ativo, filtrável) mais o gráfico de barra dupla carteira atual
 * x objetivo. Nenhum endpoint novo — `/investments/trades` já lista tudo e
 * `allocation` é o mesmo dado que já alimenta "Alocação por classe" na aba
 * Carteira. Ver `specs/investments`, "Aba Lançamentos e gráficos de carteira
 * objetivo".
 */
/** Linhas por página: 303 lançamentos de uma vez eram 1.500 paradas de Tab. */
const LEDGER_PAGE = 50

function LedgerTab({ positions }: { positions: Position[] }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [assetFilter, setAssetFilter] = useState<number | null>(null)
  const [kindFilter, setKindFilter] = useState<string | null>(null)
  const [visible, setVisible] = useState(LEDGER_PAGE)
  const [editingTrade, setEditingTrade] = useState<TradeRow | null>(null)
  const [confirmingTradeId, setConfirmingTradeId] = useState<number | null>(null)

  const trades = useQuery({
    queryKey: ['investment-trades'],
    queryFn: () => api.get<{ trades: TradeRow[] }>('/investments/trades'),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.del<{ removed: number }>(`/investments/trades/${id}`),
    onSuccess: () => {
      toast('Operação removida')
      invalidateInvestmentData(queryClient)
      setConfirmingTradeId(null)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  const rows = (trades.data?.trades ?? [])
    .filter((t) => assetFilter === null || t.assetId === assetFilter)
    .filter((t) => kindFilter === null || t.kind === kindFilter)
  const shown = rows.slice(0, visible)
  // Colunas de provento só quando há provento na lista filtrada: numa lista
  // só de compras elas eram duas colunas de "-".
  const hasDividends = shown.some((t) => t.kind === 'dividend')

  const confirmingTrade = rows.find((t) => t.id === confirmingTradeId) ?? null

  return (
    <Bento>
      {/* O gráfico "Carteira atual x objetivo" que abria esta aba saiu: era o
          mesmo número de "Alocação por classe", e a própria nota dele dizia
          que era "uma segunda leitura visual" (revisão de 03/10/2026). */}
      <Card
        span={12}
        flush
        title="Movimentações"
        subtitle={
          trades.data
            ? `${rows.length} ${rows.length === 1 ? 'operação' : 'operações'}: compras, vendas e proventos de todos os ativos`
            : 'Compras, vendas e proventos de todos os ativos'
        }
        actions={
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <FilterSelect
              icon="filter"
              value={assetFilter}
              placeholder="Todos os ativos"
              options={positions.map((p) => ({ value: p.assetId, label: p.name }))}
              onChange={(value) => {
                setAssetFilter(value)
                setVisible(LEDGER_PAGE)
              }}
            />
            <FilterSelect
              icon="filter"
              value={kindFilter}
              placeholder="Todos os tipos"
              options={Object.entries(TRADE_KIND_LABEL).map(([value, label]) => ({ value, label }))}
              onChange={(value) => {
                setKindFilter(value)
                setVisible(LEDGER_PAGE)
              }}
            />
          </div>
        }
      >
        {trades.isError ? (
          <EmptyState
            icon="alert"
            title="Falha ao carregar"
            body="Não foi possível carregar os lançamentos agora. Tente novamente em instantes."
          />
        ) : !trades.data ? (
          <div style={{ padding: 'var(--sp-5)' }}>
            <SkeletonLines lines={6} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="list"
            title="Nenhuma operação"
            body="Compras, vendas e proventos aparecem aqui assim que forem registrados."
          />
        ) : (
          <>
          <div className="table-wrap">
            <table className="table table--stack-mobile table--stack-compact">
              <thead>
                <tr>
                  <th scope="col">Data</th>
                  <th scope="col">Ativo</th>
                  <th scope="col">Tipo</th>
                  {hasDividends && <th scope="col">Tipo de provento</th>}
                  {hasDividends && <th scope="col">Data Com</th>}
                  <th scope="col" className="table__num">Qtd.</th>
                  <th scope="col" className="table__num">Preço</th>
                  <th scope="col" className="table__num">Taxas</th>
                  <th scope="col" style={{ width: 88 }}>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.id}>
                    <td data-label="__lead" className="tabular">{fmtDate(t.tradedOn)}</td>
                    <td data-label="Ativo">
                      <strong style={{ fontWeight: 500 }}>{t.assetName}</strong>
                    </td>
                    <td className="muted" data-label="Tipo">{TRADE_KIND_LABEL[t.kind] ?? t.kind}</td>
                    {hasDividends && (
                      <td className="muted" data-label="Tipo de provento" data-empty={t.kind !== 'dividend' || undefined}>
                        {t.kind !== 'dividend' ? '-' : (DIVIDEND_TYPE_LABEL[t.dividendType ?? ''] ?? 'Não informado')}
                      </td>
                    )}
                    {hasDividends && (
                      <td className="muted" data-label="Data Com" data-empty={!(t.kind === 'dividend' && t.exDate) || undefined}>
                        {t.kind === 'dividend' && t.exDate ? fmtDate(t.exDate) : '-'}
                      </td>
                    )}
                    <td className="table__num" data-label="Qtd.">{fmtQuantity(t.quantity)}</td>
                    <td className="table__num" data-label="Preço">{money(t.unitPriceCents)}</td>
                    <td className="table__num" data-label="Taxas" data-empty={t.feesCents === 0 || undefined}>{money(t.feesCents)}</td>
                    <td data-label="__trail">
                      <div className="row-actions">
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="pencil"
                          onClick={() => setEditingTrade(t)}
                          title="Editar operação"
                        />
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="trash"
                          onClick={() => setConfirmingTradeId(t.id)}
                          disabled={remove.isPending}
                          title="Excluir operação"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > shown.length && (
            <div className="row row--between row--wrap" style={{ padding: 'var(--sp-4) var(--sp-5)', gap: 'var(--sp-2)' }}>
              <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                Mostrando {shown.length} de {rows.length}
              </span>
              <Button size="sm" onClick={() => setVisible((v) => v + LEDGER_PAGE)}>
                Mostrar mais {Math.min(LEDGER_PAGE, rows.length - shown.length)}
              </Button>
            </div>
          )}
          </>
        )}
      </Card>

      {editingTrade && <EditTradeModal trade={editingTrade} onClose={() => setEditingTrade(null)} />}
      {confirmingTrade && (
        <ConfirmDeleteModal
          title={`Excluir operação de ${confirmingTrade.assetName}?`}
          body="Isso não pode ser desfeito."
          confirmLabel="Excluir operação"
          pending={remove.isPending}
          onCancel={() => setConfirmingTradeId(null)}
          onConfirm={() => remove.mutate(confirmingTrade.id)}
        />
      )}
    </Bento>
  )
}

/** The trade ledger `listTrades`/`deleteTrade` already supported, finally surfaced in the UI. */
function TradeHistoryModal({
  label,
  assetIds,
  onClose,
}: {
  label: string
  assetIds: number[]
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editingTrade, setEditingTrade] = useState<TradeRow | null>(null)
  const [confirmingTradeId, setConfirmingTradeId] = useState<number | null>(null)

  const trades = useQuery({
    queryKey: ['investment-trades'],
    queryFn: () => api.get<{ trades: TradeRow[] }>('/investments/trades'),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.del<{ removed: number }>(`/investments/trades/${id}`),
    onSuccess: () => {
      toast('Operação removida')
      invalidateInvestmentData(queryClient)
      setConfirmingTradeId(null)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  const rows = (trades.data?.trades ?? []).filter((t) => assetIds.includes(t.assetId))
  const confirmingTrade = rows.find((t) => t.id === confirmingTradeId) ?? null

  return (
    <Modal
      title={`Movimentações de ${label}`}
      onClose={onClose}
      wide
      footer={
        <Button variant="quiet" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      {trades.isError ? (
        <EmptyState
          icon="alert"
          title="Falha ao carregar"
          body="Não foi possível carregar as movimentações agora. Tente novamente em instantes."
        />
      ) : !trades.data ? (
        <SkeletonLines lines={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="list"
          title="Nenhuma operação"
          body="Compras, vendas e proventos aparecem aqui, com opção de editar e excluir."
        />
      ) : (
        <div className="table-wrap">
          <table className="table table--stack-mobile table--stack-compact">
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Ativo</th>
                <th scope="col">Tipo</th>
                <th scope="col" className="table__num">Qtd.</th>
                <th scope="col" className="table__num">Preço</th>
                <th scope="col" className="table__num">Taxas</th>
                <th scope="col" style={{ width: 88 }}>
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td data-label="__lead" className="tabular">{fmtDate(t.tradedOn)}</td>
                  <td data-label="Ativo">{t.assetName}</td>
                  <td className="muted" data-label="Tipo">{TRADE_KIND_LABEL[t.kind] ?? t.kind}</td>
                  <td className="table__num" data-label="Qtd.">{fmtQuantity(t.quantity)}</td>
                  <td className="table__num" data-label="Preço">{money(t.unitPriceCents)}</td>
                  <td className="table__num" data-label="Taxas" data-empty={t.feesCents === 0 || undefined}>{money(t.feesCents)}</td>
                  <td data-label="__trail">
                    <div className="row-actions">
                      <Button
                        variant="quiet"
                        size="sm"
                        icon="pencil"
                        onClick={() => setEditingTrade(t)}
                        title="Editar operação"
                      />
                      <Button
                        variant="quiet"
                        size="sm"
                        icon="trash"
                        onClick={() => setConfirmingTradeId(t.id)}
                        disabled={remove.isPending}
                        title="Excluir operação"
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingTrade && <EditTradeModal trade={editingTrade} onClose={() => setEditingTrade(null)} />}
      {confirmingTrade && (
        <ConfirmDeleteModal
          title={`Excluir operação de ${confirmingTrade.assetName}?`}
          body="Isso não pode ser desfeito."
          confirmLabel="Excluir operação"
          pending={remove.isPending}
          onCancel={() => setConfirmingTradeId(null)}
          onConfirm={() => remove.mutate(confirmingTrade.id)}
        />
      )}
    </Modal>
  )
}

/** Corrects a posting mistake on an existing compra/venda/provento — same shape as `TradeModal`, minus asset reassignment. */
function EditTradeModal({ trade, onClose }: { trade: TradeRow; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState(trade.kind)
  const [tradedOn, setTradedOn] = useState(trade.tradedOn)
  const [quantity, setQuantity] = useState(fmtQuantity(trade.quantity))
  const [price, setPrice] = useState(centsToInput(trade.unitPriceCents))
  const [fees, setFees] = useState(centsToInput(trade.feesCents))
  const [dividendType, setDividendType] = useState<string | null>(trade.dividendType)
  const [exDate, setExDate] = useState(trade.exDate ?? '')
  const tradedOnFieldId = useId()
  const quantityFieldId = useId()
  const dividendTypeFieldId = useId()
  const exDateFieldId = useId()
  const priceFieldId = useId()
  const feesFieldId = useId()

  const priceCents = parseMoneyInput(price)
  const feesCents = parseMoneyInput(fees)
  const quantityValue = Number(quantity.replace(',', '.'))
  const totalCents =
    Number.isFinite(quantityValue) && priceCents !== null
      ? Math.round(quantityValue * priceCents) + Math.abs(feesCents ?? 0)
      : null

  const save = useMutation({
    mutationFn: () => {
      const unitPriceCents = parseMoneyInput(price)
      const qty = Number(quantity.replace(',', '.'))
      if (unitPriceCents === null) throw new Error('informe o preço')
      if (!Number.isFinite(qty) || qty <= 0) throw new Error('informe a quantidade')
      if (kind === 'dividend' && dividendType === null) throw new Error('selecione o tipo de provento')
      return api.patch(`/investments/trades/${trade.id}`, {
        kind,
        tradedOn,
        quantity: qty,
        unitPriceCents: Math.abs(unitPriceCents),
        feesCents: Math.abs(parseMoneyInput(fees) ?? 0),
        dividendType: kind === 'dividend' ? dividendType : null,
        exDate: kind === 'dividend' && exDate.trim() !== '' ? exDate : null,
      })
    },
    onSuccess: () => {
      toast('Operação atualizada')
      invalidateInvestmentData(queryClient)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title={`Editar operação de ${trade.assetName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending} loading={save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack">
        <TradeKindToggle kind={kind} onChange={setKind} />

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={tradedOnFieldId}>{kind === 'dividend' ? 'Data de pagamento' : 'Data da transação'}</label>
            <TextInput id={tradedOnFieldId} value={tradedOn} onChange={setTradedOn} type="date" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 130 }}>
            <label className="field__label" htmlFor={quantityFieldId}>Quantidade</label>
            <TextInput id={quantityFieldId} value={quantity} onChange={setQuantity} numeral />
          </div>
        </div>

        {kind === 'dividend' && (
          <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label" htmlFor={dividendTypeFieldId}>Tipo de provento</label>
              <Select
                id={dividendTypeFieldId}
                value={dividendType}
                placeholder="Selecione"
                options={[
                  { value: 'dividendo', label: 'Dividendos' },
                  { value: 'jscp', label: 'JSCP' },
                ]}
                onChange={setDividendType}
              />
              <span className="field__hint">JSCP tem 15% retido na fonte; Dividendos são isentos</span>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label" htmlFor={exDateFieldId}>Data Com (opcional)</label>
              <TextInput id={exDateFieldId} value={exDate} onChange={setExDate} type="date" />
            </div>
          </div>
        )}

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={priceFieldId}>Preço (R$)</label>
            <TextInput id={priceFieldId} value={price} onChange={setPrice} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={feesFieldId}>Outros custos (Opcional)</label>
            <TextInput id={feesFieldId} value={fees} onChange={setFees} placeholder="0,00" numeral />
          </div>
        </div>

        <div className="row row--between" style={{ padding: 'var(--sp-3) var(--sp-4)', background: 'var(--surface-muted)', borderRadius: 'var(--r-sm)' }}>
          <span className="field__label" style={{ margin: 0 }}>
            Valor total
          </span>
          <strong className="tabular">{totalCents === null ? '-' : money(totalCents)}</strong>
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 * Rentabilidade — historical performance vs. benchmarks
 * ------------------------------------------------------------------ */
type MonthlyReturnPoint = { period: string; returnBps: number | null }
type ProfitabilityResponse = {
  portfolio: MonthlyReturnPoint[]
  benchmarks: Record<string, MonthlyReturnPoint[]>
  benchmarkLabels: Record<string, string>
  table: Array<{ year: number; months: Array<number | null>; annualReturnBps: number | null; cumulativeReturnBps: number }>
}

/** Compounds a run of monthly bps returns into one total bps figure. `null` months are skipped, not zeroed. */
function compound(points: MonthlyReturnPoint[]): number | null {
  const known = points.filter((p) => p.returnBps !== null)
  if (known.length === 0) return null
  const growth = known.reduce((acc, p) => acc * (1 + p.returnBps! / 10_000), 1)
  return Math.round((growth - 1) * 10_000)
}

const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

const CHART_WINDOW_OPTIONS = [
  { value: '12', label: '12 meses' },
  { value: '24', label: '24 meses' },
  { value: '60', label: '5 anos' },
  { value: 'all', label: 'Desde o início' },
]

function ProfitabilityTab() {
  const toast = useToast()
  const [benchmarkCode, setBenchmarkCode] = useState('CDI')
  const [chartWindow, setChartWindow] = useState('24')

  const query = useQuery({
    queryKey: ['investments', 'profitability'],
    queryFn: () => api.get<ProfitabilityResponse>('/investments/profitability'),
  })

  const refresh = useMutation({
    mutationFn: () => api.post('/investments/benchmarks/refresh'),
    onSuccess: () => query.refetch(),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao atualizar índices', 'error'),
  })

  const data = query.data
  if (!data) return <Card><SkeletonLines lines={4} /></Card>

  const benchmarkOptions = Object.keys(data.benchmarkLabels).map((code) => ({
    value: code,
    label: data.benchmarkLabels[code]!,
  }))
  const benchmarkSeries = data.benchmarks[benchmarkCode] ?? []
  const benchmarkLabel = data.benchmarkLabels[benchmarkCode] ?? benchmarkCode

  const totalBps = compound(data.portfolio)
  const last12 = compound(data.portfolio.slice(-12))
  const lastMonth = data.portfolio.at(-1)?.returnBps ?? null

  const benchmarkTotal = compound(benchmarkSeries.filter((p) => p.period >= (data.portfolio[0]?.period ?? '')))
  const benchmarkLast12 = compound(benchmarkSeries.slice(-12))
  const benchmarkLastMonth = benchmarkSeries.at(-1)?.returnBps ?? null

  // The chart's own zoom window — separate from the KPI cards above, which
  // always read "total since inception" / "last 12" / "last month"
  // regardless of what the chart is currently scoped to.
  const chartPortfolio = chartWindow === 'all' ? data.portfolio : data.portfolio.slice(-Number(chartWindow))
  const chartStartPeriod = chartPortfolio[0]?.period ?? ''
  const chartBenchmarks = Object.fromEntries(
    Object.entries(data.benchmarks).map(([code, series]) => [code, series.filter((p) => p.period >= chartStartPeriod)]),
  )

  const method = {
    formula:
      'Retorno de cada mês da carteira (valorização mais proventos, sem o efeito dos aportes), encadeado mês a mês. Na aba Carteira a rentabilidade é o ganho dividido pelo valor aportado, outra conta, por isso os números não batem. Um mês em que a cotação foi atualizada depois de muito tempo parada concentra a valorização de vários meses.',
    comparadoCom: benchmarkLabel,
  }
  const toneOf = (value: number | null, flatBelow = 0) =>
    value === null || Math.abs(value) <= flatBelow ? undefined : value > 0 ? 'up' : 'down'
  const diff = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null)

  return (
    <div className="stack stack--loose">
      {/* O índice de comparação é o filtro desta aba: fica numa linha de
          controle solta, como o filtro de período do Painel, e não num card. */}
      <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
        <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>Comparar com</span>
        <FilterSelect icon="scale" value={benchmarkCode} options={benchmarkOptions} onChange={(v) => setBenchmarkCode(v ?? 'CDI')} />
        <Button variant="quiet" icon="refresh" size="sm" onClick={() => refresh.mutate()} loading={refresh.isPending}>
          Atualizar índices
        </Button>
      </div>

      {/* Mesma linha de KPIs da Carteira e do Painel (04/10/2026). A diferença
          para o índice vai em pontos percentuais, com seta e cor. */}
      <div className="kpi-row kpi-row--3">
        <KpiTile
          accent
          label="Rentabilidade total"
          value={totalBps === null ? '-' : signedBps(totalBps)}
          delta={diff(totalBps, benchmarkTotal)}
          deltaUnit="points"
          deltaLabel={`vs. ${benchmarkLabel}`}
          assumptions={method}
        />
        <KpiTile
          label="Últimos 12 meses"
          value={last12 === null ? '-' : signedBps(last12)}
          tone={toneOf(last12)}
          delta={diff(last12, benchmarkLast12)}
          deltaUnit="points"
          deltaLabel={`vs. ${benchmarkLabel}`}
          assumptions={method}
        />
        <KpiTile
          label="Último mês"
          value={lastMonth === null ? '-' : signedBps(lastMonth)}
          tone={toneOf(lastMonth, 10)}
          delta={diff(lastMonth, benchmarkLastMonth)}
          deltaUnit="points"
          deltaLabel={`vs. ${benchmarkLabel}`}
          assumptions={method}
        />
      </div>

      <Bento>
      <Card
        span={12}
        title="Rentabilidade comparada com índices"
        subtitle="Índice acumulado (base 100). Aponte uma série para trazê-la à frente, clique para mostrar ou ocultar"
        actions={<FilterSelect icon="calendar" value={chartWindow} options={CHART_WINDOW_OPTIONS} onChange={(v) => setChartWindow(v ?? '24')} />}
      >
        <ProfitabilityChart
          portfolio={chartPortfolio}
          benchmarks={chartBenchmarks}
          benchmarkLabels={data.benchmarkLabels}
          defaultVisible={['portfolio', benchmarkCode]}
        />
      </Card>

      <Card
        span={12}
        title="Rentabilidade por mês"
        subtitle="Retorno da carteira, ano a ano. No celular ficam só o retorno anual e o acumulado"
      >
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Ano</th>
                {MONTH_LABELS.map((m) => (
                  <th key={m} scope="col" className="table__col--secondary" style={{ textAlign: 'right' }}>{m}</th>
                ))}
                <th scope="col" className="table__num">Retorno anual</th>
                <th scope="col" className="table__num">Acumulado</th>
              </tr>
            </thead>
            <tbody>
              {data.table.map((row) => (
                <tr key={row.year}>
                  <td>{row.year}</td>
                  {row.months.map((value, i) => (
                    <td
                      key={i}
                      className="table__num table__col--secondary"
                      style={value === null ? undefined : { color: value >= 0 ? 'var(--delta-up)' : 'var(--delta-down)' }}
                    >
                      {value === null ? '-' : bps(value)}
                    </td>
                  ))}
                  <td className="table__num" style={{ fontWeight: 600 }}>
                    {row.annualReturnBps === null ? '-' : bps(row.annualReturnBps)}
                  </td>
                  <td className="table__num">{bps(row.cumulativeReturnBps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      </Bento>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Goals sub-environment
 * ------------------------------------------------------------------ */
function GoalsEnvironment({
  goals,
  goalPurposes,
}: {
  goals: Goal[]
  goalPurposes: Array<{ value: string; label: string }>
}) {
  const [selectedId, setSelectedId] = useState<number | null>(goals[0]?.id ?? null)
  const [editing, setEditing] = useState<Goal | 'new' | null>(null)

  const activeId = selectedId ?? goals[0]?.id ?? null

  const projection = useQuery({
    queryKey: ['investment-goal', activeId],
    queryFn: () => api.get<Projection>(`/investments/goals/${activeId}/projection`),
    enabled: activeId !== null,
  })

  if (goals.length === 0) {
    return (
      <Bento>
        <Slab span={12} accent>
          <div className="stack" style={{ maxWidth: '60ch' }}>
            <span className="stat__label">Nenhuma meta de investimento</span>
            <h2 className="display" style={{ fontSize: 'var(--text-xl)' }}>
              Defina onde a carteira precisa chegar
            </h2>
            <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-base)' }}>
              Com valor-alvo, data e aporte mensal, o app projeta a trajetória e calcula o aporte
              necessário para chegar exatamente na data.
            </p>
            <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
              <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
                Criar meta
              </Button>
            </div>
          </div>
        </Slab>
        {editing !== null && (
          <GoalModal goal={null} goalPurposes={goalPurposes} onClose={() => setEditing(null)} />
        )}
      </Bento>
    )
  }

  const data = projection.data
  const goal = data?.goal

  return (
    <div className="stack stack--loose">
      {/* Escolha da meta numa linha de controle solta (sem card cinza), como
          os filtros do Painel. Seleção dita ao leitor de tela pelo
          `aria-pressed`, não só pela cor (03/10/2026). */}
      <div className="row row--between row--wrap" style={{ gap: 'var(--sp-2)' }}>
        <div className="segmented" role="group" aria-label="Meta">
          {goals.map((item) => (
            <button
              key={item.id}
              type="button"
              className="segmented__btn"
              aria-pressed={item.id === activeId}
              onClick={() => setSelectedId(item.id)}
            >
              {item.name}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 'var(--sp-2)' }}>
          {goal && (
            <Button variant="quiet" size="sm" icon="pencil" onClick={() => setEditing(goal)}>
              Editar
            </Button>
          )}
          <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
            Nova meta
          </Button>
        </div>
      </div>

      {!data || !goal ? (
        <PageSkeleton
          cards={[
            { span: 12, variant: 'stats', height: 120 },
            { span: 12, variant: 'block', height: 280 },
          ]}
        />
      ) : (
        <>
          {/* A linha de KPIs do Painel (04/10/2026): o card de destaque é o
              progresso da meta, com a barra; os outros três respondem
              "quando" e "quanto por mês". */}
          <div className="kpi-row">
            <Slab accent className="kpi">
              <div className="card__title-row">
                <span className="stat__label truncate">
                  {goal.purpose
                    ? `${goal.name} · ${goalPurposes.find((p) => p.value === goal.purpose)?.label ?? goal.purpose}`
                    : goal.name}
                </span>
              </div>
              <span className="stat__value kpi__value">{money(data.currentValueCents)}</span>
              <Meter usedBps={data.progressBps ?? 0} state={data.state} />
              <span className="stat__foot" style={{ justifyContent: 'space-between' }}>
                <span>
                  {data.progressBps === null ? '' : `${bps(data.progressBps, 0)} de `}
                  {money(goal.targetValueCents)}
                </span>
                <StatusBadge state={data.state} />
              </span>
            </Slab>
            <KpiTile
              label="Alcança a meta em"
              value={data.reachedPeriod ? fmtPeriod(data.reachedPeriod) : 'além do horizonte'}
              foot={
                <span>{data.reachedMonth === null ? 'aumente o aporte para chegar' : `daqui a ${monthsLabel(data.reachedMonth)}`}</span>
              }
            />
            <KpiTile
              label="Aporte mensal planejado"
              value={money(goal.monthlyContributionCents)}
              foot={<span>retorno esperado {bps(goal.expectedReturnBps)} a.a.</span>}
            />
            <KpiTile
              label="Aporte necessário"
              value={data.requiredMonthlyCents === null ? '-' : money(data.requiredMonthlyCents)}
              foot={<span>{goal.targetDate ? `por mês, para chegar em ${fmtDate(goal.targetDate)}` : 'defina uma data-alvo'}</span>}
            />
          </div>

          <Card
            title="Trajetória projetada"
            subtitle={
              data.projectedAtTargetCents === null
                ? 'Com e sem os aportes planejados'
                : `Na data-alvo, ${money(data.projectedAtTargetCents)}: ${
                    data.projectedAtTargetCents >= goal.targetValueCents
                      ? 'acima do alvo'
                      : `${money(goal.targetValueCents - data.projectedAtTargetCents)} abaixo do alvo`
                  }`
            }
          >
            <GoalProjectionChart
              data={data.series}
              targetCents={goal.targetValueCents}
              targetPeriod={goal.targetDate?.slice(0, 7) ?? null}
              surface="paper"
              height={280}
            />
          </Card>
        </>
      )}

      {editing !== null && (
        <GoalModal
          goal={editing === 'new' ? null : editing}
          goalPurposes={goalPurposes}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */
function AssetModal({
  classes,
  onClose,
}: {
  classes: Array<{ value: string; label: string }>
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [ticker, setTicker] = useState('')
  const [assetClass, setAssetClass] = useState('stocks')
  const nameFieldId = useId()
  const tickerFieldId = useId()
  const assetClassFieldId = useId()

  const save = useMutation({
    mutationFn: () =>
      api.post('/investments/assets', {
        name: name.trim(),
        ticker: ticker.trim() || null,
        assetClass,
      }),
    onSuccess: () => {
      toast('Ativo cadastrado')
      invalidateInvestmentData(queryClient)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title="Novo ativo"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" disabled={!name.trim()} onClick={() => save.mutate()}>
            Cadastrar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor={nameFieldId}>Nome</label>
          <TextInput id={nameFieldId} value={name} onChange={setName} placeholder="ex. Tesouro IPCA+ 2035" />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={tickerFieldId}>Código</label>
          <TextInput id={tickerFieldId} value={ticker} onChange={setTicker} placeholder="opcional, ex. PETR4" />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={assetClassFieldId}>Classe</label>
          <Select id={assetClassFieldId} value={assetClass} options={classes} onChange={(value) => setAssetClass(value ?? 'stocks')} />
        </div>
      </div>
    </Modal>
  )
}

/**
 * Compra/Venda toggle carries its own accent (green/red) rather than the
 * generic segmented control's neutral pressed-state, so the kind of
 * movement being logged is legible before reading a single field. A
 * third, unaccented "Provento" option keeps dividend recording alive —
 * the KPI dashboard's "Dividendos recebidos" depends on it — without
 * pretending it's a third equally-weighted primary choice.
 */
function TradeKindToggle({ kind, onChange }: { kind: string; onChange: (kind: string) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Tipo de movimentação">
      {(
        [
          { value: 'buy', label: 'Compra', tone: 'pos' },
          { value: 'sell', label: 'Venda', tone: 'neg' },
          { value: 'dividend', label: 'Provento', tone: '' },
        ] as const
      ).map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented__btn${option.tone ? ` segmented__btn--${option.tone}` : ''}`}
          aria-pressed={kind === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function TradeModal({
  classes,
  positions,
  initialAssetClass,
  initialKind,
  onClose,
}: {
  classes: Array<{ value: string; label: string }>
  positions: Position[]
  initialAssetClass?: string | null
  initialKind?: string
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState(initialKind ?? 'buy')
  const [assetClass, setAssetClass] = useState<string | null>(initialAssetClass ?? null)
  const [assetId, setAssetId] = useState<number | null>(null)
  // Dia de HOJE no fuso do navegador: `toISOString()` é UTC, e depois das
  // 21h no Brasil já devolvia amanhã (revisão de 03/10/2026).
  const [tradedOn, setTradedOn] = useState(todayIso)
  const [quantity, setQuantity] = useState('1')
  const [price, setPrice] = useState('')
  const [fees, setFees] = useState('')
  const [dividendType, setDividendType] = useState<string | null>(null)
  const [exDate, setExDate] = useState('')
  const assetClassFieldId = useId()
  const assetIdFieldId = useId()
  const tradedOnFieldId = useId()
  const quantityFieldId = useId()
  const dividendTypeFieldId = useId()
  const exDateFieldId = useId()
  const priceFieldId = useId()
  const feesFieldId = useId()

  const availableAssets = assetClass === null ? [] : positions.filter((p) => p.assetClass === assetClass)
  const quantityCents = Number(quantity.replace(',', '.'))
  const priceCents = parseMoneyInput(price)
  const feesCents = parseMoneyInput(fees)
  const totalCents =
    Number.isFinite(quantityCents) && priceCents !== null
      ? Math.round(quantityCents * priceCents) + Math.abs(feesCents ?? 0)
      : null

  const save = useMutation({
    mutationFn: () => {
      const unitPriceCents = parseMoneyInput(price)
      const qty = Number(quantity.replace(',', '.'))
      if (assetId === null) throw new Error('escolha o ativo')
      if (unitPriceCents === null) throw new Error('informe o preço')
      if (!Number.isFinite(qty) || qty <= 0) throw new Error('informe a quantidade')
      if (kind === 'dividend' && dividendType === null) throw new Error('selecione o tipo de provento')
      return api.post('/investments/trades', {
        assetId,
        kind,
        tradedOn,
        quantity: qty,
        unitPriceCents: Math.abs(unitPriceCents),
        feesCents: Math.abs(parseMoneyInput(fees) ?? 0),
        dividendType: kind === 'dividend' ? dividendType : null,
        exDate: kind === 'dividend' && exDate.trim() !== '' ? exDate : null,
      })
    },
    onSuccess: () => {
      telemetry.action('investments', 'trade_recorded')
      toast(`${TRADE_KIND_LABEL[kind] ?? 'Operação'} registrada`)
      invalidateInvestmentData(queryClient)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title="Registrar operação"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending} loading={save.isPending}>
            {kind === 'sell' ? 'Registrar venda' : kind === 'dividend' ? 'Registrar provento' : 'Registrar compra'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <TradeKindToggle kind={kind} onChange={setKind} />

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 170 }}>
            <label className="field__label" htmlFor={assetClassFieldId}>Tipo de ativo</label>
            <Select
              id={assetClassFieldId}
              value={assetClass}
              placeholder="Selecione"
              options={classes}
              onChange={(value) => {
                setAssetClass(value)
                setAssetId(null)
              }}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 170 }}>
            <label className="field__label" htmlFor={assetIdFieldId}>Ativo</label>
            {assetClass === null ? (
              <Select id={assetIdFieldId} value={null} placeholder="Escolha o tipo primeiro" options={[]} onChange={() => {}} />
            ) : availableAssets.length === 0 ? (
              <Select id={assetIdFieldId} value={null} placeholder="Nenhum ativo cadastrado nesta classe" options={[]} onChange={() => {}} />
            ) : (
              <Select
                id={assetIdFieldId}
                value={assetId}
                placeholder="Selecione"
                options={availableAssets.map((p) => ({ value: p.assetId, label: p.name }))}
                onChange={setAssetId}
              />
            )}
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={tradedOnFieldId}>{kind === 'dividend' ? 'Data de pagamento' : 'Data da transação'}</label>
            <TextInput id={tradedOnFieldId} value={tradedOn} onChange={setTradedOn} type="date" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 130 }}>
            <label className="field__label" htmlFor={quantityFieldId}>Quantidade</label>
            <TextInput id={quantityFieldId} value={quantity} onChange={setQuantity} numeral />
          </div>
        </div>

        {kind === 'dividend' && (
          <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label" htmlFor={dividendTypeFieldId}>Tipo de provento</label>
              <Select
                id={dividendTypeFieldId}
                value={dividendType}
                placeholder="Selecione"
                options={[
                  { value: 'dividendo', label: 'Dividendos' },
                  { value: 'jscp', label: 'JSCP' },
                ]}
                onChange={setDividendType}
              />
              <span className="field__hint">JSCP tem 15% retido na fonte; Dividendos são isentos</span>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label" htmlFor={exDateFieldId}>Data Com (opcional)</label>
              <TextInput id={exDateFieldId} value={exDate} onChange={setExDate} type="date" />
            </div>
          </div>
        )}

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={priceFieldId}>Preço (R$)</label>
            <TextInput id={priceFieldId} value={price} onChange={setPrice} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={feesFieldId}>Outros custos (Opcional)</label>
            <TextInput id={feesFieldId} value={fees} onChange={setFees} placeholder="0,00" numeral />
          </div>
        </div>

        <div className="row row--between" style={{ padding: 'var(--sp-3) var(--sp-4)', background: 'var(--surface-muted)', borderRadius: 'var(--r-sm)' }}>
          <span className="field__label" style={{ margin: 0 }}>
            Valor total
          </span>
          <strong className="tabular">{totalCents === null ? '-' : money(totalCents)}</strong>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Deletes the asset itself — its trades and valuations cascade with it
 * (schema onDelete: 'cascade'), so this genuinely removes the position
 * and its whole history, not just the current snapshot.
 */
function DeletePositionButton({ assetId, name }: { assetId: number; name: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)

  const remove = useMutation({
    mutationFn: () => api.del<{ removed: number }>(`/investments/assets/${assetId}`),
    onSuccess: () => {
      toast(`${name} removido da carteira`)
      invalidateInvestmentData(queryClient)
      setConfirming(false)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        icon="trash"
        onClick={() => setConfirming(true)}
        disabled={remove.isPending}
        title="Excluir posição"
      />
      {confirming && (
        <ConfirmDeleteModal
          title={`Excluir ${name}?`}
          body="Isso remove o ativo e todo o histórico de compras, vendas e proventos dele. Não pode ser desfeito."
          confirmLabel="Excluir posição"
          pending={remove.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => remove.mutate()}
        />
      )}
    </>
  )
}

/** Toggles whether this asset's value counts toward the emergency-reserve progress. */
function ReserveToggle({ assetId, checked }: { assetId: number; checked: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const toggle = useMutation({
    mutationFn: () => api.patch(`/investments/assets/${assetId}`, { countsTowardReserve: !checked }),
    onSuccess: () => {
      toast(checked ? 'Removido da reserva' : 'Marcado como reserva')
      invalidateInvestmentData(queryClient)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <button
      type="button"
      className={`badge badge--btn ${checked ? 'badge--good' : ''}`}
      onClick={() => toggle.mutate()}
      disabled={toggle.isPending}
      aria-pressed={checked}
      aria-label="Conta como reserva de emergência"
      title={checked ? 'Conta como reserva de emergência (clique para remover)' : 'Marcar como reserva de emergência'}
    >
      {checked ? 'Sim' : 'Não'}
    </button>
  )
}

type QuoteRefreshResult = {
  assetId: number
  name: string
  ticker: string
  status: 'updated' | 'error' | 'skipped'
  priceCents?: number
  error?: string
}

function RefreshQuoteButton({ assetId, name }: { assetId: number; name: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const refresh = useMutation({
    mutationFn: () => api.post<QuoteRefreshResult>(`/investments/assets/${assetId}/refresh-quote`),
    onSuccess: (result) => {
      if (result.status === 'updated') {
        toast(`${name}: cotação atualizada via BRAPI`)
        invalidateInvestmentData(queryClient)
      } else {
        toast(result.error ?? 'não foi possível atualizar', 'error')
      }
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao consultar BRAPI', 'error'),
  })

  return (
    <Button
      variant="quiet"
      size="sm"
      icon="refresh"
      onClick={() => refresh.mutate()}
      disabled={refresh.isPending}
      title="Atualizar cotação via BRAPI"
    />
  )
}

/**
 * One editor for everything about an asset — identity (nome/código/classe)
 * and today's quote together, rather than two separate pencils doing
 * overlapping-looking things. The quote fields are optional: leaving them
 * blank saves the identity edit without touching the price history.
 */
function EditAssetButton({
  assetId,
  name,
  ticker,
  assetClass,
  classes,
}: {
  assetId: number
  name: string
  ticker: string | null
  assetClass: string
  classes: Array<{ value: string; label: string }>
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [editedName, setEditedName] = useState(name)
  const [editedTicker, setEditedTicker] = useState(ticker ?? '')
  const [editedClass, setEditedClass] = useState(assetClass)
  const [price, setPrice] = useState('')
  const [asOf, setAsOf] = useState(todayIso)
  const editedNameFieldId = useId()
  const editedTickerFieldId = useId()
  const editedClassFieldId = useId()
  const priceFieldId = useId()
  const asOfFieldId = useId()

  const save = useMutation({
    mutationFn: async () => {
      await api.patch(`/investments/assets/${assetId}`, {
        name: editedName.trim(),
        ticker: editedTicker.trim() || null,
        assetClass: editedClass,
      })
      if (price.trim()) {
        const cents = parseMoneyInput(price)
        if (cents === null) throw new Error('cotação inválida')
        await api.post(`/investments/assets/${assetId}/valuation`, { asOf, unitPriceCents: Math.abs(cents) })
      }
    },
    onSuccess: () => {
      toast('Ativo atualizado')
      invalidateInvestmentData(queryClient)
      setOpen(false)
      setPrice('')
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        icon="pencil"
        onClick={() => {
          setEditedName(name)
          setEditedTicker(ticker ?? '')
          setEditedClass(assetClass)
          setOpen(true)
        }}
        title="Editar ativo"
      />
      {open && (
        <Modal
          title={`Editar ${name}`}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                icon="check"
                disabled={!editedName.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                Salvar
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="field">
              <label className="field__label" htmlFor={editedNameFieldId}>Nome</label>
              <TextInput id={editedNameFieldId} value={editedName} onChange={setEditedName} placeholder="ex. Tesouro IPCA+ 2035" />
            </div>
            <div className="field">
              <label className="field__label" htmlFor={editedTickerFieldId}>Código</label>
              <TextInput id={editedTickerFieldId} value={editedTicker} onChange={setEditedTicker} placeholder="opcional, ex. PETR4" />
              <span className="field__hint">
                Trocar o código muda qual ativo real esta posição representa: as cotações
                atualizadas passam a se referir ao novo código.
              </span>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={editedClassFieldId}>Classe</label>
              <Select id={editedClassFieldId} value={editedClass} options={classes} onChange={(value) => setEditedClass(value ?? assetClass)} />
            </div>
            <hr className="divider" />
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
              <div className="field" style={{ flex: 1, minWidth: 140 }}>
                <label className="field__label" htmlFor={priceFieldId}>Registrar cotação (opcional)</label>
                <TextInput id={priceFieldId} value={price} onChange={setPrice} placeholder="0,00" numeral />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 140 }}>
                <label className="field__label" htmlFor={asOfFieldId}>Data</label>
                <TextInput id={asOfFieldId} value={asOf} onChange={setAsOf} type="date" />
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

function AllocationModal({
  classes,
  current,
  onClose,
}: {
  classes: Array<{ value: string; label: string }>
  current: AllocationSlice[]
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const allocationFieldId = useId()
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const slice of current) {
      if (slice.targetBps !== null) initial[slice.assetClass] = bpsToInput(slice.targetBps)
    }
    return initial
  })

  const totalBps = Object.values(values).reduce((sum, value) => sum + (parsePercentInput(value) ?? 0), 0)

  const save = useMutation({
    mutationFn: () =>
      api.put('/investments/allocation', {
        entries: Object.entries(values)
          .map(([assetClass, value]) => ({ assetClass, targetBps: parsePercentInput(value) ?? 0 }))
          .filter((entry) => entry.targetBps > 0),
      }),
    onSuccess: () => {
      toast('Alocação-alvo salva')
      invalidateInvestmentData(queryClient)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title="Alocação-alvo por classe"
      onClose={onClose}
      footer={
        <>
          <span className={totalBps === 10_000 ? 'pos' : 'muted'} style={{ fontSize: 'var(--text-sm)' }}>
            Soma: {bps(totalBps, 1)}
            {totalBps !== 10_000 && ' (o ideal é 100%)'}
          </span>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending} loading={save.isPending}>
              Salvar
            </Button>
          </span>
        </>
      }
    >
      <div className="stack">
        {classes.map((assetClass) => (
          <div key={assetClass.value} className="row row--between">
            <label className="field__label" style={{ flex: 1 }} htmlFor={`${allocationFieldId}-${assetClass.value}`}>
              {assetClass.label}
            </label>
            <div style={{ width: 110 }}>
              <TextInput
                id={`${allocationFieldId}-${assetClass.value}`}
                value={values[assetClass.value] ?? ''}
                onChange={(value) =>
                  setValues((current) => ({ ...current, [assetClass.value]: value }))
                }
                placeholder="0"
                numeral
              />
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 * "Diagrama do Cerrado" — resistance questionnaire and the contribution
 * waterfall it drives. See server/src/services/criteria.ts and the
 * relevant section of server/src/services/investments.ts for the model:
 * every checked box is +1, every unchecked is -1, the sum (clamped 0-10)
 * is the note, and the note decides how much of a class's target
 * allocation an asset may claim. Unscored assets claim nothing — they
 * never silently default to "worst possible score".
 * ------------------------------------------------------------------ */
type NoteResponse = {
  assetId: number
  rawScore: number
  note: number | null
  answered: number
  total: number
  criteria: Array<{ id: number; label: string; checked: boolean | null }>
}

function CriteriaModal({
  assetId,
  name,
  assetClass,
  onClose,
}: {
  assetId: number
  name: string
  assetClass: string
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [newLabel, setNewLabel] = useState('')

  const note = useQuery({
    queryKey: ['asset-note', assetId],
    queryFn: () => api.get<NoteResponse>(`/investments/assets/${assetId}/note`),
  })

  const answer = useMutation({
    mutationFn: (input: { criteriaId: number; checked: boolean }) =>
      api.put<NoteResponse>(`/investments/assets/${assetId}/criteria/${input.criteriaId}`, {
        checked: input.checked,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(['asset-note', assetId], result)
      queryClient.invalidateQueries({ queryKey: ['investments'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const clear = useMutation({
    mutationFn: (criteriaId: number) =>
      api.del<NoteResponse>(`/investments/assets/${assetId}/criteria/${criteriaId}`),
    onSuccess: (result) => {
      queryClient.setQueryData(['asset-note', assetId], result)
      queryClient.invalidateQueries({ queryKey: ['investments'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao limpar', 'error'),
  })

  const addCriterion = useMutation({
    mutationFn: () => api.post('/criteria', { assetClass, label: newLabel.trim() }),
    onSuccess: () => {
      toast('Critério adicionado a todos os ativos desta classe')
      setNewLabel('')
      queryClient.invalidateQueries({ queryKey: ['asset-note', assetId] })
      queryClient.invalidateQueries({ queryKey: ['investments'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao adicionar', 'error'),
  })

  const data = note.data

  return (
    <Modal
      title={`Nota de resistência de ${name}`}
      onClose={onClose}
      footer={
        data ? (
          <span className="row" style={{ gap: 'var(--sp-3)' }}>
            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              {data.answered} de {data.total} respondidas
            </span>
            <StatTile
              label="Nota"
              value={data.note === null ? '-' : `${data.note}/10`}
            />
          </span>
        ) : (
          <span />
        )
      }
    >
      {!data ? (
        <SkeletonLines lines={4} />
      ) : data.total === 0 ? (
        <EmptyState
          icon="tags"
          title="Nenhum critério para esta classe ainda"
          body="Adicione a primeira pergunta de resistência abaixo; ela passa a valer para todos os ativos desta classe."
        />
      ) : (
        <div className="stack stack--tight">
          {data.criteria.map((c) => (
            <div key={c.id} className="row row--between" style={{ gap: 'var(--sp-3)' }}>
              <span className="grow" style={{ fontSize: 'var(--text-sm)' }}>
                {c.label}
              </span>
              <div className="segmented" role="group" aria-label={c.label}>
                <button
                  type="button"
                  className="segmented__btn"
                  aria-pressed={c.checked === true}
                  onClick={() => answer.mutate({ criteriaId: c.id, checked: true })}
                >
                  Sim
                </button>
                <button
                  type="button"
                  className="segmented__btn"
                  aria-pressed={c.checked === false}
                  onClick={() => answer.mutate({ criteriaId: c.id, checked: false })}
                >
                  Não
                </button>
              </div>
              {c.checked !== null && (
                <Button variant="quiet" size="sm" icon="x" onClick={() => clear.mutate(c.id)} title="Limpar resposta" />
              )}
            </div>
          ))}
        </div>
      )}

      <hr className="divider" />

      <div className="row" style={{ gap: 'var(--sp-2)' }}>
        <div className="grow">
          <TextInput
            value={newLabel}
            onChange={setNewLabel}
            placeholder="Nova pergunta de resistência para esta classe…"
          />
        </div>
        <Button
          icon="plus"
          disabled={!newLabel.trim() || addCriterion.isPending}
          onClick={() => addCriterion.mutate()}
        >
          Adicionar
        </Button>
      </div>
      <p className="chart__note">
        Cada "Sim" soma +1, cada "Não" soma -1. A nota é a soma, limitada entre 0 e 10, e ela
        decide quanto do alvo da classe este ativo pode reivindicar no aporte.
      </p>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 * Contribution waterfall — "não vende, direciona o aporte". Reserva de
 * emergência primeiro, até a meta; o resto é dividido entre TODAS as
 * classes abaixo do alvo, em proporção ao atraso de cada uma, e dentro da
 * classe entre os ativos com nota, alternando setores (specs/investments,
 * decisions 0013/0019/0022).
 * ------------------------------------------------------------------ */
type ContributionPlanResponse = {
  amountCents: number
  totalBeforeCents: number
  totalAfterCents: number
  reserve: { allocatedCents: number; gapCents: number; targetCents: number; currentCents: number; multiple: number }
  classes: Array<{
    assetClass: string
    label: string
    deltaCents: number
    allocatedCents: number
    assets: Array<{
      assetId: number
      name: string
      ticker: string | null
      sector: string | null
      note: number
      suggestedCents: number
      unitPriceCents: number | null
      quantity: number
    }>
  }>
  unallocatedCents: number
}

function ContributionPlanner({ goals }: { goals: Goal[] }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState('')
  const [tradedOn, setTradedOn] = useState(todayIso)
  const [contributingReserve, setContributingReserve] = useState<number | null>(null)
  const amountFieldId = useId()
  const tradedOnFieldId = useId()
  const parsedCents = parseMoneyInput(amount)

  const plan = useQuery({
    queryKey: ['contribution-plan', parsedCents],
    queryFn: () =>
      api.get<ContributionPlanResponse>('/investments/contribution-plan', {
        amountCents: Math.abs(parsedCents ?? 0),
      }),
    enabled: !!parsedCents && parsedCents > 0,
  })

  // decisions/0023: cada linha registra o MESMO trade que ela já
  // descreve — nenhum endpoint de "executar plano", a sugestão nunca é
  // uma entidade persistida.
  const buyAsset = useMutation({
    mutationFn: (a: ContributionPlanResponse['classes'][number]['assets'][number]) =>
      api.post('/investments/trades', {
        assetId: a.assetId,
        kind: 'buy' as const,
        tradedOn,
        quantity: a.unitPriceCents === null ? 1 : a.quantity,
        unitPriceCents: a.unitPriceCents ?? a.suggestedCents,
      }),
    onSuccess: (_, a) => {
      toast(`Compra de ${a.name} registrada`)
      invalidateInvestmentData(queryClient)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao registrar', 'error'),
  })

  return (
    <Bento>
      <Card span={12} title="Quanto você quer aportar agora?" subtitle="O sistema nunca sugere vender, só direciona o dinheiro novo">
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 220 }}>
            <label className="field__label" htmlFor={amountFieldId}>Valor do aporte (R$)</label>
            <TextInput id={amountFieldId} value={amount} onChange={setAmount} placeholder="1.000,00" numeral />
          </div>
          <div className="field" style={{ width: 160 }}>
            <label className="field__label" htmlFor={tradedOnFieldId}>Data das compras</label>
            <TextInput id={tradedOnFieldId} value={tradedOn} onChange={setTradedOn} type="date" />
          </div>
          {plan.data && (
            <span className="muted" style={{ fontSize: 'var(--text-xs)', paddingBottom: 10 }}>
              Carteira: {money(plan.data.totalBeforeCents)} → {money(plan.data.totalAfterCents)}
            </span>
          )}
        </div>
      </Card>

      {/* Um card só com as metas lado a lado (04/10/2026), como "Destino do
          dinheiro" no Painel. Antes era um bloco escuro de largura inteira por
          meta, três seguidos. */}
      {!!parsedCents && parsedCents > 0 && goals.length > 0 && (
        <Card span={12} title="Efeito nas metas" subtitle="Quando cada meta seria alcançada com este aporte somado à carteira">
          <div className={`kpi-row${goals.length === 3 ? ' kpi-row--3' : ''}`}>
            {goals.map((goal) => (
              <GoalContributionImpact key={goal.id} goal={goal} extraContributionCents={parsedCents} />
            ))}
          </div>
        </Card>
      )}

      {!parsedCents || parsedCents <= 0 ? (
        <Card span={12}>
          <EmptyState
            icon="target"
            title="Informe um valor para ver a sugestão"
            body="A simulação segue uma ordem: primeiro a reserva de emergência, até ela completar a meta. O que sobra é dividido entre as classes abaixo da alocação-alvo, em proporção ao quanto cada uma está atrasada, e dentro de cada classe entre os ativos com nota de resistência, alternando setores."
          />
        </Card>
      ) : plan.isError ? (
        <Card span={12}>
          <EmptyState
            icon="alert"
            title="Falha ao calcular"
            body="Não foi possível calcular a sugestão de aporte agora. Tente novamente em instantes."
          />
        </Card>
      ) : !plan.data ? (
        <Card span={12}>
          <EmptyState title="Calculando…" />
        </Card>
      ) : (
        <>
          {plan.data.reserve.allocatedCents > 0 && (
            <Slab span={12} accent>
              <div className="row row--between row--wrap">
                <div className="stack stack--tight">
                  <span className="stat__label">Reserva de emergência, antes das classes</span>
                  <span className="hero-figure" style={{ fontSize: 'var(--text-xl)' }}>
                    {money(plan.data.reserve.allocatedCents)}
                  </span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-2)' }}>
                    {plan.data.reserve.allocatedCents === plan.data.reserve.gapCents
                      ? `completa a meta de ${plan.data.reserve.multiple}x o custo de vida`
                      : `abate parte dos ${money(plan.data.reserve.gapCents)} que faltam para a meta de ${plan.data.reserve.multiple}x`}
                  </span>
                </div>
                <Button variant="slab" icon="plus" onClick={() => setContributingReserve(plan.data!.reserve.allocatedCents)}>
                  Aportar na reserva
                </Button>
              </div>
            </Slab>
          )}

          {plan.data.classes.length === 0 && plan.data.reserve.allocatedCents === 0 ? (
            <Card span={12}>
              <EmptyState
                icon="scale"
                title="Nada para sugerir"
                body="Ou nenhuma classe está abaixo da meta, ou nenhum ativo abaixo da meta foi avaliado ainda. Defina metas por classe e responda os critérios de resistência dos seus ativos."
              />
            </Card>
          ) : (
            <>
              {plan.data.classes.map((c) => (
                <Card key={c.assetClass} span={6} title={c.label} subtitle={`${money(c.allocatedCents)} deste aporte`}>
                  <div className="stack stack--tight">
                    {c.assets.map((a) => (
                      <div key={a.assetId} className="row row--between">
                        <span className="row" style={{ gap: 'var(--sp-2)', minWidth: 0 }}>
                          <span className="badge badge--good" style={{ minWidth: 28, justifyContent: 'center' }}>
                            {a.note}
                          </span>
                          <span className="truncate">{a.name}</span>
                          {a.ticker && <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>· {a.ticker}</span>}
                          {a.sector && <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>· {a.sector}</span>}
                        </span>
                        <span className="row" style={{ gap: 'var(--sp-3)', flex: 'none' }}>
                          <span className="stack stack--tight" style={{ alignItems: 'flex-end', gap: 0 }}>
                            <span className="tabular pos">{money(a.suggestedCents)}</span>
                            {a.unitPriceCents !== null ? (
                              <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                                {a.quantity}x a {money(a.unitPriceCents)}
                              </span>
                            ) : (
                              <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>sem cotação</span>
                            )}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="check"
                            title={`Registrar compra de ${a.name}`}
                            onClick={() => buyAsset.mutate(a)}
                            disabled={buyAsset.isPending}
                          >
                            Comprar
                          </Button>
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}

              {plan.data.unallocatedCents > 0 && (
                <Card span={12} muted>
                  <div className="row" style={{ gap: 'var(--sp-2)' }}>
                    <Icon name="info" size={16} />
                    <span style={{ fontSize: 'var(--text-sm)' }}>
                      <strong className="tabular">{money(plan.data.unallocatedCents)}</strong> não encontrou destino:
                      todas as classes com meta definida já estão no alvo, ou os ativos restantes ainda não
                      têm nota de resistência. Responda os critérios de mais ativos para liberar espaço.
                    </span>
                  </div>
                </Card>
              )}
            </>
          )}
        </>
      )}

      {contributingReserve !== null && (
        <ReserveContributeModal initialAmountCents={contributingReserve} onClose={() => setContributingReserve(null)} />
      )}
    </Bento>
  )
}

/**
 * "Se eu aportar esse valor agora, quando bato a meta, e quanto do que
 * falta esse aporte cobre?" — reusa a MESMA projeção de `goalProjection`
 * (nunca uma segunda fórmula), só com `extraContributionCents` somado ao
 * valor de partida. Duas chamadas (com e sem o aporte) para poder mostrar
 * "era X, passa a ser Y", cacheadas por valor então trocar o aporte não
 * refaz a chamada-base repetidamente.
 */
function GoalContributionImpact({ goal, extraContributionCents }: { goal: Goal; extraContributionCents: number }) {
  const baseline = useQuery({
    queryKey: ['investment-goal-projection', goal.id, 0],
    queryFn: () => api.get<Projection>(`/investments/goals/${goal.id}/projection`, { extraContributionCents: 0 }),
  })
  const withContribution = useQuery({
    queryKey: ['investment-goal-projection', goal.id, extraContributionCents],
    queryFn: () =>
      api.get<Projection>(`/investments/goals/${goal.id}/projection`, { extraContributionCents }),
  })

  if (baseline.isError || withContribution.isError) return null
  if (!baseline.data || !withContribution.data) {
    return <SkeletonLines lines={3} />
  }

  const before = baseline.data
  const after = withContribution.data
  const changesEta = before.reachedPeriod !== after.reachedPeriod

  return (
    <div className="stack stack--tight" style={{ minWidth: 0 }}>
      <span className="stat__label truncate">{goal.name}</span>
      <span className="stat__value kpi__value">
        {after.reachedPeriod === null ? 'além do horizonte' : fmtPeriod(after.reachedPeriod)}
      </span>
      <span className="stat__foot">
        {after.reachedPeriod === null ? (
          <span>mesmo com este aporte</span>
        ) : changesEta && before.reachedPeriod ? (
          <span className="delta" style={{ color: 'var(--delta-up)' }}>
            <Icon name="arrowUpRight" size={12} strokeWidth={2.2} />
            antes {fmtPeriod(before.reachedPeriod)}
          </span>
        ) : (
          <span>a data prevista não muda</span>
        )}
        {after.contributionShareOfGapBps !== null && (
          <span>cobre {bps(Math.min(after.contributionShareOfGapBps, 10_000), 0)} do que falta</span>
        )}
      </span>
    </div>
  )
}
