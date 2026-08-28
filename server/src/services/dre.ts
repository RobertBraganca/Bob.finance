import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { merchantSignature } from '../core/normalize'
import * as analytics from './analytics'
import type { BreakdownSlice, Range, Totals } from './analytics'

/**
 * DRE (Demonstração de Resultado) per account: every income/expense leaf
 * category as its own line — never folded into an "Outras" bucket the way
 * the dashboard rings do — plus the uncategorized rows grouped by merchant
 * so the biggest unclassified chunks surface first.
 */
export type DreReport = {
  range: Range
  totals: Totals
  income: BreakdownSlice[]
  expense: BreakdownSlice[]
  uncategorized: {
    groups: UncategorizedGroup[]
    groupCount: number
    totalCount: number
    hasMore: boolean
  }
  /** Only present when the report is scoped to one account — see analytics.historicalServiceAverages. */
  serviceAverages: analytics.ServiceAverages | null
}

export type UncategorizedGroup = {
  signature: string
  sampleDescription: string
  count: number
  netCents: number
  ids: number[]
}

const GROUP_LIMIT = 30

function uncategorizedGroups(range: Range): { groups: UncategorizedGroup[]; groupCount: number; totalCount: number } {
  const rows = db.all<{ id: number; description: string; amountCents: number }>(sql`
    select id, description, amount_cents as amountCents
    from transactions
    where posted_on between ${range.from} and ${range.to}
      and category_id is null
      and pending = 0
      ${range.accountId ? sql`and account_id = ${range.accountId}` : sql``}
  `)

  const bySignature = new Map<string, UncategorizedGroup>()
  for (const row of rows) {
    const key = merchantSignature(row.description) || row.description.toLowerCase().slice(0, 40)
    const group = bySignature.get(key) ?? {
      signature: key,
      sampleDescription: row.description,
      count: 0,
      netCents: 0,
      ids: [],
    }
    group.count += 1
    group.netCents += row.amountCents
    group.ids.push(row.id)
    bySignature.set(key, group)
  }

  const groups = [...bySignature.values()].sort(
    (a, b) => Math.abs(b.netCents) - Math.abs(a.netCents),
  )

  return { groups, groupCount: groups.length, totalCount: rows.length }
}

export function dreReport(range: Range): DreReport {
  const totals = analytics.totals(range)
  const income = analytics.categoryBreakdown(range, { flow: 'income', level: 'leaf' })
  const expense = analytics.categoryBreakdown(range, { flow: 'expense', level: 'leaf' })
  const { groups, groupCount, totalCount } = uncategorizedGroups(range)

  return {
    range,
    totals,
    income,
    expense,
    uncategorized: {
      groups: groups.slice(0, GROUP_LIMIT),
      groupCount,
      totalCount,
      hasMore: groupCount > GROUP_LIMIT,
    },
    serviceAverages: range.accountId ? analytics.historicalServiceAverages(range.accountId) : null,
  }
}
