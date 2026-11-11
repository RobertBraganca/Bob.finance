/**
 * Contas puras do Endividamento v2 (specs/debt-v2, decisions/0044): o
 * cronograma restante de cada dívida, o calendário de saída de 6 meses, o
 * custo do crédito em reais, a data em que fica livre, o desconto e o custo
 * de um acordo e a comparação de uma proposta. Nada aqui lê o banco: o
 * servidor monta as entradas e a tela pode refazer a simulação sozinha.
 *
 * Desde a `decisions/0047` a tela recomenda: `recommendStrategy` lê as duas
 * simulações (avalanche e bola de neve) e diz qual seguir e por qual dívida
 * começar, sempre com os números que sustentam a escolha.
 */
import { amortizationSchedule, impliedMonthlyRate, type AmortizationSystem } from './propertyPlan.ts'

/** Guarda contra dívida que nunca amortiza (mesmo limite de `services/debt`). */
export const MAX_DEBT_MONTHS = 600
export const CALENDAR_MONTHS = 6

export const addPeriod = (period: string, n: number) => {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** Taxa EFETIVA anual (bps) para mensal equivalente, e a volta. */
export const monthlyRateOfAnnual = (annualBps: number) => Math.pow(1 + annualBps / 10_000, 1 / 12) - 1
export const annualBpsOfMonthly = (monthlyRate: number) => Math.round((Math.pow(1 + monthlyRate, 12) - 1) * 10_000)

export type PlanRow = {
  period: string
  /** o que sai do caixa no mês (parcela, com seguros e taxas) */
  paymentCents: number
  interestCents: number
  principalCents: number
  balanceAfterCents: number
}

export type DebtPlanInput = {
  balanceCents: number
  aprBps: number
  /** parcela fixa (ou a parcela da vez); ignorada num contrato amortizado */
  paymentCents: number
  /** total de parcelas do contrato; nulo na rotativa */
  installmentCount: number | null
  installmentsPaid: number
  /** mês da parcela 0 (YYYY-MM); sem ele, a próxima parcela cai em `startPeriod` */
  anchorPeriod: string | null
  amortization: AmortizationSystem | null
  principalCents: number
  monthlyFeesCents: number
  /** primeiro mês do plano (o corrente) */
  startPeriod: string
}

/**
 * O que falta pagar, mês a mês, até a dívida acabar.
 *
 * - Contrato amortizado: cada parcela restante pelo cronograma (no SAC cai
 *   todo mês), no mês da âncora + k. Parcela atrasada (mês já passado) entra
 *   no mês corrente, porque ainda vai sair do caixa.
 * - Parcela fixa com número de parcelas: a parcela, nas parcelas que faltam,
 *   com juros e amortização pelo saldo medido.
 * - Rotativa: a parcela todo mês até o saldo acabar; se ela não cobre os
 *   juros, o plano para em `MAX_DEBT_MONTHS` e `endsOn` fica nulo.
 */
export function debtPlan(input: DebtPlanInput): { rows: PlanRow[]; endsOn: string | null } {
  const rate = monthlyRateOfAnnual(input.aprBps)
  const fees = Math.max(0, input.monthlyFeesCents)
  const placeOf = (k: number) => {
    if (!input.anchorPeriod) return addPeriod(input.startPeriod, k - input.installmentsPaid)
    const p = addPeriod(input.anchorPeriod, k)
    return p < input.startPeriod ? input.startPeriod : p
  }

  if (input.amortization && input.installmentCount) {
    const schedule = amortizationSchedule({
      principalCents: input.principalCents,
      rateBps: input.aprBps,
      termMonths: input.installmentCount,
      system: input.amortization,
    })
    const rows: PlanRow[] = []
    for (let k = input.installmentsPaid; k < schedule.length; k++) {
      const r = schedule[k]!
      rows.push({
        period: placeOf(k),
        paymentCents: r.paymentCents + fees,
        interestCents: r.interestCents,
        principalCents: r.amortizationCents,
        balanceAfterCents: r.balanceCents,
      })
    }
    return { rows: mergeSamePeriod(rows), endsOn: rows.at(-1)?.period ?? null }
  }

  const rows: PlanRow[] = []
  let balance = Math.max(0, input.balanceCents)
  const remaining = input.installmentCount === null ? null : Math.max(0, input.installmentCount - input.installmentsPaid)
  const limit = remaining ?? MAX_DEBT_MONTHS
  for (let k = 0; k < limit && (balance > 0 || remaining !== null); k++) {
    const interest = Math.round(balance * rate)
    const owed = balance + interest
    // Parcelado: a parcela do contrato sai mesmo que o saldo medido acabe antes.
    const payment = remaining !== null ? input.paymentCents : Math.min(input.paymentCents, owed)
    if (payment <= 0) break
    const principal = Math.max(0, Math.min(balance, payment - interest))
    balance = Math.max(0, owed - payment)
    rows.push({
      period: placeOf(input.installmentsPaid + k),
      paymentCents: payment,
      interestCents: Math.min(interest, payment),
      principalCents: principal,
      balanceAfterCents: balance,
    })
    if (remaining === null && payment <= interest) {
      // Não cobre os juros: nunca termina. A parcela continua saindo todo
      // mês (o calendário precisa dela), com o saldo crescendo.
      for (let j = 1; j < CALENDAR_MONTHS * 4; j++) {
        const i2 = Math.round(balance * rate)
        balance = balance + i2 - payment
        rows.push({ period: placeOf(input.installmentsPaid + k + j), paymentCents: payment, interestCents: Math.min(i2, payment), principalCents: 0, balanceAfterCents: balance })
      }
      return { rows: mergeSamePeriod(rows), endsOn: null }
    }
  }
  const ended = remaining !== null || balance <= 0
  return { rows: mergeSamePeriod(rows), endsOn: ended ? (rows.at(-1)?.period ?? null) : null }
}

/** Parcelas atrasadas caem todas no mês corrente: somadas numa linha só. */
function mergeSamePeriod(rows: PlanRow[]): PlanRow[] {
  const out: PlanRow[] = []
  for (const r of rows) {
    const last = out.at(-1)
    if (last && last.period === r.period) {
      last.paymentCents += r.paymentCents
      last.interestCents += r.interestCents
      last.principalCents += r.principalCents
      last.balanceAfterCents = r.balanceAfterCents
    } else out.push({ ...r })
  }
  return out
}

export type CalendarSource = {
  key: string
  label: string
  kind: 'debt' | 'card'
  /** valor por mês (YYYY-MM) */
  byPeriod: Record<string, number>
  /** último mês com saída (dívida que termina dentro da janela é marcada) */
  endsOn: string | null
}

export type CalendarMonth = {
  period: string
  debtCents: number
  cardCents: number
  totalCents: number
  /** total do mês ÷ renda típica pessoal; nulo sem renda */
  incomeShareBps: number | null
  bySource: Record<string, number>
  /** rótulos das dívidas cuja última parcela cai neste mês */
  ends: string[]
}

/** Calendário de saída: por mês, quanto sai de dívida e de cartão contra a renda típica. */
export function exitCalendar(sources: CalendarSource[], startPeriod: string, incomeCents: number, months = CALENDAR_MONTHS): CalendarMonth[] {
  return Array.from({ length: months }, (_, i) => {
    const period = addPeriod(startPeriod, i)
    const bySource: Record<string, number> = {}
    let debtCents = 0
    let cardCents = 0
    for (const s of sources) {
      const v = s.byPeriod[period] ?? 0
      if (v === 0) continue
      bySource[s.key] = v
      if (s.kind === 'debt') debtCents += v
      else cardCents += v
    }
    const totalCents = debtCents + cardCents
    return {
      period,
      debtCents,
      cardCents,
      totalCents,
      incomeShareBps: incomeCents > 0 ? Math.round((totalCents / incomeCents) * 10_000) : null,
      bySource,
      ends: sources.filter((s) => s.kind === 'debt' && s.endsOn === period).map((s) => s.label),
    }
  })
}

/**
 * Juros estimados de uma dívida sem cronograma num período passado: a soma,
 * mês a mês, do saldo medido naquele mês × a taxa mensal. É uma estimativa
 * (marcada assim na tela): o banco pode ter cobrado diferente.
 */
export function estimatedInterestCents(monthlyBalancesCents: number[], aprBps: number): number {
  const rate = monthlyRateOfAnnual(aprBps)
  return Math.round(monthlyBalancesCents.reduce((s, b) => s + Math.max(0, b) * rate, 0))
}

/** Juros pagos num contrato amortizado entre as parcelas `fromK` (inclusive) e `toK` (exclusive). */
export function scheduledInterestCents(
  contract: { principalCents: number; aprBps: number; installmentCount: number; amortization: AmortizationSystem },
  fromK: number,
  toK: number,
): number {
  const rows = amortizationSchedule({
    principalCents: contract.principalCents,
    rateBps: contract.aprBps,
    termMonths: contract.installmentCount,
    system: contract.amortization,
  })
  return rows.slice(Math.max(0, fromK), Math.max(0, toK)).reduce((s, r) => s + r.interestCents, 0)
}

export type AgreementTerms = {
  totalCents: number
  /** origem − valor financiado, quando positivo */
  discountCents: number
  /** valor financiado − origem, quando o acordo ficou maior que a dívida */
  surchargeCents: number
  /** total pago − valor financiado: os juros do acordo */
  costCents: number
}

/** Desconto e custo de um acordo de renegociação. */
export function agreementTerms(input: {
  originBalanceCents: number
  financedCents: number
  installmentCents: number
  installmentCount: number
}): AgreementTerms {
  const totalCents = Math.max(0, input.installmentCents) * Math.max(0, input.installmentCount)
  return {
    totalCents,
    discountCents: Math.max(0, input.originBalanceCents - input.financedCents),
    surchargeCents: Math.max(0, input.financedCents - input.originBalanceCents),
    costCents: totalCents - input.financedCents,
  }
}

/** Parcela fixa (Price) de um valor financiado a uma taxa mensal, em n meses. */
export function fixedPaymentCents(financedCents: number, monthlyRate: number, months: number): number {
  if (months <= 0 || financedCents <= 0) return 0
  if (monthlyRate === 0) return Math.round(financedCents / months)
  return Math.round((financedCents * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months)))
}

