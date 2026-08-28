import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/* ------------------------------------------------------------------ *
 * Shared server types (mirrors of the service return shapes)
 * ------------------------------------------------------------------ */
export type Account = {
  id: number
  name: string
  institution: string
  kind: string
  currency: string
  openingBalanceCents: number
}

export type AccountBalance = {
  id: number
  name: string
  institution: string
  kind: string
  balanceCents: number
  transactionCount: number
  lastPostedOn: string | null
}

export type Meta = {
  ledger: { min: string | null; max: string | null; count: number }
  today: string
  defaultRange: { from: string; to: string; accountId: number | null }
  accounts: AccountBalance[]
  hasData: boolean
}

export type CategoryOption = {
  id: number
  name: string
  parentName: string | null
  path: string
  kind: string
  color: string
  isLeaf: number
}

export type CategoryNode = {
  id: number
  parentId: number | null
  name: string
  kind: string
  color: string
  icon: string
  sortOrder: number
  transactionCount: number
  children: CategoryNode[]
}

/* ------------------------------------------------------------------ *
 * The one filter row that scopes every chart on a page. Per-chart
 * filters are an anti-pattern: the whole view must move together.
 * ------------------------------------------------------------------ */
export type RangePreset = 'mtd' | '3m' | '6m' | '12m' | 'ytd' | 'max' | 'custom'

type RangeState = {
  from: string
  to: string
  accountId: number | null
  preset: RangePreset
  /** The ledger's latest date (today, in effect) — independent of `to`,
   * which for backward-looking presets already means "end of period",
   * not "now". Anything that needs "now" as the anchor for a FORWARD
   * window (see forwardBoundsFor) reads this instead. */
  anchor: string
}

type RangeContextValue = RangeState & {
  setPreset: (preset: RangePreset) => void
  setCustom: (from: string, to: string) => void
  setAccountId: (accountId: number | null) => void
  ready: boolean
}

const RangeContext = createContext<RangeContextValue | null>(null)

