/**
 * Contas do plano de compra de imóvel (specs/property-plan, decisions/0041)
 * e dos contratos amortizados de Dívidas. Simulação pura (decisions/0010):
 * taxa constante, sem correção por TR/IPCA. Nada aqui consulta dado do app;
 * quem chama decide de onde vêm os números.
 *
 * Valores em centavos inteiros; taxas em pontos-base ao ano (1100 = 11%),
 * convertidas para o mês pela equivalência `(1 + a)^(1/12) − 1`, a mesma de
 * `core/money#monthlyRateOf` e das Calculadoras.
 */

export type AmortizationSystem = 'sac' | 'price'
export const AMORTIZATION_SYSTEMS: AmortizationSystem[] = ['sac', 'price']

export type CostItem = { label: string; kind: 'pct' | 'fixed'; value: number }

/** ITBI, escritura e registro, avaliação do banco: o padrão de um plano novo. */
export const DEFAULT_COSTS: CostItem[] = [
  { label: 'ITBI', kind: 'pct', value: 300 },
  { label: 'Escritura e registro', kind: 'pct', value: 150 },
  { label: 'Avaliação do banco', kind: 'fixed', value: 350_000 },
]

/** Faixas aceitas — as mesmas no zod das rotas e nos campos das telas. */
export const PLAN_LIMITS = {
  downPaymentBps: { min: 500, max: 10_000 },
  termMonths: { min: 12, max: 420 },
  rateBps: { min: 0, max: 10_000 },
  appreciationBps: { min: -2_000, max: 3_000 },
  incomeLimitBps: { min: 500, max: 10_000 },
  costPctBps: { min: 0, max: 5_000 },
} as const

/** Horizonte da acumulação: 50 anos. Evita laço sem fim num alvo inalcançável. */
export const MAX_PLAN_MONTHS = 600

export const monthlyRateFromBps = (annualBps: number) => Math.pow(1 + annualBps / 10_000, 1 / 12) - 1

/* ------------------------------------------------------------------ *
 * Cronograma de amortização
 * ------------------------------------------------------------------ */
export type ScheduleRow = {
  /** 0 = primeira parcela */
  k: number
  paymentCents: number
  interestCents: number
  amortizationCents: number
  /** saldo devedor depois desta parcela */
  balanceCents: number
}

export type ScheduleInput = { principalCents: number; rateBps: number; termMonths: number; system: AmortizationSystem }

/**
 * Parcela fixa do Price: `P × i / (1 − (1+i)^−n)`; com taxa 0, `P / n`.
 * Em centavos inteiros sobra um resíduo de arredondamento, que a última
 * parcela absorve (poucos reais num contrato de 30 anos, como no banco).
 */
function pricePayment(principalCents: number, i: number, n: number): number {
  if (n <= 0) return 0
  if (i === 0) return Math.round(principalCents / n)
  return Math.round((principalCents * i) / (1 - Math.pow(1 + i, -n)))
}

/** Amortização SAC da parcela k: `P / n` distribuída sem sobra (a soma dá exatamente o principal). */
const sacAmortizationAt = (principalCents: number, n: number, k: number) =>
  Math.round(((k + 1) * principalCents) / n) - Math.round((k * principalCents) / n)

/**
 * SAC: amortização fixa `P / n` e juros sobre o saldo, então a parcela cai
 * todo mês. Price: parcela fixa, com a amortização crescendo. Nos dois, a
 * última parcela absorve o arredondamento e zera o saldo.
 */
export function amortizationSchedule({ principalCents, rateBps, termMonths, system }: ScheduleInput): ScheduleRow[] {
  const n = Math.max(0, Math.round(termMonths))
  if (principalCents <= 0 || n === 0) return []
  const i = monthlyRateFromBps(rateBps)
  const fixedPayment = pricePayment(principalCents, i, n)
  const rows: ScheduleRow[] = []
  let balance = principalCents
  for (let k = 0; k < n; k++) {
    const interest = Math.round(balance * i)
    const isLast = k === n - 1
    let amortization = system === 'sac' ? sacAmortizationAt(principalCents, n, k) : fixedPayment - interest
    if (isLast || amortization > balance) amortization = balance
    amortization = Math.max(0, amortization)
    balance -= amortization
    rows.push({ k, paymentCents: amortization + interest, interestCents: interest, amortizationCents: amortization, balanceCents: balance })
  }
  return rows
}

