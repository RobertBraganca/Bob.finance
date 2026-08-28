import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { telemetry } from '../lib/telemetry'
import {
  bps,
  bpsToInput,
  centsToInput,
  money,
  moneyCompact,
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
  Button,
  Card,
  EmptyState,
  FilterSelect,
  HeroFigure,
  Icon,
  Meter,
  Modal,
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
} from '../components/ui'
import { PageHeader } from '../components/shell/Shell'
import {
  AllocationChart,
  AllocationVsTargetChart,
  AssetClassRing,
  GoalProjectionChart,
  PortfolioEvolutionChart,
  type AllocationSlice,
  type PerformancePoint,
} from '../components/charts/InvestmentCharts'
import { ProfitabilityChart } from '../components/charts/ProfitabilityChart'
import { DateRangePopover } from '../components/ui/DateRangePopover'

/** Only these classes trade on B3 the way BRAPI understands — mirrors the server's set. */
const QUOTABLE_CLASSES = new Set(['stocks', 'fii'])

type Position = {
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

type Goal = {
  id: number
  name: string
  targetValueCents: number
  targetDate: string | null
  monthlyContributionCents: number
  expectedReturnBps: number
  purpose: string | null
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
  goalPurposes: Array<{ value: string; label: string }>
}

type Projection = {
  goal: Goal
  series: Array<{ month: number; period: string; baselineCents: number; projectedCents: number; contributedCents: number }>
  currentValueCents: number
  progressBps: number | null
  reachedMonth: number | null
  reachedPeriod: string | null
  onTrack: boolean | null
  requiredMonthlyCents: number | null
  projectedAtTargetCents: number | null
}

export function InvestmentsPage() {
  const [tab, setTab] = useState<'portfolio' | 'contribute' | 'goals' | 'profitability' | 'ledger'>('portfolio')
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
      <PageHeader
        title="Investimentos"
        subtitle="Carteira, alocação e o ambiente de metas de aporte"
        actions={
          <div className="row">
            <RefreshAllQuotesButton hasQuotable={(data?.positions ?? []).some((p) => p.ticker && QUOTABLE_CLASSES.has(p.assetClass))} />
            <Button icon="plus" onClick={() => setAssetModal(true)}>
              Novo ativo
            </Button>
            <Button
              variant="primary"
              icon="trending"
              onClick={() => setTradeModal(true)}
              disabled={(data?.assetCount ?? 0) === 0}
            >
              Registrar aporte
            </Button>
          </div>
        }
      />

      <div className="page">
        <Segmented
          ariaLabel="Seção"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'portfolio', label: 'Carteira' },
            { value: 'contribute', label: 'Aportar' },
            { value: 'ledger', label: 'Lançamentos' },
            { value: 'goals', label: `Metas (${data?.goals.length ?? 0})` },
            { value: 'profitability', label: 'Rentabilidade' },
          ]}
        />

        {!data ? (
          <Card>
            <SkeletonLines lines={4} />
          </Card>
        ) : data.assetCount === 0 ? (
          <div className="bento">
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
          </div>
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
          <ContributionPlanner />
        ) : tab === 'ledger' ? (
          <LedgerTab positions={data.positions} allocation={data.allocation} />
        ) : tab === 'profitability' ? (
          <ProfitabilityTab />
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
          classes={data?.assetClasses ?? []}
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
      queryClient.invalidateQueries()
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
      className={`badge ${tone === 'good' ? 'badge--good' : tone === 'warning' ? 'badge--warning' : tone === 'critical' ? 'badge--critical' : ''}`}
      style={{ cursor: 'pointer', minWidth: 34, justifyContent: 'center' }}
      onClick={onClick}
      title={title}
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
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [classFilter, setClassFilter] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const anchorIso = customTo || new Date().toISOString().slice(0, 10)
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

  const groups = useMemo(() => {
    const byClass = new Map<string, Position[]>()
    for (const p of data.positions) {
      const list = byClass.get(p.assetClass) ?? []
      list.push(p)
      byClass.set(p.assetClass, list)
    }
    return [...byClass.entries()]
      .map(([assetClass, rows]) => ({
        assetClass,
        label: rows[0]!.assetClassLabel,
        rows,
        alloc: data.allocation.find((a) => a.assetClass === assetClass) ?? null,
      }))
      .sort(
        (a, b) =>
          b.rows.reduce((s, p) => s + p.marketValueCents, 0) - a.rows.reduce((s, p) => s + p.marketValueCents, 0),
      )
  }, [data.positions, data.allocation])

  return (
    <div className="bento">
      <Card span={12} muted>
        <div className="row row--wrap row--between">
          <div className="row row--wrap">
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
      </Card>

      <Slab span={6} accent>
        <HeroFigure
          label="Patrimônio total"
          value={moneyCompact(data.marketValueCents)}
          delta={summary.data?.valueGrowthBpsInRange ?? null}
          deltaLabel={`no período (${rangeLabel})`}
        >
          <div className="kv" style={{ marginTop: 'var(--sp-3)' }}>
            <span className="kv__k">Valor investido</span>
            <span className="kv__v">{money(data.contributedCents)}</span>
          </div>
        </HeroFigure>
      </Slab>

      <Card span={6}>
        <StatTile label="Lucro total" value={money(data.gainCents)} large />
        <div className="kv">
          <span className="kv__k">Ganho de capital</span>
          <span className={`kv__v ${data.gainCents - data.dividendsCents < 0 ? 'neg' : 'pos'}`}>
            {money(data.gainCents - data.dividendsCents)}
          </span>
          <span className="kv__k">Dividendos recebidos</span>
          <span className="kv__v pos">{money(data.dividendsCents)}</span>
        </div>
      </Card>

      <Card span={4}>
        <StatTile
          label={`Proventos recebidos (${rangeLabel})`}
          value={summary.data ? money(summary.data.dividendsInRangeCents) : '-'}
          foot={summary.data ? `Total ${money(summary.data.dividendsCents)}` : undefined}
        />
      </Card>
      <Card span={4}>
        <StatTile
          label={`Rentabilidade (${rangeLabel})`}
          value={
            summary.data?.gainBpsInRange === null || summary.data?.gainBpsInRange === undefined
              ? '-'
              : signedBps(summary.data.gainBpsInRange)
          }
        />
      </Card>
      <Card span={4}>
        <StatTile
          label="Rentabilidade total"
          value={
            summary.data?.gainBpsAllTime === null || summary.data?.gainBpsAllTime === undefined
              ? '-'
              : signedBps(summary.data.gainBpsAllTime)
          }
        />
      </Card>

      <Card span={7} title="Evolução do patrimônio">
        <PortfolioEvolutionChart data={evolutionData} surface="paper" height={260} />
      </Card>
      <Card span={5} title="Ativos na carteira">
        <AssetClassRing slices={data.allocation} surface="paper" height={220} />
      </Card>

      <Card
        span={7}
        title="Alocação por classe"
        subtitle="Barra é o real, marca vertical é a meta"
        actions={
          <Button size="sm" icon="target" onClick={onOpenAlloc}>
            Definir metas
          </Button>
        }
      >
        <AllocationChart slices={data.allocation} surface="paper" />
      </Card>

      <BelowTargetCard allocation={data.allocation} onOpenAlloc={onOpenAlloc} />

      <AllocationDeviationCard />

      <ReserveCard />

      <Card span={12} flush>
        <div className="row row--between" style={{ padding: 'var(--sp-5) var(--sp-5) 0', flexWrap: 'wrap', gap: 'var(--sp-3)' }}>
          <h2 className="card__title">Meus ativos ({data.positions.length})</h2>
          <Button size="sm" icon="target" onClick={onOpenAlloc}>
            Configurar % ideal da carteira
          </Button>
        </div>
        {data.unpricedCount > 0 && (
          <p className="field__hint" style={{ padding: 'var(--sp-3) var(--sp-5) 0' }}>
            <Icon name="info" size={12} /> {data.unpricedCount} ativo(s) sem cotação registrada; o valor
            mostrado é o custo médio.
          </p>
        )}
        <div className="stack stack--tight" style={{ padding: 'var(--sp-5)' }}>
          {groups.map((group) => (
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
              onToggle={() =>
                setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(group.assetClass)) next.delete(group.assetClass)
                  else next.add(group.assetClass)
                  return next
                })
              }
              onOpenCriteria={onOpenCriteria}
              onAddTrade={() => onAddTrade(group.assetClass)}
              onViewTrades={() => onViewTrades(group.label, group.rows.map((r) => r.assetId))}
            />
          ))}
        </div>
      </Card>
    </div>
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
  onOpenAlloc,
}: {
  allocation: AllocationSlice[]
  onOpenAlloc: () => void
}) {
  const hasAnyTarget = allocation.some((slice) => slice.rebalanceCents !== null)
  const below = allocation.filter(
    (slice) => slice.rebalanceCents !== null && slice.rebalanceCents > 0,
  )

  return (
    <Card
      span={5}
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
          {below.map((slice) => (
            <div key={slice.assetClass} className="row row--between">
              <span className="truncate">{slice.label}</span>
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
        </div>
      )}
    </Card>
  )
}

type AllocationDeviation = {
  assetClass: string
  label: string
  actualBps: number
  targetBps: number
  deviationBps: number
}

/**
 * Desvio de alocação: current share against the policy the user configured,
 * per class, and nothing else.
 *
 * This card deliberately does NOT suggest an asset, a class or an operation,
 * and the endpoint behind it has no field that could be rendered as one. See
 * `decisions/0010` and, for investments specifically, the Ofício-Circular
 * CVM/SIN 2/2026 reasoning recorded there: a managerial report on portfolio
 * composition against the client's own investment policy is a different
 * thing from consultoria de valores mobiliários, and the difference lives
 * exactly in not recommending. Rows keep the API's alphabetical order,
 * because sorting by "biggest gap first" would be a recommendation
 * expressed as a layout.
 */
function AllocationDeviationCard() {
  const deviation = useQuery({
    queryKey: ['allocation-deviation'],
    queryFn: () =>
      api.get<{ classes: AllocationDeviation[]; assumptions: AssumptionBag }>(
        '/investments/allocation-deviation',
      ),
  })

  const classes = deviation.data?.classes ?? []

  return (
    <Card
      span={12}
      title="Desvio de alocação"
      subtitle="Sua carteira hoje comparada com a política de alocação que você configurou"
    >
      {classes.length === 0 ? (
        <EmptyState
          icon="scale"
          title="Nenhuma classe com meta configurada"
          body="Uma classe entra nesta tabela quando tem percentual-alvo definido na alocação."
        />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Classe</th>
                  <th className="table__num">Atual</th>
                  <th className="table__num">Meta</th>
                  <th className="table__num">Desvio</th>
                </tr>
              </thead>
              <tbody>
                {classes.map((row) => (
                  <tr key={row.assetClass}>
                    <td>{row.label}</td>
                    <td className="table__num">{bps(row.actualBps)}</td>
                    <td className="table__num">{bps(row.targetBps)}</td>
                    <td className="table__num">{signedPoints(row.deviationBps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Assumptions data={deviation.data?.assumptions} />
        </>
      )}
    </Card>
  )
}

function ReserveCard() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editingCost, setEditingCost] = useState(false)
  const [costInput, setCostInput] = useState('')
  const [contributing, setContributing] = useState(false)
  const [viewingHistory, setViewingHistory] = useState(false)

  const reserve = useQuery({
    queryKey: ['investment-reserve'],
    queryFn: () => api.get<ReserveStatus>('/investments/reserve'),
  })

  const setMultiple = useMutation({
    mutationFn: (multiple: number) => api.put('/investments/reserve', { multiple }),
    onSuccess: () => {
      toast('Meta de reserva atualizada')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const setLivingCost = useMutation({
    mutationFn: (manualLivingCostCents: number | null) => api.put('/investments/reserve', { manualLivingCostCents }),
    onSuccess: (_, manualLivingCostCents) => {
      toast(manualLivingCostCents === null ? 'Voltou a usar a média calculada' : 'Custo de vida atualizado')
      queryClient.invalidateQueries()
      setEditingCost(false)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const data = reserve.data
  const meterState = targetProgressState(data ? data.progressBps : null)

  return (
    <Card
      span={12}
      title="Reserva de emergência"
      subtitle="Antes de investir: quanto do seu custo de vida médio já está guardado"
      actions={
        <div className="row" style={{ gap: 'var(--sp-2)' }}>
          <Segmented
            ariaLabel="Meta de reserva"
            value={data ? String(data.multiple) : '6'}
            options={RESERVE_MULTIPLE_OPTIONS}
            onChange={(value) => setMultiple.mutate(Number(value))}
          />
          {data?.assetId && (
            <Button variant="ghost" size="sm" icon="list" onClick={() => setViewingHistory(true)}>
              Lançamentos
            </Button>
          )}
          <Button variant="primary" size="sm" icon="plus" onClick={() => setContributing(true)}>
            Aportar na reserva
          </Button>
        </div>
      }
    >
      {!data ? (
        <SkeletonLines lines={4} />
      ) : (
        <div className="stack">
          <div className="row row--between row--wrap">
            <StatTile label="Guardado" value={money(data.currentCents)} large />
            <StatTile
              label={`Meta (${data.multiple}x o custo de vida)`}
              value={money(data.targetCents)}
            />
            <StatTile
              label="Falta"
              value={data.gapCents === 0 ? 'Completa' : money(data.gapCents)}
            />
          </div>

          {!editingCost ? (
            <div className="row row--between" style={{ fontSize: 'var(--text-xs)' }}>
              <span className="muted">
                Custo de vida usado: <strong className="tabular">{money(data.monthlyLivingCostCents)}</strong>/mês
                {data.livingCostIsManual ? ' (informado por você)' : ` (média real, últimos ${data.lookbackMonths} meses)`}
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
                <label className="field__label">Custo de vida mensal (R$)</label>
                <TextInput value={costInput} onChange={setCostInput} placeholder="0,00" numeral />
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
          <p className="chart__note">
            {data.gapCents > 0
              ? 'Enquanto a reserva não está completa, cada aporte é direcionado pra ela antes de qualquer ativo: marque os ativos que contam como reserva na tabela abaixo.'
              : 'Reserva completa: todo novo aporte vai direto para a carteira, seguindo o alvo por classe.'}
          </p>
        </div>
      )}

      {contributing && <ReserveContributeModal onClose={() => setContributing(false)} />}
      {viewingHistory && data?.assetId && (
        <TradeHistoryModal
          label="Reserva de emergência"
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
  const [tradedOn, setTradedOn] = useState(() => new Date().toISOString().slice(0, 10))

  const save = useMutation({
    mutationFn: () => {
      const amountCents = parseMoneyInput(amount)
      if (amountCents === null || amountCents === 0) throw new Error('informe o valor')
      return api.post('/investments/reserve/contribute', { amountCents: Math.abs(amountCents), tradedOn, kind })
    },
    onSuccess: () => {
      toast(kind === 'buy' ? 'Aporte registrado na reserva' : 'Retirada registrada na reserva')
      queryClient.invalidateQueries()
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
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending}>
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
            <label className="field__label">Valor (R$)</label>
            <TextInput value={amount} onChange={setAmount} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Data</label>
            <TextInput value={tradedOn} onChange={setTradedOn} type="date" />
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

  return (
    <div className="card group-card">
      <button type="button" className="group-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="row" style={{ gap: 'var(--sp-3)', minWidth: 0 }}>
          <Icon name={ASSET_CLASS_ICON[assetClass] ?? 'wallet'} size={18} />
          <strong className="truncate">{label}</strong>
        </span>
        <span className="row row--wrap group-head__stats">
          <MiniStat label="Ativos" value={String(rows.length)} />
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
            <table className="table">
              <thead>
                <tr>
                  <th>Ativo</th>
                  <th style={{ textAlign: 'center', width: 70 }}>Nota</th>
                  <th style={{ textAlign: 'right' }}>Qtd.</th>
                  <th style={{ textAlign: 'right' }}>Preço médio</th>
                  <th style={{ textAlign: 'right' }}>Cotação</th>
                  <th style={{ textAlign: 'right' }}>Variação</th>
                  <th style={{ textAlign: 'right' }}>Saldo</th>
                  <th style={{ textAlign: 'center' }}>Reserva</th>
                  <th style={{ textAlign: 'right' }}>% carteira</th>
                  <th style={{ textAlign: 'right' }}>% ideal</th>
                  <th style={{ textAlign: 'center' }}>Comprar?</th>
                  <th style={{ width: 76 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((position) => {
                  const slice = slices.get(position.assetId)
                  const variacao =
                    position.lastUnitPriceCents !== null && position.avgUnitPriceCents > 0
                      ? Math.round(
                          ((position.lastUnitPriceCents - position.avgUnitPriceCents) /
                            position.avgUnitPriceCents) *
                            10_000,
                        )
                      : null
                  return (
                    <tr key={position.assetId}>
                      <td>
                        <strong>{position.name}</strong>
                        {position.ticker && (
                          <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                            {' '}
                            · {position.ticker}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
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
                      <td className="table__num">{fmtQuantity(position.quantity)}</td>
                      <td className="table__num">{money(position.avgUnitPriceCents)}</td>
                      <td className="table__num">
                        {position.lastUnitPriceCents === null ? (
                          <span className="muted">-</span>
                        ) : (
                          money(position.lastUnitPriceCents)
                        )}
                      </td>
                      <td className={`table__num ${variacao === null ? '' : variacao < 0 ? 'neg' : 'pos'}`}>
                        {variacao === null ? '-' : signedBps(variacao, 2)}
                      </td>
                      <td className="table__num">{money(position.marketValueCents)}</td>
                      <td style={{ textAlign: 'center' }}>
                        <ReserveToggle assetId={position.assetId} checked={position.countsTowardReserve} />
                      </td>
                      <td className="table__num">{slice ? bps(slice.actualBps, 0) : '-'}</td>
                      <td className="table__num">
                        {slice === undefined || slice.targetBps === null ? '-' : bps(slice.targetBps, 0)}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {slice === undefined || slice.rebalanceCents === null ? (
                          <span className="muted">-</span>
                        ) : slice.rebalanceCents > 0 ? (
                          <span className="badge badge--good">Sim</span>
                        ) : (
                          <span className="badge">Não</span>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 2 }}>
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
          <div className="row row--between" style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
            <Button variant="ghost" size="sm" icon="list" onClick={onViewTrades}>
              Lançamentos
            </Button>
            <Button variant="primary" size="sm" icon="plus" onClick={onAddTrade}>
              Adicionar lançamento
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
}

const TRADE_KIND_LABEL: Record<string, string> = { buy: 'Compra', sell: 'Venda', dividend: 'Provento' }

/**
 * Aba "Lançamentos": tabela dedicada de `assetTrades` (compra/venda/provento
 * de qualquer ativo, filtrável) mais o gráfico de barra dupla carteira atual
 * x objetivo. Nenhum endpoint novo — `/investments/trades` já lista tudo e
 * `allocation` é o mesmo dado que já alimenta "Alocação por classe" na aba
 * Carteira. Ver `specs/investments`, "Aba Lançamentos e gráficos de carteira
 * objetivo".
 */
function LedgerTab({ positions, allocation }: { positions: Position[]; allocation: AllocationSlice[] }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [assetFilter, setAssetFilter] = useState<number | null>(null)
  const [kindFilter, setKindFilter] = useState<string | null>(null)
  const [editingTrade, setEditingTrade] = useState<TradeRow | null>(null)

  const trades = useQuery({
    queryKey: ['investment-trades'],
    queryFn: () => api.get<{ trades: TradeRow[] }>('/investments/trades'),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.del<{ removed: number }>(`/investments/trades/${id}`),
    onSuccess: () => {
      toast('Lançamento removido')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  const rows = (trades.data?.trades ?? [])
    .filter((t) => assetFilter === null || t.assetId === assetFilter)
    .filter((t) => kindFilter === null || t.kind === kindFilter)

  return (
    <div className="bento">
      <Slab span={12}>
        <AllocationVsTargetChart slices={allocation} />
      </Slab>

      <Card
        span={12}
        flush
        title="Lançamentos"
        subtitle="Todo aporte, venda e provento, de qualquer ativo"
        actions={
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <FilterSelect
              icon="filter"
              value={assetFilter}
              placeholder="Todos os ativos"
              options={positions.map((p) => ({ value: p.assetId, label: p.name }))}
              onChange={setAssetFilter}
            />
            <FilterSelect
              icon="filter"
              value={kindFilter}
              placeholder="Todos os tipos"
              options={Object.entries(TRADE_KIND_LABEL).map(([value, label]) => ({ value, label }))}
              onChange={setKindFilter}
            />
          </div>
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            icon="list"
            title="Nenhum lançamento"
            body="Compras, vendas e proventos aparecem aqui assim que forem registrados."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Ativo</th>
                  <th>Tipo</th>
                  <th style={{ textAlign: 'right' }}>Qtd.</th>
                  <th style={{ textAlign: 'right' }}>Preço</th>
                  <th style={{ textAlign: 'right' }}>Taxas</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>{fmtDate(t.tradedOn)}</td>
                    <td>{t.assetName}</td>
                    <td className="muted">{TRADE_KIND_LABEL[t.kind] ?? t.kind}</td>
                    <td className="table__num">{fmtQuantity(t.quantity)}</td>
                    <td className="table__num">{money(t.unitPriceCents)}</td>
                    <td className="table__num">{money(t.feesCents)}</td>
                    <td>
                      <div className="row" style={{ gap: 2 }}>
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="pencil"
                          onClick={() => setEditingTrade(t)}
                          title="Editar lançamento"
                        />
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="trash"
                          onClick={() => remove.mutate(t.id)}
                          disabled={remove.isPending}
                          title="Excluir lançamento"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editingTrade && <EditTradeModal trade={editingTrade} onClose={() => setEditingTrade(null)} />}
    </div>
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

  const trades = useQuery({
    queryKey: ['investment-trades'],
    queryFn: () => api.get<{ trades: TradeRow[] }>('/investments/trades'),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.del<{ removed: number }>(`/investments/trades/${id}`),
    onSuccess: () => {
      toast('Lançamento removido')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  const rows = (trades.data?.trades ?? []).filter((t) => assetIds.includes(t.assetId))

  return (
    <Modal
      title={`Lançamentos de ${label}`}
      onClose={onClose}
      wide
      footer={
        <Button variant="quiet" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon="list"
          title="Nenhum lançamento"
          body="Compras, vendas e proventos desta classe aparecem aqui, com opção de excluir."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Ativo</th>
                <th>Tipo</th>
                <th style={{ textAlign: 'right' }}>Qtd.</th>
                <th style={{ textAlign: 'right' }}>Preço</th>
                <th style={{ textAlign: 'right' }}>Taxas</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>{fmtDate(t.tradedOn)}</td>
                  <td>{t.assetName}</td>
                  <td className="muted">{TRADE_KIND_LABEL[t.kind] ?? t.kind}</td>
                  <td className="table__num">{fmtQuantity(t.quantity)}</td>
                  <td className="table__num">{money(t.unitPriceCents)}</td>
                  <td className="table__num">{money(t.feesCents)}</td>
                  <td>
                    <div className="row" style={{ gap: 2 }}>
                      <Button
                        variant="quiet"
                        size="sm"
                        icon="pencil"
                        onClick={() => setEditingTrade(t)}
                        title="Editar lançamento"
                      />
                      <Button
                        variant="quiet"
                        size="sm"
                        icon="trash"
                        onClick={() => remove.mutate(t.id)}
                        disabled={remove.isPending}
                        title="Excluir lançamento"
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
      return api.patch(`/investments/trades/${trade.id}`, {
        kind,
        tradedOn,
        quantity: qty,
        unitPriceCents: Math.abs(unitPriceCents),
        feesCents: Math.abs(parseMoneyInput(fees) ?? 0),
      })
    },
    onSuccess: () => {
      toast('Lançamento atualizado')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title={`Editar lançamento de ${trade.assetName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack">
        <TradeKindToggle kind={kind} onChange={setKind} />

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Data da transação</label>
            <TextInput value={tradedOn} onChange={setTradedOn} type="date" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 130 }}>
            <label className="field__label">Quantidade</label>
            <TextInput value={quantity} onChange={setQuantity} numeral />
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Preço (R$)</label>
            <TextInput value={price} onChange={setPrice} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Outros custos (Opcional)</label>
            <TextInput value={fees} onChange={setFees} placeholder="0,00" numeral />
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

function ProfitabilityKpiCard({
  label,
  totalBps,
  benchmarkLabel,
  benchmarkBps,
  neutralOnFlat,
}: {
  label: string
  totalBps: number | null
  benchmarkLabel: string
  benchmarkBps: number | null
  /** "Último mês" treats ~0% as neutral (gray, horizontal arrow) rather than good/bad green/red. */
  neutralOnFlat?: boolean
}) {
  const diffBps = totalBps !== null && benchmarkBps !== null ? totalBps - benchmarkBps : null
  const flat = neutralOnFlat && totalBps !== null && Math.abs(totalBps) < 10
  return (
    <Slab span={4}>
      <div className="stack stack--tight">
        <span className="stat__label">{label}</span>
        <span className="hero-figure" style={flat ? { color: 'var(--on-slab-2)' } : undefined}>
          {totalBps === null ? '—' : signedBps(totalBps)}
        </span>
        {diffBps !== null && (
          <span className="stat__foot">
            <span
              className="delta"
              style={{ color: flat || diffBps === 0 ? 'var(--on-slab-2)' : diffBps > 0 ? 'var(--delta-up-slab)' : 'var(--delta-down-slab)' }}
            >
              <Icon
                name={flat || diffBps === 0 ? 'arrowRight' : diffBps > 0 ? 'arrowUpRight' : 'arrowDownLeft'}
                size={12}
                strokeWidth={2.2}
              />
              {signedBps(diffBps)}
              <span className="muted" style={{ fontWeight: 400 }}> vs. {benchmarkLabel}</span>
            </span>
          </span>
        )}
      </div>
    </Slab>
  )
}

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

  return (
    <div className="bento">
      <Card span={12} muted>
        <div className="row row--wrap row--between">
          <span className="field__label" style={{ margin: 0 }}>Comparar com</span>
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <FilterSelect icon="scale" value={benchmarkCode} options={benchmarkOptions} onChange={(v) => setBenchmarkCode(v ?? 'CDI')} />
            <Button icon="refresh" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              Atualizar índices
            </Button>
          </div>
        </div>
      </Card>

      <ProfitabilityKpiCard label="Rentabilidade total" totalBps={totalBps} benchmarkLabel={benchmarkLabel} benchmarkBps={benchmarkTotal} />
      <ProfitabilityKpiCard label="Últimos 12 meses" totalBps={last12} benchmarkLabel={benchmarkLabel} benchmarkBps={benchmarkLast12} />
      <ProfitabilityKpiCard label="Último mês" totalBps={lastMonth} benchmarkLabel={benchmarkLabel} benchmarkBps={benchmarkLastMonth} neutralOnFlat />

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

      <Card span={12} title="Rentabilidade por mês" subtitle="Retorno da carteira, ano a ano">
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Ano</th>
                {MONTH_LABELS.map((m) => (
                  <th key={m} style={{ textAlign: 'right' }}>{m}</th>
                ))}
                <th style={{ textAlign: 'right' }}>Retorno anual</th>
                <th style={{ textAlign: 'right' }}>Acumulado</th>
              </tr>
            </thead>
            <tbody>
              {data.table.map((row) => (
                <tr key={row.year}>
                  <td>{row.year}</td>
                  {row.months.map((value, i) => (
                    <td
                      key={i}
                      className="table__num"
                      style={value === null ? undefined : { color: value >= 0 ? 'var(--delta-up)' : 'var(--delta-down)' }}
                    >
                      {value === null ? '—' : bps(value)}
                    </td>
                  ))}
                  <td className="table__num" style={{ fontWeight: 600 }}>
                    {row.annualReturnBps === null ? '—' : bps(row.annualReturnBps)}
                  </td>
                  <td className="table__num">{bps(row.cumulativeReturnBps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
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
      <div className="bento">
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
      </div>
    )
  }

  const data = projection.data
  const goal = data?.goal

  return (
    <>
      <div className="bento">
        <Card span={12} muted>
          <div className="row row--between row--wrap">
            <div className="row row--wrap">
              {goals.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`btn ${item.id === activeId ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  {item.name}
                </button>
              ))}
            </div>
            <div className="row">
              <Button icon="plus" onClick={() => setEditing('new')}>
                Nova meta
              </Button>
              {goal && (
                <Button icon="pencil" onClick={() => setEditing(goal)}>
                  Editar
                </Button>
              )}
            </div>
          </div>
        </Card>

        {!data || !goal ? (
          <Card span={12}>
            <SkeletonBlock height={260} />
          </Card>
        ) : (
          <>
            <Slab span={4} accent>
              <HeroFigure
                label={
                  goal.purpose
                    ? `${goal.name} · ${goalPurposes.find((p) => p.value === goal.purpose)?.label ?? goal.purpose}`
                    : goal.name
                }
                value={moneyCompact(data.currentValueCents)}
              >
                <div className="stack stack--tight" style={{ marginTop: 'var(--sp-3)' }}>
                  <div className="row row--between">
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-2)' }}>
                      meta {money(goal.targetValueCents)}
                    </span>
                    <StatusBadge
                      state={
                        data.onTrack === null
                          ? 'no_target'
                          : data.onTrack
                            ? 'on_track'
                            : 'at_risk'
                      }
                    />
                  </div>
                  <Meter
                    usedBps={data.progressBps ?? 0}
                    state={data.onTrack === false ? 'at_risk' : 'on_track'}
                  />
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-2)' }}>
                    {data.progressBps === null ? '' : `${bps(data.progressBps, 0)} do alvo`}
                  </span>
                </div>
              </HeroFigure>
            </Slab>

            <Card span={8} title="Trajetória projetada">
              <GoalProjectionChart
                data={data.series}
                targetCents={goal.targetValueCents}
                surface="paper"
                height={250}
              />
            </Card>

            <Card span={3}>
              <StatTile
                label="Aporte mensal planejado"
                value={moneyCompact(goal.monthlyContributionCents)}
                foot={`retorno esperado ${bps(goal.expectedReturnBps)} a.a.`}
              />
            </Card>
            <Card span={3}>
              <StatTile
                label="Alcança a meta em"
                value={data.reachedMonth === null ? 'além do horizonte' : monthsLabel(data.reachedMonth)}
                foot={data.reachedPeriod ? fmtPeriod(data.reachedPeriod) : 'aumente o aporte'}
              />
            </Card>
            <Card span={3}>
              <StatTile
                label="Aporte necessário na data"
                value={
                  data.requiredMonthlyCents === null ? '-' : moneyCompact(data.requiredMonthlyCents)
                }
                foot={
                  goal.targetDate
                    ? `para chegar em ${fmtDate(goal.targetDate)}`
                    : 'defina uma data-alvo'
                }
              />
            </Card>
            <Card span={3}>
              <StatTile
                label="Projetado na data-alvo"
                value={
                  data.projectedAtTargetCents === null
                    ? '-'
                    : moneyCompact(data.projectedAtTargetCents)
                }
                foot={
                  data.projectedAtTargetCents !== null
                    ? data.projectedAtTargetCents >= goal.targetValueCents
                      ? 'acima do alvo'
                      : `${money(goal.targetValueCents - data.projectedAtTargetCents)} de diferença`
                    : ''
                }
              />
            </Card>
          </>
        )}
      </div>

      {editing !== null && (
        <GoalModal
          goal={editing === 'new' ? null : editing}
          goalPurposes={goalPurposes}
          onClose={() => setEditing(null)}
        />
      )}
    </>
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

  const save = useMutation({
    mutationFn: () =>
      api.post('/investments/assets', {
        name: name.trim(),
        ticker: ticker.trim() || null,
        assetClass,
      }),
    onSuccess: () => {
      toast('Ativo cadastrado')
      queryClient.invalidateQueries()
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
          <label className="field__label">Nome</label>
          <TextInput value={name} onChange={setName} placeholder="ex. Tesouro IPCA+ 2035" />
        </div>
        <div className="field">
          <label className="field__label">Código</label>
          <TextInput value={ticker} onChange={setTicker} placeholder="opcional, ex. PETR4" />
        </div>
        <div className="field">
          <label className="field__label">Classe</label>
          <Select value={assetClass} options={classes} onChange={(value) => setAssetClass(value ?? 'stocks')} />
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

function TradeModal({
  classes,
  positions,
  initialAssetClass,
  onClose,
}: {
  classes: Array<{ value: string; label: string }>
  positions: Position[]
  initialAssetClass?: string | null
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState('buy')
  const [assetClass, setAssetClass] = useState<string | null>(initialAssetClass ?? null)
  const [assetId, setAssetId] = useState<number | null>(null)
  const [tradedOn, setTradedOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [quantity, setQuantity] = useState('1')
  const [price, setPrice] = useState('')
  const [fees, setFees] = useState('')

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
      return api.post('/investments/trades', {
        assetId,
        kind,
        tradedOn,
        quantity: qty,
        unitPriceCents: Math.abs(unitPriceCents),
        feesCents: Math.abs(parseMoneyInput(fees) ?? 0),
      })
    },
    onSuccess: () => {
      telemetry.action('investments', 'trade_recorded')
      toast('Lançamento adicionado')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title="Adicionar lançamento"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending}>
            Adicionar lançamento
          </Button>
        </>
      }
    >
      <div className="stack">
        <TradeKindToggle kind={kind} onChange={setKind} />

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 170 }}>
            <label className="field__label">Tipo de ativo</label>
            <Select
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
            <label className="field__label">Ativo</label>
            {assetClass === null ? (
              <Select value={null} placeholder="Escolha o tipo primeiro" options={[]} onChange={() => {}} />
            ) : availableAssets.length === 0 ? (
              <Select value={null} placeholder="Nenhum ativo cadastrado nesta classe" options={[]} onChange={() => {}} />
            ) : (
              <Select
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
            <label className="field__label">Data da transação</label>
            <TextInput value={tradedOn} onChange={setTradedOn} type="date" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 130 }}>
            <label className="field__label">Quantidade</label>
            <TextInput value={quantity} onChange={setQuantity} numeral />
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Preço (R$)</label>
            <TextInput value={price} onChange={setPrice} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Outros custos (Opcional)</label>
            <TextInput value={fees} onChange={setFees} placeholder="0,00" numeral />
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

  const remove = useMutation({
    mutationFn: () => api.del<{ removed: number }>(`/investments/assets/${assetId}`),
    onSuccess: () => {
      toast(`${name} removido da carteira`)
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  return (
    <Button
      variant="quiet"
      size="sm"
      icon="trash"
      onClick={() => remove.mutate()}
      disabled={remove.isPending}
      title="Excluir posição"
    />
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
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <button
      type="button"
      className={`badge ${checked ? 'badge--good' : ''}`}
      style={{ cursor: 'pointer' }}
      onClick={() => toggle.mutate()}
      disabled={toggle.isPending}
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
        queryClient.invalidateQueries()
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
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10))

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
      queryClient.invalidateQueries()
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
              <label className="field__label">Nome</label>
              <TextInput value={editedName} onChange={setEditedName} placeholder="ex. Tesouro IPCA+ 2035" />
            </div>
            <div className="field">
              <label className="field__label">Código</label>
              <TextInput value={editedTicker} onChange={setEditedTicker} placeholder="opcional, ex. PETR4" />
              <span className="field__hint">
                Trocar o código muda qual ativo real esta posição representa — as cotações
                atualizadas passam a se referir ao novo código.
              </span>
            </div>
            <div className="field">
              <label className="field__label">Classe</label>
              <Select value={editedClass} options={classes} onChange={(value) => setEditedClass(value ?? assetClass)} />
            </div>
            <hr className="divider" />
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
              <div className="field" style={{ flex: 1, minWidth: 140 }}>
                <label className="field__label">Registrar cotação (opcional)</label>
                <TextInput value={price} onChange={setPrice} placeholder="0,00" numeral />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 140 }}>
                <label className="field__label">Data</label>
                <TextInput value={asOf} onChange={setAsOf} type="date" />
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
      queryClient.invalidateQueries()
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
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack">
        {classes.map((assetClass) => (
          <div key={assetClass.value} className="row row--between">
            <label className="field__label" style={{ flex: 1 }}>
              {assetClass.label}
            </label>
            <div style={{ width: 110 }}>
              <TextInput
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

function GoalModal({
  goal,
  goalPurposes,
  onClose,
}: {
  goal: Goal | null
  goalPurposes: Array<{ value: string; label: string }>
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [name, setName] = useState(goal?.name ?? '')
  const [target, setTarget] = useState(centsToInput(goal?.targetValueCents ?? null))
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '')
  const [monthly, setMonthly] = useState(centsToInput(goal?.monthlyContributionCents ?? null))
  const [expected, setExpected] = useState(bpsToInput(goal?.expectedReturnBps ?? 800))
  const [purpose, setPurpose] = useState<string | null>(goal?.purpose ?? null)

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        targetValueCents: Math.abs(parseMoneyInput(target) ?? 0),
        targetDate: targetDate || null,
        monthlyContributionCents: Math.abs(parseMoneyInput(monthly) ?? 0),
        expectedReturnBps: parsePercentInput(expected) ?? 800,
        purpose,
      }
      return goal ? api.patch(`/investments/goals/${goal.id}`, body) : api.post('/investments/goals', body)
    },
    onSuccess: () => {
      toast(goal ? 'Meta atualizada' : 'Meta criada')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const remove = useMutation({
    mutationFn: () => api.del(`/investments/goals/${goal!.id}`),
    onSuccess: () => {
      toast('Meta removida')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  return (
    <Modal
      title={goal ? `Editar ${goal.name}` : 'Nova meta de investimento'}
      onClose={onClose}
      footer={
        <>
          {goal ? (
            <Button variant="danger" icon="trash" onClick={() => remove.mutate()}>
              Remover
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" icon="check" disabled={!name.trim()} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label">Nome da meta</label>
          <TextInput value={name} onChange={setName} placeholder="ex. Reserva de oportunidade" />
        </div>
        <div className="field">
          <label className="field__label">Propósito (opcional)</label>
          <div className="row row--wrap" style={{ gap: 6 }}>
            {goalPurposes.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`btn btn--sm ${purpose === option.value ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => setPurpose(purpose === option.value ? null : option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="field__hint">
            Só organiza e identifica a meta — nunca influencia o cálculo de aporte.
          </span>
        </div>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Valor-alvo (R$)</label>
            <TextInput value={target} onChange={setTarget} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Data-alvo</label>
            <TextInput value={targetDate} onChange={setTargetDate} type="date" />
          </div>
        </div>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Aporte mensal (R$)</label>
            <TextInput value={monthly} onChange={setMonthly} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Retorno esperado a.a. (%)</label>
            <TextInput value={expected} onChange={setExpected} placeholder="8" numeral />
          </div>
        </div>
        <p className="chart__note">
          A projeção usa retorno constante: serve para dimensionar o aporte, não para prever
          mercado.
        </p>
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
 * Contribution waterfall — "não vende, direciona o aporte". Points at
 * the single most underweight class, then the single most underweight
 * SCORED asset within it, filling each in turn.
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

function ContributionPlanner() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState('')
  const [tradedOn, setTradedOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [contributingReserve, setContributingReserve] = useState<number | null>(null)
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
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao registrar', 'error'),
  })

  return (
    <div className="bento">
      <Card span={12} title="Quanto você quer aportar agora?" subtitle="O sistema nunca sugere vender, só direciona o dinheiro novo">
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 220 }}>
            <label className="field__label">Valor do aporte (R$)</label>
            <TextInput value={amount} onChange={setAmount} placeholder="1.000,00" numeral />
          </div>
          <div className="field" style={{ width: 160 }}>
            <label className="field__label">Data das compras</label>
            <TextInput value={tradedOn} onChange={setTradedOn} type="date" />
          </div>
          {plan.data && (
            <span className="muted" style={{ fontSize: 'var(--text-xs)', paddingBottom: 10 }}>
              Carteira: {money(plan.data.totalBeforeCents)} → {money(plan.data.totalAfterCents)}
            </span>
          )}
        </div>
      </Card>

      {!parsedCents || parsedCents <= 0 ? (
        <Card span={12}>
          <EmptyState
            icon="target"
            title="Informe um valor para ver a sugestão"
            body="O aporte é distribuído em cascata: primeiro para a classe mais atrasada em relação à meta, depois para o ativo com a maior nota dentro dela que ainda não atingiu seu alvo."
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
                  <span className="stat__label">Reserva de emergência: prioridade zero</span>
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
    </div>
  )
}
