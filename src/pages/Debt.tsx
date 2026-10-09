import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { telemetry } from '../lib/telemetry'
import { useAccounts } from '../lib/store'
import {
  annualRateBpsFromMonthly,
  bps,
  bpsToInput,
  centsToInput,
  money,
  monthlyRateBpsFromAnnual,
  monthsLabel,
  parseMoneyInput,
  parsePercentInput,
  date as fmtDate,
  periodLong as fmtPeriodLong,
} from '../lib/format'
import {
  Bento,
  Button,
  Card,
  ConfirmDeleteModal,
  EmptyState,
  Icon,
  Modal,
  Select,
  SkeletonLines,
  Slab,
  TextInput,
  useToast,
} from '../components/ui'
import { PageHeader } from '../components/shell/Shell'
import {
  DebtProjectionChart,
  PayoffSummary,
} from '../components/charts/DebtCharts'
import { DebtHistoryChart } from '../components/charts/DebtHistoryChart'
import { CategoryRing } from '../components/charts/CategoryRing'
import { todayIso } from '../lib/period'
import { installmentsCents, type AmortizationSystem } from '@shared/propertyPlan'
import { CategorySelect } from '../components/ui/CategorySelect'
import { CreditCostCard, ExitCalendarCard, FreedomCard, OweToday, RenegotiationCard, type AgreementPrefill, type DebtV2 } from './debt/DebtV2'

const KIND_LABEL: Record<string, string> = {
  credit_card: 'Cartão de crédito',
  personal_loan: 'Empréstimo pessoal',
  financing: 'Financiamento',
  overdraft: 'Cheque especial',
  student: 'Crédito estudantil',
  other: 'Outro',
}

/**
 * Debt kinds get the brand's 4 categorical hues, cycled — there are more
 * debt kinds than the brand provides distinct colours for, but the name
 * column and icon already carry identity, so a repeated hue is fine here.
 */
const KIND_COLOR: Record<string, string> = {
  credit_card: '#007bff',
  personal_loan: '#ff2ea6',
  financing: '#1e8e3c',
  overdraft: '#ba2be2',
  student: '#007bff',
  other: '#ff2ea6',
}

type DebtRow = {
  id: number
  name: string
  kind: string
  institution: string | null
  accountId: number | null
  accountName: string | null
  balanceCents: number
  aprBps: number
  minimumPaymentCents: number
  scheduledPaymentCents: number
  dueDay: number
  monthlyInterestCents: number
  /** taxa mensal equivalente à efetiva anual gravada */
  monthlyRateBps: number
  shareBps: number
  installmentCount: number | null
  installmentsPaid: number
  installmentsRemaining: number | null
  lastPaymentOn: string | null
  /** contrato amortizado (decisions/0041); nulo = parcela fixa */
  amortization: AmortizationSystem | null
  monthlyFeesCents: number
  principalCents: number
  /** TAG das parcelas (specs/debt-v2) */
  categoryId: number | null
  openedOn: string | null
  /** paga dentro da fatura deste cartão (specs/personal-picture) */
  paidViaCardId: number | null
}

type PaymentRow = {
  id: number
  debtId: number
  debtName: string
  kind: string
  paidOn: string
  amountCents: number
  notes: string | null
}

type ClosedDebtRow = DebtRow & {
  closedOn: string | null
  totalPaidCents: number
  closedReason: 'paid' | 'renegotiated' | 'manual' | null
}

const CLOSED_REASON_LABEL: Record<string, string> = { paid: 'quitada', renegotiated: 'renegociada', manual: 'encerrada à mão' }

type SuggestedMatch = {
  pending: { id: number; postedOn: string; description: string; amountCents: number }
  match: { id: number; postedOn: string; description: string; amountCents: number }
  debtId: number
  debtName: string
}

type ValueMismatch = {
  debtId: number
  debtName: string
  registeredAmountCents: number
  confirmedAmountCents: number
  diffCents: number
  paymentCount: number
  confirmedTransactionCount: number
  payments: Array<{ id: number; paidOn: string; amountCents: number; notes: string | null }>
  confirmedTransactions: Array<{ id: number; postedOn: string; description: string; amountCents: number }>
}

type ReconciliationQueue = {
  suggestedMatches: SuggestedMatch[]
  valueMismatches: ValueMismatch[]
}

/** Saldo medido no tempo (`debt.ts#debtTrend`) — um ponto por data em que ALGUMA dívida teve o saldo medido. */
type TrendPoint = { asOf: string; balanceCents: number }

type Overview = {
  debts: DebtRow[]
  closedDebts: ClosedDebtRow[]
  trend: TrendPoint[]
  totalCents: number
  monthlyInterestCents: number
  minimumCents: number
  scheduledCents: number
  weightedAprBps: number
  monthlyIncomeCents: number
  typicalMonthlyIncomeCents: number
  incomeWindowMonths: number
  incomeSampleMonths: number
  debtToIncomeBps: number | null
  debtToAnnualIncomeBps: number | null
  period: string
  byKind: Array<{ kind: string; amountCents: number; shareBps: number }>
}

type ScenarioPerDebt = Array<{ debtId: number; name: string; months: number | null; interestCents: number }>
type Projection = {
  baseline: { months: number | null; totalInterestCents: number; payoffPeriod: string | null; perDebt: ScenarioPerDebt }
  accelerated: { months: number | null; totalInterestCents: number; payoffPeriod: string | null; perDebt: ScenarioPerDebt }
  merged: Array<{ month: number; period: string; baselineCents: number | null; acceleratedCents: number | null }>
  savings: { monthsSaved: number | null; interestSavedCents: number }
}

const EXTRA_STEPS = [0, 10_000, 25_000, 50_000, 100_000, 200_000, 500_000]

