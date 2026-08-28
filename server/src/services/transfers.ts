import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import type { Range } from './analytics'

/**
 * Account-to-account flow.
 *
 * A transfer between the user's own accounts is stored as TWO independent
 * rows — money leaving one account and arriving in another — because that is
 * literally what the two bank exports say. Summing both legs would double
 * count, and the description alone cannot resolve direction: a Pix from the
 * PJ account to the PF account names the institution ("NU PAGAMENTOS") on
 * both sides, which is the same string for both Nubank accounts.
 *
 * So the legs are PAIRED instead: an outflow and an inflow of the exact same
 * amount, on the same day (or one day apart for non-instant rails), in two
 * different accounts, with at least one side already classified as a
 * transfer. That resolves PJ vs PF unambiguously and counts the money once.
 *
 * Legs that find no partner are reported separately rather than guessed at —
 * they are usually transfers to a bank that has no statement in this ledger,
 * or a period where only one of the two accounts was exported.
 */

/** Institutions that can be recognized in a transfer description. */
const INSTITUTIONS: Array<[RegExp, string]> = [
  [/nu pagamentos|nubank/, 'Nubank'],
  [/banco inter|\binter\b/, 'Inter'],
  [/picpay/, 'PicPay'],
  [/mercado pago/, 'Mercado Pago'],
  [/bco c6|c6 s\.a|banco c6/, 'C6'],
  [/banestes/, 'Banestes'],
  [/itau/, 'Itaú'],
  [/bradesco/, 'Bradesco'],
  [/caixa economica/, 'Caixa'],
  [/santander/, 'Santander'],
  [/bco do brasil|banco do brasil|bb s\.a/, 'Banco do Brasil'],
  [/pagseguro|pagbank/, 'PagBank'],
  [/will financeira/, 'Will'],
  [/neon pagamentos|banco neon/, 'Neon'],
]

const institutionOf = (description: string): string | null =>
  INSTITUTIONS.find(([re]) => re.test(description))?.[1] ?? null

type Leg = {
  id: number
  accountId: number
  accountName: string
  postedOn: string
  amountCents: number
  descriptionNorm: string
  isTransfer: boolean
}

export type FlowEdge = {
  fromAccountId: number
  fromName: string
  toAccountId: number
  toName: string
  amountCents: number
  count: number
}

export type LooseLeg = {
  accountId: number
  accountName: string
  direction: 'out' | 'in'
  /** counterparty institution, when the description names one */
  institution: string | null
  amountCents: number
  count: number
}

export type AccountFlow = {
  range: Range
  nodes: Array<{ id: number; name: string; institution: string; kind: string }>
  edges: FlowEdge[]
  /** transfer legs with no matching partner in the ledger */
  loose: LooseLeg[]
  totals: {
    internalCents: number
    internalCount: number
    looseCents: number
    looseCount: number
    /** share of transfer legs that were successfully paired, in basis points */
    pairedBps: number
  }
}

