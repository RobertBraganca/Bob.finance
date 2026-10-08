/**
 * Contas de "Minha empresa" para o MEI (specs/company-mei, decisions/0043).
 * Puras: quem chama traz caixa, faturamento, custos e retiradas já somados.
 * Valores em centavos; percentuais em pontos-base.
 */

export const DEFAULT_MEI_LIMIT_CENTS = 8_100_000
export const DEFAULT_CUSHION_MONTHS = 2

/** Mediana; vazio = 0. */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/**
 * Custo fixo mensal da PJ: mediana de (custos + DAS) nos meses com algum
 * movimento na PJ. Sem histórico, o DAS mensal.
 */
export function fixedMonthlyCost(months: Array<{ costsCents: number; dasCents: number; hasMovement: boolean }>, dasMonthlyCents: number): number {
  const values = months.filter((m) => m.hasMovement).map((m) => Math.max(0, m.costsCents) + Math.max(0, m.dasCents))
  return values.length ? median(values) : Math.max(0, dasMonthlyCents)
}

export type Withdrawable = {
  cashCents: number
  dasDueCents: number
  pendingCents: number
  fixedMonthlyCents: number
  cushionMonths: number
  cushionCents: number
  /** o que pode sair sem a PJ ficar abaixo do colchão; nunca negativo */
  withdrawableCents: number
  /** quanto a PJ já está abaixo do colchão (0 quando cabe) */
  shortfallCents: number
}

export function withdrawable(input: {
  cashCents: number
  dasDueCents: number
  pendingCents: number
  fixedMonthlyCents: number
  cushionMonths: number
}): Withdrawable {
  const cushionMonths = Math.max(0, input.cushionMonths)
  const cushionCents = Math.round(Math.max(0, input.fixedMonthlyCents) * cushionMonths)
  const free = input.cashCents - Math.max(0, input.dasDueCents) - Math.max(0, input.pendingCents) - cushionCents
  return {
    cashCents: input.cashCents,
    dasDueCents: Math.max(0, input.dasDueCents),
    pendingCents: Math.max(0, input.pendingCents),
    fixedMonthlyCents: Math.max(0, input.fixedMonthlyCents),
    cushionMonths,
    cushionCents,
    withdrawableCents: Math.max(0, free),
    shortfallCents: Math.max(0, -free),
  }
}

export type Cascade = {
  revenueCents: number
  dasCents: number
  costsCents: number
  profitCents: number
  withdrawalsCents: number
  keptCents: number
}

export function cascade({ revenueCents, dasCents, costsCents, withdrawalsCents }: { revenueCents: number; dasCents: number; costsCents: number; withdrawalsCents: number }): Cascade {
  const profitCents = revenueCents - dasCents - costsCents
  return { revenueCents, dasCents, costsCents, profitCents, withdrawalsCents, keptCents: profitCents - withdrawalsCents }
}

export type CeilingProjection = {
  yearRevenueCents: number
  limitCents: number
  /** média mensal dos 3 meses fechados anteriores ao mês (do mesmo ano ou não) */
  paceCents: number
  projectedYearCents: number
  /** faturado ÷ teto */
  usedBps: number
  /** projetado ÷ teto */
  projectedShareBps: number
  /** primeiro mês (YYYY-MM) do ano em que o acumulado projetado passa do teto; nulo se não passa */
  reachesInPeriod: string | null
  state: 'ok' | 'attention' | 'critical'
}

/**
 * Teto do MEI no ano civil de `period`. `yearRevenueCents` é o faturado de
 * janeiro até `period` inclusive; `closedPace` são os 3 meses fechados
 * anteriores a `period` (o mês corrente ainda está entrando). Projeção =
 * faturado + ritmo × meses que faltam depois de `period`.
 */
export function ceilingProjection({
  period,
  yearRevenueCents,
  closedPace,
  limitCents,
}: {
  period: string
  yearRevenueCents: number
  closedPace: number[]
  limitCents: number
}): CeilingProjection {
  const [year, month] = period.split('-').map(Number) as [number, number]
  const valid = closedPace.filter((v) => Number.isFinite(v))
  const paceCents = valid.length ? Math.round(valid.reduce((s, v) => s + v, 0) / valid.length) : 0
  const remaining = 12 - month
  const projectedYearCents = yearRevenueCents + paceCents * remaining
  const limit = Math.max(1, limitCents)
  let reachesInPeriod: string | null = null
  if (yearRevenueCents >= limit) reachesInPeriod = period
  else if (paceCents > 0) {
    const monthsNeeded = Math.ceil((limit - yearRevenueCents) / paceCents)
    if (monthsNeeded <= remaining) reachesInPeriod = `${year}-${String(month + monthsNeeded).padStart(2, '0')}`
  }
  const projectedShareBps = Math.round((projectedYearCents / limit) * 10_000)
  return {
    yearRevenueCents,
    limitCents: limit,
    paceCents,
    projectedYearCents,
    usedBps: Math.round((yearRevenueCents / limit) * 10_000),
    projectedShareBps,
    reachesInPeriod,
    state: projectedShareBps > 10_000 ? 'critical' : projectedShareBps > 8_000 ? 'attention' : 'ok',
  }
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Detecção padrão de TAG de DAS: nome com "imposto" ou "das", ou grupo de imposto no DRE. */
export function isDasCategory(name: string, dreGroup: string | null): boolean {
  if (dreGroup === 'tax') return true
  const n = normalize(name)
  return n.includes('imposto') || /\bdas\b/.test(n)
}