export type ProposalSide = {
  paymentCents: number
  months: number | null
  totalPaidCents: number
  interestCents: number
  monthlyRate: number | null
  payoffPeriod: string | null
}

/**
 * Proposta x dívida atual, lado a lado. A proposta vem com valor, prazo e a
 * taxa OU a parcela (aí a taxa implícita é calculada). Nada grava.
 */
export function compareProposal(input: {
  current: DebtPlanInput
  proposal: { financedCents: number; months: number; monthlyRate?: number | null; installmentCents?: number | null }
}): { current: ProposalSide; proposal: ProposalSide | null } {
  const plan = debtPlan(input.current)
  const paid = plan.rows.reduce((s, r) => s + r.paymentCents, 0)
  // Contrato com número de parcelas: o custo em reais é o que se paga além do
  // saldo de hoje (a taxa cadastrada pode não fechar o contrato). Rotativa:
  // os juros da projeção.
  const contractCost = input.current.installmentCount !== null ? Math.max(0, paid - input.current.balanceCents) : null
  const current: ProposalSide = {
    paymentCents: plan.rows[0]?.paymentCents ?? 0,
    months: plan.endsOn ? plan.rows.length : null,
    totalPaidCents: paid,
    interestCents: contractCost ?? plan.rows.reduce((s, r) => s + r.interestCents, 0),
    monthlyRate: monthlyRateOfAnnual(input.current.aprBps),
    payoffPeriod: plan.endsOn,
  }

  const { financedCents, months } = input.proposal
  if (financedCents <= 0 || months <= 0) return { current, proposal: null }
  let rate = input.proposal.monthlyRate ?? null
  let payment = input.proposal.installmentCents ?? null
  if (payment !== null && payment > 0) {
    rate = impliedMonthlyRate(financedCents, payment, months)
    if (rate === null && payment * months >= financedCents) rate = 0
  } else if (rate !== null) {
    payment = fixedPaymentCents(financedCents, rate, months)
  }
  if (payment === null || payment <= 0) return { current, proposal: null }
  const total = payment * months
  return {
    current,
    proposal: {
      paymentCents: payment,
      months,
      totalPaidCents: total,
      interestCents: total - financedCents,
      monthlyRate: rate,
      payoffPeriod: addPeriod(input.current.startPeriod, months - 1),
    },
  }
}