export type ScheduleSummary = {
  system: AmortizationSystem
  principalCents: number
  months: number
  firstPaymentCents: number
  lastPaymentCents: number
  totalInterestCents: number
  totalPaidCents: number
}

/** Resumo de um cronograma; `feesCents` (seguros e taxas) soma em cada parcela e no total pago. */
export function scheduleSummary(input: ScheduleInput, feesCents = 0): ScheduleSummary {
  const rows = amortizationSchedule(input)
  const fees = rows.length > 0 ? Math.max(0, feesCents) : 0
  const totalInterestCents = rows.reduce((sum, r) => sum + r.interestCents, 0)
  return {
    system: input.system,
    principalCents: Math.max(0, input.principalCents),
    months: rows.length,
    firstPaymentCents: rows.length ? rows[0]!.paymentCents + fees : 0,
    lastPaymentCents: rows.length ? rows.at(-1)!.paymentCents + fees : 0,
    totalInterestCents,
    totalPaidCents: rows.reduce((sum, r) => sum + r.paymentCents, 0) + fees * rows.length,
  }
}

/** 1ª parcela sem montar o cronograma inteiro (as contas do plano chamam isto a cada mês). */
export function firstPaymentCents({ principalCents, rateBps, termMonths, system }: ScheduleInput): number {
  const n = Math.max(0, Math.round(termMonths))
  if (principalCents <= 0 || n === 0) return 0
  const i = monthlyRateFromBps(rateBps)
  if (n === 1) return principalCents + Math.round(principalCents * i)
  return system === 'sac' ? sacAmortizationAt(principalCents, n, 0) + Math.round(principalCents * i) : pricePayment(principalCents, i, n)
}

/* ------------------------------------------------------------------ *
 * Contratos amortizados de Dívidas
 * ------------------------------------------------------------------ */
export type AmortizedContract = {
  principalCents: number
  aprBps: number
  installmentCount: number | null
  amortization: AmortizationSystem | null
  monthlyFeesCents: number
}

const scheduleOf = (c: AmortizedContract) =>
  amortizationSchedule({ principalCents: c.principalCents, rateBps: c.aprBps, termMonths: c.installmentCount ?? 0, system: c.amortization ?? 'price' })

/** Valor da parcela k (0 = primeira) com seguros e taxas; 0 fora do contrato. */
export function installmentCents(contract: AmortizedContract, k: number): number {
  const row = scheduleOf(contract)[k]
  return row ? row.paymentCents + Math.max(0, contract.monthlyFeesCents) : 0
}

/** Todas as parcelas do contrato, com seguros e taxas (para materializar várias de uma vez). */
export function installmentsCents(contract: AmortizedContract): number[] {
  const fees = Math.max(0, contract.monthlyFeesCents)
  return scheduleOf(contract).map((r) => r.paymentCents + fees)
}

/** Saldo devedor depois de `paidCount` parcelas pagas: só a amortização sai, nunca juros e taxas. */
export function balanceAfter(contract: AmortizedContract, paidCount: number): number {
  if (paidCount <= 0) return Math.max(0, contract.principalCents)
  const rows = scheduleOf(contract)
  if (rows.length === 0) return Math.max(0, contract.principalCents)
  return rows[Math.min(paidCount, rows.length) - 1]!.balanceCents
}

/* ------------------------------------------------------------------ *
 * Plano de compra
 * ------------------------------------------------------------------ */
export type PlanInputs = {
  priceCents: number
  appreciationBps: number
  downPaymentBps: number
  costs: CostItem[]
  otherResourcesCents: number
  financingRateBps: number
  termMonths: number
  system: AmortizationSystem
  monthlyFeesCents: number
  /** renda considerada no teste; nulo = desconhecida */
  incomeCents: number | null
  incomeLimitBps: number
  expenseReliefCents: number
  livingCostCents: number
  reserveMultiple: number
  reserveCurrentCents: number
  /** o que já está juntado para o imóvel (ativos ligados, ou o valor digitado na calculadora) */
  savedCents: number
  monthlyContributionCents: number
  expectedReturnBps: number
}

