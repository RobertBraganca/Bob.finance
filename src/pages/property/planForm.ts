import { bpsToInput, centsToInput, parseMoneyInput, parsePercentInput } from '../../lib/format'
import { DEFAULT_COSTS, PLAN_LIMITS, type AmortizationSystem, type CostItem, type PlanInputs } from '@shared/propertyPlan'

/**
 * Estado de formulário do plano de imóvel (texto, como os campos guardam)
 * e a conversão para as premissas numéricas de `shared/propertyPlan`.
 * Usado pela calculadora "Imóvel" e pela edição de um plano salvo.
 */

export type CostDraft = { label: string; kind: 'pct' | 'fixed'; value: string }

export type PlanForm = {
  price: string
  appreciation: string
  downPayment: string
  costs: CostDraft[]
  otherResources: string
  rate: string
  termYears: string
  system: AmortizationSystem
  fees: string
  income: string
  incomeLimit: string
  relief: string
  saved: string
  monthly: string
  expectedReturn: string
  livingCost: string
  multiple: string
  reserveCurrent: string
}

/** Premissas que o servidor guarda em `property_plans` (mesmo formato de `PlanFields` no serviço). */
export type PlanFields = {
  priceCents: number
  appreciationBps: number
  downPaymentBps: number
  costs: CostItem[]
  otherResourcesCents: number
  financingRateBps: number
  termMonths: number
  system: AmortizationSystem
  monthlyFeesCents: number
  incomeOverrideCents: number | null
  incomeLimitBps: number
  expenseReliefCents: number
}

export type PlanDefaults = {
  reserve: { currentCents: number; livingCostCents: number; multiple: number }
  typicalIncomeCents: number
  incomeSampleMonths: number
}

const costToDraft = (c: CostItem): CostDraft => ({ label: c.label, kind: c.kind, value: c.kind === 'pct' ? bpsToInput(c.value) : centsToInput(c.value) })

export const emptyForm = (): PlanForm => ({
  price: '',
  appreciation: '4',
  downPayment: '20',
  costs: DEFAULT_COSTS.map(costToDraft),
  otherResources: '',
  rate: '11',
  termYears: '30',
  system: 'sac',
  fees: '',
  income: '',
  incomeLimit: '30',
  relief: '',
  saved: '',
  monthly: '',
  expectedReturn: '10',
  livingCost: '',
  multiple: '6',
  reserveCurrent: '',
})

/** Preenche o formulário com um plano salvo (os campos de segurança vêm do app, não do plano). */
export function formFromPlan(
  plan: PlanFields,
  goal: { monthlyContributionCents: number; expectedReturnBps: number },
  defaults: PlanDefaults,
  savedCents: number,
): PlanForm {
  return {
    price: centsToInput(plan.priceCents),
    appreciation: bpsToInput(plan.appreciationBps),
    downPayment: bpsToInput(plan.downPaymentBps),
    costs: plan.costs.map(costToDraft),
    otherResources: centsToInput(plan.otherResourcesCents || null),
    rate: bpsToInput(plan.financingRateBps),
    termYears: String(Math.round((plan.termMonths / 12) * 10) / 10).replace('.', ','),
    system: plan.system,
    fees: centsToInput(plan.monthlyFeesCents || null),
    income: centsToInput(plan.incomeOverrideCents),
    incomeLimit: bpsToInput(plan.incomeLimitBps),
    relief: centsToInput(plan.expenseReliefCents || null),
    saved: centsToInput(savedCents),
    monthly: centsToInput(goal.monthlyContributionCents || null),
    expectedReturn: bpsToInput(goal.expectedReturnBps),
    livingCost: centsToInput(defaults.reserve.livingCostCents),
    multiple: String(defaults.reserve.multiple),
    reserveCurrent: centsToInput(defaults.reserve.currentCents),
  }
}

const money0 = (raw: string) => Math.abs(parseMoneyInput(raw) ?? 0)
const clamp = (n: number, lim: { min: number; max: number }) => Math.min(lim.max, Math.max(lim.min, n))

/** Meses a partir de "30" ou "12,5" anos; nulo se vazio ou inválido. */
export function termMonthsOf(raw: string): number | null {
  const n = Number(raw.trim().replace(',', '.'))
  if (!raw.trim() || !Number.isFinite(n) || n <= 0) return null
  return clamp(Math.round(n * 12), PLAN_LIMITS.termMonths)
}

export function costsOf(form: PlanForm): CostItem[] {
  return form.costs
    .filter((c) => c.label.trim())
    .map((c) => ({
      label: c.label.trim(),
      kind: c.kind,
      value: c.kind === 'pct' ? clamp(Math.abs(parsePercentInput(c.value) ?? 0), PLAN_LIMITS.costPctBps) : money0(c.value),
    }))
}

/** Premissas do plano, ou nulo enquanto faltar preço, taxa ou prazo. */
export function fieldsOf(form: PlanForm): PlanFields | null {
  const priceCents = parseMoneyInput(form.price)
  const rate = parsePercentInput(form.rate)
  const termMonths = termMonthsOf(form.termYears)
  if (!priceCents || priceCents <= 0 || rate === null || termMonths === null) return null
  const income = parseMoneyInput(form.income)
  return {
    priceCents: Math.abs(priceCents),
    appreciationBps: clamp(parsePercentInput(form.appreciation) ?? 0, PLAN_LIMITS.appreciationBps),
    downPaymentBps: clamp(Math.abs(parsePercentInput(form.downPayment) ?? 2000), PLAN_LIMITS.downPaymentBps),
    costs: costsOf(form),
    otherResourcesCents: money0(form.otherResources),
    financingRateBps: clamp(Math.abs(rate), PLAN_LIMITS.rateBps),
    termMonths,
    system: form.system,
    monthlyFeesCents: money0(form.fees),
    incomeOverrideCents: income && income > 0 ? Math.abs(income) : null,
    incomeLimitBps: clamp(Math.abs(parsePercentInput(form.incomeLimit) ?? 3000), PLAN_LIMITS.incomeLimitBps),
    expenseReliefCents: money0(form.relief),
  }
}

/**
 * Premissas completas para `projectPlan`. Na calculadora, renda, reserva e
 * custo de vida vêm do formulário; no plano salvo, `incomeFallbackCents` é
 * a renda típica do app quando o campo de renda está vazio.
 */
export function inputsOf(form: PlanForm, incomeFallbackCents: number | null = null): PlanInputs | null {
  const fields = fieldsOf(form)
  if (!fields) return null
  const multiple = Number(form.multiple.replace(',', '.'))
  return {
    ...fields,
    incomeCents: fields.incomeOverrideCents ?? (incomeFallbackCents && incomeFallbackCents > 0 ? incomeFallbackCents : null),
    livingCostCents: money0(form.livingCost),
    reserveMultiple: Number.isFinite(multiple) && multiple >= 0 ? multiple : 0,
    reserveCurrentCents: money0(form.reserveCurrent),
    savedCents: money0(form.saved),
    monthlyContributionCents: money0(form.monthly),
    expectedReturnBps: parsePercentInput(form.expectedReturn) ?? 0,
  }
}
