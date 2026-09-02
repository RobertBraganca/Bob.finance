import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { telemetry } from '../lib/telemetry'
import { useAccounts } from '../lib/store'
import {
  bps,
  bpsToInput,
  centsToInput,
  money,
  moneyCompact,
  monthsLabel,
  parseMoneyInput,
  parsePercentInput,
  date as fmtDate,
  period as fmtPeriod,
  periodLong as fmtPeriodLong,
} from '../lib/format'
import {
  Bento,
  Button,
  Card,
  EmptyState,
  FilterSelect,
  HeroFigure,
  Icon,
  Modal,
  Select,
  SkeletonLines,
  Slab,
  StatTile,
  TextInput,
  useToast,
} from '../components/ui'
import { SimulatorModal } from '../components/ui/SimulatorModal'
import { PageHeader } from '../components/shell/Shell'
import {
  DebtProjectionChart,
  DebtServiceGauge,
  PayoffSummary,
} from '../components/charts/DebtCharts'
import { CategoryRing } from '../components/charts/CategoryRing'

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
  shareBps: number
  installmentCount: number | null
  installmentsPaid: number
  installmentsRemaining: number | null
  lastPaymentOn: string | null
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

type Overview = {
  debts: DebtRow[]
  totalCents: number
  monthlyInterestCents: number
  minimumCents: number
  scheduledCents: number
  weightedAprBps: number
  monthlyIncomeCents: number
  debtToIncomeBps: number | null
  debtToAnnualIncomeBps: number | null
  period: string
  byKind: Array<{ kind: string; amountCents: number; shareBps: number }>
}

type Projection = {
  baseline: { months: number | null; totalInterestCents: number; payoffPeriod: string | null }
  accelerated: { months: number | null; totalInterestCents: number; payoffPeriod: string | null }
  merged: Array<{ month: number; period: string; baselineCents: number | null; acceleratedCents: number | null }>
  savings: { monthsSaved: number | null; interestSavedCents: number }
}

const EXTRA_STEPS = [0, 10_000, 25_000, 50_000, 100_000, 200_000, 500_000]

