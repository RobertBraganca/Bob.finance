import { useId, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  forwardBoundsFor,
  useAccounts,
  useMeta,
  useRange,
  useUserProfile,
  type Account,
  type RangeContextValue,
} from '../lib/store'
import { shiftPeriod, singleMonthOf, todayIso } from '../lib/period'
import { AccountModal, BalanceCheckModal } from './Settings'
import {
  bps,
  centsToInput,
  money,
  parseMoneyInput,
  period as fmtPeriod,
  periodLong as fmtPeriodLong,
  date as fmtDate,
  points,
  signedBps,
} from '../lib/format'
import {
  Assumptions,
  Bento,
  Button,
  Card,
  CategorySelect,
  ConfirmDeleteModal,
  Delta,
  EmptyState,
  Icon,
  Modal,
  PendingEditScopeModal,
  PendingScopeModal,
  PageSkeleton,
  Segmented,
  Select,
  Slab,
  SkeletonBlock,
  StatTile,
  TextInput,
  useToast,
  type AssumptionBag,
  type MeterState,
  type PendingDeleteScope,
} from '../components/ui'
import { PageHeader, RangeFilter } from '../components/shell/Shell'
import { IncomeExpenseChart } from '../components/charts/IncomeExpenseChart'
import { TransactionForm, type TransactionFormValue } from '../components/forms/TransactionForm'
import { CategoryRing, type Slice } from '../components/charts/CategoryRing'
import { NetFlowChart } from '../components/charts/NetFlowChart'
import { type FlowEdge } from '../components/charts/AccountFlowSankey'
import { CARD_USAGE_BANDS, DebtServiceGauge } from '../components/charts/DebtCharts'
import { SpendingPaceChart, type SpendingPacePoint } from '../components/charts/SpendingPaceChart'
import { AnnualPaceChart, type AnnualPacePoint } from '../components/charts/AnnualPaceChart'
import { SpendingHeatmap } from '../components/charts/SpendingHeatmap'
import { AnnualSpendingHeatmap } from '../components/charts/AnnualSpendingHeatmap'

type DashboardResponse = {
  range: { from: string; to: string }
  totals: {
    incomeCents: number
    expenseCents: number
    netCents: number
    investedCents: number
    investedGrossCents: number
    redeemedCents: number
    transferCents: number
    savingsRateBps: number
    transactionCount: number
    uncategorizedCount: number
    /** receita pendente (ainda não confirmada) com vencimento dentro do período — "a receber" */
    receivableCents: number
  }
  deltas: {
    incomeBps: number | null
    expenseBps: number | null
    netBps: number | null
    receivableBps: number | null
  }
  monthly: Array<{ period: string; incomeCents: number; expenseCents: number; netCents: number; investedCents: number }>
  daily: Array<{ period: string; incomeCents: number; expenseCents: number; netCents: number; investedCents: number }>
  byCategory: Slice[]
  byCategoryLeaf: Slice[]
  incomeByCategory: Slice[]
  incomeByCategoryLeaf: Slice[]
  netFlow: Array<{ period: string; netCents: number; cumulativeCents: number }>
  topMerchants: Array<{ signature: string; amount: number; count: number }>
}

type FlowResponse = {
  edges: FlowEdge[]
  totals: { internalCents: number; internalCount: number; looseCents: number; looseCount: number; pairedBps: number }
}

type PendingRow = {
  id: number
  accountId: number
  accountName: string
  postedOn: string
  description: string
  amountCents: number
  direction: string
  categoryId: number | null
  categoryName: string | null
  forecastId: number | null
  debtId: number | null
  installmentLabel: string | null
  isOverdue: boolean
  manuallyEdited: boolean
}

/** decisions/0024: a forecast whose next occurrence is beyond the
 * materialization horizon has no row in `PendingRow` at all yet — this is
 * what `Ver lançamentos` shows for it instead, so "salvei mas não aparece
 * em lugar nenhum" has an actual answer besides a toast that already
 * scrolled away. */
type ForecastEntry = {
  id: number
  description: string
  amountCents: number
  active: boolean
  nextOccurrencePeriod: string | null
}

type ReconciliationCandidate = {
  pending: PendingRow
  match: { id: number; postedOn: string; description: string; amountCents: number }
}

type CardRow = {
  id: number
  name: string
  institution: string | null
  accountName: string | null
  creditLimitCents: number
  availableLimitCents: number
  usedBps: number
  nextClosingOn: string
  nextDueOn: string
}

/** Formato do skeleton do primeiro carregamento — espelha a forma fixa da
 * tela real (saudação, duas linhas de dois cards, lista de pendências),
 * não uma grade de retângulos iguais. */
const DASHBOARD_SKELETON_CARDS: Array<{ span: 6 | 12; variant: 'lines' | 'stats' | 'block'; height?: number }> = [
  { span: 12, variant: 'stats', height: 120 },
  { span: 6, variant: 'block', height: 320 },
  { span: 6, variant: 'block', height: 320 },
  { span: 6, variant: 'block', height: 150 },
  { span: 6, variant: 'block', height: 150 },
  { span: 12, variant: 'lines', height: 180 },
]

