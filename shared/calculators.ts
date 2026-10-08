/**
 * Contas das Calculadoras de Investimentos (juros compostos, renda e
 * primeiro milhão). Simulação pura (decisions/0010): taxa constante, juros
 * compostos mês a mês, aporte ou retirada no fim de cada mês. Nada aqui
 * consulta dado do app; quem chama decide de onde vêm os números.
 *
 * Valores em centavos; taxas em porcentagem (8 = 8%).
 */

export type RateUnit = 'year' | 'month'
export type PeriodUnit = 'year' | 'month'

/** Teto de horizonte: 100 anos. Evita laço infinito num alvo inalcançável. */
export const MAX_MONTHS = 1200

/** Taxa mensal equivalente: 12% ao ano ≈ 0,9489% ao mês (não 1%, que daria 12,68% ao ano). */
export function monthlyRate(ratePct: number, unit: RateUnit): number {
  const r = ratePct / 100
  return unit === 'month' ? r : Math.pow(1 + r, 1 / 12) - 1
}

export function toMonths(period: number, unit: PeriodUnit): number {
  return Math.max(0, Math.round(unit === 'year' ? period * 12 : period))
}

export type GrowthPoint = { month: number; investedCents: number; valueCents: number; interestCents: number }

/**
 * Acumulação: valor inicial mais um aporte no fim de cada mês, rendendo à
 * taxa mensal. Devolve um ponto por mês, do mês 0 (só o valor inicial) ao
 * último.
 */
export function compoundGrowth(input: {
  initialCents: number
  monthlyCents: number
  rate: number
  months: number
}): GrowthPoint[] {
  const months = Math.min(MAX_MONTHS, Math.max(0, Math.floor(input.months)))
  let value = input.initialCents
  let invested = input.initialCents
  const points: GrowthPoint[] = [{ month: 0, investedCents: invested, valueCents: value, interestCents: 0 }]
  for (let m = 1; m <= months; m++) {
    value = value * (1 + input.rate) + input.monthlyCents
    invested += input.monthlyCents
    points.push({ month: m, investedCents: invested, valueCents: Math.round(value), interestCents: Math.round(value - invested) })
  }
  return points
}

export type IncomePoint = { month: number; balanceCents: number; withdrawnCents: number; interestCents: number }

/**
 * Renda: parte de um valor, rende à taxa mensal e paga a retirada no fim de
 * cada mês. Para no mês em que o dinheiro acaba (a última retirada pode ser
 * parcial) ou no fim do prazo.
 */
export function incomeDrawdown(input: {
  initialCents: number
  withdrawalCents: number
  rate: number
  months: number
}): { points: IncomePoint[]; depletedMonth: number | null } {
  const months = Math.min(MAX_MONTHS, Math.max(0, Math.floor(input.months)))
  let balance = input.initialCents
  let withdrawn = 0
  let interest = 0
  const points: IncomePoint[] = [{ month: 0, balanceCents: balance, withdrawnCents: 0, interestCents: 0 }]
  for (let m = 1; m <= months; m++) {
    const earned = balance * input.rate
    interest += earned
    balance += earned
    const take = Math.min(balance, input.withdrawalCents)
    balance -= take
    withdrawn += take
    points.push({ month: m, balanceCents: Math.round(balance), withdrawnCents: Math.round(withdrawn), interestCents: Math.round(interest) })
    if (balance <= 0.5 && input.withdrawalCents > 0) return { points, depletedMonth: m }
  }
  return { points, depletedMonth: null }
}

/** Primeiro mês em que a acumulação alcança o alvo, ou `null` se não alcança em 100 anos. */
export function monthsToTarget(input: { initialCents: number; monthlyCents: number; rate: number; targetCents: number }): number | null {
  if (input.initialCents >= input.targetCents) return 0
  let value = input.initialCents
  for (let m = 1; m <= MAX_MONTHS; m++) {
    value = value * (1 + input.rate) + input.monthlyCents
    if (value >= input.targetCents) return m
  }
  return null
}

/**
 * Aporte mensal (no fim do mês) para sair do valor inicial e chegar ao alvo
 * em `months` meses. Zero quando o valor inicial sozinho já chega.
 */
export function requiredMonthly(input: { initialCents: number; rate: number; months: number; targetCents: number }): number {
  const n = Math.max(1, Math.floor(input.months))
  const grown = input.initialCents * Math.pow(1 + input.rate, n)
  const gap = input.targetCents - grown
  if (gap <= 0) return 0
  if (input.rate === 0) return Math.ceil(gap / n)
  return Math.ceil((gap * input.rate) / (Math.pow(1 + input.rate, n) - 1))
}

/** "3 anos e 4 meses", "11 meses", "1 ano". */
export function durationLabel(months: number): string {
  const years = Math.floor(months / 12)
  const rest = months % 12
  const y = years === 0 ? '' : years === 1 ? '1 ano' : `${years} anos`
  const m = rest === 0 ? '' : rest === 1 ? '1 mês' : `${rest} meses`
  return y && m ? `${y} e ${m}` : y || m || '0 mês'
}

/**
 * Pontos para o gráfico: mês a mês até 3 anos; depois disso um por ano (e o
 * último, se o prazo não fechar o ano), para o eixo não virar uma parede de
 * barras.
 */
export function chartPoints<T extends { month: number }>(points: T[]): T[] {
  const last = points.at(-1)
  if (!last || last.month <= 36) return points
  return points.filter((p) => p.month % 12 === 0 || p.month === last.month)
}
