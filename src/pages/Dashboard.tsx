import { Fragment, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { forwardBoundsFor, useAccounts, useMeta, useRange, type Account } from '../lib/store'
import { AccountModal, BalanceCheckModal } from './Settings'
import {
  bps,
  centsToInput,
  money,
  moneyCompact,
  parseMoneyInput,
  period as fmtPeriod,
  periodLong as fmtPeriodLong,
  date as fmtDate,
} from '../lib/format'
import {
  BENTO_CARD_LABELS,
  BENTO_SPAN_OPTIONS,
  DEFAULT_BENTO_LAYOUT,
  useBentoLayout,
  type BentoCardId,
  type BentoSpan,
} from '../lib/bentoLayout'
import {
  Button,
  Card,
  capUsageState,
  CategorySelect,
  EmptyState,
  HeroFigure,
  Icon,
  Meter,
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
  type MeterState,
  type PendingDeleteScope,
} from '../components/ui'
import { PageHeader, RangeFilter } from '../components/shell/Shell'
import { IncomeExpenseChart } from '../components/charts/IncomeExpenseChart'
import { TransactionForm, type TransactionFormValue } from '../components/forms/TransactionForm'
import { CategoryRing, type Slice } from '../components/charts/CategoryRing'
import { NetFlowChart } from '../components/charts/NetFlowChart'
import { AccountFlowSankey, type FlowEdge, type FlowNode, type LooseLeg } from '../components/charts/AccountFlowSankey'

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
  nodes: FlowNode[]
  edges: FlowEdge[]
  loose: LooseLeg[]
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

/** Formato de cada card no skeleton do primeiro carregamento — espelha
 * o que `DEFAULT_BENTO_LAYOUT` normalmente desenha ali (linhas de texto
 * pros cards de lista, pares label+valor pras estatísticas, um bloco
 * só pros gráficos), não uma grade de retângulos iguais. */
const DASHBOARD_SKELETON_VARIANT: Partial<Record<BentoCardId, 'lines' | 'stats' | 'block'>> = {
  'month-mode': 'stats',
  hero: 'stats',
  'income-expense-kpi': 'stats',
  'income-expense-chart': 'block',
  'income-by-category': 'block',
  'expense-by-category': 'block',
  'net-flow': 'block',
  'account-flow': 'block',
}

export function Dashboard() {
  const range = useRange()
  const navigate = useNavigate()
  const meta = useMeta()
  const accountsQuery = useAccounts()
  const bento = useBentoLayout()
  const [customizing, setCustomizing] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [balanceCheckAccount, setBalanceCheckAccount] = useState<Account | null>(null)

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
        <PageHeader title="Visão geral" actions={<RangeFilter />} />
        <div className="page">
          <PageSkeleton
            cards={DEFAULT_BENTO_LAYOUT.filter((c) => c.visible).map((c) => ({
              span: c.span,
              variant: DASHBOARD_SKELETON_VARIANT[c.id] ?? 'lines',
            }))}
          />
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

  const spanOf = (id: BentoCardId): BentoSpan => bento.layout.find((c) => c.id === id)?.span ?? 4
  const isVisible = (id: BentoCardId): boolean => bento.layout.find((c) => c.id === id)?.visible ?? true

  // Every card as a React element, keyed by id — built once per render, then
  // laid out (order, span, visibility) purely from `bento.layout` below.
  // Hidden cards still get built (cheap: just an element, not a mount) so
  // toggling visibility never has to re-derive anything.
  const cardsById: Record<BentoCardId, ReactNode> = {
    hero: (
      // The one hero figure on this view. Exactly one per page.
      <Slab span={spanOf('hero')} accent>
        <HeroFigure
          label="Resultado do período"
          value={moneyCompact(totals.netCents)}
          delta={deltas.netBps}
          deltaLabel="vs. período anterior"
        />
        <div className="kv" style={{ marginTop: 'var(--sp-2)' }}>
          <span className="kv__k">Taxa de poupança</span>
          <span className="kv__v">{bps(totals.savingsRateBps)}</span>
          <span className="kv__k" title="Aportes menos resgates, já que varreduras automáticas RDB entram e saem constantemente e só o líquido significa algo">
            Investido no período (líquido)
          </span>
          <span className="kv__v">{money(totals.investedCents)}</span>
          <span className="kv__k">Saldo somado das contas</span>
          <span className="kv__v">{money(balance)}</span>
        </div>
      </Slab>
    ),
    'income-expense-kpi': (
      <Card span={spanOf('income-expense-kpi')}>
        <StatTile
          label="Entradas"
          value={moneyCompact(totals.incomeCents)}
          delta={deltas.incomeBps}
          deltaLabel="vs. anterior"
          large
        />
        <hr className="divider" />
        <StatTile
          label="Saídas"
          value={moneyCompact(totals.expenseCents)}
          delta={deltas.expenseBps}
          deltaLabel="vs. anterior"
          large
        />
        <hr className="divider" />
        <StatTile
          label="A receber"
          value={moneyCompact(totals.receivableCents)}
          delta={deltas.receivableBps}
          deltaLabel="vs. anterior"
          large
        />
      </Card>
    ),
    accounts: (
      <Card
        span={spanOf('accounts')}
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
                <span className={`kv__v ${account.balanceCents < 0 ? 'neg' : ''}`}>{money(account.balanceCents)}</span>
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
    ),
    'month-mode': <MonthModeCard span={spanOf('month-mode')} rangeTo={range.to} rangeAnchor={range.anchor} />,
    'credit-cards': (
      <CreditCardsSlab cards={cards.data?.cards ?? []} isError={cards.isError} span={spanOf('credit-cards')} />
    ),
    reconciliation: <ReconciliationCard span={spanOf('reconciliation')} />,
    'pending-income': <PendingCard flow="income" title="Receitas pendentes" span={spanOf('pending-income')} />,
    'pending-expense': <PendingCard flow="expense" title="Despesas pendentes" span={spanOf('pending-expense')} />,
    'income-expense-chart': (
      <Card
        span={spanOf('income-expense-chart')}
        title="Entradas e saídas"
        subtitle={useDailyBars ? 'Comparação dia a dia no período selecionado' : 'Comparação mês a mês no período selecionado'}
      >
        <IncomeExpenseChart
          data={flowSeries}
          surface="paper"
          height={280}
          granularity={useDailyBars ? 'day' : 'month'}
        />
      </Card>
    ),
    'income-by-category': (
      <Card span={spanOf('income-by-category')} title="Entradas por categoria" subtitle="Agrupado por categoria-mãe">
        <CategoryRing
          slices={incomeByCategory}
          childSlices={incomeByCategoryLeaf}
          surface="paper"
          totalLabel="Total de entradas"
          height={200}
          paddingAngle={5}
          cornerRadius={6}
          onSliceClick={(categoryId) => navigate(`/lancamentos?parentCategoryId=${categoryId}`)}
        />
      </Card>
    ),
    'expense-by-category': (
      <Card span={spanOf('expense-by-category')} title="Gastos por categoria" subtitle="Agrupado por categoria-mãe">
        <CategoryRing
          slices={byCategory}
          childSlices={byCategoryLeaf}
          surface="paper"
          totalLabel="Total de saídas"
          height={200}
          paddingAngle={5}
          cornerRadius={6}
          onSliceClick={(categoryId) => navigate(`/lancamentos?parentCategoryId=${categoryId}`)}
        />
      </Card>
    ),
    'net-flow': (
      <Card span={spanOf('net-flow')} title="Resultado acumulado" subtitle="Quanto sobrou, somado mês a mês">
        <NetFlowChart data={netFlow} surface="paper" height={200} />
      </Card>
    ),
    'top-merchants': (
      <Card span={spanOf('top-merchants')} title="Onde o dinheiro mais foi" subtitle="Maiores saídas do período">
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
              <li key={merchant.signature} className="ranked__item" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}>
                <span className="truncate">{merchant.signature}</span>
                <span className="ranked__share">{merchant.count}x</span>
                <span className="ranked__value">{money(merchant.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    ),
    'account-flow': (
      <Card
        span={spanOf('account-flow')}
        title="Fluxo entre contas"
        subtitle="Transferências entre suas próprias contas: cada perna do banco é pareada com a outra ponta para não contar em dobro"
      >
        {flows.data ? (
          <AccountFlowSankey
            nodes={flows.data.nodes}
            edges={flows.data.edges}
            loose={flows.data.loose}
            totals={flows.data.totals}
            surface="paper"
            height={320}
          />
        ) : (
          <SkeletonBlock height={320} />
        )}
      </Card>
    ),
    'uncategorized-banner': totals.uncategorizedCount > 0 ? (
      <Card span={spanOf('uncategorized-banner')} muted>
        <div className="row row--between row--wrap">
          <span className="row">
            <Icon name="alert" size={16} />
            <span>
              <strong className="tabular">{totals.uncategorizedCount}</strong> lançamentos sem
              categoria no período, e os gráficos os contam pelo sinal, o que pode distorcer a
              quebra por categoria.
            </span>
          </span>
          <Link to="/lancamentos?uncategorized=1">
            <Button variant="primary" size="sm" icon="tags">
              Categorizar agora
            </Button>
          </Link>
        </div>
      </Card>
    ) : null,
  }

  return (
    <>
      <PageHeader
        title="Visão geral"
        subtitle={`${totals.transactionCount.toLocaleString('pt-BR')} lançamentos no período`}
        actions={
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <RangeFilter />
            <Button variant="ghost" size="sm" icon="settings" onClick={() => setCustomizing(true)}>
              Personalizar
            </Button>
          </div>
        }
      />

      <div className="page" style={{ opacity: dashboard.isFetching ? 0.72 : 1, transition: 'opacity 120ms' }}>
        <div className="bento">
          {bento.layout
            .filter((c) => isVisible(c.id))
            .map((c) => <Fragment key={c.id}>{cardsById[c.id]}</Fragment>)}
        </div>
      </div>

      {customizing && <BentoSettingsModal bento={bento} onClose={() => setCustomizing(false)} />}
      {editingAccount && <AccountModal account={editingAccount} onClose={() => setEditingAccount(null)} />}
      {balanceCheckAccount && (
        <BalanceCheckModal account={balanceCheckAccount} onClose={() => setBalanceCheckAccount(null)} />
      )}
    </>
  )
}

/**
 * Which cards show, how wide, in what order — all local to this browser
 * (see `lib/bentoLayout.ts`). Reordering is native HTML5 drag-and-drop off
 * a dedicated handle (no drag library — `draggable` + the browser's own
 * drag events), with the same up/down step still one click away: a mouse-
 * only reorder gesture would otherwise regress the keyboard/screen-reader
 * access the old "posição" dropdown gave for free.
 */
function BentoSettingsModal({
  bento,
  onClose,
}: {
  bento: ReturnType<typeof useBentoLayout>
  onClose: () => void
}) {
  const [draggedId, setDraggedId] = useState<BentoCardId | null>(null)
  const [dragOverId, setDragOverId] = useState<BentoCardId | null>(null)

  const dropOn = (targetId: BentoCardId) => {
    if (draggedId && draggedId !== targetId) {
      const targetIndex = bento.layout.findIndex((c) => c.id === targetId)
      bento.moveTo(draggedId, targetIndex)
    }
    setDraggedId(null)
    setDragOverId(null)
  }

  return (
    <Modal
      title="Personalizar a visão geral"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={bento.reset}>
            Restaurar padrão
          </Button>
          <Button variant="primary" icon="check" onClick={onClose}>
            Concluído
          </Button>
        </>
      }
    >
      <p className="chart__note" style={{ marginBottom: 'var(--sp-3)' }}>
        Escolha quais cards aparecem, o quanto cada um ocupa da largura (de 3 a 12, numa grade de
        12 colunas) e arraste pelo ícone <Icon name="grip" size={11} strokeWidth={3} /> para reordenar.
        Vale só neste navegador.
      </p>
      <div className="stack stack--tight">
        {bento.layout.map((card, index) => (
          <div
            key={card.id}
            onDragOver={(e) => {
              if (!draggedId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dragOverId !== card.id) setDragOverId(card.id)
            }}
            onDrop={(e) => {
              e.preventDefault()
              dropOn(card.id)
            }}
            className="row row--between row--wrap"
            style={{
              gap: 'var(--sp-3)',
              padding: 'var(--sp-3)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--surface-muted)',
              opacity: card.visible ? (draggedId === card.id ? 0.4 : 1) : draggedId === card.id ? 0.4 : 0.55,
              boxShadow: dragOverId === card.id && draggedId !== card.id ? 'inset 0 2px 0 var(--brand)' : 'none',
              transition: 'box-shadow 100ms',
            }}
          >
            <div className="row" style={{ gap: 'var(--sp-2)', flex: 1, minWidth: 180 }}>
              <span
                draggable
                onDragStart={(e) => {
                  setDraggedId(card.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => {
                  setDraggedId(null)
                  setDragOverId(null)
                }}
                title="Arrastar para reordenar"
                aria-hidden="true"
                style={{ display: 'flex', cursor: 'grab', color: 'var(--ink-3)', touchAction: 'none' }}
              >
                <Icon name="grip" size={14} strokeWidth={2.6} />
              </span>
              <div className="row" style={{ gap: 1 }}>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  style={{ width: 22, minWidth: 22, padding: 0 }}
                  disabled={index === 0}
                  title="Mover para cima"
                  onClick={() => bento.move(card.id, -1)}
                >
                  <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}>
                    <Icon name="chevronRight" size={13} />
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  style={{ width: 22, minWidth: 22, padding: 0 }}
                  disabled={index === bento.layout.length - 1}
                  title="Mover para baixo"
                  onClick={() => bento.move(card.id, 1)}
                >
                  <span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}>
                    <Icon name="chevronRight" size={13} />
                  </span>
                </button>
              </div>
              <label className="row" style={{ gap: 'var(--sp-2)' }}>
                <input
                  type="checkbox"
                  checked={card.visible}
                  onChange={(e) => bento.setVisible(card.id, e.target.checked)}
                />
                <span className="truncate">{BENTO_CARD_LABELS[card.id]}</span>
              </label>
            </div>

            <div className="field" style={{ minWidth: 110 }}>
              <label className="field__label">Largura</label>
              <Select
                value={card.span}
                options={BENTO_SPAN_OPTIONS.map((span) => ({ value: span, label: `${span}/12` }))}
                onChange={(span) => bento.setSpan(card.id, (span ?? card.span) as BentoSpan)}
              />
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/**
 * Same ink-card family as every other KPI slab on this page (Reserva,
 * Receitas/Despesas pendentes) instead of the lone paper table it used to
 * be. One page at a time — the consolidated total across every card first,
 * then one page per card — because "limite total" and "limite disponível"
 * don't mean anything summed across cards with different due dates.
 */
/* ================================================================== *
 * "Modo mês"
 *
 * Composição pura: nenhum endpoint novo, nenhuma tabela nova. As cinco
 * linhas vêm de respostas que já existem, e o veredito de status reusa os
 * MESMOS thresholds do Radar de risco em vez de inventar um segundo
 * conjunto de limites para a mesma decisão (`specs/dashboard`, "Modo mês").
 * ================================================================== */
/** Só o que o card lê de cada resposta, para não duplicar os tipos inteiros. */
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

type RadarLite = { rules: Array<{ key: string; label: string; outsideRange: boolean }> }

type MonthLine = {
  key: string
  label: string
  realizedCents: number
  /** null quando o usuário não configurou meta para esta linha */
  targetCents: number | null
  /** true quando passar da meta é o objetivo (receita, investimento), false quando é o limite (gasto) */
  higherIsBetter: boolean
  /** verde/amarelo/vermelho — o mesmo veredito que o servidor já calcula para Metas do mês e Motor financeiro, nunca um segundo limite inventado aqui */
  state: MeterState
}

function MonthModeCard({
  span,
  rangeTo,
  rangeAnchor,
}: {
  span: BentoSpan
  rangeTo: string
  rangeAnchor: string
}) {
  // Segue o seletor de período global, sempre — nunca deriva nem substitui
  // o próprio mês. Uma versão anterior recuava um mês sempre que o fim do
  // período selecionado caía no mês corrente, para nunca comparar uma
  // meta contra um mês ainda incompleto (mesma regra de
  // "mês corrente nunca é o padrão" de specs/debt). Isso quebrava o
  // propósito do próprio card: com a visão padrão do Painel (6 meses,
  // terminando hoje), "Modo mês" sempre mostrava o mês ANTERIOR ao atual,
  // silenciosamente — confirmado como bug num teste de uso real (o card
  // mostrava julho com o app já em agosto). "Mês corrente sempre mostra
  // progresso, nunca um veredito prematuro" (specs/monthly-goals) é a
  // regra certa aqui: mostra o mês corrente como está, em andamento, em
  // vez de trocá-lo por outro nos bastidores.
  const currentPeriod = rangeAnchor.slice(0, 7)
  const period = rangeTo.slice(0, 7)
  const isCurrentPeriod = period === currentPeriod

  const goals = useQuery({
    queryKey: ['month-mode-goals', period],
    queryFn: () => api.get<PeriodProgressLite>(`/goals/${period}`),
    enabled: period !== null,
  })

  // Traz, num payload só, meta e realizado do mês para investimento,
  // dívida e reserva — os três já compostos por `specs/motor-financeiro`.
  const available = useQuery({
    queryKey: ['month-mode-available', period],
    queryFn: () => api.get<AvailableLite>('/financial-engine/available', { period }),
    enabled: period !== null,
  })

  const radar = useQuery({
    queryKey: ['financial-health-radar', period],
    queryFn: () => api.get<RadarLite>('/financial-health/risk-radar', { period }),
    enabled: period !== null,
  })

  if (goals.isError || available.isError) {
    return (
      <Card span={span} title="Modo mês">
        <EmptyState
          icon="alert"
          title="Falha ao carregar"
          body="Não foi possível carregar os dados do mês agora. Tente novamente em instantes."
        />
      </Card>
    )
  }

  if (!goals.data || !available.data) {
    return (
      <Card span={span} title="Modo mês">
        <EmptyState title="Compondo o mês…" />
      </Card>
    )
  }

  const destino = (key: string) => available.data!.destinations.find((d) => d.key === key)

  const lines: MonthLine[] = [
    {
      key: 'income',
      label: 'Receita',
      realizedCents: goals.data.actual.incomeCents,
      targetCents: goals.data.goal.incomeTargetCents,
      higherIsBetter: true,
      state: goals.data.progress.income.state,
    },
    {
      key: 'spend',
      label: 'Gasto',
      realizedCents: goals.data.actual.expenseCents,
      targetCents: goals.data.goal.spendCapCents,
      higherIsBetter: false,
      state: goals.data.progress.spend.state,
    },
    {
      key: 'investment',
      label: 'Investimento',
      realizedCents: destino('investment')?.realizedCents ?? 0,
      targetCents: destino('investment')?.targetCents ?? null,
      higherIsBetter: true,
      state: destino('investment')?.state ?? 'no_target',
    },
    {
      key: 'debt',
      label: 'Dívida',
      realizedCents: destino('debt')?.realizedCents ?? 0,
      targetCents: destino('debt')?.targetCents ?? null,
      higherIsBetter: true,
      state: destino('debt')?.state ?? 'no_target',
    },
    {
      key: 'reserve',
      label: 'Reserva',
      realizedCents: destino('reserve')?.realizedCents ?? 0,
      targetCents: destino('reserve')?.targetCents ?? null,
      higherIsBetter: true,
      state: destino('reserve')?.state ?? 'no_target',
    },
  ]

  /*
   * "Atenção" quando ao menos uma regra do Radar está fora da faixa. O
   * limite é o do Radar, não um inventado aqui: dois limites para a mesma
   * decisão divergiriam no primeiro ajuste que o usuário fizesse.
   */
  const foraDaFaixa = (radar.data?.rules ?? []).filter((r) => r.outsideRange)
  const atencao = foraDaFaixa.length > 0
  const semRadar = !radar.data

  return (
    <Card
      span={span}
      title="Modo mês"
      subtitle={period ? `${fmtPeriodLong(period)}${isCurrentPeriod ? ' · em andamento' : ''}` : undefined}
      actions={
        semRadar ? undefined : (
          <span className={`badge ${atencao ? 'badge--warning' : 'badge--good'}`}>
            <Icon name={atencao ? 'alert' : 'check'} size={11} strokeWidth={2.4} />
            {atencao ? 'Atenção' : 'No caminho'}
          </span>
        )
      }
    >
      <div className="bento" style={{ gap: 'var(--sp-4)' }}>
        {lines.map((line) => (
          <div key={line.key} className="col-2" style={{ minWidth: 0 }}>
            <MonthLineTile line={line} />
          </div>
        ))}
      </div>
      {atencao && (
        <p className="chart__note">
          {foraDaFaixa.length === 1 ? 'Um indicador está' : `${foraDaFaixa.length} indicadores estão`} fora
          da faixa configurada no Radar de risco: {foraDaFaixa.map((r) => r.label).join(', ')}.
        </p>
      )}
    </Card>
  )
}

function MonthLineTile({ line }: { line: MonthLine }) {
  const hasTarget = line.targetCents !== null && line.targetCents > 0
  const usedBps = hasTarget
    ? Math.max(0, Math.round((line.realizedCents / line.targetCents!) * 10_000))
    : 0

  return (
    <div className="stack stack--tight">
      <span className="stat__label">{line.label}</span>
      <span className="tabular" style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>
        {moneyCompact(line.realizedCents)}
      </span>
      {hasTarget ? (
        <>
          {/* Verde/amarelo/vermelho, mesmo padrão de cor usado em Metas do
              mês e nos cartões de crédito — confirmado por uso real que a
              barra neutra escondia justamente o sinal que este card existe
              para dar. */}
          <Meter usedBps={Math.min(usedBps, 10_000)} state={line.state} />
          <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
            {line.higherIsBetter ? 'de' : 'do teto de'} {moneyCompact(line.targetCents!)} ({bps(usedBps, 0)})
          </span>
        </>
      ) : (
        // Sem meta configurada: mostra o valor e para aí, sem inventar uma
        // meta nem esconder a linha.
        <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
          sem meta configurada
        </span>
      )}
    </div>
  )
}

function CreditCardsSlab({
  cards,
  isError,
  span,
}: {
  cards: CardRow[]
  isError: boolean
  span: BentoSpan
}) {
  const [page, setPage] = useState(0)
  const pageCount = cards.length + 1
  const current = page === 0 ? null : cards[page - 1]

  const limitCents = current ? current.creditLimitCents : cards.reduce((s, c) => s + c.creditLimitCents, 0)
  const availableCents = current
    ? current.availableLimitCents
    : cards.reduce((s, c) => s + c.availableLimitCents, 0)
  const usedBps = limitCents > 0 ? Math.round(((limitCents - availableCents) / limitCents) * 10_000) : 0
  const meterState = capUsageState(usedBps)

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

          <div className="row row--between row--wrap">
            <StatTile label="Limite disponível" value={money(availableCents)} large />
            <StatTile label="Limite total" value={money(limitCents)} />
          </div>

          <Meter usedBps={usedBps} state={meterState} />

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

/* ------------------------------------------------------------------ *
 * Pending — a confirmed future receipt/expense the bank hasn't posted
 * yet (a freelancer's recurring retainer, an already-agreed installment
 * deal). Unified with the real ledger (same `transactions` table, same
 * Lançamentos list) rather than a side preview; every totals query
 * excludes it by default, so it can never inflate a closed period's
 * real Entradas/Saídas until reconciled against the real posted row.
 * ------------------------------------------------------------------ */
function PendingCard({ flow, title, span }: { flow: 'income' | 'expense'; title: string; span: BentoSpan }) {
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

  return (
    <>
      <Card
        span={span}
        title={title}
        subtitle={
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
        }
        actions={
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
        }
      >
        <StatTile label={flow === 'income' ? 'Ainda não caiu na conta' : 'Ainda não saiu da conta'} value={moneyCompact(totalCents)} large />
        {overdueCount > 0 && (
          <p className="chart__note" style={{ marginTop: 'var(--sp-2)' }}>
            <span className="badge badge--critical">Atrasado</span> {overdueCount} de período(s) anterior(es) ainda{' '}
            {flow === 'income' ? 'não recebido(s)' : 'não pago(s)'}
          </p>
        )}
        {invisibleForecasts.length > 0 && (
          <p className="chart__note" style={{ marginTop: 'var(--sp-2)' }}>
            <Icon name="info" size={12} /> {invisibleForecasts.length} previsão(ões) só aparecerá(ão) mais perto da
            data — confira em "Ver lançamentos"
          </p>
        )}
      </Card>

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

  const remove = useMutation({
    mutationFn: ({ id, scope }: { id: number; scope?: PendingDeleteScope }) =>
      api.del(`/cash-flow/pending/${id}`, scope ? { scope } : {}),
    onSuccess: () => {
      toast('Pendência removida')
      queryClient.invalidateQueries()
      setScopeTarget(null)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  // decisions/0024: essas linhas não têm transação real ainda — o "remover"
  // aqui apaga a PREVISÃO inteira (endpoint de forecast, não de pendência).
  const removeForecast = useMutation({
    mutationFn: (id: number) => api.del(`/cash-flow/forecasts/${id}`),
    onSuccess: () => {
      toast('Previsão removida')
      queryClient.invalidateQueries()
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
              <th>Descrição</th>
              <th>Data</th>
              <th style={{ textAlign: 'right' }}>Valor</th>
              <th style={{ width: 104 }} />
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
                        r.forecastId !== null || r.debtId !== null ? setScopeTarget(r) : remove.mutate({ id: r.id })
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
            Salvas normalmente — só ainda não viraram lançamento porque a primeira data está longe demais. Vão
            aparecer sozinhas conforme o mês se aproxima.
          </p>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {invisibleForecasts.map((f) => (
                  <tr key={f.id}>
                    <td>{f.description}</td>
                    <td className="muted">
                      primeira ocorrência: {f.nextOccurrencePeriod ? fmtPeriodLong(f.nextOccurrencePeriod) : '—'}
                    </td>
                    <td className={`table__num ${flow === 'income' ? 'pos' : 'neg'}`}>
                      {money(Math.abs(f.amountCents))}
                    </td>
                    <td>
                      <Button
                        variant="quiet"
                        size="sm"
                        icon="trash"
                        onClick={() => removeForecast.mutate(f.id)}
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
            <Button variant="primary" icon="check" onClick={requestSave} disabled={save.isPending}>
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
          <label className="field__label">Descrição</label>
          <TextInput value={description} onChange={setDescription} placeholder="ex. BERA, Design UI/UX E-commerce DME" />
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
              ? 'Repete todo mês, indefinidamente, sempre no mesmo dia a partir da data de pagamento.'
              : kind === 'installment'
                ? 'Uma quantidade fixa de parcelas, uma por mês, sempre no mesmo dia a partir da data de pagamento.'
                : 'Uma única ocorrência, exatamente na data informada.'}
          </span>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">
              Valor {kind === 'recurring' ? 'por mês' : kind === 'installment' ? 'por parcela' : ''} (R$)
            </label>
            <TextInput value={amount} onChange={setAmount} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Data de pagamento</label>
            <TextInput value={paymentDate} onChange={setPaymentDate} type="date" />
            {kind !== 'single' && (
              <span className="field__hint">O dia (não o mês) se repete nas próximas ocorrências.</span>
            )}
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 170 }}>
            <label className="field__label">Conta esperada</label>
            <Select
              value={accountId}
              placeholder="Selecione"
              options={(meta.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
              onChange={setAccountId}
            />
            <span className="field__hint">Usada para sugerir a conciliação quando o extrato real chegar.</span>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 170 }}>
            <label className="field__label">Categoria (opcional)</label>
            <CategorySelect
              value={categoryId}
              direction={flow === 'income' ? 'in' : 'out'}
              onChange={setCategoryId}
            />
          </div>
        </div>

        {kind === 'installment' && (
          <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label">Total de parcelas</label>
              <TextInput value={installmentCount} onChange={setInstallmentCount} placeholder="ex. 3" numeral />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label">Parcelas já confirmadas/recebidas</label>
              <TextInput value={installmentsRealized} onChange={setInstallmentsRealized} placeholder="ex. 1" numeral />
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
function ReconciliationCard({ span }: { span: BentoSpan }) {
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
    <Card span={span} muted title="Possíveis conciliações" subtitle="Mesma conta, mesmo valor, data próxima: confirme se é o mesmo lançamento">
      <div className="stack stack--tight">
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
                title="Não é o mesmo — remover esta sugestão"
                onClick={() => dismiss.mutate({ pendingId: pending.id, matchId: match.id })}
              />
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** The zero-data state for the whole product, not just one chart. */
function FirstRun() {
  return (
    <>
      <PageHeader title="Visão geral" subtitle="Nenhum dado importado ainda" />
      <div className="page">
        <div className="bento">
          <Slab span={12} accent>
            <div className="stack" style={{ maxWidth: '62ch' }}>
              <span className="stat__label">Primeiro passo</span>
              <h2 className="display" style={{ fontSize: 'var(--text-2xl)' }}>
                Importe um extrato para começar
              </h2>
              <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-base)' }}>
                O app já conhece o formato de CSV do Itaú, Nubank (conta e cartão), Bradesco,
                Santander e Inter: detecta o banco pelo cabeçalho, normaliza datas e valores,
                marca duplicatas e sugere categorias antes de gravar qualquer coisa.
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
        </div>
      </div>
    </>
  )
}
