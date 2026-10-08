/**
 * Comparar alocações (Calculadoras de Investimentos): projeção de
 * cenários de divisão por classe, cada classe rendendo à taxa que o usuário
 * informou. Simulação pura (decisions/0010): taxa constante e sem
 * oscilação, então o risco de cada classe não entra na conta. Nada aqui
 * escolhe cenário.
 *
 * Valores em centavos; pesos e taxas em pontos-base (2500 = 25%; taxa ao ano).
 */

export const FULL_WEIGHT = 10_000

export type ScenarioInput = {
  /** peso de cada classe, em bps; soma 10000 */
  weights: Record<string, number>
}

export type SimulationInput = {
  /** taxa anual esperada por classe, em bps */
  rates: Record<string, number>
  initialCents: number
  monthlyCents: number
  months: number
  /** "reserva primeiro": o aporte enche a falta da reserva antes de ir para as classes */
  reserveFirst?: { gapCents: number; rateBps: number } | null
}

export type ScenarioResult = {
  /** média dos pesos × taxas (aproximação da taxa da carteira) */
  blendedRateBps: number
  /** quanto do aporte mensal vai para cada classe depois da reserva */
  monthlySplit: Record<string, number>
  /** valor total (classes + reserva acumulada) mês a mês, do mês 0 */
  series: number[]
  /** mês em que a reserva fica completa; nulo sem "reserva primeiro" ou se não completa no prazo */
  reserveCompleteMonth: number | null
  investedCents: number
}

const monthlyRate = (annualBps: number) => Math.pow(1 + annualBps / 10_000, 1 / 12) - 1

export const weightTotal = (weights: Record<string, number>) => Object.values(weights).reduce((s, w) => s + (w > 0 ? w : 0), 0)

/**
 * Cada classe é um balde que rende à sua taxa mensal equivalente; o valor
 * inicial e cada aporte entram divididos pelos pesos, no fim do mês, sem
 * rebalancear. Com "reserva primeiro", o aporte vai inteiro para a reserva
 * até cobrir a falta, que rende à taxa dela.
 */
export function simulateScenario(scenario: ScenarioInput, input: SimulationInput): ScenarioResult {
  const classes = Object.keys(scenario.weights).filter((c) => (scenario.weights[c] ?? 0) > 0)
  const total = weightTotal(scenario.weights) || FULL_WEIGHT
  const share = (c: string) => (scenario.weights[c] ?? 0) / total
  const rate = new Map(classes.map((c) => [c, monthlyRate(input.rates[c] ?? 0)]))
  const buckets = new Map(classes.map((c) => [c, Math.max(0, input.initialCents) * share(c)]))
  const months = Math.max(0, Math.round(input.months))
  const monthly = Math.max(0, input.monthlyCents)

  const reserveGap = Math.max(0, input.reserveFirst?.gapCents ?? 0)
  const reserveRate = monthlyRate(input.reserveFirst?.rateBps ?? 0)
  let reserve = 0
  let reserveCompleteMonth: number | null = input.reserveFirst && reserveGap === 0 ? 0 : null

  const sum = () => [...buckets.values()].reduce((s, v) => s + v, 0) + reserve
  const series = [Math.round(sum())]
  for (let m = 1; m <= months; m++) {
    for (const c of classes) buckets.set(c, buckets.get(c)! * (1 + rate.get(c)!))
    reserve *= 1 + reserveRate
    let toClasses = monthly
    if (input.reserveFirst && reserve < reserveGap) {
      const toReserve = Math.min(monthly, reserveGap - reserve)
      reserve += toReserve
      toClasses -= toReserve
      if (reserve >= reserveGap - 0.5 && reserveCompleteMonth === null) reserveCompleteMonth = m
    }
    for (const c of classes) buckets.set(c, buckets.get(c)! + toClasses * share(c))
    series.push(Math.round(sum()))
  }

  const blendedRateBps = Math.round(classes.reduce((s, c) => s + share(c) * (input.rates[c] ?? 0), 0))
  const monthlySplit: Record<string, number> = {}
  for (const c of classes) monthlySplit[c] = Math.round(monthly * share(c))
  return {
    blendedRateBps,
    monthlySplit,
    series,
    reserveCompleteMonth,
    investedCents: Math.max(0, input.initialCents) + monthly * months,
  }
}

/** Retorno acumulado de uma série de retornos mensais (bps), só se houver ao menos `minMonths` pontos. */
export function trailingReturnBps(monthlyBps: number[], minMonths = 12): number | null {
  if (monthlyBps.length < minMonths) return null
  const last = monthlyBps.slice(-minMonths)
  const acc = last.reduce((p, r) => p * (1 + r / 10_000), 1)
  return Math.round((acc - 1) * 10_000)
}