export function accountFlows(range: Range): AccountFlow {
  const nodes = db.all<{ id: number; name: string; institution: string; kind: string }>(sql`
    select id, name, institution, kind from accounts where archived = 0 order by name`)

  /**
   * Every row in the window, flagged for whether it is a classified transfer.
   * Candidates are deliberately NOT limited to classified transfers: PicPay
   * reports incoming Pix with no counterparty at all, so those 724 rows are
   * uncategorized and a both-sides-classified rule could never pair a
   * Nubank -> PicPay move. Pairing requires only that ONE side is a known
   * transfer, which keeps the signal strong without discarding the partner.
   */
  const all = db.all<Leg>(sql`
    select
      t.id,
      t.account_id as accountId,
      a.name as accountName,
      t.posted_on as postedOn,
      t.amount_cents as amountCents,
      t.description_norm as descriptionNorm,
      case when c.kind = 'transfer' then 1 else 0 end as isTransfer
    from transactions t
    join accounts a on a.id = t.account_id and a.archived = 0
    left join categories c on c.id = t.category_id
    where t.posted_on between ${range.from} and ${range.to}
      and t.pending = 0
    order by abs(t.amount_cents) desc, t.posted_on`)

  // `legs` is what the unpaired remainder is measured against: the rows that
  // actually claim to be transfers.
  const legs = all.filter((l) => l.isTransfer)
  const outflows = all.filter((l) => l.amountCents < 0)
  const inflows = all.filter((l) => l.amountCents > 0)

  /**
   * Index inflows by amount so pairing is a lookup rather than an O(n^2)
   * scan — this runs over years of history on every dashboard load.
   */
  const inflowsByAmount = new Map<number, Leg[]>()
  for (const leg of inflows) {
    const key = Math.abs(leg.amountCents)
    const bucket = inflowsByAmount.get(key)
    if (bucket) bucket.push(leg)
    else inflowsByAmount.set(key, [leg])
  }

  const used = new Set<number>()
  const edgeMap = new Map<string, FlowEdge>()
  let internalCents = 0
  let internalCount = 0

  const dayDiff = (a: string, b: string) =>
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

  // Same-day first, then a one-day window for rails that settle overnight.
  for (const tolerance of [0, 1]) {
    for (const out of outflows) {
      if (used.has(out.id)) continue
      const candidates = inflowsByAmount.get(Math.abs(out.amountCents))
      if (!candidates) continue

      const match = candidates.find(
        (candidate) =>
          !used.has(candidate.id) &&
          candidate.accountId !== out.accountId &&
          dayDiff(candidate.postedOn, out.postedOn) <= tolerance &&
          // At least one side must claim to be a transfer, otherwise two
          // unrelated same-amount rows on the same day would pair by chance.
          (out.isTransfer || candidate.isTransfer),
      )
      if (!match) continue

      used.add(out.id)
      used.add(match.id)

      const key = `${out.accountId}->${match.accountId}`
      const existing = edgeMap.get(key)
      if (existing) {
        existing.amountCents += Math.abs(out.amountCents)
        existing.count++
      } else {
        edgeMap.set(key, {
          fromAccountId: out.accountId,
          fromName: out.accountName,
          toAccountId: match.accountId,
          toName: match.accountName,
          amountCents: Math.abs(out.amountCents),
          count: 1,
        })
      }
      internalCents += Math.abs(out.amountCents)
      internalCount++
    }
  }

  // Everything that found no partner, grouped by account + direction +
  // institution, so the unexplained remainder is visible instead of hidden.
  const looseMap = new Map<string, LooseLeg>()
  let looseCents = 0
  let looseCount = 0

  for (const leg of legs) {
    if (used.has(leg.id)) continue
    const direction = leg.amountCents < 0 ? 'out' : 'in'
    const institution = institutionOf(leg.descriptionNorm)
    const key = `${leg.accountId}|${direction}|${institution ?? '?'}`
    const existing = looseMap.get(key)
    if (existing) {
      existing.amountCents += Math.abs(leg.amountCents)
      existing.count++
    } else {
      looseMap.set(key, {
        accountId: leg.accountId,
        accountName: leg.accountName,
        direction,
        institution,
        amountCents: Math.abs(leg.amountCents),
        count: 1,
      })
    }
    looseCents += Math.abs(leg.amountCents)
    looseCount++
  }

  const totalLegs = legs.length
  return {
    range,
    nodes,
    edges: [...edgeMap.values()].sort((a, b) => b.amountCents - a.amountCents),
    loose: [...looseMap.values()].sort((a, b) => b.amountCents - a.amountCents),
    totals: {
      internalCents,
      internalCount,
      looseCents,
      looseCount,
      // Two legs are consumed per pair, hence the doubling.
      pairedBps: totalLegs > 0 ? Math.round(((internalCount * 2) / totalLegs) * 10_000) : 0,
    },
  }
}
