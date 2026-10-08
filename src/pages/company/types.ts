/** Formatos de `/company/overview` e `/company/settings` (server/src/services/company.ts). */

export type CompanyOverview = {
  period: string
  isCurrent: boolean
  pjAccount: { id: number; name: string } | null
  dasMonthlyCents: number
  dasPending: boolean
  withdrawable: {
    cashCents: number
    dasDueCents: number
    pendingCents: number
    fixedMonthlyCents: number
    cushionMonths: number
    cushionCents: number
    withdrawableCents: number
    shortfallCents: number
    withdrawnThisMonthCents: number
  } | null
  cascade: { revenueCents: number; dasCents: number; costsCents: number; profitCents: number; withdrawalsCents: number; keptCents: number }
  ceiling: {
    yearRevenueCents: number
    limitCents: number
    paceCents: number
    projectedYearCents: number
    usedBps: number
    projectedShareBps: number
    reachesInPeriod: string | null
    state: 'ok' | 'attention' | 'critical'
  }
  coverage: { withdrawalsCents: number; personalSpentCents: number; coverageBps: number | null; livingCostCents: number }
  series: Array<{ period: string; revenueCents: number; withdrawalsCents: number; personalSpentCents: number }>
  assumptions: Record<string, unknown>
}

export type CompanySettings = {
  pjAccountId: number | null
  dasMonthlyCents: number | null
  lastDasPaid: { cents: number; postedOn: string } | null
  pjCushionMonths: number
  meiAnnualLimitCents: number
  dasCategoryIds: number[] | null
  effectiveDasCategoryIds: number[]
  categories: Array<{ id: number; name: string; parentId: number | null; detected: boolean }>
}
