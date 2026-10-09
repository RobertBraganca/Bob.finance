import { useId, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import {
  bps,
  bpsToInput,
  centsToInput,
  date as fmtDate,
  money,
  parseMoneyInput,
  parsePercentInput,
  period as fmtPeriod,
  periodLong as fmtPeriodLong,
} from '../../lib/format'
import { Button, Card, EmptyState, HeroFigure, Icon, Meter, Modal, Segmented, Select, Slab, TextInput, capUsageState, useToast } from '../../components/ui'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { DebtServiceGauge, ExitCalendarChart } from '../../components/charts/DebtCharts'
import { compareProposal, debtPlan, monthlyRateOfAnnual, type DebtPlanInput } from '@shared/debt'
import type { AmortizationSystem } from '@shared/propertyPlan'

/**
 * Endividamento v2 (specs/debt-v2, decisions/0044): as seis perguntas da
 * tela, cada uma numa seção. Observação e simulação, nunca recomendação
 * (decisions/0010): nada aqui diz o que fazer, só mostra o que acontece.
 */

export type DebtV2 = {
  startPeriod: string
  total: { cents: number; debtsCents: number; cardsUsedCents: number }
  debts: Array<{
    id: number
    name: string
    kind: string
    balanceCents: number
    aprBps: number
    monthlyRateBps: number
    paymentCents: number
    interestThisMonthCents: number
    principalThisMonthCents: number
    endsOn: string | null
    monthsLeft: number | null
    impliedAprBps: number | null
    categoryId: number | null
  }>
  cards: Array<{
    id: number
    name: string
    source: 'pluggy' | 'manual'
    limitCents: number
    usedCents: number
    usedBps: number
    grossUsedCents: number
    linkedDebts: Array<{ id: number; name: string; balanceCents: number }>
    openBillCents: number | null
    dueOn: string
    lastSyncedAt: string | null
    lastChargesCents: number
    charges12mCents: number
    byPeriod: Record<string, number>
  }>
  income: { typicalCents: number; sampleMonths: number }
  commitment: { debtCents: number; cardCents: number; shareBps: number | null }
  calendar: Array<{
    period: string
    debtCents: number
    cardCents: number
    totalCents: number
    incomeShareBps: number | null
    bySource: Record<string, number>
    ends: string[]
  }>
  cost: { monthCents: number; last12m: Array<{ key: string; label: string; cents: number; estimated: boolean }>; last12mCents: number }
  freeOn: string | null
  agreements: Array<{
    debtId: number
    name: string
    agreedOn: string | null
    origins: Array<{ debtId: number; name: string; balanceCents: number }>
    originBalanceCents: number
    financedCents: number
    installmentCents: number
    installmentCount: number | null
    totalCents: number
    discountCents: number
    surchargeCents: number
    costCents: number
  }>
  assumptions: Record<string, string>
}

/** O mínimo de `DebtRow` (Debt.tsx) que as simulações precisam. */
export type DebtBasics = {
  id: number
  name: string
  balanceCents: number
  aprBps: number
  scheduledPaymentCents: number
  minimumPaymentCents: number
  installmentCount: number | null
  installmentsPaid: number
  openedOn: string | null
  amortization: AmortizationSystem | null
  principalCents: number
  monthlyFeesCents: number
}

/** Cadastro de acordo preenchido a partir de uma proposta simulada. */
export type AgreementPrefill = {
  name: string
  principalCents: number
  aprBps: number
  scheduledPaymentCents: number
  installmentCount: number
  originDebtIds: number[]
}

const monthsText = (n: number | null) => (n === null ? 'sem data' : n === 1 ? '1 mês' : `${n} meses`)

/** Mesma entrada do servidor, com as parcelas restantes que o Endividamento v2 usa. */
export function planInputFor(d: DebtBasics, v2: DebtV2['debts'][number] | undefined, startPeriod: string, aprBps = d.aprBps): DebtPlanInput {
  const paid = d.installmentCount !== null && v2?.monthsLeft !== null && v2?.monthsLeft !== undefined ? d.installmentCount - v2.monthsLeft : d.installmentsPaid
  return {
    balanceCents: d.balanceCents,
    aprBps,
    paymentCents: d.scheduledPaymentCents || d.minimumPaymentCents,
    installmentCount: d.installmentCount,
    installmentsPaid: paid,
    anchorPeriod: d.openedOn?.slice(0, 7) ?? null,
    amortization: d.amortization,
    principalCents: d.principalCents,
    monthlyFeesCents: d.monthlyFeesCents,
    startPeriod,
  }
}

/* ------------------------------------------------------------------ *
 * 1. Quanto você deve hoje
 * ------------------------------------------------------------------ */
export function OweToday({ v2 }: { v2: DebtV2 }) {
  return (
    <>
      <Slab span={6} accent assumptions={{ total: v2.assumptions.total ?? '' }}>
        <HeroFigure label="Quanto você deve hoje" value={money(v2.total.cents)}>
          <div className="kv" style={{ marginTop: 'var(--sp-3)' }}>
            <span className="kv__k">Dívidas e acordos</span>
            <span className="kv__v">{money(v2.total.debtsCents)}</span>
            <span className="kv__k">Cartões (limite usado)</span>
            <span className="kv__v">{money(v2.total.cardsUsedCents)}</span>
          </div>
        </HeroFigure>
        {v2.cards.length > 0 && (
          <div className="stack stack--tight" style={{ marginTop: 'var(--sp-4)' }}>
            {v2.cards.map((c) => (
              <div key={c.id} className="stack" style={{ gap: 4 }}>
                <span className="row row--between" style={{ fontSize: 'var(--text-sm)', gap: 'var(--sp-3)' }}>
                  <span className="truncate" style={{ color: 'var(--on-slab)' }}>
                    {c.name}
                    <span style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-2xs)' }}>
                      {' '}
                      · {c.source === 'pluggy' ? 'Open Finance' : 'medido à mão'}
                    </span>
                  </span>
                  <span className="tabular" style={{ color: 'var(--on-slab)', fontWeight: c.usedBps >= 8000 ? 600 : undefined }}>
                    {money(c.usedCents)} · {bps(c.usedBps, 0)}
                  </span>
                </span>
                <Meter usedBps={c.usedBps} state={capUsageState(c.usedBps)} />
                <span style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-2xs)' }}>
                  {c.openBillCents !== null ? `fatura aberta ${money(c.openBillCents)} · ` : ''}vence {fmtDate(c.dueOn)}
                  {c.usedBps >= 8000 && ' · acima de 80% do limite'}
                </span>
                {c.linkedDebts.length > 0 && (
                  <span style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-2xs)' }}>
                    usado no banco {money(c.grossUsedCents)}, menos {c.linkedDebts.map((d) => `${d.name} (${money(d.balanceCents)})`).join(', ')}, que já conta como dívida
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Slab>

      <Slab
        span={6}
        title="Renda comprometida"
        subtitle="O que sai de dívida e cartão neste mês, sobre a sua renda típica"
        assumptions={{
          formula: v2.assumptions.comprometimento ?? '',
          faixas: 'Saudável até 20%; Atenção até 36%; Comprometido até 50%; Crítico acima de 50%',
          cartoes: 'cartões medidos à mão não entram: sem a fatura do banco, o app não sabe quanto vence no mês',
        }}
      >
        <DebtServiceGauge
          ratioBps={v2.commitment.shareBps}
          surface="paper"
          emptyBody="Sem receita nas contas pessoais nos últimos 6 meses para comparar."
          caption={
            v2.income.typicalCents > 0
              ? `${money(v2.commitment.debtCents)} de parcelas + ${money(v2.commitment.cardCents)} de fatura, de ${money(v2.income.typicalCents)} de renda típica (mediana de ${v2.income.sampleMonths} ${v2.income.sampleMonths === 1 ? 'mês' : 'meses'})`
              : undefined
          }
        />
      </Slab>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * 2. Calendário de saída
 * ------------------------------------------------------------------ */
export function ExitCalendarCard({ v2 }: { v2: DebtV2 }) {
  const sources = [
    ...v2.debts.map((d) => ({ key: `debt:${d.id}`, label: d.name, kind: 'debt' as const })),
    ...v2.cards.map((c) => ({ key: `card:${c.id}`, label: c.name, kind: 'card' as const })),
  ]
  const manual = v2.cards.filter((c) => c.source === 'manual')
  return (
    <Card
      span={12}
      title="O que sai nos próximos 6 meses"
      subtitle="Parcelas das dívidas e fatura dos cartões, mês a mês, contra a renda típica"
      assumptions={{ calendario: v2.assumptions.calendario ?? '', renda: `renda típica pessoal de ${money(v2.income.typicalCents)}` }}
    >
      <ExitCalendarChart months={v2.calendar} sources={sources} incomeCents={v2.income.typicalCents} />
      {manual.length > 0 && (
        <p className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--sp-2)' }}>
          <Icon name="info" size={12} /> {manual.map((c) => c.name).join(', ')} {manual.length === 1 ? 'está medido' : 'estão medidos'} à mão: a fatura e as parcelas
          futuras {manual.length === 1 ? 'dele' : 'deles'} não entram no calendário. Ligue em Ajustes → Open Finance para entrarem.
        </p>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ *
 * 3. Custo do crédito em reais
 * ------------------------------------------------------------------ */
export function CreditCostCard({ v2 }: { v2: DebtV2 }) {
  const cardCharges = v2.cards.filter((c) => c.lastChargesCents > 0)
  return (
    <Card
      span={6}
      title="Quanto o crédito custa"
      subtitle="Juros e encargos em reais"
      assumptions={{ jurosDoMes: v2.assumptions.jurosDoMes ?? '', ultimos12Meses: v2.assumptions.juros12m ?? '' }}
    >
      <div className="stack">
        <div className="row row--between row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="stack stack--tight">
            <span className="stat__label">Juros deste mês</span>
            <span className="numeral neg" style={{ fontSize: 'var(--text-xl)' }}>{money(v2.cost.monthCents)}</span>
          </div>
          <div className="stack stack--tight" style={{ textAlign: 'right' }}>
            <span className="stat__label">Últimos 12 meses</span>
            <span className="numeral neg" style={{ fontSize: 'var(--text-xl)' }}>{money(v2.cost.last12mCents)}</span>
          </div>
        </div>

        {v2.debts.length > 0 && (
          <div className="stack stack--tight">
            <span className="label">Da parcela deste mês</span>
            {v2.debts.map((d) => {
              const total = d.interestThisMonthCents + d.principalThisMonthCents
              const interestBps = total > 0 ? Math.round((d.interestThisMonthCents / total) * 10_000) : 0
              return (
                <div key={d.id} className="stack" style={{ gap: 4 }}>
                  <span className="row row--between" style={{ fontSize: 'var(--text-sm)', gap: 'var(--sp-3)' }}>
                    <span className="truncate">{d.name}</span>
                    <span className="tabular">{money(d.paymentCents)}</span>
                  </span>
                  <div className="split-bar" role="img" aria-label={`${bps(interestBps, 0)} de juros, o resto abate o saldo`}>
                    <span style={{ width: `${interestBps / 100}%`, background: 'var(--status-critical)' }} />
                    <span style={{ width: `${100 - interestBps / 100}%`, background: 'var(--status-good)' }} />
                  </div>
                  <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                    {money(d.interestThisMonthCents)} de juros · {money(d.principalThisMonthCents)} abatem o saldo
                  </span>
                </div>
              )
            })}
            {cardCharges.map((c) => (
              <span key={c.id} className="row row--between" style={{ fontSize: 'var(--text-sm)', gap: 'var(--sp-3)' }}>
                <span className="muted truncate">{c.name}: encargos da última fatura</span>
                <span className="tabular neg">{money(c.lastChargesCents)}</span>
              </span>
            ))}
          </div>
        )}

        {v2.cost.last12m.length > 0 && (
          <>
            <hr className="divider" />
            <div className="stack stack--tight">
              <span className="label">Juros pagos nos últimos 12 meses</span>
              {v2.cost.last12m.map((i) => (
                <span key={i.key} className="row row--between" style={{ fontSize: 'var(--text-sm)', gap: 'var(--sp-3)' }}>
                  <span className="row" style={{ gap: 6, minWidth: 0 }}>
                    <span className="muted truncate">{i.label}</span>
                    {i.estimated && <span className="badge" style={{ flexShrink: 0 }}>estimado</span>}
                  </span>
                  <span className="tabular">{money(i.cents)}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ *
 * 4. Quando fico livre (+ "Usar a taxa do contrato")
 * ------------------------------------------------------------------ */
export function FreedomCard({ v2, debts, onEdit }: { v2: DebtV2; debts: DebtBasics[]; onEdit: (id: number) => void }) {
  const [confirming, setConfirming] = useState<number | null>(null)
  const mismatched = v2.debts.filter((d) => d.monthsLeft !== null && d.impliedAprBps !== null && Math.abs(Math.round(monthlyRateOfAnnual(d.impliedAprBps) * 10_000) - d.monthlyRateBps) >= 50)
  const noRate = v2.debts.filter((d) => d.monthsLeft !== null && d.impliedAprBps === null && d.kind !== 'financing' && d.paymentCents > 0 && d.balanceCents > d.paymentCents * d.monthsLeft)
  return (
    <Card span={6} title="Quando fico livre" subtitle="Pelo cronograma de cada dívida, sem aporte extra">
      <div className="stack">
        <div className="stack stack--tight">
          <span className="stat__label">Livre das dívidas em</span>
          <span className="numeral" style={{ fontSize: 'var(--text-xl)' }}>{v2.freeOn ? fmtPeriodLong(v2.freeOn) : 'sem data'}</span>
          {v2.freeOn === null && (
            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Uma dívida rotativa com o pagamento atual não cobre os juros: o saldo não cai.
            </span>
          )}
        </div>
        <div className="stack stack--tight">
          {v2.debts.map((d) => (
            <span key={d.id} className="row row--between" style={{ fontSize: 'var(--text-sm)', gap: 'var(--sp-3)' }}>
              <span className="muted truncate">{d.name}</span>
              <span className="tabular">{d.endsOn ? `${fmtPeriod(d.endsOn)} · ${monthsText(d.monthsLeft)}` : 'sem data'}</span>
            </span>
          ))}
          {v2.cards.length > 0 && (
            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Cartões não têm data: a fatura fecha todo mês. As parcelas já lançadas aparecem no calendário.
            </span>
          )}
        </div>

        {(mismatched.length > 0 || noRate.length > 0) && (
          <Alert variant="warning">
            <Icon name="alert" size={16} />
            <AlertTitle>A taxa cadastrada não bate com o contrato</AlertTitle>
            <AlertDescription>
              <div className="stack stack--tight" style={{ marginTop: 'var(--sp-2)' }}>
                {mismatched.map((d) => (
                  <div key={d.id} className="stack stack--tight">
                    <span>
                      <strong>{d.name}</strong>: cadastrada a {bpsToInput(d.monthlyRateBps)}% ao mês; com {d.monthsLeft} parcelas de {money(d.paymentCents)} sobre{' '}
                      {money(d.balanceCents)}, a taxa que fecha o contrato é {bpsToInput(Math.round(monthlyRateOfAnnual(d.impliedAprBps!) * 10_000))}% ao mês.
                    </span>
                    <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                      <Button size="sm" variant="primary" onClick={() => setConfirming(d.id)}>
                        Usar a taxa do contrato
                      </Button>
                      <Button size="sm" icon="pencil" onClick={() => onEdit(d.id)}>
                        Revisar dívida
                      </Button>
                    </span>
                  </div>
                ))}
                {noRate.map((d) => (
                  <span key={d.id}>
                    <strong>{d.name}</strong>: as {d.monthsLeft} parcelas restantes de {money(d.paymentCents)} somam menos que o saldo de {money(d.balanceCents)}; nenhuma taxa fecha esse
                    contrato.{' '}
                    <Button size="sm" icon="pencil" onClick={() => onEdit(d.id)}>
                      Revisar dívida
                    </Button>
                  </span>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        )}
      </div>
      {confirming !== null && (
        <UseImpliedRateModal
          v2={v2}
          debt={debts.find((d) => d.id === confirming)!}
          summary={v2.debts.find((d) => d.id === confirming)!}
          onClose={() => setConfirming(null)}
        />
      )}
    </Card>
  )
}

function UseImpliedRateModal({ v2, debt, summary, onClose }: { v2: DebtV2; debt: DebtBasics; summary: DebtV2['debts'][number]; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const before = debtPlan(planInputFor(debt, summary, v2.startPeriod))
  const after = debtPlan(planInputFor(debt, summary, v2.startPeriod, summary.impliedAprBps!))
  const leftover = (rows: typeof before.rows) => rows.at(-1)?.balanceAfterCents ?? 0
  const apply = useMutation({
    mutationFn: () => api.post<{ afterAprBps: number }>(`/debts/${debt.id}/use-implied-rate`),
    onSuccess: async () => {
      toast('Taxa do contrato gravada; juros e projeção foram recalculados')
      await queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao gravar a taxa', 'error'),
  })
  const line = (label: string, a: string, b: string) => (
    <tr>
      <td>{label}</td>
      <td className="table__num">{a}</td>
      <td className="table__num">{b}</td>
    </tr>
  )
  return (
    <Modal
      title={`Usar a taxa do contrato em ${debt.name}?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" icon="check" loading={apply.isPending} onClick={() => apply.mutate()}>
            Gravar a taxa do contrato
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          Saldo, parcela e número de parcelas continuam os mesmos. Muda só a taxa, e com ela os juros do mês e a projeção.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col" className="table__num">Hoje</th>
                <th scope="col" className="table__num">Com a taxa do contrato</th>
              </tr>
            </thead>
            <tbody>
              {line('Taxa ao mês', `${bpsToInput(summary.monthlyRateBps)}%`, `${bpsToInput(Math.round(monthlyRateOfAnnual(summary.impliedAprBps!) * 10_000))}%`)}
              {line('Juros deste mês', money(before.rows[0]?.interestCents ?? 0), money(after.rows[0]?.interestCents ?? 0))}
              {line('Termina em', before.endsOn ? fmtPeriod(before.endsOn) : 'sem data', after.endsOn ? fmtPeriod(after.endsOn) : 'sem data')}
              {line('Saldo que sobra no fim', money(leftover(before.rows)), money(leftover(after.rows)))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 * 5. Renegociação: acordos registrados e o simulador de proposta
 * ------------------------------------------------------------------ */
export function RenegotiationCard({ v2, debts, onRegister }: { v2: DebtV2; debts: DebtBasics[]; onRegister: (prefill: AgreementPrefill) => void }) {
  return (
    <Card span={12} title="Renegociação" subtitle="Acordos registrados e a simulação de uma proposta antes de aceitar">
      <div className="calc-layout">
        <ProposalSimulator v2={v2} debts={debts} onRegister={onRegister} />
        <div className="stack">
          <span className="label">Acordos registrados</span>
          {v2.agreements.length === 0 ? (
            <EmptyState
              icon="scale"
              title="Nenhum acordo registrado"
              body="Ao cadastrar uma dívida nova que é um acordo, marque em 'Este acordo renegocia' as dívidas que ele substituiu: o desconto e o custo aparecem aqui."
            />
          ) : (
            v2.agreements.map((a) => (
              <div key={a.debtId} className="stack stack--tight">
                <span className="row row--between" style={{ gap: 'var(--sp-3)' }}>
                  <strong>{a.name}</strong>
                  <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>{a.agreedOn ? `acordo em ${fmtDate(a.agreedOn)}` : ''}</span>
                </span>
                <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                  Renegociou {a.origins.map((o) => `${o.name} (${money(o.balanceCents)})`).join(', ')}
                </span>
                <div className="kv">
                  <span className="kv__k">Dívida de origem</span>
                  <span className="kv__v">{money(a.originBalanceCents)}</span>
                  <span className="kv__k">Valor do acordo</span>
                  <span className="kv__v">{money(a.financedCents)}</span>
                  <span className="kv__k">{a.surchargeCents > 0 ? 'Acréscimo sobre a origem' : 'Desconto obtido'}</span>
                  <span className={a.surchargeCents > 0 ? 'kv__v neg' : 'kv__v pos'}>{money(a.surchargeCents > 0 ? a.surchargeCents : a.discountCents)}</span>
                  <span className="kv__k">
                    Custo do acordo ({a.installmentCount ?? '-'}× {money(a.installmentCents)})
                  </span>
                  <span className="kv__v neg">{money(a.costCents)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Card>
  )
}

function ProposalSimulator({ v2, debts, onRegister }: { v2: DebtV2; debts: DebtBasics[]; onRegister: (prefill: AgreementPrefill) => void }) {
  const ids = { debt: useId(), amount: useId(), months: useId(), value: useId() }
  const [debtId, setDebtId] = useState<number | null>(debts[0]?.id ?? null)
  const [amount, setAmount] = useState('')
  const [months, setMonths] = useState('')
  const [basis, setBasis] = useState<'installment' | 'rate'>('installment')
  const [value, setValue] = useState('')
  const debt = debts.find((d) => d.id === debtId) ?? null
  const summary = v2.debts.find((d) => d.id === debtId)

  const result = useMemo(() => {
    if (!debt) return null
    const financedCents = parseMoneyInput(amount)
    const n = Math.round(Number(months))
    const typed = basis === 'installment' ? parseMoneyInput(value) : parsePercentInput(value)
    return compareProposal({
      current: planInputFor(debt, summary, v2.startPeriod),
      proposal: {
        financedCents: Math.abs(financedCents ?? 0),
        months: Number.isFinite(n) ? n : 0,
        installmentCents: basis === 'installment' && typed !== null ? Math.abs(typed) : null,
        monthlyRate: basis === 'rate' && typed !== null ? Math.abs(typed) / 10_000 : null,
      },
    })
  }, [debt, summary, v2.startPeriod, amount, months, basis, value])

  if (debts.length === 0) return null
  const side = (label: string, s: { paymentCents: number; months: number | null; totalPaidCents: number; interestCents: number; monthlyRate: number | null; payoffPeriod: string | null } | null) => (
    <div className="stack stack--tight" style={{ flex: 1, minWidth: 150 }}>
      <span className="label">{label}</span>
      {s ? (
        <div className="kv">
          <span className="kv__k">Parcela</span>
          <span className="kv__v">{money(s.paymentCents)}</span>
          <span className="kv__k">Taxa ao mês</span>
          <span className="kv__v">{s.monthlyRate === null ? '-' : `${bpsToInput(Math.round(s.monthlyRate * 10_000))}%`}</span>
          <span className="kv__k">Total pago</span>
          <span className="kv__v">{money(s.totalPaidCents)}</span>
          <span className="kv__k">Juros</span>
          <span className="kv__v neg">{money(s.interestCents)}</span>
          <span className="kv__k">Termina em</span>
          <span className="kv__v">{s.payoffPeriod ? fmtPeriod(s.payoffPeriod) : 'sem data'}</span>
        </div>
      ) : (
        <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>Preencha valor, prazo e {basis === 'installment' ? 'parcela' : 'taxa'}.</span>
      )}
    </div>
  )

  return (
    <div className="stack">
      <span className="label">Simular uma proposta</span>
      <div className="field">
        <label className="field__label" htmlFor={ids.debt}>Dívida</label>
        <Select id={ids.debt} value={debtId} options={debts.map((d) => ({ value: d.id, label: d.name }))} onChange={setDebtId} />
      </div>
      <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
        <div className="field" style={{ flex: 1, minWidth: 140 }}>
          <label className="field__label" htmlFor={ids.amount}>Valor do acordo (R$)</label>
          <TextInput id={ids.amount} value={amount} onChange={setAmount} placeholder={debt ? centsToInput(debt.balanceCents) : '0,00'} numeral />
        </div>
        <div className="field" style={{ width: 120 }}>
          <label className="field__label" htmlFor={ids.months}>Prazo (meses)</label>
          <TextInput id={ids.months} value={months} onChange={setMonths} placeholder="ex. 24" numeral />
        </div>
      </div>
      <Segmented
        ariaLabel="O que a proposta informa"
        value={basis}
        options={[
          { value: 'installment', label: 'Parcela' },
          { value: 'rate', label: 'Taxa ao mês' },
        ]}
        onChange={(next) => {
          setBasis(next)
          setValue('')
        }}
      />
      <div className="field">
        <label className="field__label" htmlFor={ids.value}>{basis === 'installment' ? 'Parcela proposta (R$)' : 'Taxa proposta (% ao mês)'}</label>
        <TextInput id={ids.value} value={value} onChange={setValue} placeholder={basis === 'installment' ? '0,00' : 'ex. 1,99'} numeral />
        {basis === 'installment' && <span className="field__hint">A taxa que fecha a proposta é calculada pela parcela.</span>}
      </div>
      <div className="row row--wrap" style={{ gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
        {side('Como está', result?.current ?? null)}
        {side('Com a proposta', result?.proposal ?? null)}
      </div>
      {result?.proposal && (
        <>
          <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            {result.proposal.totalPaidCents < result.current.totalPaidCents
              ? `Pela simulação, a proposta paga ${money(result.current.totalPaidCents - result.proposal.totalPaidCents)} a menos no total.`
              : `Pela simulação, a proposta paga ${money(result.proposal.totalPaidCents - result.current.totalPaidCents)} a mais no total.`}{' '}
            Simulação com taxa constante; nada é gravado.
          </p>
          <div className="row">
            <Button
              icon="plus"
              onClick={() =>
                onRegister({
                  name: `Acordo · ${debt!.name}`,
                  principalCents: Math.abs(parseMoneyInput(amount) ?? 0),
                  aprBps: Math.round((Math.pow(1 + (result.proposal!.monthlyRate ?? 0), 12) - 1) * 10_000),
                  scheduledPaymentCents: result.proposal!.paymentCents,
                  installmentCount: result.proposal!.months ?? 0,
                  originDebtIds: [debt!.id],
                })
              }
            >
              Registrar como acordo
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