export type NeedBreakdown = {
  month: number
  priceCents: number
  downPaymentCents: number
  costsCents: number
  financedCents: number
  /** 1ª parcela do sistema escolhido, com seguros e taxas (0 sem financiamento) */
  firstInstallmentCents: number
  reserveTargetCents: number
  reserveGapCents: number
  otherResourcesCents: number
  totalCents: number
}

export function priceAt(priceCents: number, appreciationBps: number, month: number): number {
  return Math.round(priceCents * Math.pow(1 + appreciationBps / 10_000, month / 12))
}

/** Itens em % sobre o preço do mês; itens fixos não corrigem. */
export function costsAt(costs: CostItem[], priceCents: number): number {
  return costs.reduce((sum, c) => sum + Math.max(0, c.kind === 'pct' ? Math.round((priceCents * c.value) / 10_000) : c.value), 0)
}

/**
 * Dinheiro necessário no mês m: entrada + custos + o que faltar na reserva
 * (recalculada com a parcela nova) − outros recursos. A reserva atual não
 * cresce na projeção; o que faltar nela sai do dinheiro do imóvel.
 */
export function needAt(p: PlanInputs, month: number): NeedBreakdown {
  const priceCents = priceAt(p.priceCents, p.appreciationBps, month)
  const downPaymentCents = Math.round((priceCents * Math.min(10_000, Math.max(0, p.downPaymentBps))) / 10_000)
  const costsCents = costsAt(p.costs, priceCents)
  const financedCents = Math.max(0, priceCents - downPaymentCents)
  const firstInstallmentCents =
    financedCents > 0
      ? firstPaymentCents({ principalCents: financedCents, rateBps: p.financingRateBps, termMonths: p.termMonths, system: p.system }) +
        Math.max(0, p.monthlyFeesCents)
      : 0
  const monthlyCost = Math.max(0, p.livingCostCents - p.expenseReliefCents + firstInstallmentCents)
  const reserveTargetCents = Math.round(monthlyCost * Math.max(0, p.reserveMultiple))
  const reserveGapCents = Math.max(0, reserveTargetCents - Math.max(0, p.reserveCurrentCents))
  const otherResourcesCents = Math.max(0, p.otherResourcesCents)
  return {
    month,
    priceCents,
    downPaymentCents,
    costsCents,
    financedCents,
    firstInstallmentCents,
    reserveTargetCents,
    reserveGapCents,
    otherResourcesCents,
    totalCents: Math.max(0, downPaymentCents + costsCents + reserveGapCents - otherResourcesCents),
  }
}

export type IncomeTest = {
  incomeCents: number
  installmentCents: number
  shareBps: number
  limitBps: number
  withinLimit: boolean
}

/**
 * Maior preço cuja 1ª parcela (com taxas) cabe em `renda × limite`, com a
 * entrada do plano. Nulo sem financiamento (entrada 100%) ou sem renda.
 */
export function maxPriceByIncome(p: Pick<PlanInputs, 'incomeCents' | 'incomeLimitBps' | 'financingRateBps' | 'termMonths' | 'system' | 'monthlyFeesCents' | 'downPaymentBps'>): number | null {
  if (!p.incomeCents || p.incomeCents <= 0 || p.downPaymentBps >= 10_000) return null
  const budget = (p.incomeCents * p.incomeLimitBps) / 10_000 - Math.max(0, p.monthlyFeesCents)
  if (budget <= 0) return 0
  const n = Math.max(1, Math.round(p.termMonths))
  const i = monthlyRateFromBps(p.financingRateBps)
  const financed = p.system === 'sac' ? budget / (1 / n + i) : i === 0 ? budget * n : (budget * (1 - Math.pow(1 + i, -n))) / i
  return Math.floor(financed / (1 - p.downPaymentBps / 10_000))
}

export type PlanPoint = { month: number; savedCents: number; needCents: number }
export type BalancePoint = { month: number; sacCents: number; priceCents: number }