const pad = (n: number) => String(n).padStart(2, '0')
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + months
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`
}

function boundsFor(preset: RangePreset, anchorIso: string): { from: string; to: string } {
  const anchorPeriod = anchorIso.slice(0, 7)
  const [ay, am] = anchorPeriod.split('-').map(Number) as [number, number]

  // "Mês atual" ends AT the anchor date itself, not the end of the month —
  // the anchor is the ledger's latest date, so the month is genuinely
  // in progress and there is nothing to show past it.
  if (preset === 'mtd') return { from: `${anchorPeriod}-01`, to: anchorIso }

  const to = `${anchorPeriod}-${pad(lastDayOf(ay, am))}`
  if (preset === 'ytd') return { from: `${ay}-01-01`, to }
  const months = preset === '3m' ? 2 : preset === '12m' ? 11 : 5
  return { from: `${shiftPeriod(anchorPeriod, -months)}-01`, to }
}

/**
 * The forward-looking mirror of `boundsFor`, for things that haven't
 * happened yet (pending receipts/expenses). A backward-looking preset
 * like "3m" means "the last 3 months" for a review card, but every one
 * of these presets is anchored at "now" and looks BACKWARD only — a
 * pending forecast dated next month would never fall inside any of
 * them, no matter which one is picked, so the card looked static. Here
 * the same preset means "this month plus the next N" instead. `from`
 * is always the START of the current month, not today — a pending item
 * dated earlier this month (still not confirmed by the bank) must stay
 * visible in "Mês atual", not drop out just because "today" moved past
 * it. `max`'s true horizon is whatever the forecast materializer
 * covers (6 months, see server cashFlow.ts) — 24 months forward is
 * just a generous stand-in for "everything there could ever be", not
 * a real boundary anything relies on.
 */
export function forwardBoundsFor(preset: RangePreset, anchorIso: string): { from: string; to: string } {
  const anchorPeriod = anchorIso.slice(0, 7)
  const [ay, am] = anchorPeriod.split('-').map(Number) as [number, number]
  const from = `${anchorPeriod}-01`

  if (preset === 'mtd') return { from, to: `${anchorPeriod}-${pad(lastDayOf(ay, am))}` }
  if (preset === 'ytd') return { from, to: `${ay}-12-31` }

  const months = preset === '3m' ? 3 : preset === '12m' ? 12 : preset === 'max' ? 24 : 6
  const endPeriod = shiftPeriod(anchorPeriod, months)
  const [ey, em] = endPeriod.split('-').map(Number) as [number, number]
  return { from, to: `${endPeriod}-${pad(lastDayOf(ey, em))}` }
}

export function RangeProvider({ children }: { children: ReactNode }) {
  const meta = useMeta()
  const [preset, setPresetState] = useState<RangePreset>('mtd')
  const [custom, setCustomState] = useState<{ from: string; to: string } | null>(null)
  const [accountId, setAccountId] = useState<number | null>(null)

  /**
   * The anchor is the latest date the LEDGER holds, not today. Someone who
   * just imported statements from last quarter should not land on an empty
   * dashboard because the calendar moved on. But it can never run AHEAD of
   * today: `ledgerBounds()` only counts confirmed (non-pending) rows, so
   * this is meant to track real, already-posted history — a single
   * mis-dated or leftover-test row with a future `postedOn` would otherwise
   * drag "Mês atual" (and every preset built on it) into that future month
   * for the whole app, with no way to tell why from the UI.
   */
  const anchor =
    meta.data && meta.data.ledger.max
      ? meta.data.ledger.max < meta.data.today
        ? meta.data.ledger.max
        : meta.data.today
      : meta.data?.today ?? '2026-01-01'

  const earliest = meta.data?.ledger.min ?? anchor

  const value = useMemo<RangeContextValue>(() => {
    const bounds =
      preset === 'custom' && custom
        ? custom
        : preset === 'max'
          ? { from: earliest, to: anchor }
          : boundsFor(preset, anchor)
    return {
      ...bounds,
      anchor,
      accountId,
      preset,
      ready: meta.isSuccess,
      setPreset: (next) => {
        setPresetState(next)
        if (next !== 'custom') setCustomState(null)
      },
      setCustom: (from, to) => {
        setCustomState({ from, to })
        setPresetState('custom')
      },
      setAccountId,
    }
  }, [preset, custom, anchor, earliest, accountId, meta.isSuccess])

  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>
}

export function useRange(): RangeContextValue {
  const context = useContext(RangeContext)
  if (!context) throw new Error('useRange precisa estar dentro de RangeProvider')
  return context
}

/* ------------------------------------------------------------------ *
 * Shared queries
 * ------------------------------------------------------------------ */
export const useMeta = () =>
  useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta') })

export const useCategories = () =>
  useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ tree: CategoryNode[]; options: CategoryOption[] }>('/categories'),
    staleTime: 60_000,
  })

export const useAccounts = () =>
  useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<{ accounts: Account[] }>('/accounts'),
    staleTime: 60_000,
  })

/**
 * Normalized lookups by id, built once from the category query. Cheap
 * cross-module joins without duplicating the data into another store.
 */
export function useCategoryIndex() {
  const { data } = useCategories()
  return useMemo(() => {
    const byId = new Map<number, CategoryOption>()
    for (const option of data?.options ?? []) byId.set(option.id, option)
    const leaves = (data?.options ?? []).filter((o) => o.isLeaf === 1)
    const parents = (data?.options ?? []).filter((o) => o.parentName === null)
    return { byId, options: data?.options ?? [], tree: data?.tree ?? [], leaves, parents }
  }, [data])
}

/** Options for a category <select>, grouped by flow kind. */
export function useCategorySelectOptions(kinds?: string[]) {
  const { options } = useCategoryIndex()
  return useMemo(
    () =>
      options
        .filter((option) => (kinds ? kinds.includes(option.kind) : true))
        .filter((option) => option.isLeaf === 1 || option.parentName === null)
        .map((option) => ({ value: option.id, label: option.path })),
    [options, kinds],
  )
}

/**
 * A transaction's `direction` (in/out) is binary; a category's `kind` is
 * four-valued (income/expense/transfer/investment). Transfer and
 * investment categories are legitimate on EITHER direction (a transfer OUT
 * and a transfer IN are both `kind: transfer`) — only income and expense
 * are direction-locked. This is the one place that mapping lives, so every
 * category picker enforces it the same way.
 */
export const KINDS_FOR_DIRECTION: Record<'in' | 'out', string[]> = {
  in: ['income', 'transfer', 'investment'],
  out: ['expense', 'transfer', 'investment'],
}

export type CategorySelectGroup = {
  parentId: number
  parentName: string
  options: Array<{ value: number; label: string }>
}

/**
 * Same category set as `useCategorySelectOptions`, shaped for a grouped
 * `<optgroup>` picker instead of a flat "Parent / Child" string list — the
 * parent/child structure is visible at selection time, not just encoded
 * into a label.
 */
export function useCategorySelectGroups(kinds?: string[]): CategorySelectGroup[] {
  const { tree } = useCategoryIndex()
  return useMemo(
    () =>
      tree
        .filter((parent) => (kinds ? kinds.includes(parent.kind) : true))
        .map((parent) => ({
          parentId: parent.id,
          parentName: parent.name,
          options: [
            { value: parent.id, label: parent.name },
            ...parent.children.map((child) => ({ value: child.id, label: child.name })),
          ],
        })),
    [tree, kinds],
  )
}