export type PayoffStrategy = 'avalanche' | 'snowball'

/** O que `recommendStrategy` lê de cada simulação (`services/debt#projectPaydown`). */
export type StrategyOutcome = {
  /** nulo quando a simulação não quita (pagamentos não cobrem os juros) */
  months: number | null
  totalInterestCents: number
  payoffPeriod: string | null
  perDebt: Array<{ debtId: number; name: string; months: number | null; interestCents: number; aprBps: number; balanceCents: number }>
}

export type StrategyRecommendation = {
  /** nulo quando não há o que escolher (uma dívida só) ou nenhuma estratégia quita */
  strategy: PayoffStrategy | null
  /**
   * - `less_interest`: a vencedora paga menos juros (diferença acima da margem de empate)
   * - `tie_first_sooner`: juros empatados; a bola de neve quita a primeira dívida antes
   * - `same`: as duas chegam no mesmo resultado; fica a avalanche, que nunca custa mais
   * - `single_debt`: só uma dívida aberta, as duas estratégias são a mesma
   * - `never_ends`: com os pagamentos atuais nenhuma das duas quita
   */
  reason: 'less_interest' | 'tie_first_sooner' | 'same' | 'single_debt' | 'never_ends'
  /** meses e juros da vencedora (ou da avalanche, sem vencedora) */
  months: number | null
  totalInterestCents: number
  payoffPeriod: string | null
  /** juros da outra estratégia menos os da recomendada (≥ 0 quando há vencedora) */
  interestSavedCents: number
  /** meses da outra menos os da recomendada; nulo se alguma não quita */
  monthsSaved: number | null
  /** em quantos meses a primeira dívida acaba em cada estratégia */
  firstClearedMonths: Record<PayoffStrategy, number | null>
  /** diferença de juros abaixo disto conta como empate */
  tieThresholdCents: number
  /** a dívida que recebe todo valor extra primeiro, pela regra da recomendada */
  attackFirst: {
    debtId: number
    name: string
    aprBps: number
    balanceCents: number
    /** em quantos meses ela acaba no plano recomendado */
    months: number | null
    why: 'highest_rate' | 'smallest_balance' | 'only_debt'
  } | null
}