export function DebtPage() {
  const [extraIndex, setExtraIndex] = useState(0)
  const [editing, setEditing] = useState<DebtRow | 'new' | null>(null)
  const [prefill, setPrefill] = useState<AgreementPrefill | null>(null)
  const [strategy, setStrategy] = useState<'avalanche' | 'snowball'>('avalanche')
  const [paymentModal, setPaymentModal] = useState<DebtRow | null>(null)
  const [paymentHistory, setPaymentHistory] = useState<DebtRow | null>(null)
  const [mismatchDetail, setMismatchDetail] = useState<ValueMismatch | null>(null)
  const strategyFieldId = useId()

  const extraMonthlyCents = EXTRA_STEPS[extraIndex] ?? 0

  const overview = useQuery({
    queryKey: ['debts'],
    queryFn: () => api.get<Overview>('/debts'),
  })

  // Endividamento v2 (specs/debt-v2): total com cartões, calendário, custo, datas e acordos.
  const v2 = useQuery({
    queryKey: ['debts', 'v2'],
    queryFn: () => api.get<DebtV2>('/debts/overview-v2'),
  })

  const projection = useQuery({
    queryKey: ['debt-projection', extraMonthlyCents, strategy],
    queryFn: () => api.get<Projection>('/debts/projection', { extraMonthlyCents, strategy }),
    enabled: (overview.data?.debts.length ?? 0) > 0,
    placeholderData: (previous) => previous,
  })

  const reconciliation = useQuery({
    queryKey: ['debt-reconciliation'],
    queryFn: () => api.get<ReconciliationQueue>('/debts/reconciliation'),
  })

  const data = overview.data

  return (
    <>
      <PageHeader
        title="Endividamento"
        subtitle="Quanto você deve, o que sai por mês, quanto custa e quando acaba"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            Cadastrar dívida
          </Button>
        }
      />

      <div className="page">
        {overview.isError ? (
          <Card>
            <EmptyState
              icon="alert"
              title="Falha ao carregar"
              body="Não foi possível carregar as dívidas agora. Tente novamente em instantes."
            />
          </Card>
        ) : !data ? (
          <Card>
            <SkeletonLines lines={3} />
          </Card>
        ) : data.debts.length === 0 ? (
          <Bento>
            <Slab span={12} accent>
              <div className="stack" style={{ maxWidth: '62ch' }}>
                <span className="stat__label">Nenhuma dívida cadastrada</span>
                <h2 className="display" style={{ fontSize: 'var(--text-xl)' }}>
                  Cadastre saldo e taxa para ver o custo real
                </h2>
                <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-base)' }}>
                  Com saldo, taxa anual e pagamento mensal de cada dívida, o app calcula quanto de
                  juros você paga por mês, quanto da sua renda está comprometida e em quanto tempo
                  a dívida acaba, com e sem um aporte extra.
                </p>
                <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
                  <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
                    Cadastrar primeira dívida
                  </Button>
                </div>
              </div>
            </Slab>
          </Bento>
        ) : (
          <Bento>
            {v2.data ? (
              <>
                <OweToday v2={v2.data} />
                <ExitCalendarCard v2={v2.data} />
                <CreditCostCard v2={v2.data} />
                <FreedomCard v2={v2.data} debts={data.debts} onEdit={(id) => setEditing(data.debts.find((d) => d.id === id) ?? null)} />
              </>
            ) : v2.isError ? (
              <Card span={12}>
                <EmptyState icon="alert" title="Falha ao carregar o resumo" body="Não foi possível montar o total com os cartões agora. Tente novamente em instantes." />
              </Card>
            ) : (
              <Card span={12}>
                <SkeletonLines lines={3} />
              </Card>
            )}

            {data.byKind.length > 1 && (
            <Slab span={6} title="Composição" subtitle="Saldo por tipo de dívida">
              <CategoryRing
                surface="paper"
                totalLabel="Dívida total"
                height={190}
                paddingAngle={5}
                cornerRadius={6}
                slices={data.byKind.map((entry) => ({
                  categoryId: null,
                  name: KIND_LABEL[entry.kind] ?? entry.kind,
                  color: KIND_COLOR[entry.kind] ?? '#71717a',
                  amountCents: entry.amountCents,
                  shareBps: entry.shareBps,
                  transactionCount: 0,
                }))}
              />
            </Slab>
            )}

            <Card span={data.byKind.length > 1 ? 6 : 12} title="O que muda com o aporte">
              {projection.isError ? (
                <EmptyState
                  icon="alert"
                  title="Falha ao carregar"
                  body="Não foi possível calcular a projeção agora. Tente novamente em instantes."
                />
              ) : projection.data ? (
                <>
                  <PayoffSummary
                    months={
                      extraMonthlyCents > 0
                        ? projection.data.accelerated.months
                        : projection.data.baseline.months
                    }
                    interestCents={
                      extraMonthlyCents > 0
                        ? projection.data.accelerated.totalInterestCents
                        : projection.data.baseline.totalInterestCents
                    }
                    monthsSaved={projection.data.savings.monthsSaved}
                    interestSavedCents={projection.data.savings.interestSavedCents}
                    payoffPeriod={
                      extraMonthlyCents > 0 ? projection.data.accelerated.payoffPeriod : projection.data.baseline.payoffPeriod
                    }
                  />
                  {v2.data && extraMonthlyCents === 0 && v2.data.freeOn !== projection.data.baseline.payoffPeriod && (
                    <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                      <Icon name="info" size={12} /> Esta projeção usa a taxa cadastrada de cada dívida. Pelo cronograma dos contratos, você fica livre em{' '}
                      {v2.data.freeOn ? fmtPeriodLong(v2.data.freeOn) : 'data nenhuma'} (veja "Quando fico livre"); a diferença some quando a taxa bate com o contrato.
                    </p>
                  )}
                  {(() => {
                    const perDebt = (extraMonthlyCents > 0 ? projection.data.accelerated : projection.data.baseline).perDebt ?? []
                    if (perDebt.length < 2) return null
                    return (
                      <>
                        <hr className="divider" />
                        <div className="stack stack--tight">
                          <span className="label">Quando cada uma acaba</span>
                          {[...perDebt]
                            .sort((a, b) => (a.months ?? Infinity) - (b.months ?? Infinity))
                            .map((d) => (
                              <span key={d.debtId} className="row row--between" style={{ fontSize: 'var(--text-sm)', gap: 'var(--sp-3)' }}>
                                <span className="muted truncate">{d.name}</span>
                                <span className="tabular">
                                  {monthsLabel(d.months)} · juros {money(d.interestCents)}
                                </span>
                              </span>
                            ))}
                        </div>
                      </>
                    )
                  })()}
                  <hr className="divider" />
                  <div className="stack stack--tight">
                    <span className="label">Sem aporte extra</span>
                    <span className="row row--between" style={{ fontSize: 'var(--text-sm)' }}>
                      <span className="muted">Tempo até quitar</span>
                      <span className="tabular">{monthsLabel(projection.data.baseline.months)}</span>
                    </span>
                    <span className="row row--between" style={{ fontSize: 'var(--text-sm)' }}>
                      <span className="muted">Juros no caminho</span>
                      <span className="tabular">{money(projection.data.baseline.totalInterestCents)}</span>
                    </span>
                  </div>
                  {projection.data.baseline.months === null && (
                    <p className="field__error">
                      <Icon name="alert" size={12} /> Com os pagamentos atuais o saldo não cai: as
                      parcelas não cobrem os juros.
                    </p>
                  )}
                </>
              ) : (
                <EmptyState title="Calculando projeção…" />
              )}
            </Card>

            <Card
              span={12}
              title="Trajetória até a quitação"
              subtitle="Mova o aporte extra para comparar cenários"
            >
              <div className="row row--wrap" style={{ gap: 'var(--sp-4)' }}>
                <div className="grow" style={{ minWidth: 240 }}>
                  <label className="field__label" htmlFor="extra-slider">
                    Aporte extra por mês: <strong>{money(extraMonthlyCents)}</strong>
                  </label>
                  <input
                    id="extra-slider"
                    type="range"
                    min={0}
                    max={EXTRA_STEPS.length - 1}
                    step={1}
                    value={extraIndex}
                    onChange={(event) => setExtraIndex(Number(event.target.value))}
                    style={{ width: '100%', accentColor: 'var(--brand)' }}
                  />
                </div>
                <div className="field" style={{ minWidth: 190 }}>
                  <label className="field__label" htmlFor={strategyFieldId}>Estratégia</label>
                  <Select
                    id={strategyFieldId}
                    value={strategy}
                    options={[
                      { value: 'avalanche', label: 'Avalanche (maior taxa)' },
                      { value: 'snowball', label: 'Bola de neve (menor saldo)' },
                    ]}
                    onChange={(value) => setStrategy((value as 'avalanche' | 'snowball') ?? 'avalanche')}
                  />
                </div>
              </div>

              <DebtProjectionChart
                data={projection.data?.merged ?? []}
                surface="paper"
                height={280}
                extraMonthlyCents={extraMonthlyCents}
                strategy={strategy}
              />
            </Card>

            {v2.data && (
              <RenegotiationCard
                v2={v2.data}
                debts={data.debts}
                onRegister={(next) => {
                  setPrefill(next)
                  setEditing('new')
                }}
              />
            )}

            <Card
              span={12}
              title="Evolução da dívida"
              subtitle="Saldo total medido ao longo do tempo, por registro de saldo, pagamento ou uso"
            >
              <DebtHistoryChart points={data.trend} surface="paper" />
            </Card>

            <ReconciliationQueueCard
              queue={reconciliation.data}
              isLoading={reconciliation.isLoading}
              onDetail={setMismatchDetail}
            />

            <Card span={12} flush title="Dívidas cadastradas">
              <div className="table-wrap">
                <table className="table table--stack-mobile">
                  <thead>
                    <tr>
                      <th scope="col">Dívida</th>
                      <th scope="col">Tipo</th>
                      <th scope="col" className="table__num">Saldo</th>
                      <th scope="col" className="table__num">Taxa efetiva</th>
                      <th scope="col" className="table__num">Juros/mês</th>
                      <th scope="col" className="table__num">Mínimo</th>
                      <th scope="col" className="table__num">Programado</th>
                      <th scope="col" className="table__center">Parcelas</th>
                      <th scope="col" className="table__num">Share</th>
                      <th scope="col" style={{ width: 108 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {data.debts.map((debt) => (
                      <tr key={debt.id}>
                        <td data-label="Dívida">
                          <span className="row" style={{ gap: 'var(--sp-2)' }}>
                            <span className="swatch" style={{ background: KIND_COLOR[debt.kind] ?? '#71717a' }} />
                            <span>
                              <strong>{debt.name}</strong>
                              {debt.institution && (
                                <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                                  {' '}
                                  · {debt.institution}
                                </span>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="muted" data-label="Tipo">{KIND_LABEL[debt.kind] ?? debt.kind}</td>
                        <td className="table__num" data-label="Saldo">{money(debt.balanceCents)}</td>
                        <td className="table__num" data-label="Taxa efetiva">
                          {bps(debt.aprBps)} a.a.
                          <span className="muted" style={{ display: 'block', fontSize: 'var(--text-2xs)' }}>
                            {bps(debt.monthlyRateBps)} a.m.
                          </span>
                        </td>
                        <td className="table__num neg" data-label="Juros/mês">{money(debt.monthlyInterestCents)}</td>
                        <td className="table__num" data-label="Mínimo">{money(debt.minimumPaymentCents)}</td>
                        <td className="table__num" data-label="Programado">{money(debt.scheduledPaymentCents)}</td>
                        <td className="table__center" data-label="Parcelas">
                          <button
                            type="button"
                            className="badge"
                            style={{ cursor: 'pointer' }}
                            onClick={() => setPaymentHistory(debt)}
                            title="Ver histórico de pagamentos"
                          >
                            {debt.installmentCount === null
                              ? `${debt.installmentsPaid} pagas`
                              : `${debt.installmentsPaid} / ${debt.installmentCount}`}
                          </button>
                        </td>
                        <td className="table__num muted" data-label="Share">{bps(debt.shareBps, 0)}</td>
                        <td data-label="__trail">
                          <div className="row" style={{ gap: 2 }}>
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="plus"
                              onClick={() => setPaymentModal(debt)}
                              title="Registrar pagamento"
                            />
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="pencil"
                              onClick={() => setEditing(debt)}
                              title="Editar"
                            />
                            <DeleteDebtButton debtId={debt.id} name={debt.name} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {data.closedDebts.length > 0 && (
              <Card
                span={12}
                flush
                title="Encerradas"
                subtitle="Quitadas, renegociadas num acordo ou encerradas à mão"
              >
                <div className="table-wrap">
                  <table className="table table--stack-mobile">
                    <thead>
                      <tr>
                        <th scope="col">Dívida</th>
                        <th scope="col">Tipo</th>
                        <th scope="col" className="table__center">Parcelas</th>
                        <th scope="col" className="table__num">Total pago</th>
                        <th scope="col">Encerrada em</th>
                        <th scope="col" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.closedDebts.map((debt) => (
                        <tr key={debt.id}>
                          <td data-label="Dívida">
                            <span className="row" style={{ gap: 'var(--sp-2)' }}>
                              <span className="swatch" style={{ background: KIND_COLOR[debt.kind] ?? '#71717a' }} />
                              <strong>{debt.name}</strong>
                            </span>
                          </td>
                          <td className="muted" data-label="Tipo">{KIND_LABEL[debt.kind] ?? debt.kind}</td>
                          <td className="table__center" data-label="Parcelas">
                            <button
                              type="button"
                              className="badge"
                              style={{ cursor: 'pointer' }}
                              onClick={() => setPaymentHistory(debt)}
                              title="Ver histórico de pagamentos"
                            >
                              {debt.installmentCount === null ? '-' : `${debt.installmentCount} / ${debt.installmentCount}`}
                            </button>
                          </td>
                          <td className="table__num" data-label="Total pago">{money(debt.totalPaidCents)}</td>
                          <td className="muted" data-label="Encerrada em">
                            {debt.closedOn ? fmtDate(debt.closedOn) : '-'}
                            {debt.closedReason && <span className="badge" style={{ marginLeft: 6 }}>{CLOSED_REASON_LABEL[debt.closedReason]}</span>}
                          </td>
                          <td data-label="__trail">
                            <div className="row" style={{ gap: 2 }}>
                              <Button
                                variant="quiet"
                                size="sm"
                                icon="pencil"
                                onClick={() => setEditing(debt)}
                                title="Editar"
                              />
                              <DeleteDebtButton debtId={debt.id} name={debt.name} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </Bento>
        )}
      </div>

      {editing !== null && (
        <DebtModal
          debt={editing === 'new' ? null : editing}
          prefill={editing === 'new' ? prefill : null}
          activeDebts={data?.debts ?? []}
          onClose={() => {
            setEditing(null)
            setPrefill(null)
          }}
        />
      )}
      {paymentModal && <DebtPaymentModal debt={paymentModal} onClose={() => setPaymentModal(null)} />}
      {paymentHistory && (
        <DebtPaymentHistoryModal debt={paymentHistory} onClose={() => setPaymentHistory(null)} />
      )}
      {mismatchDetail && (
        <ValueMismatchDetailModal mismatch={mismatchDetail} onClose={() => setMismatchDetail(null)} />
      )}
    </>
  )
}

/**
 * Fila de conciliação (specs/debt-reconciliation): dois tipos de item, um
 * card só, para não precisar caçar cada caso espalhado pelo app.
 *
 * "Match sugerido" reaproveita reconciliationCandidates/confirm-match/
 * dismiss — as MESMAS rotas que o card "Possíveis conciliações" do Painel
 * já usa (`src/pages/Dashboard.tsx`), aqui filtradas para pendências
 * ligadas a uma dívida. Confirmar ou rejeitar aqui também limpa a
 * sugestão de lá, porque é a mesma linha no banco.
 *
 * "Divergência de valor" não tem match para confirmar — é uma
 * discrepância entre dois registros que já existem (o que Endividamento
 * anotou como pago vs. o que o extrato mostra), então só oferece "Ver
 * detalhes".
 */
function ReconciliationQueueCard({
  queue,
  isLoading,
  onDetail,
}: {
  queue: ReconciliationQueue | undefined
  isLoading: boolean
  onDetail: (mismatch: ValueMismatch) => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['debt-reconciliation'] }),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  if (isLoading) {
    return (
      <Card span={12} title="Fila de conciliação">
        <SkeletonLines lines={2} />
      </Card>
    )
  }

  const matches = queue?.suggestedMatches ?? []
  const mismatches = queue?.valueMismatches ?? []
  if (matches.length === 0 && mismatches.length === 0) return null

  return (
    <Card
      span={12}
      title="Fila de conciliação"
      subtitle="Sugestões e divergências entre o extrato e o que está registrado; nada muda de status sem confirmação"
    >
      <div className="stack stack--loose">
        {matches.map(({ pending, match, debtName }) => (
          <div
            key={`${pending.id}-${match.id}`}
            className="row row--between row--wrap"
            style={{ gap: 'var(--sp-3)' }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              {/* Sem truncate (revisão de responsividade de 26/09/2026):
                  nome da dívida competindo com o badge cortava num telefone. */}
              <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                <strong style={{ minWidth: 0 }}>{debtName}</strong>
                <span className="badge badge--warning">Match sugerido</span>
              </span>
              <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                {match.description} · recebido em {fmtDate(match.postedOn)}
              </div>
            </div>
            <span className="row row--wrap" style={{ gap: 'var(--sp-2) var(--sp-3)' }}>
              <span className="stack" style={{ gap: 0 }}>
                <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                  cadastrado / CSV
                </span>
                <strong className="tabular">{money(Math.abs(pending.amountCents))}</strong>
              </span>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                onClick={() => confirm.mutate({ pendingId: pending.id, matchId: match.id })}
                disabled={confirm.isPending}
              >
                Confirmar match
              </Button>
              <Button
                variant="quiet"
                size="sm"
                icon="x"
                title="Não é o mesmo, remover esta sugestão"
                onClick={() => dismiss.mutate({ pendingId: pending.id, matchId: match.id })}
                disabled={dismiss.isPending}
              />
            </span>
          </div>
        ))}

        {mismatches.map((mismatch) => (
          <div key={mismatch.debtId} className="row row--between row--wrap" style={{ gap: 'var(--sp-3)' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              {/* Sem truncate (revisão de responsividade de 26/09/2026):
                  nome da dívida competindo com o badge cortava num telefone. */}
              <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                <strong style={{ minWidth: 0 }}>{mismatch.debtName}</strong>
                <span className="badge badge--critical">Divergência de valor</span>
              </span>
              <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                {mismatch.paymentCount} pagamento(s) registrado(s) · {mismatch.confirmedTransactionCount} lançamento(s) confirmado(s) no extrato
              </div>
            </div>
            <span className="row row--wrap" style={{ gap: 'var(--sp-2) var(--sp-3)' }}>
              <span className="stack" style={{ gap: 0 }}>
                <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                  cadastrado
                </span>
                <strong className="tabular">{money(mismatch.registeredAmountCents)}</strong>
              </span>
              <span className="stack" style={{ gap: 0 }}>
                <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                  extrato
                </span>
                <strong className="tabular">{money(mismatch.confirmedAmountCents)}</strong>
              </span>
              <span className="stack" style={{ gap: 0 }}>
                <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                  diferença
                </span>
                <strong className="tabular neg">
                  {mismatch.diffCents >= 0 ? '+' : ''}
                  {money(mismatch.diffCents)}
                </strong>
              </span>
              <Button size="sm" icon="search" onClick={() => onDetail(mismatch)}>
                Ver detalhes
              </Button>
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function ValueMismatchDetailModal({ mismatch, onClose }: { mismatch: ValueMismatch; onClose: () => void }) {
  return (
    <Modal
      title={`Divergência: ${mismatch.debtName}`}
      onClose={onClose}
      footer={
        <Button variant="quiet" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className="stack">
        <p className="chart__note">
          Endividamento registrou {money(mismatch.registeredAmountCents)} em {mismatch.paymentCount}{' '}
          pagamento(s); o extrato confirma {money(mismatch.confirmedAmountCents)} em{' '}
          {mismatch.confirmedTransactionCount} lançamento(s) ligado(s) a esta dívida. Os dois lados não
          guardam qual pagamento corresponde a qual lançamento, então a comparação é pelo total: confira
          as duas listas abaixo.
        </p>

        <div className="row row--wrap" style={{ gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <span className="stat__label">Registrado em Endividamento</span>
            <div className="table-wrap" style={{ marginTop: 'var(--sp-2)' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Data</th>
                    <th scope="col" className="table__num">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {mismatch.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="tabular">{fmtDate(p.paidOn)}</td>
                      <td className="table__num">{money(p.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 220 }}>
            <span className="stat__label">Confirmado no extrato</span>
            <div className="table-wrap" style={{ marginTop: 'var(--sp-2)' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Data</th>
                    <th scope="col" className="table__num">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {mismatch.confirmedTransactions.map((t) => (
                    <tr key={t.id}>
                      <td className="tabular">{fmtDate(t.postedOn)}</td>
                      <td className="table__num">{money(Math.abs(t.amountCents))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** A direct delete action in the row, alongside "editar" — the modal keeps its own "Remover" too. */
function DeleteDebtButton({ debtId, name }: { debtId: number; name: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)

  const remove = useMutation({
    mutationFn: () => api.del(`/debts/${debtId}`),
    onSuccess: () => {
      toast(`${name} removida`)
      queryClient.invalidateQueries()
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
        title="Excluir dívida"
      />
      {confirming && (
        <ConfirmDeleteModal
          title={`Excluir ${name}?`}
          body="Pagamentos e saldos registrados para esta dívida também são apagados. Isso não pode ser desfeito."
          confirmLabel="Excluir dívida"
          pending={remove.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => remove.mutate()}
        />
      )}
    </>
  )
}

/**
 * Taxa cadastrada × contrato (revisão de 08/10/2026): numa dívida de
 * parcela fixa, saldo, parcela e parcelas restantes já determinam a taxa.
 * Quando a cadastrada passa longe dela, juros por mês, prazo e projeção
 * saem errados; o card mostra a diferença e abre a edição, sem mudar nada
 * sozinho.
 */
function DebtModal({
  debt,
  prefill,
  activeDebts,
  onClose,
}: {
  debt: DebtRow | null
  /** acordo vindo do simulador de proposta (specs/debt-v2) */
  prefill?: AgreementPrefill | null
  activeDebts: DebtRow[]
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [name, setName] = useState(debt?.name ?? prefill?.name ?? '')
  const [kind, setKind] = useState(debt?.kind ?? (prefill ? 'personal_loan' : 'credit_card'))
  /** TAG das parcelas; na dívida nova, vazio = o servidor usa "Financeiro › Empréstimos" */
  const [categoryId, setCategoryId] = useState<number | null>(debt?.categoryId ?? null)
  /** "Este acordo renegocia": dívidas de origem que o acordo encerra como renegociadas */
  const [origins, setOrigins] = useState<Set<number>>(() => new Set(prefill?.originDebtIds ?? []))
  const categoryFieldId = useId()
  /** Paga na fatura do cartão: não lança pendência na conta e conta uma vez no Endividamento */
  const [paidViaCardId, setPaidViaCardId] = useState<number | null>(debt?.paidViaCardId ?? null)
  const cardFieldId = useId()
  const cardOptions = useQuery({
    queryKey: ['credit-cards'],
    queryFn: () => api.get<{ cards: Array<{ id: number; name: string }> }>('/credit-cards'),
  })
  const [institution, setInstitution] = useState(debt?.institution ?? '')
  /**
   * Contrato amortizado (SAC ou Price, só em Financiamento): o campo de
   * valor edita o PRINCIPAL do contrato, base do cronograma, e não o saldo
   * de hoje, que sai do cronograma pelas parcelas pagas. Editar o saldo ali
   * reiniciaria o cronograma a partir dele.
   */
  const [amortization, setAmortization] = useState<AmortizationSystem | null>(debt?.amortization ?? null)
  const [fees, setFees] = useState(centsToInput(debt?.monthlyFeesCents || null))
  const amortized = kind === 'financing' && amortization !== null
  const [balance, setBalance] = useState(centsToInput((debt?.amortization ? debt.principalCents : debt?.balanceCents) ?? prefill?.principalCents ?? null))
  /**
   * A taxa é GRAVADA sempre como efetiva anual, mas pode ser DIGITADA ao
   * mês, que é como cartão rotativo e cheque especial são publicados no
   * Brasil. Sem isso, o caminho natural do usuário era multiplicar a taxa
   * mensal por 12 e digitar o resultado como se fosse anual, o que produz
   * uma taxa nominal onde o cálculo espera uma efetiva: 14% a.m. viram
   * "168% a.a." e o app passa a calcular 8,55% a.m., 39% menos juro do que
   * o real, com a projeção de quitação errando por anos.
   */
  const [rateBasis, setRateBasis] = useState<'annual' | 'monthly'>('annual')
  const [apr, setApr] = useState(bpsToInput(debt?.aprBps ?? prefill?.aprBps ?? null))
  const [minimum, setMinimum] = useState(centsToInput(debt?.minimumPaymentCents ?? null))
  const [scheduled, setScheduled] = useState(centsToInput(debt?.scheduledPaymentCents ?? prefill?.scheduledPaymentCents ?? null))
  const [dueDay, setDueDay] = useState(String(debt?.dueDay ?? 10))
  const [installments, setInstallments] = useState(
    debt?.installmentCount !== null && debt?.installmentCount !== undefined
      ? String(debt.installmentCount)
      : prefill?.installmentCount
        ? String(prefill.installmentCount)
        : '',
  )
  const [accountId, setAccountId] = useState<number | null>(debt?.accountId ?? null)
  const accounts = useAccounts()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const nameFieldId = useId()
  const kindFieldId = useId()
  const institutionFieldId = useId()
  const balanceFieldId = useId()
  const minimumFieldId = useId()
  const scheduledFieldId = useId()
  const installmentsFieldId = useId()
  const dueDayFieldId = useId()
  const accountFieldId = useId()
  const amortizationFieldId = useId()
  const feesFieldId = useId()

  const save = useMutation({
    mutationFn: async () => {
      const principalCents = parseMoneyInput(balance)
      const typedBps = parsePercentInput(apr)
      if (principalCents === null) throw new Error('informe o saldo')
      if (typedBps === null) throw new Error('informe a taxa de juros')
      // Uma única unidade canônica no banco, sempre: taxa efetiva anual.
      const aprBps = rateBasis === 'monthly' ? annualRateBpsFromMonthly(Math.abs(typedBps)) : typedBps
      const installmentCount = installments.trim() ? Math.abs(Math.round(Number(installments))) : null
      if (amortized && !installmentCount) throw new Error('informe o número de parcelas do contrato')
      const body = {
        name: name.trim(),
        kind,
        institution: institution.trim() || null,
        principalCents: Math.abs(principalCents),
        aprBps: Math.abs(aprBps),
        minimumPaymentCents: Math.abs(parseMoneyInput(minimum) ?? 0),
        scheduledPaymentCents: Math.abs(parseMoneyInput(scheduled) ?? 0),
        dueDay: Math.min(31, Math.max(1, Math.round(Number(dueDay)) || 10)),
        installmentCount,
        accountId,
        amortization: amortized ? amortization : null,
        monthlyFeesCents: amortized ? Math.abs(parseMoneyInput(fees) ?? 0) : 0,
        // Na edição, vazio = sem TAG; na dívida nova, vazio deixa o servidor escolher a padrão.
        ...(debt || categoryId !== null ? { categoryId } : {}),
        paidViaCardId,
      }
      const saved = debt ? await api.patch<{ id: number }>(`/debts/${debt.id}`, body) : await api.post<{ id: number }>('/debts', body)
      if (origins.size > 0) await api.post(`/debts/${saved.id}/renegotiation`, { originDebtIds: [...origins] })
      return saved
    },
    onSuccess: async () => {
      if (!debt) telemetry.action('debt', 'debt_created')
      toast(origins.size > 0 ? 'Acordo registrado; as dívidas de origem saíram da lista como renegociadas' : debt ? 'Dívida atualizada' : 'Dívida cadastrada')
      // Awaited: se o modal reabrir antes do refetch, ele reidrata do cache
      // (ainda com o dado pré-edição) e a próxima edição sobrescreve esta.
      await queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const remove = useMutation({
    mutationFn: () => api.del(`/debts/${debt!.id}`),
    onSuccess: () => {
      toast('Dívida removida')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  const updateBalance = useMutation({
    mutationFn: () =>
      api.post(`/debts/${debt!.id}/snapshot`, {
        balanceCents: Math.abs(parseMoneyInput(balance) ?? 0),
      }),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao registrar saldo', 'error'),
    onSuccess: () => {
      toast('Saldo registrado: o histórico da dívida usa esta medição')
      queryClient.invalidateQueries()
      onClose()
    },
  })

  /**
   * Mostra a taxa na OUTRA unidade enquanto o usuário digita. É o que faz
   * uma taxa absurda se denunciar sozinha: "180% ao ano" aparecendo como
   * "8,88% ao mês" é imediatamente reconhecível como pequeno demais para
   * um rotativo, enquanto "180" sozinho não diz nada.
   */
  const typedRateBps = parsePercentInput(apr)
  // Só na dívida nova: um acordo existente já encerrou as origens dele.
  const renegotiable = debt ? [] : activeDebts
  // Prévia do cronograma: 1ª e última parcela do contrato como está digitado.
  const preview = (() => {
    if (!amortized) return null
    const principalCents = parseMoneyInput(balance)
    const count = installments.trim() ? Math.abs(Math.round(Number(installments))) : 0
    if (principalCents === null || typedRateBps === null || count <= 0) return null
    const aprBps = rateBasis === 'monthly' ? annualRateBpsFromMonthly(Math.abs(typedRateBps)) : Math.abs(typedRateBps)
    const all = installmentsCents({
      principalCents: Math.abs(principalCents),
      aprBps,
      installmentCount: count,
      amortization,
      monthlyFeesCents: Math.abs(parseMoneyInput(fees) ?? 0),
    })
    return all.length ? { first: all[0]!, last: all.at(-1)! } : null
  })()
  const aprHint =
    typedRateBps === null
      ? 'Taxa efetiva, não nominal. Cartão rotativo passa de 14% ao mês.'
      : rateBasis === 'annual'
        ? `Efetiva ao ano, equivale a ${bpsToInput(monthlyRateBpsFromAnnual(Math.abs(typedRateBps)))}% ao mês.`
        : `Gravada como ${bpsToInput(annualRateBpsFromMonthly(Math.abs(typedRateBps)))}% efetivos ao ano.`

  if (confirmingDelete) {
    return (
      <ConfirmDeleteModal
        title={`Excluir ${debt!.name}?`}
        body="Pagamentos e saldos registrados para esta dívida também são apagados. Isso não pode ser desfeito."
        confirmLabel="Excluir dívida"
        pending={remove.isPending}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => remove.mutate()}
      />
    )
  }

  return (
    <Modal
      title={debt ? `Editar ${debt.name}` : 'Nova dívida'}
      onClose={onClose}
      footer={
        <>
          {debt ? (
            <Button variant="danger" icon="trash" onClick={() => setConfirmingDelete(true)}>
              Remover
            </Button>
          ) : (
            <span />
          )}
          <div className="row">
            {/* Contrato amortizado: o saldo vem do cronograma, e o campo é o principal. */}
            {debt && !amortized && (
              <Button icon="clock" onClick={() => updateBalance.mutate()}>
                Registrar saldo de hoje
              </Button>
            )}
            <Button
              variant="primary"
              icon="check"
              onClick={() => save.mutate()}
              disabled={!name.trim() || save.isPending}
            >
              Salvar
            </Button>
          </div>
        </>
      }
    >
      <div className="stack">
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label className="field__label" htmlFor={nameFieldId}>Nome</label>
            <TextInput id={nameFieldId} value={name} onChange={setName} placeholder="ex. Cartão Nubank" />
          </div>
          <div className="field" style={{ minWidth: 190 }}>
            <label className="field__label" htmlFor={kindFieldId}>Tipo</label>
            <Select
              id={kindFieldId}
              value={kind}
              options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))}
              onChange={(value) => setKind(value ?? 'credit_card')}
            />
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={institutionFieldId}>Instituição</label>
          <TextInput id={institutionFieldId} value={institution} onChange={setInstitution} placeholder="opcional" />
        </div>

        {kind === 'financing' && (
          <div className="field">
            <label className="field__label" htmlFor={amortizationFieldId}>Sistema de amortização</label>
            <Select
              id={amortizationFieldId}
              value={amortization ?? 'none'}
              options={[
                { value: 'none', label: 'Sem sistema (parcela fixa)' },
                { value: 'sac', label: 'SAC (parcela cai todo mês)' },
                { value: 'price', label: 'Price (parcela fixa, com juros e amortização)' },
              ]}
              onChange={(value) => setAmortization(value === 'sac' || value === 'price' ? value : null)}
            />
            <span className="field__hint">
              Com SAC ou Price, cada parcela sai do cronograma e o saldo cai só pela amortização.
            </span>
          </div>
        )}

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={balanceFieldId}>{amortized ? 'Valor financiado (R$)' : 'Saldo devedor (R$)'}</label>
            <TextInput id={balanceFieldId} value={balance} onChange={setBalance} placeholder="0,00" numeral />
            {amortized && debt && (
              <span className="field__hint">Saldo hoje pelo cronograma: {money(debt.balanceCents)}.</span>
            )}
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Taxa de juros (%)</label>
            <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
              <TextInput value={apr} onChange={setApr} placeholder="ex. 14" numeral />
              <div style={{ width: 132, flexShrink: 0 }}>
                <Select
                  value={rateBasis}
                  options={[
                    { value: 'annual', label: 'ao ano' },
                    { value: 'monthly', label: 'ao mês' },
                  ]}
                  onChange={(value) => {
                    const next = (value as 'annual' | 'monthly') ?? 'annual'
                    if (next === rateBasis) return
                    // Trocar a unidade não pode mudar a taxa: converte o
                    // que já está digitado em vez de reinterpretá-lo.
                    const typed = parsePercentInput(apr)
                    if (typed !== null) {
                      setApr(
                        bpsToInput(
                          next === 'monthly'
                            ? monthlyRateBpsFromAnnual(Math.abs(typed))
                            : annualRateBpsFromMonthly(Math.abs(typed)),
                        ),
                      )
                    }
                    setRateBasis(next)
                  }}
                />
              </div>
            </div>
            <span className="field__hint">{aprHint}</span>
          </div>
        </div>

        {amortized ? (
          <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label" htmlFor={feesFieldId}>Seguros e taxas por mês (R$)</label>
              <TextInput id={feesFieldId} value={fees} onChange={setFees} placeholder="0,00" numeral />
              <span className="field__hint">Somados a cada parcela; não abatem o saldo.</span>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <span className="field__label">Parcela</span>
              <span className="numeral" style={{ paddingBlock: 'var(--sp-2)' }}>
                {preview ? (amortization === 'sac' ? `${money(preview.first)} → ${money(preview.last)}` : money(preview.first)) : '-'}
              </span>
              <span className="field__hint">
                {amortization === 'sac' ? 'Da 1ª à última, calculada pelo cronograma.' : 'Calculada pelo cronograma.'}
              </span>
            </div>
          </div>
        ) : (
          <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label" htmlFor={minimumFieldId}>Pagamento mínimo (R$)</label>
              <TextInput id={minimumFieldId} value={minimum} onChange={setMinimum} placeholder="0,00" numeral />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label" htmlFor={scheduledFieldId}>Pagamento programado (R$)</label>
              <TextInput id={scheduledFieldId} value={scheduled} onChange={setScheduled} placeholder="0,00" numeral />
              <span className="field__hint">O que você realmente paga por mês.</span>
            </div>
          </div>
        )}

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ maxWidth: 220 }}>
            <label className="field__label" htmlFor={installmentsFieldId}>{amortized ? 'Nº de parcelas' : 'Nº de parcelas (opcional)'}</label>
            <TextInput id={installmentsFieldId} value={installments} onChange={setInstallments} placeholder="ex. 48" numeral />
            <span className="field__hint">
              {amortized
                ? 'O prazo do contrato, base do cronograma.'
                : 'Deixe em branco para dívida rotativa (cartão, cheque especial), sem número fixo de parcelas.'}
            </span>
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label className="field__label" htmlFor={dueDayFieldId}>Dia de vencimento</label>
            <TextInput id={dueDayFieldId} value={dueDay} onChange={setDueDay} placeholder="ex. 10" numeral />
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={accountFieldId}>Conta de pagamento</label>
          <Select
            id={accountFieldId}
            value={accountId}
            options={(accounts.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
            placeholder="Nenhuma"
            onChange={setAccountId}
          />
          <span className="field__hint">
            Lança as parcelas restantes como despesa pendente nessa conta, no dia de vencimento de cada mês.
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={cardFieldId}>Paga na fatura do cartão</label>
          <Select
            id={cardFieldId}
            value={paidViaCardId}
            options={(cardOptions.data?.cards ?? []).map((c) => ({ value: c.id, label: c.name }))}
            placeholder="Não, paga por uma conta"
            onChange={setPaidViaCardId}
          />
          <span className="field__hint">
            {paidViaCardId
              ? 'A parcela vem dentro da fatura: não vira pendência na conta, e o saldo dela sai do limite usado do cartão para contar uma vez.'
              : 'Para parcelamento ou acordo cobrado na fatura de um cartão.'}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={categoryFieldId}>TAG das parcelas</label>
          <CategorySelect id={categoryFieldId} value={categoryId} onChange={setCategoryId} direction="out" placeholder={debt ? 'Sem TAG' : 'Financeiro › Empréstimos (padrão)'} />
          <span className="field__hint">As parcelas pendentes entram com esta TAG, e com ela no grupo dela no Orçamento.</span>
        </div>

        {renegotiable.length > 0 && (
          <div className="field">
            <span className="field__label">Este acordo renegocia</span>
            <ul className="asset-pick">
              {renegotiable.map((d) => (
                <li key={d.id}>
                  <label className="asset-pick__row">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={origins.has(d.id)}
                      onChange={() =>
                        setOrigins((current) => {
                          const next = new Set(current)
                          if (next.has(d.id)) next.delete(d.id)
                          else next.add(d.id)
                          return next
                        })
                      }
                    />
                    <span className="asset-pick__name">{d.name}</span>
                    <span className="tabular muted">{money(d.balanceCents)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <span className="field__hint">
              As marcadas saem da lista como renegociadas (não quitadas), com o saldo de hoje guardado para medir o desconto e o custo do acordo.
            </span>
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 * Payment ledger — mirrors the investments trade modal: a log of real
 * events (parcela paga, novo uso/saque) the balance-snapshot mechanism
 * alone can't answer ("how many parcelas, when, how much").
 * ------------------------------------------------------------------ */
function DebtPaymentModal({ debt, onClose }: { debt: DebtRow; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState('payment')
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const paidOnFieldId = useId()
  const amountFieldId = useId()
  const notesFieldId = useId()

  const save = useMutation({
    mutationFn: () => {
      const amountCents = parseMoneyInput(amount)
      if (amountCents === null || amountCents <= 0) throw new Error('informe o valor')
      return api.post('/debts/payments', {
        debtId: debt.id,
        kind,
        paidOn,
        amountCents: Math.abs(amountCents),
        notes: notes.trim() || null,
      })
    },
    onSuccess: () => {
      toast(kind === 'payment' ? 'Pagamento registrado' : 'Novo uso registrado')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title={`Registrar lançamento de ${debt.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending} loading={save.isPending}>
            Registrar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="segmented" role="group" aria-label="Tipo de lançamento">
          {(
            [
              { value: 'payment', label: 'Pagamento', tone: 'pos' },
              { value: 'charge', label: 'Novo uso / saque', tone: 'neg' },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              className={`segmented__btn segmented__btn--${option.tone}`}
              aria-pressed={kind === option.value}
              onClick={() => setKind(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={paidOnFieldId}>Data</label>
            <TextInput id={paidOnFieldId} value={paidOn} onChange={setPaidOn} type="date" />
            {paidOn > todayIso() && (
              <p className="field__hint" role="status">
                Data no futuro: o pagamento já abate o saldo da dívida e entra nos totais desse mês.
              </p>
            )}
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label" htmlFor={amountFieldId}>Valor (R$)</label>
            <TextInput id={amountFieldId} value={amount} onChange={setAmount} placeholder="0,00" numeral />
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={notesFieldId}>Notas (opcional)</label>
          <TextInput id={notesFieldId} value={notes} onChange={setNotes} placeholder="ex. parcela 12 de 48" />
        </div>

        <p className="chart__note">
          {kind === 'payment'
            ? 'Conta como uma parcela paga, soma no contador "parcelas pagas" da dívida.'
            : 'Não conta como parcela, registra apenas um novo uso do limite (cartão) ou saque (cheque especial).'}
        </p>
      </div>
    </Modal>
  )
}

const DEBT_PAYMENT_KIND_LABEL: Record<string, string> = { payment: 'Pagamento', charge: 'Novo uso / saque' }

function DebtPaymentHistoryModal({ debt, onClose }: { debt: DebtRow; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const payments = useQuery({
    queryKey: ['debt-payments', debt.id],
    queryFn: () => api.get<{ payments: PaymentRow[] }>('/debts/payments', { debtId: debt.id }),
  })

  const [confirmingId, setConfirmingId] = useState<number | null>(null)

  const remove = useMutation({
    mutationFn: (id: number) => api.del<{ removed: number }>(`/debts/payments/${id}`),
    onSuccess: () => {
      toast('Lançamento removido')
      queryClient.invalidateQueries()
      setConfirmingId(null)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  const rows = payments.data?.payments ?? []
  const confirmingPayment = rows.find((p) => p.id === confirmingId) ?? null

  return (
    <Modal
      title={`Pagamentos de ${debt.name}`}
      onClose={onClose}
      footer={
        <Button variant="quiet" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      {payments.isError ? (
        <EmptyState
          icon="alert"
          title="Falha ao carregar"
          body="Não foi possível carregar os pagamentos agora. Tente novamente em instantes."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="list"
          title="Nenhum pagamento registrado"
          body="Registre cada parcela paga (ou novo uso) para acompanhar o progresso desta dívida."
        />
      ) : (
        <div className="table-wrap">
          <table className="table table--stack-mobile">
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Tipo</th>
                <th scope="col" className="table__num">Valor</th>
                <th scope="col">Notas</th>
                <th scope="col" style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td data-label="Data">{fmtDate(p.paidOn)}</td>
                  <td className="muted" data-label="Tipo">{DEBT_PAYMENT_KIND_LABEL[p.kind] ?? p.kind}</td>
                  <td className={`table__num ${p.kind === 'payment' ? 'pos' : 'neg'}`} data-label="Valor">{money(p.amountCents)}</td>
                  <td className="muted" data-label="Notas">{p.notes ?? '-'}</td>
                  <td data-label="__trail">
                    <Button
                      variant="quiet"
                      size="sm"
                      icon="trash"
                      onClick={() => setConfirmingId(p.id)}
                      disabled={remove.isPending}
                      title="Excluir lançamento"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirmingPayment && (
        <ConfirmDeleteModal
          title={`Excluir o lançamento de ${money(confirmingPayment.amountCents)} em ${fmtDate(confirmingPayment.paidOn)}?`}
          body="Isso não pode ser desfeito."
          confirmLabel="Excluir lançamento"
          pending={remove.isPending}
          onCancel={() => setConfirmingId(null)}
          onConfirm={() => remove.mutate(confirmingPayment.id)}
        />
      )}
    </Modal>
  )
}
