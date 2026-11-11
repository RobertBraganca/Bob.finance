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
  advice: CeilingAdvice
}

/**
 * Faturar até 20% acima do teto desenquadra o MEI a partir de janeiro do ano
 * seguinte (com DAS complementar sobre o excesso); passar de 20% desenquadra
 * retroativamente a janeiro do próprio ano, com os tributos de ME desde lá
 * (LC 123/2006, art. 18-A §7º III).
 */
export const MEI_TOLERANCE_BPS = 2_000

/**
 * Recomendação do teto (`decisions/0047`: o app recomenda, não só mostra).
 * - `retroactive`: o faturado já passou de teto + 20%.
 * - `exceeded`: o faturado passou do teto, ainda dentro dos 20%.
 * - `projected_retroactive`: no ritmo, o ano fecha acima de teto + 20%.
 * - `projected_over`: no ritmo, o ano fecha acima do teto.
 * - `approaching`: no ritmo, o ano fecha acima de 80% do teto.
 * - `none`: folga.
 */
export type CeilingAdvice = {
  kind: 'none' | 'approaching' | 'projected_over' | 'projected_retroactive' | 'exceeded' | 'retroactive'
  /** meses depois de `period` até dezembro */
  monthsLeft: number
  /** quanto ainda cabe no teto até dezembro; 0 se já passou */
  roomCents: number
  /** `roomCents` ÷ meses que faltam; nulo em dezembro (não há mês seguinte) */
  monthlyRoomCents: number | null
  /** teto + 20%: acima disso o desenquadramento é retroativo a janeiro */
  toleranceLimitCents: number
  /** quanto ainda dá para faturar no ano sem passar de teto + 20%; 0 se já passou */
  toleranceRoomCents: number
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
  const toleranceLimitCents = Math.round((limit * (10_000 + MEI_TOLERANCE_BPS)) / 10_000)
  const roomCents = Math.max(0, limit - yearRevenueCents)
  const kind: CeilingAdvice['kind'] =
    yearRevenueCents > toleranceLimitCents
      ? 'retroactive'
      : yearRevenueCents > limit
        ? 'exceeded'
        : projectedYearCents > toleranceLimitCents
          ? 'projected_retroactive'
          : projectedYearCents > limit
            ? 'projected_over'
            : projectedShareBps > 8_000
              ? 'approaching'
              : 'none'
  return {
    yearRevenueCents,
    limitCents: limit,
    paceCents,
    projectedYearCents,
    usedBps: Math.round((yearRevenueCents / limit) * 10_000),
    projectedShareBps,
    reachesInPeriod,
    state: projectedShareBps > 10_000 ? 'critical' : projectedShareBps > 8_000 ? 'attention' : 'ok',
    advice: {
      kind,
      monthsLeft: remaining,
      roomCents,
      monthlyRoomCents: remaining > 0 ? Math.floor(roomCents / remaining) : null,
      toleranceLimitCents,
      toleranceRoomCents: Math.max(0, toleranceLimitCents - yearRevenueCents),
    },
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