/** Empate de juros: diferença abaixo de 1% dos juros da avalanche (mínimo R$ 1,00). */
export const STRATEGY_TIE_SHARE = 0.01

/**
 * Qual estratégia seguir, a partir das duas simulações com o mesmo aporte
 * extra (decisions/0047). Nenhuma conta nova: compara os juros totais e os
 * meses que `projectPaydown` já calculou. A dívida a atacar primeiro segue a
 * mesma ordem da simulação: maior taxa (empate: menor saldo) na avalanche,
 * menor saldo (empate: maior taxa) na bola de neve.
 */
export function recommendStrategy(avalanche: StrategyOutcome, snowball: StrategyOutcome): StrategyRecommendation | null {
  const open = avalanche.perDebt.filter((d) => d.balanceCents > 0)
  if (open.length === 0) return null

  const byRate = [...open].sort((a, b) => b.aprBps - a.aprBps || a.balanceCents - b.balanceCents)[0]!
  const byBalance = [...open].sort((a, b) => a.balanceCents - b.balanceCents || b.aprBps - a.aprBps)[0]!
  const monthsIn = (outcome: StrategyOutcome, debtId: number) => outcome.perDebt.find((d) => d.debtId === debtId)?.months ?? null
  const firstCleared = (outcome: StrategyOutcome) => {
    const months = outcome.perDebt.map((d) => d.months).filter((m): m is number => m !== null)
    return months.length > 0 ? Math.min(...months) : null
  }
  const firstClearedMonths = { avalanche: firstCleared(avalanche), snowball: firstCleared(snowball) }
  const tieThresholdCents = Math.max(100, Math.round(avalanche.totalInterestCents * STRATEGY_TIE_SHARE))

  const base = {
    months: avalanche.months,
    totalInterestCents: avalanche.totalInterestCents,
    payoffPeriod: avalanche.payoffPeriod,
    interestSavedCents: 0,
    monthsSaved: null,
    firstClearedMonths,
    tieThresholdCents,
  }

  if (open.length === 1) {
    return { ...base, strategy: null, reason: 'single_debt', attackFirst: { ...pick(byRate), months: monthsIn(avalanche, byRate.debtId), why: 'only_debt' } }
  }
  if (avalanche.months === null || snowball.months === null) {
    return { ...base, strategy: null, reason: 'never_ends', attackFirst: { ...pick(byRate), months: null, why: 'highest_rate' } }
  }

  const diff = snowball.totalInterestCents - avalanche.totalInterestCents
  let strategy: PayoffStrategy
  let reason: StrategyRecommendation['reason']
  if (diff > tieThresholdCents) [strategy, reason] = ['avalanche', 'less_interest']
  else if (diff < -tieThresholdCents) [strategy, reason] = ['snowball', 'less_interest']
  else if (firstClearedMonths.snowball !== null && firstClearedMonths.avalanche !== null && firstClearedMonths.snowball < firstClearedMonths.avalanche)
    [strategy, reason] = ['snowball', 'tie_first_sooner']
  else [strategy, reason] = ['avalanche', 'same']

  const [won, lost] = strategy === 'avalanche' ? [avalanche, snowball] : [snowball, avalanche]
  const target = strategy === 'avalanche' ? byRate : byBalance
  return {
    strategy,
    reason,
    months: won.months,
    totalInterestCents: won.totalInterestCents,
    payoffPeriod: won.payoffPeriod,
    interestSavedCents: lost.totalInterestCents - won.totalInterestCents,
    monthsSaved: won.months !== null && lost.months !== null ? lost.months - won.months : null,
    firstClearedMonths,
    tieThresholdCents,
    attackFirst: { ...pick(target), months: monthsIn(won, target.debtId), why: strategy === 'avalanche' ? 'highest_rate' : 'smallest_balance' },
  }
}

const pick = (d: StrategyOutcome['perDebt'][number]) => ({ debtId: d.debtId, name: d.name, aprBps: d.aprBps, balanceCents: d.balanceCents })

/**
 * Taxa implícita de um contrato de parcela fixa a partir do saldo, da parcela
 * e das parcelas que faltam; nula quando nenhuma taxa fecha (parcelas não
 * cobrem o saldo, ou dívida rotativa).
 */
export function impliedAnnualBps(balanceCents: number, paymentCents: number, remaining: number | null): number | null {
  if (remaining === null) return null
  const rate = impliedMonthlyRate(balanceCents, paymentCents, remaining)
  return rate === null ? null : annualBpsOfMonthly(rate)
}