export type PlanProjection = {
  /** primeiro mês em que o juntado cobre o necessário; nulo se não alcança em 50 anos */
  purchaseMonth: number | null
  /** o mês usado para o financiamento e o teste da renda: o da compra, ou hoje se não alcança */
  atMonth: number
  need: NeedBreakdown
  savedAtCents: number
  /** quanto falta no fim do horizonte quando não alcança; 0 quando alcança */
  shortfallCents: number
  /** mês a mês até a compra (ou até o horizonte) */
  series: PlanPoint[]
  sac: ScheduleSummary | null
  price: ScheduleSummary | null
  /** saldo devedor SAC e Price depois da compra, um ponto por ano */
  balanceSeries: BalancePoint[]
  incomeTest: IncomeTest | null
  maxPriceCents: number | null
}

export function projectPlan(p: PlanInputs): PlanProjection {
  const r = monthlyRateFromBps(p.expectedReturnBps)
  const contribution = Math.max(0, p.monthlyContributionCents)
  const series: PlanPoint[] = []
  let saved = Math.max(0, p.savedCents)
  let purchaseMonth: number | null = null
  let lastNeed = needAt(p, 0)
  for (let m = 0; m <= MAX_PLAN_MONTHS; m++) {
    if (m > 0) saved = Math.round(saved * (1 + r) + contribution)
    lastNeed = needAt(p, m)
    series.push({ month: m, savedCents: saved, needCents: lastNeed.totalCents })
    if (saved >= lastNeed.totalCents) {
      purchaseMonth = m
      break
    }
  }

  const atMonth = purchaseMonth ?? 0
  const need = purchaseMonth === null ? needAt(p, 0) : lastNeed
  const shortfallCents = purchaseMonth === null ? Math.max(0, lastNeed.totalCents - saved) : 0
  const savedAtCents = series[atMonth]?.savedCents ?? 0

  const financed = need.financedCents
  const base = { principalCents: financed, rateBps: p.financingRateBps, termMonths: p.termMonths }
  const sac = financed > 0 ? scheduleSummary({ ...base, system: 'sac' }, p.monthlyFeesCents) : null
  const price = financed > 0 ? scheduleSummary({ ...base, system: 'price' }, p.monthlyFeesCents) : null

  const balanceSeries: BalancePoint[] = []
  if (financed > 0) {
    const sacRows = amortizationSchedule({ ...base, system: 'sac' })
    const priceRows = amortizationSchedule({ ...base, system: 'price' })
    for (let month = 0; month <= sacRows.length; month += 12) {
      balanceSeries.push({
        month,
        sacCents: month === 0 ? financed : sacRows[month - 1]?.balanceCents ?? 0,
        priceCents: month === 0 ? financed : priceRows[month - 1]?.balanceCents ?? 0,
      })
    }
    if (balanceSeries.at(-1)!.month !== sacRows.length) balanceSeries.push({ month: sacRows.length, sacCents: 0, priceCents: 0 })
  }

  const incomeTest: IncomeTest | null =
    p.incomeCents && p.incomeCents > 0 && need.firstInstallmentCents > 0
      ? {
          incomeCents: p.incomeCents,
          installmentCents: need.firstInstallmentCents,
          shareBps: Math.round((need.firstInstallmentCents / p.incomeCents) * 10_000),
          limitBps: p.incomeLimitBps,
          withinLimit: need.firstInstallmentCents * 10_000 <= p.incomeCents * p.incomeLimitBps,
        }
      : null

  return {
    purchaseMonth,
    atMonth,
    need,
    savedAtCents,
    shortfallCents,
    series,
    sac,
    price,
    balanceSeries,
    incomeTest,
    maxPriceCents: maxPriceByIncome(p),
  }
}

/** Mês a mês até 3 anos, depois um ponto por ano (mesma regra das Calculadoras). */
export function thinSeries<T extends { month: number }>(points: T[]): T[] {
  const last = points.at(-1)
  if (!last || last.month <= 36) return points
  return points.filter((pt) => pt.month % 12 === 0 || pt.month === last.month)
}