/** Last 24 calendar months (oldest first), skipping the current one — it's still accruing and would understate "renda comprometida" if picked. */
function recentClosedMonths(count: number): string[] {
  const now = new Date()
  const months: string[] = []
  for (let i = 1; i <= count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return months.reverse()
}

export function DebtPage() {
  const [extraIndex, setExtraIndex] = useState(0)
  const [editing, setEditing] = useState<DebtRow | 'new' | null>(null)
  const [simulating, setSimulating] = useState(false)
  const [strategy, setStrategy] = useState<'avalanche' | 'snowball'>('avalanche')
  const monthOptions = useState(() => recentClosedMonths(24))[0]
  const [period, setPeriod] = useState(() => monthOptions[monthOptions.length - 1]!)
  const [paymentModal, setPaymentModal] = useState<DebtRow | null>(null)
  const [paymentHistory, setPaymentHistory] = useState<DebtRow | null>(null)

  const extraMonthlyCents = EXTRA_STEPS[extraIndex] ?? 0

  const overview = useQuery({
    queryKey: ['debts', period],
    queryFn: () => api.get<Overview>('/debts', { period }),
  })

  const projection = useQuery({
    queryKey: ['debt-projection', extraMonthlyCents, strategy],
    queryFn: () => api.get<Projection>('/debts/projection', { extraMonthlyCents, strategy }),
    enabled: (overview.data?.debts.length ?? 0) > 0,
    placeholderData: (previous) => previous,
  })

  const data = overview.data

  return (
    <>
      <PageHeader
        title="Endividamento"
        subtitle="Composição, custo dos juros e trajetória até a quitação"
        actions={
          <div className="row">
            <Button size="sm" icon="sparkle" onClick={() => setSimulating(true)}>
              Simular quitação
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              Cadastrar dívida
            </Button>
          </div>
        }
      />

      <div className="page">
        {!data ? (
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
            <Slab span={4} accent>
              <HeroFigure label="Dívida total" value={moneyCompact(data.totalCents)}>
                <div className="kv" style={{ marginTop: 'var(--sp-3)' }}>
                  <span className="kv__k">Juros por mês</span>
                  <span className="kv__v">{money(data.monthlyInterestCents)}</span>
                  <span className="kv__k">Taxa média ponderada</span>
                  <span className="kv__v">{bps(data.weightedAprBps)} a.a.</span>
                  <span className="kv__k">Pagamento programado</span>
                  <span className="kv__v">{money(data.scheduledCents)}</span>
                </div>
              </HeroFigure>
            </Slab>

            <Slab
              span={4}
              title="Renda comprometida"
              subtitle="Parcela mensal sobre a renda daquele mês"
              actions={
                <FilterSelect
                  icon="clock"
                  value={period}
                  onChange={(value) => setPeriod(value ?? period)}
                  options={monthOptions.map((m) => ({ value: m, label: fmtPeriod(m) }))}
                />
              }
            >
              <DebtServiceGauge
                ratioBps={data.debtToIncomeBps}
                surface="paper"
                caption={
                  data.monthlyIncomeCents > 0
                    ? `${money(data.scheduledCents)} de ${money(data.monthlyIncomeCents)} de renda em ${fmtPeriodLong(data.period)}`
                    : `Sem renda registrada em ${fmtPeriodLong(data.period)}`
                }
              />
            </Slab>

            <Slab span={4} title="Composição" subtitle="Saldo por tipo de dívida">
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

            <Card
              span={8}
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
                  <label className="field__label">Estratégia</label>
                  <Select
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
              />
            </Card>

            <Card span={4} title="O que muda com o aporte">
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
                  />
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

            <Card span={12} flush title="Dívidas cadastradas">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Dívida</th>
                      <th>Tipo</th>
                      <th className="table__num">Saldo</th>
                      <th className="table__num">Taxa a.a.</th>
                      <th className="table__num">Juros/mês</th>
                      <th className="table__num">Mínimo</th>
                      <th className="table__num">Programado</th>
                      <th className="table__center">Parcelas</th>
                      <th className="table__num">Share</th>
                      <th style={{ width: 108 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {data.debts.map((debt) => (
                      <tr key={debt.id}>
                        <td>
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
                        <td className="muted">{KIND_LABEL[debt.kind] ?? debt.kind}</td>
                        <td className="table__num">{money(debt.balanceCents)}</td>
                        <td className="table__num">{bps(debt.aprBps)}</td>
                        <td className="table__num neg">{money(debt.monthlyInterestCents)}</td>
                        <td className="table__num">{money(debt.minimumPaymentCents)}</td>
                        <td className="table__num">{money(debt.scheduledPaymentCents)}</td>
                        <td className="table__center">
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
                        <td className="table__num muted">{bps(debt.shareBps, 0)}</td>
                        <td>
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
          </Bento>
        )}
      </div>

      {simulating && <SimulatorModal initialKind="payoff" onClose={() => setSimulating(false)} />}
      {editing !== null && (
        <DebtModal debt={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {paymentModal && <DebtPaymentModal debt={paymentModal} onClose={() => setPaymentModal(null)} />}
      {paymentHistory && (
        <DebtPaymentHistoryModal debt={paymentHistory} onClose={() => setPaymentHistory(null)} />
      )}
    </>
  )
}

/** A direct delete action in the row, alongside "editar" — the modal keeps its own "Remover" too. */
function DeleteDebtButton({ debtId, name }: { debtId: number; name: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const remove = useMutation({
    mutationFn: () => api.del(`/debts/${debtId}`),
    onSuccess: () => {
      toast(`${name} removida`)
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
      title="Excluir dívida"
    />
  )
}

function DebtModal({ debt, onClose }: { debt: DebtRow | null; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [name, setName] = useState(debt?.name ?? '')
  const [kind, setKind] = useState(debt?.kind ?? 'credit_card')
  const [institution, setInstitution] = useState(debt?.institution ?? '')
  const [balance, setBalance] = useState(centsToInput(debt?.balanceCents ?? null))
  const [apr, setApr] = useState(bpsToInput(debt?.aprBps ?? null))
  const [minimum, setMinimum] = useState(centsToInput(debt?.minimumPaymentCents ?? null))
  const [scheduled, setScheduled] = useState(centsToInput(debt?.scheduledPaymentCents ?? null))
  const [dueDay, setDueDay] = useState(String(debt?.dueDay ?? 10))
  const [installments, setInstallments] = useState(
    debt?.installmentCount !== null && debt?.installmentCount !== undefined ? String(debt.installmentCount) : '',
  )
  const [accountId, setAccountId] = useState<number | null>(debt?.accountId ?? null)
  const accounts = useAccounts()

  const save = useMutation({
    mutationFn: () => {
      const principalCents = parseMoneyInput(balance)
      const aprBps = parsePercentInput(apr)
      if (principalCents === null) throw new Error('informe o saldo')
      if (aprBps === null) throw new Error('informe a taxa anual')
      const installmentCount = installments.trim() ? Math.abs(Math.round(Number(installments))) : null
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
      }
      return debt ? api.patch(`/debts/${debt.id}`, body) : api.post('/debts', body)
    },
    onSuccess: async () => {
      if (!debt) telemetry.action('debt', 'debt_created')
      toast(debt ? 'Dívida atualizada' : 'Dívida cadastrada')
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

  return (
    <Modal
      title={debt ? `Editar ${debt.name}` : 'Nova dívida'}
      onClose={onClose}
      footer={
        <>
          {debt ? (
            <Button variant="danger" icon="trash" onClick={() => remove.mutate()}>
              Remover
            </Button>
          ) : (
            <span />
          )}
          <div className="row">
            {debt && (
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
            <label className="field__label">Nome</label>
            <TextInput value={name} onChange={setName} placeholder="ex. Cartão Nubank" />
          </div>
          <div className="field" style={{ minWidth: 190 }}>
            <label className="field__label">Tipo</label>
            <Select
              value={kind}
              options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))}
              onChange={(value) => setKind(value ?? 'credit_card')}
            />
          </div>
        </div>

        <div className="field">
          <label className="field__label">Instituição</label>
          <TextInput value={institution} onChange={setInstitution} placeholder="opcional" />
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Saldo devedor (R$)</label>
            <TextInput value={balance} onChange={setBalance} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Taxa anual (%)</label>
            <TextInput value={apr} onChange={setApr} placeholder="ex. 180" numeral />
            <span className="field__hint">Nominal ao ano; cartão rotativo passa de 300%.</span>
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Pagamento mínimo (R$)</label>
            <TextInput value={minimum} onChange={setMinimum} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Pagamento programado (R$)</label>
            <TextInput value={scheduled} onChange={setScheduled} placeholder="0,00" numeral />
            <span className="field__hint">O que você realmente paga por mês.</span>
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ maxWidth: 220 }}>
            <label className="field__label">Nº de parcelas (opcional)</label>
            <TextInput value={installments} onChange={setInstallments} placeholder="ex. 48" numeral />
            <span className="field__hint">
              Deixe em branco para dívida rotativa (cartão, cheque especial), sem número fixo de parcelas.
            </span>
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label className="field__label">Dia de vencimento</label>
            <TextInput value={dueDay} onChange={setDueDay} placeholder="ex. 10" numeral />
          </div>
        </div>

        <div className="field">
          <label className="field__label">Conta de pagamento</label>
          <Select
            value={accountId}
            options={(accounts.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
            placeholder="Nenhuma"
            onChange={setAccountId}
          />
          <span className="field__hint">
            Lança as parcelas restantes como despesa pendente nessa conta, no dia de vencimento de cada mês.
          </span>
        </div>
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
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending}>
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
            <label className="field__label">Data</label>
            <TextInput value={paidOn} onChange={setPaidOn} type="date" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Valor (R$)</label>
            <TextInput value={amount} onChange={setAmount} placeholder="0,00" numeral />
          </div>
        </div>

        <div className="field">
          <label className="field__label">Notas (opcional)</label>
          <TextInput value={notes} onChange={setNotes} placeholder="ex. parcela 12 de 48" />
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

  const remove = useMutation({
    mutationFn: (id: number) => api.del<{ removed: number }>(`/debts/payments/${id}`),
    onSuccess: () => {
      toast('Lançamento removido')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  const rows = payments.data?.payments ?? []

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
          <table className="table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Tipo</th>
                <th className="table__num">Valor</th>
                <th>Notas</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.paidOn)}</td>
                  <td className="muted">{DEBT_PAYMENT_KIND_LABEL[p.kind] ?? p.kind}</td>
                  <td className={`table__num ${p.kind === 'payment' ? 'pos' : 'neg'}`}>{money(p.amountCents)}</td>
                  <td className="muted">{p.notes ?? '-'}</td>
                  <td>
                    <Button
                      variant="quiet"
                      size="sm"
                      icon="trash"
                      onClick={() => remove.mutate(p.id)}
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
    </Modal>
  )
}
