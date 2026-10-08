import type { BudgetGroupSource } from '@shared/budget'

/** Formatos de `/budget/:period` e `/budget/settings` (server/src/services/budget.ts). */

export type BudgetIncome = { cents: number; receivedCents: number; typicalCents: number; estimated: boolean }

export type BudgetLine = {
  id: number
  name: string
  color: string
  source: BudgetGroupSource
  archived: boolean
  targetBps: number
  plannedCents: number
  actualCents: number
  remainingCents: number
  shareBps: number | null
  usedBps: number | null
  pendingCents: number
  count: number
}

export type MonthBudget = {
  period: string
  income: BudgetIncome
  totals: { spentCents: number; contributedCents: number; remainingCents: number; spentShareBps: number | null }
  groups: BudgetLine[]
  ungrouped: { actualCents: number; pendingCents: number; count: number }
  plan: { effectivePeriod: string } | null
  assumptions: Record<string, unknown>
}

export type BudgetGroup = {
  id: number
  name: string
  color: string
  sortOrder: number
  source: BudgetGroupSource
  archived: boolean
}

export type BudgetCategory = {
  id: number
  parentId: number | null
  name: string
  budgetGroupId: number | null
  budgetExcluded: boolean
  effectiveGroupId: number | null
  effectiveExcluded: boolean
  suggestedGroupId: number | null
  suggestedExcluded: boolean
}

export type BudgetSettings = {
  groups: BudgetGroup[]
  plan: { effectivePeriod: string; allocations: Array<{ groupId: number; targetBps: number }> } | null
  period: string
  income: BudgetIncome
  history: Array<{ groupId: number; shareBps: number }>
  historyMonths: number
  categories: BudgetCategory[]
}

export const SOURCE_NOTE: Record<BudgetGroupSource, string | null> = {
  categories: null,
  goal_contributions: 'mede aportes em ativos separados para metas',
  other_contributions: 'mede os demais aportes, reserva inclusa',
}

/** Cores para um grupo novo: a paleta de séries e da marca, na ordem. */
export const GROUP_COLORS = ['#007bff', '#ff2ea6', '#e8590c', '#ffc700', '#ba2be2', '#1e8e3c', '#00a3a3', '#6b5bd6']