export function Dashboard() {
  // O Painel é sempre a visão consolidada: a barra dele não tem filtro de
  // conta (30/09/2026), então um filtro escolhido em outra tela não pode
  // continuar valendo aqui sem nada na tela que o mostre.
  const range = { ...useRange(), accountId: null }
  const navigate = useNavigate()
  const meta = useMeta()
  const profile = useUserProfile()
  const accountsQuery = useAccounts()
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [balanceCheckAccount, setBalanceCheckAccount] = useState<Account | null>(null)
  // Revisão de UX de 26/09/2026 (Direção A do estudo de densidade): o Bento
  // arrastável/redimensionável saiu desta tela -- layout fixo, e só este
  // acordeão único controla o que fica sempre visível vs. atrás de um clique.
  const [showMore, setShowMore] = useState(false)

  const dashboard = useQuery({
    queryKey: ['dashboard', range.from, range.to, range.accountId, range.preset],
    queryFn: () =>
      api.get<DashboardResponse>('/dashboard', {
        from: range.from,
        to: range.to,
        accountId: range.accountId,
        // decisions/0030: "Período máximo" é a única leitura de "A receber"
        // que deveria olhar pra frente, sem limite — os outros presets
        // continuam restritos ao próprio período, como sempre.
        futureReceivables: range.preset === 'max' ? 1 : undefined,
      }),
    enabled: range.ready,
    // Hold the previous render while refetching — no skeleton flash.
    placeholderData: (previous) => previous,
  })

  // A flow diagram IS the cross-account picture, so it ignores the account
  // filter — scoping it to one account would leave nothing to draw.
  const flows = useQuery({
    queryKey: ['flows', range.from, range.to],
    queryFn: () => api.get<FlowResponse>('/analytics/flows', { from: range.from, to: range.to }),
    enabled: range.ready,
    placeholderData: (previous) => previous,
  })

  // Cards ignore the date range too — limit/cycle is a "right now" fact,
  // not something a past period would change.
  const cards = useQuery({
    queryKey: ['credit-cards'],
    queryFn: () => api.get<{ cards: CardRow[] }>('/credit-cards'),
  })

  if (meta.isSuccess && !meta.data.hasData) return <FirstRun />
  if (!dashboard.data) {
    return (
      <>
        <PageHeader title={`${greetingWord(profile.data?.profile.displayName)}!`} filters={<RangeFilter hideAccountFilter />} />
        <div className="page">
          <PageSkeleton cards={DASHBOARD_SKELETON_CARDS} />
        </div>
      </>
    )
  }

  const {
    totals,
    deltas,
    monthly,
    daily,
    byCategory,
    byCategoryLeaf,
    incomeByCategory,
    incomeByCategoryLeaf,
    netFlow,
    topMerchants,
  } = dashboard.data
  const balance = (meta.data?.accounts ?? []).reduce((sum, account) => sum + account.balanceCents, 0)
  // One bar per day beats one bar for the whole month — but only makes
  // sense once the selection actually IS a single month.
  // O backend (dailySeries, services/analytics.ts) só preenche `daily`
  // quando o intervalo cabe em 31 dias — não há necessidade de checar o
  // preset aqui: qualquer período curto (o atalho "mês atual" ou um mês
  // específico escolhido na grade do seletor) ativa a granularidade diária.
  const useDailyBars = daily.length > 0
  const flowSeries = useDailyBars ? daily : monthly

  // Ordem fixa (revisão de UX de 26/09/2026): saudação -> ritmo do mês lado
  // a lado com o mapa de calor -> composição por TAG -> pendências
  // unificadas -> tudo o mais atrás do acordeão "Mostrar mais". `balance`
  // (saldo somado das contas) e as StatTiles de Entradas/Saídas/A receber
  // saíram daqui: o primeiro número já está narrado na saudação, o segundo
  // é redundante com ela, e "A receber" já aparece na lista de pendências.

  // Com uma conta filtrada, o saldo mostrado é o DELA — somar todas as
  // contas ao lado de receitas/despesas de uma conta só misturaria escopos.
  // Conta de investimento fica fora: o que ela guarda é carteira, não saldo
  // disponível (revisão beta de 30/09/2026), e a carteira já tem tela própria.
  const scopedAccounts = (meta.data?.accounts ?? []).filter(
    (account) => account.kind !== 'investment' && (range.accountId == null || account.id === range.accountId),
  )
  const scopedBalance = scopedAccounts.reduce((sum, account) => sum + account.balanceCents, 0)

  return (
    <>
      <PageHeader
        title={`${greetingWord(profile.data?.profile.displayName)}!`}
        subtitle="O que está acontecendo no período"
        filters={<RangeFilter hideAccountFilter />}
      />

      {/* Enquanto o período novo carrega, os números ainda são do anterior:
          esmaecidos para quem vê e `aria-busy` para quem usa leitor de tela. */}
      <div
        className="page stack stack--loose"
        aria-busy={dashboard.isFetching || undefined}
        style={{ opacity: dashboard.isFetching ? 0.72 : 1, transition: 'opacity 120ms' }}
      >
        {/* Revisão de 30/09/2026: a saudação em prosa (receita, meta, gasto,
            teto, resultado, destinos e radar num só parágrafo) virou quatro
            números lado a lado. Os destinos foram para "Mostrar mais" e o
            radar já vive no sino de notificações. */}
        <PeriodKpis range={range} totals={totals} deltas={deltas} balanceCents={scopedBalance} accounts={scopedAccounts.length} />

        <PjTransferNote range={range} />

        <Bento>
          <SpendingHeatmapCard span={6} range={range} />
          <TagsCard
            span={6}
            expense={{ slices: byCategory, leaf: byCategoryLeaf }}
            income={{ slices: incomeByCategory, leaf: incomeByCategoryLeaf }}
            uncategorizedCount={totals.uncategorizedCount}
            onSliceClick={(categoryId) => navigate(`/lancamentos?parentCategoryId=${categoryId}`)}
          />
        </Bento>

        <Bento>
          <SpendingPaceCard span={6} range={range} />
          <HistoryCard span={6} range={range} />
        </Bento>

        <Card title="Pendências e sugestões">
          <Bento>
            <div className="col-6">
              <ReconciliationSection />
            </div>
            <div className="col-6">
              <SubscriptionsSection />
            </div>
            <div className="col-6">
              <PendingSection flow="income" title="Receitas pendentes" />
            </div>
            <div className="col-6">
              <PendingSection flow="expense" title="Despesas pendentes" />
            </div>
          </Bento>
        </Card>

        <button
          type="button"
          className="btn btn--ghost"
          style={{ width: '100%', justifyContent: 'center', gap: 'var(--sp-2)' }}
          aria-expanded={showMore}
          onClick={() => setShowMore((v) => !v)}
        >
          {showMore ? 'Mostrar menos' : 'Mostrar mais'}
          <span
            style={{
              display: 'inline-flex',
              transition: 'transform 150ms',
              transform: showMore ? 'rotate(180deg)' : undefined,
            }}
          >
            <Icon name="chevronDown" size={13} />
          </span>
        </button>

        {showMore && (
          <div className="stack stack--loose">
            <DestinationsCard range={range} />

            <Bento>
              <Card
                span={6}
                title="Contas"
                subtitle="Saldo derivado dos lançamentos, nunca armazenado"
                actions={
                  <Link to="/ajustes" className="btn btn--ghost btn--sm">
                    Gerenciar
                  </Link>
                }
              >
                <div className="kv">
                  {(meta.data?.accounts ?? []).map((account) => (
                    <span key={account.id} style={{ display: 'contents' }}>
                      <span className="kv__k truncate">
                        {account.name}
                        <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                          {' '}
                          · {account.institution}
                        </span>
                      </span>
                      <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <span className={`kv__v ${account.balanceCents < 0 ? 'neg' : ''}`}>
                          {money(account.balanceCents)}
                        </span>
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="scale"
                          title="Conferir saldo"
                          onClick={() => {
                            const full = accountsQuery.data?.accounts.find((a) => a.id === account.id)
                            if (full) setBalanceCheckAccount(full)
                          }}
                        />
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="pencil"
                          title="Editar conta"
                          onClick={() => {
                            const full = accountsQuery.data?.accounts.find((a) => a.id === account.id)
                            if (full) setEditingAccount(full)
                          }}
                        />
                      </span>
                    </span>
                  ))}
                </div>
              </Card>
              <CreditCardsSlab span={6} cards={cards.data?.cards ?? []} isError={cards.isError} />
            </Bento>

            <Bento>
              <Card span={6} title="Resultado acumulado" subtitle="Quanto sobrou, somado mês a mês">
                <NetFlowChart data={netFlow} surface="paper" height={200} />
              </Card>
              <Card span={6} title="Onde o dinheiro mais foi" subtitle="Maiores saídas do período">
                {dashboard.isError ? (
                  <EmptyState
                    icon="alert"
                    title="Falha ao carregar"
                    body="Não foi possível carregar as maiores saídas agora. Tente novamente em instantes."
                  />
                ) : topMerchants.length === 0 ? (
                  <EmptyState icon="search" title="Nada a listar" body="Sem saídas registradas no período." />
                ) : (
                  <ul className="ranked">
                    {topMerchants.map((merchant) => (
                      <li
                        key={merchant.signature}
                        className="ranked__item"
                        style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}
                      >
                        <span className="truncate">{merchant.signature}</span>
                        <span className="ranked__share">{merchant.count}x</span>
                        <span className="ranked__value">{money(merchant.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </Bento>

            <Card
              title="Entradas e saídas no período"
              subtitle={useDailyBars ? 'Dia a dia no período selecionado' : 'Mês a mês no período selecionado'}
            >
              <IncomeExpenseChart
                data={flowSeries}
                surface="paper"
                height={280}
                granularity={useDailyBars ? 'day' : 'month'}
              />
            </Card>

            <AccountFlowSimple edges={flows.data?.edges} totals={flows.data?.totals} isLoading={!flows.data} />
          </div>
        )}
      </div>

      {editingAccount && <AccountModal account={editingAccount} onClose={() => setEditingAccount(null)} />}
      {balanceCheckAccount && (
        <BalanceCheckModal account={balanceCheckAccount} onClose={() => setBalanceCheckAccount(null)} />
      )}
    </>
  )
}

/* ================================================================== *
 * Números do período
 *
 * Composição pura: nenhum endpoint novo. Os quatro valores vêm do mesmo
 * `/dashboard` que o resto da tela já usa; meta e teto (quando o período é
 * um mês só) vêm de `/goals/{período}`, a mesma fonte de Metas do mês.
 * ================================================================== */
/** Só o que a tela lê de cada resposta, para não duplicar os tipos inteiros. */
type PeriodProgressLite = {
  goal: { incomeTargetCents: number | null; spendCapCents: number | null }
  actual: { incomeCents: number; expenseCents: number }
  // `state` já vem calculado por specs/monthly-goals (targetState/capState)
  // — reusado aqui, nunca recalculado com um limite novo.
  progress: { income: { state: MeterState }; spend: { state: MeterState } }
}

type AvailableLite = {
  destinations: Array<{ key: string; targetCents: number | null; realizedCents: number; state: MeterState }>
}

function greetingWord(displayName: string | null | undefined): string {
  const hour = new Date().getHours()
  const word = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'
  return displayName ? `${word}, ${displayName}` : word
}

function KpiTile({
  label,
  value,
  tone,
  accent,
  delta,
  deltaInvert,
  foot,
  assumptions,
}: {
  label: string
  value: string
  tone?: 'up' | 'down'
  /** O único card de destaque da tela (regra de 01/09/2026: exatamente um por tela). */
  accent?: boolean
  delta?: number | null
  deltaInvert?: boolean
  foot?: ReactNode
  assumptions: AssumptionBag
}) {
  const body = (
    <>
      <div className="card__title-row">
        <span className="stat__label">{label}</span>
        <Assumptions data={assumptions} compact />
      </div>
      <span className={`stat__value kpi__value${tone ? ` kpi__value--${tone}` : ''}`}>{value}</span>
      {(delta !== undefined || foot) && (
        <span className="stat__foot">
          {delta !== undefined && <Delta bps={delta} label="vs. período anterior" invert={deltaInvert} />}
          {foot}
        </span>
      )}
    </>
  )
  return accent ? <Slab accent className="kpi">{body}</Slab> : <section className="card kpi">{body}</section>
}

function PeriodKpis({
  range,
  totals,
  deltas,
  balanceCents,
  accounts,
}: {
  range: RangeSubset
  totals: DashboardResponse['totals']
  deltas: DashboardResponse['deltas']
  balanceCents: number
  accounts: number
}) {
  // Meta e teto só existem por mês — num intervalo de vários meses eles não
  // têm um número único para comparar, então simplesmente não aparecem.
  const month = singleMonthOf(range)
  const goals = useQuery({
    queryKey: ['month-mode-goals', month, range.accountId],
    queryFn: () => api.get<PeriodProgressLite>(`/goals/${month}`, { accountId: range.accountId ?? undefined }),
    enabled: month !== null,
  })
  const incomeTarget = month ? goals.data?.goal.incomeTargetCents ?? null : null
  const spendCap = month ? goals.data?.goal.spendCapCents ?? null : null
  const scope = range.accountId == null ? 'todas as contas' : 'a conta filtrada'

  return (
    <div className="kpi-row">
      <KpiTile
        accent
        label="Resultado do período"
        value={money(totals.netCents)}
        delta={deltas.netBps}
        foot={<span>{totals.transactionCount.toLocaleString('pt-BR')} lançamentos confirmados</span>}
        assumptions={{
          formula: 'Receitas menos despesas confirmadas no período. Investimentos e transferências entre contas não entram.',
          receitaDoPeriodoCents: totals.incomeCents,
          gastoCents: totals.expenseCents,
          escopo: scope,
        }}
      />
      <KpiTile
        label="Receitas"
        value={money(totals.incomeCents)}
        tone="up"
        delta={deltas.incomeBps}
        foot={incomeTarget != null ? <span>meta {money(incomeTarget)}</span> : undefined}
        assumptions={{
          formula: 'Soma dos lançamentos confirmados com TAG de receita no período.',
          ...(incomeTarget != null ? { metaCents: incomeTarget } : {}),
          escopo: scope,
        }}
      />
      <KpiTile
        label="Despesas"
        value={money(totals.expenseCents)}
        tone="down"
        delta={deltas.expenseBps}
        deltaInvert
        foot={
          spendCap != null ? (
            <span className={totals.expenseCents > spendCap ? 'neg' : undefined}>teto {money(spendCap)}</span>
          ) : undefined
        }
        assumptions={{
          formula: 'Soma dos lançamentos confirmados com TAG de despesa no período. Pagamento de fatura e transferências não contam em dobro.',
          ...(spendCap != null ? { tetoCents: spendCap } : {}),
          escopo: scope,
        }}
      />
      <KpiTile
        label="Saldo em conta"
        value={money(balanceCents)}
        foot={
          <>
            <span>hoje, {accounts === 1 ? '1 conta' : `${accounts} contas`}</span>
            {/* Saldo negativo numa conta corrente quase sempre é saldo inicial
                ou lançamento faltando, não dívida: o atalho leva a conferir. */}
            {balanceCents < 0 && (
              <Link to="/ajustes" className="neg">
                negativo, conferir saldos
              </Link>
            )}
          </>
        }
        assumptions={{
          formula:
            'Saldo atual derivado dos lançamentos de cada conta corrente, a partir do saldo inicial cadastrado. Contas de investimento ficam de fora. É um retrato de hoje, não do fim do período.',
          saldoConsolidadoCents: balanceCents,
          contasSomadas: accounts,
        }}
      />
    </div>
  )
}

/**
 * Um card só para a quebra por TAG, com Despesas/Receitas num alternador —
 * antes eram dois anéis lado a lado mais uma faixa solta avisando dos
 * lançamentos sem TAG (revisão de 30/09/2026). O aviso virou o link do rodapé.
 */
function TagsCard({
  span,
  expense,
  income,
  uncategorizedCount,
  onSliceClick,
}: {
  span?: 6 | 12
  expense: { slices: Slice[]; leaf: Slice[] }
  income: { slices: Slice[]; leaf: Slice[] }
  uncategorizedCount: number
  onSliceClick: (categoryId: number) => void
}) {
  const [flow, setFlow] = useState<'expense' | 'income'>('expense')
  const data = flow === 'expense' ? expense : income

  return (
    <Card
      span={span}
      title="Por tag"
      subtitle="Agrupado por TAG-mãe"
      actions={
        <Segmented
          ariaLabel="Fluxo da quebra por TAG"
          value={flow}
          options={[
            { value: 'expense', label: 'Despesas' },
            { value: 'income', label: 'Receitas' },
          ]}
          onChange={setFlow}
        />
      }
    >
      <CategoryRing
        key={flow}
        slices={data.slices}
        childSlices={data.leaf}
        surface="paper"
        totalLabel={flow === 'expense' ? 'Total de saídas' : 'Total de entradas'}
        height={200}
        paddingAngle={5}
        cornerRadius={6}
        onSliceClick={onSliceClick}
      />
      <div className="row row--wrap" style={{ gap: 'var(--sp-2) var(--sp-4)', marginTop: 'auto' }}>
        <Link to="/categorias" className="btn btn--quiet btn--sm">
          Ver todas as TAGs
        </Link>
        {uncategorizedCount > 0 && (
          <Link to="/lancamentos?uncategorized=1" className="btn btn--quiet btn--sm">
            <Icon name="tags" size={13} />
            Dar TAG a {uncategorizedCount.toLocaleString('pt-BR')} sem TAG
          </Link>
        )}
      </div>
    </Card>
  )
}

type HistoryWindow = '3' | '6' | '12'

/**
 * Entradas contra saídas mês a mês, olhando para trás a partir do fim do
 * período escolhido no filtro do topo. O alternador escolhe só o tamanho da
 * janela; o ponto final e a conta continuam vindo do filtro único da página.
 */
function HistoryCard({ span, range }: { span?: 6 | 12; range: RangeSubset }) {
  const [months, setMonths] = useState<HistoryWindow>('6')
  const endPeriod = range.to.slice(0, 7)
  const from = `${shiftPeriod(endPeriod, -(Number(months) - 1))}-01`

  const history = useQuery({
    queryKey: ['history-monthly', from, range.to, range.accountId],
    queryFn: () =>
      api.get<{ series: Array<{ period: string; incomeCents: number; expenseCents: number; netCents: number }> }>(
        '/analytics/monthly',
        { from, to: range.to, accountId: range.accountId ?? undefined },
      ),
    placeholderData: (previous) => previous,
  })

  return (
    <Card
      span={span}
      title="Histórico financeiro"
      subtitle={`Entradas e saídas mês a mês, até ${fmtPeriodLong(endPeriod)}`}
      actions={
        <Segmented
          ariaLabel="Janela do histórico"
          value={months}
          options={[
            { value: '3', label: '3M' },
            { value: '6', label: '6M' },
            { value: '12', label: '1A' },
          ]}
          onChange={setMonths}
        />
      }
    >
      {from > todayIso() ? (
        <EmptyState
          icon="calendar"
          title="Este período ainda não começou"
          body="O histórico mostra o que já aconteceu. Escolha um mês até hoje no seletor do topo."
        />
      ) : history.isError ? (
        <EmptyState
          icon="alert"
          title="Falha ao carregar"
          body="Não foi possível carregar o histórico agora. Tente novamente em instantes."
        />
      ) : !history.data ? (
        <SkeletonBlock height={260} />
      ) : (
        <IncomeExpenseChart data={history.data.series} surface="paper" height={260} granularity="month" />
      )}
    </Card>
  )
}

type Destination = { targetCents: number | null; realizedCents: number; state: MeterState }
const NO_TARGET_DESTINATION: Destination = { targetCents: null, realizedCents: 0, state: 'no_target' }
const DESTINATION_LABEL: Record<'investment' | 'debt' | 'reserve', string> = {
  investment: 'Investimento',
  debt: 'Dívida',
  reserve: 'Reserva',
}

/**
 * Investimento, dívida e reserva: realizado contra o planejado no Motor
 * financeiro. Saiu da saudação (30/09/2026) para cá, atrás de "Mostrar mais".
 */
function DestinationsCard({ range }: { range: RangeSubset }) {
  const isYear = range.preset === 'max'
  const period = range.to.slice(0, 7)
  const year = range.anchor.slice(0, 4)

  const monthAvailable = useQuery({
    queryKey: ['month-mode-available', period],
    queryFn: () => api.get<AvailableLite>('/financial-engine/available', { period }),
    enabled: !isYear,
  })
  const yearAvailable = useQuery({
    queryKey: ['year-mode-available', year],
    queryFn: () => api.get<YearDestinationsLite>('/financial-engine/available-year', { year }),
    enabled: isYear,
  })

  const isError = isYear ? yearAvailable.isError : monthAvailable.isError
  const isLoading = isYear ? !yearAvailable.data : !monthAvailable.data

  const destino = (key: 'investment' | 'debt' | 'reserve'): Destination => {
    if (isYear) return yearAvailable.data?.[key] ?? NO_TARGET_DESTINATION
    return monthAvailable.data?.destinations.find((d) => d.key === key) ?? NO_TARGET_DESTINATION
  }

  return (
    <Card
      title="Destino do dinheiro"
      subtitle={`Realizado / planejado no Motor financeiro, ${isYear ? year : fmtPeriodLong(period)}`}
      actions={
        <Link to="/saude" className="btn btn--ghost btn--sm">
          Ajustar
        </Link>
      }
    >
      {isError ? (
        <EmptyState
          icon="alert"
          title="Falha ao carregar"
          body="Não foi possível carregar os destinos agora. Tente novamente em instantes."
        />
      ) : isLoading ? (
        <SkeletonBlock height={56} />
      ) : (
        <div className="kpi-row kpi-row--3">
          {(['investment', 'debt', 'reserve'] as const).map((key) => {
            const d = destino(key)
            return (
              <div key={key} className="stack stack--tight" style={{ minWidth: 0 }}>
                <span className="stat__label">{DESTINATION_LABEL[key]}</span>
                <span className="tabular" style={{ fontWeight: 600 }}>
                  {money(d.realizedCents)}
                  {d.targetCents != null && <span className="muted" style={{ fontWeight: 400 }}> / {money(d.targetCents)}</span>}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

type FinancialEngineSettingsLite = { pjAccountId: number | null; pfAccountId: number | null }

/**
 * Pedido de 26/09/2026: uma frase no Painel sobre quanto da conta PJ foi
 * repassado para a PF, mesmo cálculo que a DRE já mostra (Dre.tsx,
 * `ReconciliationSlab`, "repasse em % da receita"). Só aparece quando as
 * duas contas estão configuradas no Motor financeiro E houve de fato um
 * repasse PJ→PF no período — sem isso, "0%" não diria nada de útil.
 */
function PjTransferNote({ range }: { range: RangeSubset }) {
  const engineSettings = useQuery({
    queryKey: ['financial-engine-settings'],
    queryFn: () => api.get<{ settings: FinancialEngineSettingsLite }>('/financial-engine/settings'),
  })
  const pjAccountId = engineSettings.data?.settings.pjAccountId ?? null
  const pfAccountId = engineSettings.data?.settings.pfAccountId ?? null

  const pjTotals = useQuery({
    queryKey: ['dashboard', range.from, range.to, pjAccountId],
    queryFn: () =>
      api.get<{ totals: { incomeCents: number } }>('/dashboard', {
        from: range.from,
        to: range.to,
        accountId: pjAccountId ?? undefined,
      }),
    enabled: pjAccountId != null,
  })
  // Mesma queryKey de `flows` na Dashboard() e no Dre.tsx — o React Query
  // serve do cache já buscado por eles, nunca uma requisição extra.
  const flows = useQuery({
    queryKey: ['flows', range.from, range.to],
    queryFn: () => api.get<{ edges: FlowEdge[] }>('/analytics/flows', { from: range.from, to: range.to }),
  })

  if (!pjAccountId || !pfAccountId) return null
  if (!pjTotals.data || !flows.data) return null

  const pjToPfCents = flows.data.edges.find((e) => e.fromAccountId === pjAccountId && e.toAccountId === pfAccountId)?.amountCents ?? 0
  const pjIncomeCents = pjTotals.data.totals.incomeCents
  if (pjIncomeCents <= 0 || pjToPfCents <= 0) return null

  const shareBps = Math.round((pjToPfCents / pjIncomeCents) * 10_000)

  return (
    <Card muted>
      <div className="row" style={{ gap: 'var(--sp-2)' }}>
        <Icon name="info" size={16} />
        <span>
          Sua conta PJ transferiu <strong className="tabular">{bps(shareBps)}</strong> da receita do período (
          {money(pjToPfCents)}) para a conta PF.
        </span>
      </div>
    </Card>
  )
}

type YearProgressLite = {
  goal: { incomeTargetCents: number | null; spendCapCents: number | null }
  actual: { incomeCents: number; expenseCents: number }
  progress: { income: { state: MeterState }; spend: { state: MeterState } }
}

type YearDestinationsLite = {
  investment: { targetCents: number; realizedCents: number; state: MeterState }
  debt: { targetCents: number; realizedCents: number; state: MeterState }
  reserve: { targetCents: number; realizedCents: number; state: MeterState }
}

type RangeSubset = Pick<RangeContextValue, 'preset' | 'from' | 'to' | 'anchor' | 'accountId'>

/**
 * Item 7 do backlog de 07/09/2026 ("a Home falta um gráfico de abertura").
 *
 * Um único mês em foco (`singleMonthOf`) dá o gráfico original: dia a dia,
 * mês corrente contra anterior. Qualquer outra seleção (3m/6m/12m/ano/
 * máximo, ou um intervalo personalizado que não é um mês inteiro) não tem
 * um "mês corrente" pra desenhar — vira o mesmo gráfico um grau mais
 * grosso, ano corrente contra anterior, mês a mês (generalização de
 * 07/09/2026: antes este card ignorava o seletor de período do topo por
 * completo e sempre mostrava o mês corrente, não importava o que
 * estivesse selecionado ali).
 */
function SpendingPaceCard({ span, range }: { span?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12; range: RangeSubset }) {
  const singleMonth = singleMonthOf(range)
  return singleMonth ? (
    <MonthlyPaceCard span={span} period={singleMonth} anchor={range.anchor} accountId={range.accountId} />
  ) : (
    <AnnualPaceCard span={span} anchor={range.anchor} accountId={range.accountId} />
  )
}

function MonthlyPaceCard({
  span,
  period,
  anchor,
  accountId,
}: {
  span?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12
  period: string
  anchor: string
  accountId: number | null
}) {
  const previousPeriod = shiftPeriod(period, -1)
  const isCurrentMonth = period === anchor.slice(0, 7)
  const cutoffDay = isCurrentMonth ? Number(anchor.slice(8, 10)) : daysInMonthOf(period)

  const current = useQuery({
    queryKey: ['daily-series', period, accountId],
    queryFn: () => api.get<{ days: Array<{ day: string; expenseCents: number }> }>('/analytics/daily', { period, accountId: accountId ?? undefined }),
  })
  const previous = useQuery({
    queryKey: ['daily-series', previousPeriod, accountId],
    queryFn: () => api.get<{ days: Array<{ day: string; expenseCents: number }> }>('/analytics/daily', { period: previousPeriod, accountId: accountId ?? undefined }),
  })

  const points: SpendingPacePoint[] = []
  let currentDeltaBps: number | null = null
  let currentDeltaCents: number | null = null

  if (current.data && previous.data) {
    const maxDays = Math.max(current.data.days.length, previous.data.days.length)
    let runningCurrent = 0
    let runningPrevious = 0
    for (let i = 0; i < maxDays; i++) {
      const dayOfMonth = i + 1
      const currentDay = current.data.days[i]
      const previousDay = previous.data.days[i]
      const isFuture = dayOfMonth > cutoffDay
      if (currentDay && !isFuture) runningCurrent += currentDay.expenseCents
      if (previousDay) runningPrevious += previousDay.expenseCents
      points.push({
        dayOfMonth,
        currentCents: currentDay && !isFuture ? runningCurrent : null,
        previousCents: previousDay ? runningPrevious : null,
      })
      if (dayOfMonth === cutoffDay) {
        currentDeltaCents = runningCurrent - runningPrevious
        currentDeltaBps = runningPrevious > 0 ? Math.round((currentDeltaCents / runningPrevious) * 10_000) : null
      }
    }
  }

  return (
    <Card
      span={span}
      title="Ritmo de gastos"
      subtitle="Gasto acumulado do mês, dia a dia, contra o mesmo ponto do mês passado"
      actions={
        currentDeltaCents !== null ? (
          <div className="stack" style={{ gap: 0, alignItems: 'flex-end' }}>
            <span className="tabular" style={{ fontSize: 'var(--text-sm)' }}>
              {currentDeltaCents >= 0 ? '+' : ''}
              {money(currentDeltaCents)}
              <span className="muted"> {currentDeltaCents >= 0 ? 'acima' : 'abaixo'}</span>
            </span>
            <Delta bps={currentDeltaBps} label="vs mês passado" invert />
          </div>
        ) : undefined
      }
    >
      {!current.data || !previous.data ? (
        <SkeletonBlock height={220} />
      ) : (
        <SpendingPaceChart points={points} surface="paper" />
      )}
    </Card>
  )
}

/**
 * Correção de 07/09/2026 (mesmo dia da primeira versão): "mês a mês contra
 * o ano passado" não é um acumulado subindo o ano inteiro (isso confundia
 * "ritmo" com "resultado do ano") — é cada mês comparado ao MESMO mês do
 * ano anterior, lado a lado. O card ainda resume "quanto já gastei este
 * ano contra o mesmo trecho do ano passado" no canto (útil pra manter),
 * mas o gráfico em si virou duas colunas por mês, não uma linha corrida.
 */
function AnnualPaceCard({
  span,
  anchor,
  accountId,
}: {
  span?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12
  anchor: string
  accountId: number | null
}) {
  const currentYear = Number(anchor.slice(0, 4))
  const previousYear = currentYear - 1
  const cutoffMonth = Number(anchor.slice(5, 7))

  const current = useQuery({
    queryKey: ['monthly-series', currentYear, accountId],
    queryFn: () =>
      api.get<{ series: Array<{ period: string; expenseCents: number }> }>('/analytics/monthly', {
        from: `${currentYear}-01-01`,
        to: `${currentYear}-12-31`,
        accountId: accountId ?? undefined,
      }),
  })
  const previous = useQuery({
    queryKey: ['monthly-series', previousYear, accountId],
    queryFn: () =>
      api.get<{ series: Array<{ period: string; expenseCents: number }> }>('/analytics/monthly', {
        from: `${previousYear}-01-01`,
        to: `${previousYear}-12-31`,
        accountId: accountId ?? undefined,
      }),
  })

  const points: AnnualPacePoint[] = []
  let currentDeltaBps: number | null = null
  let currentDeltaCents: number | null = null

  if (current.data && previous.data) {
    const currentByMonth = new Map(current.data.series.map((m) => [m.period.slice(5, 7), m.expenseCents]))
    const previousByMonth = new Map(previous.data.series.map((m) => [m.period.slice(5, 7), m.expenseCents]))
    // Resumo do canto: só o trecho já decorrido dos dois anos (Jan..mês
    // corrente) — comparar contra o ano passado INTEIRO inflaria o "ano
    // passado" com meses que este ano ainda nem chegou.
    let ytdCurrent = 0
    let ytdPreviousThroughCutoff = 0
    for (let monthIndex = 1; monthIndex <= 12; monthIndex++) {
      const key = String(monthIndex).padStart(2, '0')
      const isFuture = monthIndex > cutoffMonth
      const currentMonthCents = currentByMonth.get(key) ?? 0
      const previousMonthCents = previousByMonth.get(key) ?? 0
      if (!isFuture) {
        ytdCurrent += currentMonthCents
        ytdPreviousThroughCutoff += previousMonthCents
      }
      points.push({
        monthIndex,
        currentCents: isFuture ? null : currentMonthCents,
        previousCents: previousMonthCents,
      })
    }
    currentDeltaCents = ytdCurrent - ytdPreviousThroughCutoff
    currentDeltaBps = ytdPreviousThroughCutoff > 0 ? Math.round((currentDeltaCents / ytdPreviousThroughCutoff) * 10_000) : null
  }

  return (
    <Card
      span={span}
      title="Ritmo de gastos"
      subtitle="Gasto por mês, este ano contra o mesmo mês do ano passado"
      actions={
        currentDeltaCents !== null ? (
          <div className="stack" style={{ gap: 0, alignItems: 'flex-end' }}>
            <span className="tabular" style={{ fontSize: 'var(--text-sm)' }}>
              {currentDeltaCents >= 0 ? '+' : ''}
              {money(currentDeltaCents)}
              <span className="muted"> {currentDeltaCents >= 0 ? 'acima' : 'abaixo'}</span>
            </span>
            <Delta bps={currentDeltaBps} label="vs ano passado até aqui" invert />
          </div>
        ) : undefined
      }
    >
      {!current.data || !previous.data ? (
        <SkeletonBlock height={220} />
      ) : (
        <AnnualPaceChart points={points} surface="paper" />
      )}
    </Card>
  )
}

/**
 * Item 8 do backlog de 07/09/2026: mesma rota do item 7, só o mês corrente.
 * Mesma generalização de `SpendingPaceCard` (07/09/2026): sem um único mês
 * em foco, vira um mapa de calor por mês do ano em vez de por dia do mês.
 */
function SpendingHeatmapCard({ span, range }: { span?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12; range: RangeSubset }) {
  const singleMonth = singleMonthOf(range)
  return singleMonth ? (
    <MonthlyHeatmapCard span={span} period={singleMonth} accountId={range.accountId} />
  ) : (
    <AnnualHeatmapCard span={span} anchor={range.anchor} accountId={range.accountId} />
  )
}

function MonthlyHeatmapCard({
  span,
  period,
  accountId,
}: {
  span?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12
  period: string
  accountId: number | null
}) {
  const current = useQuery({
    queryKey: ['daily-series', period, accountId],
    queryFn: () => api.get<{ days: Array<{ day: string; expenseCents: number; transactionCount: number }> }>('/analytics/daily', { period, accountId: accountId ?? undefined }),
  })

  return (
    <Card span={span} title="Mapa de calor" subtitle="Gasto confirmado por dia do mês">
      {!current.data ? <SkeletonBlock height={220} /> : <SpendingHeatmap days={current.data.days} surface="paper" />}
    </Card>
  )
}

function AnnualHeatmapCard({
  span,
  anchor,
  accountId,
}: {
  span?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12
  anchor: string
  accountId: number | null
}) {
  const year = Number(anchor.slice(0, 4))
  const current = useQuery({
    queryKey: ['monthly-series', year, accountId],
    queryFn: () =>
      api.get<{ series: Array<{ period: string; expenseCents: number }> }>('/analytics/monthly', {
        from: `${year}-01-01`,
        to: `${year}-12-31`,
        accountId: accountId ?? undefined,
      }),
  })

  return (
    <Card span={span} title="Mapa de calor" subtitle="Gasto confirmado por mês do ano">
      {!current.data ? <SkeletonBlock height={220} /> : <AnnualSpendingHeatmap months={current.data.series} surface="paper" />}
    </Card>
  )
}

function daysInMonthOf(period: string): number {
  const [y, m] = period.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function CreditCardsSlab({
  cards,
  isError,
  span,
}: {
  cards: CardRow[]
  isError: boolean
  span?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12
}) {
  const [page, setPage] = useState(0)
  const pageCount = cards.length + 1
  const current = page === 0 ? null : cards[page - 1]

  const limitCents = current ? current.creditLimitCents : cards.reduce((s, c) => s + c.creditLimitCents, 0)
  const availableCents = current
    ? current.availableLimitCents
    : cards.reduce((s, c) => s + c.availableLimitCents, 0)
  const usedBps = limitCents > 0 ? Math.round(((limitCents - availableCents) / limitCents) * 10_000) : 0

  const go = (delta: number) => setPage((p) => (p + delta + pageCount) % pageCount)

  return (
    <Card
      span={span}
      title="Cartões de crédito"
      subtitle="Limite total e disponível por cartão"
      actions={
        <Link to="/cartoes" className="btn btn--ghost btn--sm">
          Gerenciar
        </Link>
      }
    >
      {isError ? (
        <EmptyState
          icon="alert"
          title="Falha ao carregar"
          body="Não foi possível carregar os cartões agora. Tente novamente em instantes."
        />
      ) : cards.length === 0 ? (
        <EmptyState
          icon="wallet"
          title="Nenhum cartão cadastrado"
          body="Cadastre limite, fechamento e vencimento na página Cartões."
        />
      ) : (
        <div className="stack">
          <div className="row row--between">
            <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
              <Button
                variant="quiet"
                size="sm"
                icon="chevronRight"
                onClick={() => go(-1)}
                title="Cartão anterior"
                disabled={pageCount <= 1}
              />
            </span>
            <span className="stat__label">{current ? current.name : `Todos os cartões (${cards.length})`}</span>
            <Button
              variant="quiet"
              size="sm"
              icon="chevronRight"
              onClick={() => go(1)}
              title="Próximo cartão"
              disabled={pageCount <= 1}
            />
          </div>

          {/* Arco em vez de barra: o limite usado é um percentual contra um
              teto, e a barra amarela de largura inteira punha cor decorativa
              no card inteiro (revisão de design de 01/09/2026, "donut/gauge
              para %"). O arco carrega a mesma cor de status num espaço
              menor, com ícone e rótulo junto. */}
          <div className="row row--between row--wrap" style={{ alignItems: 'center', gap: 'var(--sp-4)' }}>
            <div className="stack" style={{ gap: 'var(--sp-3)', minWidth: 0 }}>
              <StatTile label="Limite disponível" value={money(availableCents)} large />
              <StatTile label="Limite total" value={money(limitCents)} />
            </div>
            <DebtServiceGauge
              ratioBps={usedBps}
              surface="paper"
              bands={CARD_USAGE_BANDS}
              caption="do limite total já comprometido"
              emptyTitle="Sem limite cadastrado"
              emptyBody="Informe o limite dos cartões para acompanhar quanto já está comprometido."
            />
          </div>

          {current && (
            <div className="row row--between" style={{ fontSize: 'var(--text-xs)' }}>
              <span className="muted">
                Fechamento <strong className="tabular">{fmtDate(current.nextClosingOn)}</strong>
              </span>
              <span className="muted">
                Vencimento <strong className="tabular">{fmtDate(current.nextDueOn)}</strong>
              </span>
            </div>
          )}

          {pageCount > 1 && (
            <div className="carousel-dots">
              {Array.from({ length: pageCount }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  className="carousel-dots__dot"
                  aria-current={i === page}
                  aria-label={i === 0 ? 'Todos os cartões' : cards[i - 1]?.name}
                  onClick={() => setPage(i)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

/**
 * Substitui o diagrama Sankey por uma lista ranqueada dos mesmos dados
 * (`FlowEdge[]`) — revisão de UX de 26/09/2026 ("fluxo entre contas não
 * fica claro como o fluxo funciona exatamente"). `AccountFlowSankey` e
 * `shared/accountFlowGraph.ts` continuam existindo (têm cobertura própria
 * em `scripts/verify.ts`), só deixam de ser usados nesta tela.
 */
function AccountFlowSimple({
  edges,
  totals,
  isLoading,
}: {
  edges: FlowEdge[] | undefined
  totals: { looseCents: number; looseCount: number } | undefined
  isLoading: boolean
}) {
  return (
    <Card
      title="Fluxo entre contas"
      subtitle="Transferências entre suas próprias contas, da maior para a menor"
    >
      {isLoading ? (
        <SkeletonBlock height={160} />
      ) : !edges || edges.length === 0 ? (
        <EmptyState icon="search" title="Nada a listar" body="Sem transferências entre contas próprias no período." />
      ) : (
        <div className="stack stack--tight">
          <ul className="ranked">
            {[...edges]
              .sort((a, b) => b.amountCents - a.amountCents)
              .map((edge) => (
                <li
                  key={`${edge.fromAccountId}-${edge.toAccountId}`}
                  className="ranked__item"
                  style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}
                >
                  <span className="truncate">
                    {edge.fromName} <Icon name="arrowUpRight" size={12} strokeWidth={2.2} /> {edge.toName}
                  </span>
                  <span className="ranked__share">{edge.count}x</span>
                  <span className="ranked__value">{money(edge.amountCents)}</span>
                </li>
              ))}
          </ul>
          {totals && totals.looseCount > 0 && (
            <p className="chart__note">
              {totals.looseCount} transferência(s) sem par identificado, {money(totals.looseCents)} no total.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ *
 * Pending — a confirmed future receipt/expense the bank hasn't posted
 * yet (a freelancer's recurring retainer, an already-agreed installment
 * deal). Unified with the real ledger (same `transactions` table, same
 * Lançamentos list) rather than a side preview; every totals query
 * excludes it by default, so it can never inflate a closed period's
 * real Entradas/Saídas until reconciled against the real posted row.
 * ------------------------------------------------------------------ */
function PendingSection({ flow, title }: { flow: 'income' | 'expense'; title: string }) {
  const range = useRange()
  const [adding, setAdding] = useState(false)
  const [listing, setListing] = useState(false)

  // "Pendente" is inherently about what hasn't happened YET — but every
  // preset in the shared filter (mtd/3m/6m/12m/ytd/max) looks only
  // BACKWARD from today, so a forecast dated next month never fell
  // inside any of them and the card looked frozen no matter which one
  // was picked. Mirroring the preset into a forward-looking window
  // (see forwardBoundsFor) fixes that; a manually-picked custom range
  // is left exactly as the user set it.
  const { from, to } = range.preset === 'custom' ? range : forwardBoundsFor(range.preset, range.anchor)

  const pending = useQuery({
    queryKey: ['cash-flow-pending', flow, from, to],
    queryFn: () => api.get<{ pending: PendingRow[] }>('/cash-flow/pending', { flow, from, to }),
    enabled: range.ready,
    placeholderData: (previous) => previous,
  })
  const forecasts = useQuery({
    queryKey: ['cash-flow-forecasts'],
    queryFn: () => api.get<{ forecasts: ForecastEntry[] }>('/cash-flow/forecasts'),
  })

  const rows = pending.data?.pending ?? []
  const totalCents = rows.reduce((s, r) => s + Math.abs(r.amountCents), 0)
  const overdueCount = rows.filter((r) => r.isOverdue).length

  // decisions/0024: a forecast só some "sem aviso" quando o próprio próximo
  // vencimento ainda não materializou — se algum outro ciclo dela já está
  // pendente, ela não é "invisível", só está representada por essa linha.
  const invisibleForecasts = (forecasts.data?.forecasts ?? []).filter(
    (f) =>
      f.active &&
      f.nextOccurrencePeriod !== null &&
      (flow === 'income' ? f.amountCents > 0 : f.amountCents < 0) &&
      !rows.some((r) => r.forecastId === f.id),
  )

  const subtitle =
    range.preset === 'custom'
      ? 'No período selecionado'
      : // "Máximo" no seletor principal é todo o histórico do ledger PRA
        // TRÁS; aqui, pendência é sempre sobre o futuro, e o mesmo preset
        // vira 24 meses À FRENTE (forwardBoundsFor) — mesmo rótulo,
        // sentido oposto, confirmado como fonte real de confusão. O card
        // nunca repete a palavra "Máximo" para essa janela.
        range.preset === 'max'
        ? 'Todo o horizonte à frente'
        : `${fmtDate(from)} a ${fmtDate(to)}`

  return (
    <>
      <div className="stack stack--tight">
        <div className="row row--between row--wrap">
          <div>
            <span className="stat__label">{title}</span>
            <p className="chart__note" style={{ margin: 0 }}>{subtitle}</p>
          </div>
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            {(rows.length > 0 || invisibleForecasts.length > 0) && (
              <Button variant="ghost" size="sm" icon="list" onClick={() => setListing(true)}>
                Ver lançamentos
              </Button>
            )}
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              Novo
            </Button>
          </div>
        </div>
        <StatTile label={flow === 'income' ? 'Ainda não caiu na conta' : 'Ainda não saiu da conta'} value={money(totalCents)} large />
        {overdueCount > 0 && (
          <p className="chart__note">
            <span className="badge badge--critical">Atrasado</span> {overdueCount} de período(s) anterior(es) ainda{' '}
            {flow === 'income' ? 'não recebido(s)' : 'não pago(s)'}
          </p>
        )}
        {invisibleForecasts.length > 0 && (
          <p className="chart__note">
            <Icon name="info" size={12} /> {invisibleForecasts.length} previsão(ões) só aparecerá(ão) mais perto da
            data, confira em "Ver lançamentos"
          </p>
        )}
      </div>

      {adding && <PendingModal flow={flow} onClose={() => setAdding(false)} />}
      {listing && (
        <PendingListModal
          flow={flow}
          title={title}
          rows={rows}
          invisibleForecasts={invisibleForecasts}
          onClose={() => setListing(false)}
        />
      )}
    </>
  )
}

/** Full itemized breakdown + delete, opened on demand — the card itself shows only the total. */
function PendingListModal({
  flow,
  title,
  rows,
  invisibleForecasts,
  onClose,
}: {
  flow: 'income' | 'expense'
  title: string
  rows: PendingRow[]
  invisibleForecasts: ForecastEntry[]
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<PendingRow | null>(null)
  // Só pergunta escopo quando a linha vem de um template (forecastId) —
  // uma pendência avulsa exclui direto, sem modal extra (decisions/0020).
  const [scopeTarget, setScopeTarget] = useState<PendingRow | null>(null)
  // Mas "direto" não é mais "sem perguntar nada" (revisão de UX copy de
  // 26/09/2026): só não pergunta o ESCOPO, ainda confirma a exclusão.
  const [confirmingPending, setConfirmingPending] = useState<PendingRow | null>(null)

  const remove = useMutation({
    mutationFn: ({ id, scope }: { id: number; scope?: PendingDeleteScope }) =>
      api.del(`/cash-flow/pending/${id}`, scope ? { scope } : {}),
    onSuccess: () => {
      toast('Pendência removida')
      queryClient.invalidateQueries()
      setScopeTarget(null)
      setConfirmingPending(null)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  // decisions/0024: essas linhas não têm transação real ainda — o "remover"
  // aqui apaga a PREVISÃO inteira (endpoint de forecast, não de pendência).
  const [confirmingForecast, setConfirmingForecast] = useState<ForecastEntry | null>(null)
  const removeForecast = useMutation({
    mutationFn: (id: number) => api.del(`/cash-flow/forecasts/${id}`),
    onSuccess: () => {
      toast('Previsão removida')
      queryClient.invalidateQueries()
      setConfirmingForecast(null)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  const settle = useMutation({
    mutationFn: (id: number) => api.post(`/cash-flow/pending/${id}/settle`, {}),
    onSuccess: () => {
      toast(flow === 'income' ? 'Marcada como recebida' : 'Marcada como paga')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao confirmar', 'error'),
  })

  return (
    <Modal title={title} onClose={onClose}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Descrição</th>
              <th scope="col">Data</th>
              <th scope="col" className="table__num">Valor</th>
              <th scope="col" style={{ width: 104 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.isOverdue && (
                    <span className="badge badge--critical" style={{ marginRight: 6 }}>
                      Atrasado
                    </span>
                  )}
                  {r.description}
                  {r.installmentLabel && (
                    <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                      {' '}
                      · parcela {r.installmentLabel}
                    </span>
                  )}
                  {r.manuallyEdited && (
                    <span
                      className="muted"
                      title="Editada manualmente: não segue mais a dívida/previsão original"
                      style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle' }}
                    >
                      <Icon name="pencil" size={12} />
                    </span>
                  )}
                  <br />
                  <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>{r.accountName}</span>
                </td>
                <td className="muted">{fmtDate(r.postedOn)}</td>
                <td className={`table__num ${flow === 'income' ? 'pos' : 'neg'}`}>{money(Math.abs(r.amountCents))}</td>
                <td>
                  <div className="row" style={{ gap: 2 }}>
                    <Button
                      variant="quiet"
                      size="sm"
                      icon="check"
                      onClick={() => settle.mutate(r.id)}
                      disabled={settle.isPending}
                      title={flow === 'income' ? 'Marcar como recebido' : 'Marcar como pago'}
                    />
                    <Button
                      variant="quiet"
                      size="sm"
                      icon="pencil"
                      onClick={() => setEditing(r)}
                      title="Editar pendência"
                    />
                    <Button
                      variant="quiet"
                      size="sm"
                      icon="trash"
                      onClick={() =>
                        r.forecastId !== null || r.debtId !== null ? setScopeTarget(r) : setConfirmingPending(r)
                      }
                      disabled={remove.isPending}
                      title="Remover pendência"
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {invisibleForecasts.length > 0 && (
        <div className="stack stack--tight" style={{ marginTop: 'var(--sp-4)' }}>
          <span className="field__label">Previsões que ainda não aparecem no histórico</span>
          <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            Salvas normalmente, só ainda não viraram lançamento porque a primeira data está longe demais. Vão
            aparecer sozinhas conforme o mês se aproxima.
          </p>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {invisibleForecasts.map((f) => (
                  <tr key={f.id}>
                    <td>{f.description}</td>
                    <td className="muted">
                      primeira ocorrência: {f.nextOccurrencePeriod ? fmtPeriodLong(f.nextOccurrencePeriod) : '-'}
                    </td>
                    <td className={`table__num ${flow === 'income' ? 'pos' : 'neg'}`}>
                      {money(Math.abs(f.amountCents))}
                    </td>
                    <td>
                      <Button
                        variant="quiet"
                        size="sm"
                        icon="trash"
                        onClick={() => setConfirmingForecast(f)}
                        disabled={removeForecast.isPending}
                        title="Remover previsão"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && <EditPendingModal row={editing} flow={flow} onClose={() => setEditing(null)} />}
      {scopeTarget && (
        <PendingScopeModal
          pending={remove.isPending}
          onCancel={() => setScopeTarget(null)}
          onConfirm={(scope) => remove.mutate({ id: scopeTarget.id, scope })}
        />
      )}
      {confirmingPending && (
        <ConfirmDeleteModal
          title={`Excluir ${confirmingPending.description}?`}
          body="Isso não pode ser desfeito."
          confirmLabel="Excluir pendência"
          pending={remove.isPending}
          onCancel={() => setConfirmingPending(null)}
          onConfirm={() => remove.mutate({ id: confirmingPending.id })}
        />
      )}
      {confirmingForecast && (
        <ConfirmDeleteModal
          title={`Excluir a previsão de ${confirmingForecast.description}?`}
          body="Isso não pode ser desfeito."
          confirmLabel="Excluir previsão"
          pending={removeForecast.isPending}
          onCancel={() => setConfirmingForecast(null)}
          onConfirm={() => removeForecast.mutate(confirmingForecast.id)}
        />
      )}
    </Modal>
  )
}

/** Edits one materialized pending row directly — date, description, amount,
 * account, category — the same PATCH the confirmed-ledger edit modal uses. */
/**
 * Edits one materialized pending row — date, description, amount, account,
 * category, plus the shared "já recebido/pago" toggle (see
 * `components/forms/TransactionForm`). Checking it settles the row the same
 * way the row's own "check" button does; leaving it unchecked just edits
 * the pendência in place. The two paths call the same endpoints, this is
 * just a second way to reach "settle" without closing the editor first.
 */
function EditPendingModal({
  row,
  flow,
  onClose,
}: {
  row: PendingRow
  flow: 'income' | 'expense'
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  // decisions/0029: só pergunta escopo quando a edição de fato muda um
  // campo que o template governa (descrição/valor/conta).
  const [scopePrompt, setScopePrompt] = useState(false)

  const [value, setValue] = useState<TransactionFormValue>({
    description: row.description,
    postedOn: row.postedOn,
    direction: flow === 'income' ? 'in' : 'out',
    amount: centsToInput(Math.abs(row.amountCents)),
    accountId: row.accountId,
    categoryId: row.categoryId,
    pending: true,
  })

  const save = useMutation({
    mutationFn: async (scope?: PendingDeleteScope) => {
      const rawCents = parseMoneyInput(value.amount)
      if (rawCents === null || rawCents === 0) throw new Error('informe o valor')
      const amountCents = flow === 'income' ? Math.abs(rawCents) : -Math.abs(rawCents)
      if (value.accountId === null) throw new Error('escolha a conta')

      await api.patch(`/transactions/${row.id}`, {
        postedOn: value.postedOn,
        description: value.description.trim(),
        amountCents,
        accountId: value.accountId,
        ...(scope ? { scope } : {}),
      })
      if (value.categoryId !== row.categoryId) {
        await api.post('/transactions/categorize', { ids: [row.id], categoryId: value.categoryId, saveAsRule: false })
      }
      if (value.pending === false) {
        await api.post(`/cash-flow/pending/${row.id}/settle`, {})
      }
    },
    onSuccess: async () => {
      toast(
        value.pending === false
          ? flow === 'income'
            ? 'Marcada como recebida'
            : 'Marcada como paga'
          : 'Pendência atualizada',
      )
      // Awaited: reabrir esta pendência antes do refetch reidrataria do
      // cache pré-edição, e uma segunda edição sobrescreveria a primeira.
      await queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const requestSave = () => {
    const rawCents = parseMoneyInput(value.amount)
    const amountCents = flow === 'income' ? Math.abs(rawCents ?? 0) : -Math.abs(rawCents ?? 0)
    const changesTemplateField =
      value.description.trim() !== row.description || amountCents !== row.amountCents || value.accountId !== row.accountId
    if ((row.forecastId !== null || row.debtId !== null) && changesTemplateField) setScopePrompt(true)
    else save.mutate(undefined)
  }

  return (
    <>
      <Modal
        title="Editar pendência"
        onClose={onClose}
        footer={
          <>
            <Button variant="quiet" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" onClick={requestSave} disabled={save.isPending} loading={save.isPending}>
              Salvar
            </Button>
          </>
        }
      >
        <TransactionForm
          value={value}
          onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
          showDirection={false}
          showPending
        />
      </Modal>
      {scopePrompt && (
        <PendingEditScopeModal
          pending={save.isPending}
          onCancel={() => setScopePrompt(false)}
          onConfirm={(scope) => save.mutate(scope)}
        />
      )}
    </>
  )
}

function PendingModal({ flow, onClose }: { flow: 'income' | 'expense'; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const meta = useMeta()
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<'recurring' | 'installment' | 'single'>('recurring')
  const [amount, setAmount] = useState('')
  const [accountId, setAccountId] = useState<number | null>(null)
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [installmentCount, setInstallmentCount] = useState('3')
  const [installmentsRealized, setInstallmentsRealized] = useState('0')
  /**
   * Fim de contrato de uma recorrência: um salário é fixo e só para quando
   * o contrato encerra. O campo `end_period` existia no banco e na API
   * desde sempre e nenhum formulário mandava — então toda recorrência
   * nascia sem fim, e a única saída era apagar ocorrência por ocorrência
   * (02/09/2026). Vazio = sem fim previsto, que segue sendo o padrão.
   */
  const [endMonth, setEndMonth] = useState('')
  const descriptionFieldId = useId()
  const amountFieldId = useId()
  const paymentDateFieldId = useId()
  const accountFieldId = useId()
  const categoryFieldId = useId()
  const installmentCountFieldId = useId()
  const installmentsRealizedFieldId = useId()

  const save = useMutation({
    mutationFn: () => {
      const rawCents = parseMoneyInput(amount)
      if (rawCents === null || rawCents === 0) throw new Error('informe o valor')
      if (accountId === null) throw new Error('escolha a conta')
      const amountCents = flow === 'income' ? Math.abs(rawCents) : -Math.abs(rawCents)
      return api.post<{ nextOccurrencePeriod: string | null }>('/cash-flow/forecasts', {
        description: description.trim(),
        kind,
        amountCents,
        accountId,
        categoryId,
        startPeriod: paymentDate.slice(0, 7),
        dueDay: Number(paymentDate.slice(8, 10)),
        installmentCount: kind === 'installment' ? Math.max(1, Math.round(Number(installmentCount)) || 1) : null,
        installmentsRealized: kind === 'installment' ? Math.max(0, Math.round(Number(installmentsRealized)) || 0) : 0,
        // Só recorrência tem fim de contrato: parcelado já termina pela
        // contagem de parcelas, e pontual acontece uma vez.
        endPeriod: kind === 'recurring' && endMonth !== '' ? endMonth : null,
      })
    },
    onSuccess: (created) => {
      // The first occurrence can land beyond the 6-month materialization
      // horizon (ex. a raise starting after a 5-parcela contract ends) —
      // that used to produce zero visible feedback anywhere, which read
      // exactly like the save had failed (decisions/0020). Naming the next
      // occurrence here, even when nothing materializes yet, closes that gap.
      toast(
        created.nextOccurrencePeriod
          ? `Pendência registrada. Próxima ocorrência: ${fmtPeriodLong(created.nextOccurrencePeriod)}.`
          : 'Pendência registrada.',
      )
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title={flow === 'income' ? 'Nova receita pendente' : 'Nova despesa pendente'}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            icon="check"
            onClick={() => save.mutate()}
            disabled={!description.trim() || save.isPending}
          >
            Registrar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor={descriptionFieldId}>Descrição</label>
          <TextInput
            id={descriptionFieldId}
            value={description}
            onChange={setDescription}
            placeholder="ex. BERA, Design UI/UX E-commerce DME"
          />
        </div>

        <div className="field">
          <label className="field__label">Tipo</label>
          <Segmented
            ariaLabel="Tipo de pendência"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'recurring', label: 'Fixo recorrente' },
              { value: 'installment', label: 'Parcelado' },
              { value: 'single', label: 'Pontual' },
            ]}
          />
          <span className="field__hint">
            {kind === 'recurring'
              ? 'Repete todo mês, sempre no mesmo dia a partir da data de pagamento. Sem fim informado, não para.'
              : kind === 'installment'
                ? 'Uma quantidade fixa de parcelas, uma por mês, sempre no mesmo dia a partir da data de pagamento.'
                : 'Uma única ocorrência, exatamente na data informada.'}
          </span>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={amountFieldId}>
              Valor {kind === 'recurring' ? 'por mês' : kind === 'installment' ? 'por parcela' : ''} (R$)
            </label>
            <TextInput id={amountFieldId} value={amount} onChange={setAmount} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={paymentDateFieldId}>Data de pagamento</label>
            <TextInput id={paymentDateFieldId} value={paymentDate} onChange={setPaymentDate} type="date" />
            {kind !== 'single' && (
              <span className="field__hint">O dia (não o mês) se repete nas próximas ocorrências.</span>
            )}
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 170 }}>
            <label className="field__label" htmlFor={accountFieldId}>Conta esperada</label>
            <Select
              id={accountFieldId}
              value={accountId}
              placeholder="Selecione"
              options={(meta.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
              onChange={setAccountId}
            />
            <span className="field__hint">Usada para sugerir a conciliação quando o extrato real chegar.</span>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 170 }}>
            <label className="field__label" htmlFor={categoryFieldId}>TAG (opcional)</label>
            <CategorySelect
              id={categoryFieldId}
              value={categoryId}
              direction={flow === 'income' ? 'in' : 'out'}
              onChange={setCategoryId}
            />
          </div>
        </div>

        {kind === 'recurring' && (
          <div className="field">
            <label className="field__label" htmlFor="forecast-end">
              Até quando <span className="muted">(opcional)</span>
            </label>
            <TextInput
              id="forecast-end"
              value={endMonth}
              onChange={setEndMonth}
              type="month"
              min={paymentDate.slice(0, 7)}
            />
            <span className="field__hint">
              {endMonth === ''
                ? 'Vazio: repete sem data de término. Preencha com o encerramento do contrato para o planejamento parar ali.'
                : `Última ocorrência em ${endMonth}. Depois disso nada é lançado.`}
            </span>
          </div>
        )}

        {kind === 'installment' && (
          <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label" htmlFor={installmentCountFieldId}>Total de parcelas</label>
              <TextInput
                id={installmentCountFieldId}
                value={installmentCount}
                onChange={setInstallmentCount}
                placeholder="ex. 3"
                numeral
              />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label" htmlFor={installmentsRealizedFieldId}>
                Parcelas já confirmadas/recebidas
              </label>
              <TextInput
                id={installmentsRealizedFieldId}
                value={installmentsRealized}
                onChange={setInstallmentsRealized}
                placeholder="ex. 1"
                numeral
              />
              <span className="field__hint">A pendência só materializa as parcelas futuras, a partir da próxima.</span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * Suggested pairs only — an amount + date-window match is a candidate,
 * never proof, so the user confirms each one by hand before the
 * pending placeholder is dropped in favour of the real posted row.
 */
function ReconciliationSection() {
  const toast = useToast()
  const queryClient = useQueryClient()

  const candidates = useQuery({
    queryKey: ['reconciliation-candidates'],
    queryFn: () => api.get<{ candidates: ReconciliationCandidate[] }>('/cash-flow/reconciliation-candidates'),
  })

  const confirm = useMutation({
    mutationFn: ({ pendingId, matchId }: { pendingId: number; matchId: number }) =>
      api.post(`/cash-flow/pending/${pendingId}/confirm-match`, { matchId }),
    onSuccess: () => {
      toast('Conciliado: a pendência foi substituída pelo lançamento real')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao conciliar', 'error'),
  })

  const dismiss = useMutation({
    mutationFn: ({ pendingId, matchId }: { pendingId: number; matchId: number }) =>
      api.post('/cash-flow/reconciliation-candidates/dismiss', { pendingId, matchId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reconciliation-candidates'] }),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  const rows = candidates.data?.candidates ?? []
  if (rows.length === 0) return null

  return (
    <div className="stack stack--tight">
      <div>
        <span className="stat__label">Possíveis conciliações</span>
        <p className="chart__note" style={{ margin: 0 }}>Mesma conta, mesmo valor, data próxima: confirme se é o mesmo lançamento</p>
      </div>
      {rows.map(({ pending, match }) => (
        <div key={`${pending.id}-${match.id}`} className="row row--between row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="truncate">
              <strong>{pending.description}</strong>
              <span className="muted"> · previsto para {fmtPeriod(pending.postedOn.slice(0, 7))}</span>
            </div>
            <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Recebido em {fmtDate(match.postedOn)}
            </div>
          </div>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <strong className="tabular">{money(match.amountCents)}</strong>
            <Button
              size="sm"
              variant="primary"
              icon="check"
              onClick={() => confirm.mutate({ pendingId: pending.id, matchId: match.id })}
            >
              É o mesmo
            </Button>
            <Button
              variant="quiet"
              size="sm"
              icon="x"
              title="Não é o mesmo, remover esta sugestão"
              onClick={() => dismiss.mutate({ pendingId: pending.id, matchId: match.id })}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

type SubscriptionCandidate = {
  signature: string
  description: string
  occurrences: number
  avgAmountCents: number
  lastPostedOn: string
  accountId: number
  categoryId: number | null
}

/**
 * Item 8 do backlog de 07/09/2026: sugestão de assinatura recorrente por
 * padrão de comerciante — mesmo padrão de sugestão revisável de
 * `ReconciliationSection` acima, nunca aplicação automática (decisions/0003).
 * "Aceitar" vira uma previsão recorrente de verdade (Motor financeiro/
 * Painel passam a mostrá-la); "Não é assinatura" descarta e nunca mais
 * sugere este comerciante.
 */
function SubscriptionsSection() {
  const toast = useToast()
  const queryClient = useQueryClient()

  const candidates = useQuery({
    queryKey: ['subscription-candidates'],
    queryFn: () => api.get<{ candidates: SubscriptionCandidate[] }>('/subscriptions/candidates'),
  })

  const confirm = useMutation({
    mutationFn: (signature: string) => api.post('/subscriptions/confirm', { signature }),
    onSuccess: () => {
      toast('Virou uma previsão recorrente')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao confirmar', 'error'),
  })

  const dismiss = useMutation({
    mutationFn: (signature: string) => api.post('/subscriptions/dismiss', { signature }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['subscription-candidates'] }),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  const rows = candidates.data?.candidates ?? []
  if (rows.length === 0) return null

  return (
    <div className="stack stack--tight">
      <div>
        <span className="stat__label">Possíveis assinaturas</span>
        <p className="chart__note" style={{ margin: 0 }}>Mesmo valor, todo mês, no mesmo comerciante: confirme se é uma assinatura</p>
      </div>
      {rows.map((candidate) => (
        <div key={candidate.signature} className="row row--between row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="truncate">
              <strong>{candidate.description}</strong>
            </div>
            <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              {candidate.occurrences}x, última em {fmtDate(candidate.lastPostedOn)}
            </div>
          </div>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <strong className="tabular">{money(candidate.avgAmountCents)}</strong>
            <Button
              size="sm"
              variant="primary"
              icon="check"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate(candidate.signature)}
            >
              É assinatura
            </Button>
            <Button
              variant="quiet"
              size="sm"
              icon="x"
              title="Não é uma assinatura, remover esta sugestão"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(candidate.signature)}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

/** The zero-data state for the whole product, not just one chart. */
function FirstRun() {
  return (
    <>
      <PageHeader title="Visão geral" subtitle="Nenhum dado importado ainda" />
      <div className="page">
        <Bento>
          <Slab span={12} accent>
            <div className="stack" style={{ maxWidth: '62ch' }}>
              <span className="stat__label">Primeiro passo</span>
              <h2 className="display" style={{ fontSize: 'var(--text-2xl)' }}>
                Importe um extrato para começar
              </h2>
              <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-base)' }}>
                O app já conhece o formato de CSV do Itaú, Nubank (conta e cartão), Bradesco,
                Santander e Inter: detecta o banco pelo cabeçalho, normaliza datas e valores,
                marca duplicatas e sugere TAGs antes de gravar qualquer coisa.
              </p>
              <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
                <Link to="/importar">
                  <Button variant="primary" icon="upload">
                    Importar CSV
                  </Button>
                </Link>
                <Link to="/diario">
                  <Button variant="slab" icon="plus">
                    Ou lançar um gasto à mão
                  </Button>
                </Link>
              </div>
            </div>
          </Slab>

          {[
            {
              icon: 'upload' as const,
              title: 'Importação por perfil de banco',
              body: 'Cada banco é uma linha de configuração (delimitador, formato de data, convenção de sinal), não um caso especial no código.',
            },
            {
              icon: 'tags' as const,
              title: 'Categorização que aprende',
              body: 'Regras determinísticas primeiro; suas correções viram regra depois de três confirmações.',
            },
            {
              icon: 'target' as const,
              title: 'Metas, dívida e carteira',
              body: 'Tudo derivado da mesma tabela de lançamentos, então nenhum painel discorda do outro.',
            },
          ].map((item) => (
            <Card key={item.title} span={4}>
              <span className="muted">
                <Icon name={item.icon} size={20} strokeWidth={1.5} />
              </span>
              <h3 className="h3">{item.title}</h3>
              <p className="muted" style={{ fontSize: 'var(--text-sm)', lineHeight: 1.55 }}>
                {item.body}
              </p>
            </Card>
          ))}
        </Bento>
      </div>
    </>
  )
}
