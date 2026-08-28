import { normalizeDescription } from '../core/normalize.ts'

/**
 * Two-layer categorization, deliberately without any ML infrastructure.
 *
 *  1. RULES — deterministic, ordered by priority, fully user-editable. This
 *     is what actually categorizes transactions.
 *  2. MEMORY — a frequency table of past manual corrections keyed by merchant
 *     signature. It only ever *suggests*; a suggestion becomes a rule when
 *     the same correction has been confirmed AUTO_PROMOTE_AT times, or when
 *     the user promotes it by hand.
 *
 * Anything the two layers cannot explain stays uncategorized rather than
 * being guessed at, because a wrong category is worse than a blank one.
 */

export const AUTO_PROMOTE_AT = 3

export type RuleRow = {
  id: number
  categoryId: number
  field: string
  matchType: string
  pattern: string
  direction: string
  amountMinCents: number | null
  amountMaxCents: number | null
  accountId: number | null
  priority: number
  active: boolean
}

export type MemoryRow = {
  signature: string
  categoryId: number
  hits: number
  lastSeenAt: string
}

export type CategorizableRow = {
  descriptionNorm: string
  signature: string
  amountCents: number
  rawCategory: string | null
  accountId: number
}

export type Suggestion = {
  categoryId: number | null
  source: 'rule' | 'memory' | 'raw_category' | 'none'
  detail: string | null
  ruleId: number | null
}

const NO_MATCH: Suggestion = { categoryId: null, source: 'none', detail: null, ruleId: null }

export class Categorizer {
  private readonly rules: RuleRow[]
  private readonly memory: Map<string, MemoryRow[]>
  private readonly categoriesByName: Map<string, number>
  private readonly regexCache = new Map<string, RegExp | null>()

  constructor(
    rules: RuleRow[],
    memory: MemoryRow[],
    categories: Array<{ id: number; name: string }>,
  ) {
    this.rules = rules
      .filter((r) => r.active)
      .slice()
      .sort((a, b) => a.priority - b.priority || a.id - b.id)

    this.memory = new Map()
    for (const row of memory) {
      const bucket = this.memory.get(row.signature)
      if (bucket) bucket.push(row)
      else this.memory.set(row.signature, [row])
    }
    for (const bucket of this.memory.values()) {
      bucket.sort((a, b) => b.hits - a.hits || b.lastSeenAt.localeCompare(a.lastSeenAt))
    }

    this.categoriesByName = new Map()
    for (const c of categories) {
      const key = normalizeDescription(c.name)
      if (key && !this.categoriesByName.has(key)) this.categoriesByName.set(key, c.id)
    }
  }

  suggest(row: CategorizableRow): Suggestion {
    const fromRule = this.matchRule(row)
    if (fromRule) return fromRule

    const fromMemory = this.matchMemory(row)
    if (fromMemory) return fromMemory

    const fromRaw = this.matchRawCategory(row)
    if (fromRaw) return fromRaw

    return NO_MATCH
  }

  private matchRule(row: CategorizableRow): Suggestion | null {
    for (const rule of this.rules) {
      if (rule.accountId !== null && rule.accountId !== row.accountId) continue

      const direction = row.amountCents >= 0 ? 'in' : 'out'
      if (rule.direction !== 'any' && rule.direction !== direction) continue

      const magnitude = Math.abs(row.amountCents)
      if (rule.amountMinCents !== null && magnitude < rule.amountMinCents) continue
      if (rule.amountMaxCents !== null && magnitude > rule.amountMaxCents) continue

      const haystack =
        rule.field === 'raw_category' ? normalizeDescription(row.rawCategory ?? '') : row.descriptionNorm
      if (!haystack) continue

      if (this.matches(haystack, rule)) {
        return {
          categoryId: rule.categoryId,
          source: 'rule',
          detail: `regra #${rule.id}: ${rule.matchType} "${rule.pattern}"`,
          ruleId: rule.id,
        }
      }
    }
    return null
  }

  private matches(haystack: string, rule: RuleRow): boolean {
    const needle = rule.matchType === 'regex' ? rule.pattern : normalizeDescription(rule.pattern)
    if (!needle) return false

    switch (rule.matchType) {
      case 'contains':
        return haystack.includes(needle)
      case 'starts_with':
        return haystack.startsWith(needle)
      case 'equals':
        return haystack === needle
      case 'regex': {
        const re = this.compile(needle)
        return re ? re.test(haystack) : false
      }
      default:
        return false
    }
  }

  private compile(pattern: string): RegExp | null {
    if (!this.regexCache.has(pattern)) {
      try {
        this.regexCache.set(pattern, new RegExp(pattern, 'i'))
      } catch {
        this.regexCache.set(pattern, null)
      }
    }
    return this.regexCache.get(pattern) ?? null
  }

  private matchMemory(row: CategorizableRow): Suggestion | null {
    if (!row.signature) return null
    const bucket = this.memory.get(row.signature)
    const best = bucket?.[0]
    if (!best) return null
    return {
      categoryId: best.categoryId,
      source: 'memory',
      detail: `aprendido de ${best.hits} correção(ões) para "${row.signature}"`,
      ruleId: null,
    }
  }

  /** Last resort: the bank's own category label, if it names a real category. */
  private matchRawCategory(row: CategorizableRow): Suggestion | null {
    if (!row.rawCategory) return null
    const key = normalizeDescription(row.rawCategory)
    const categoryId = this.categoriesByName.get(key)
    if (categoryId === undefined) return null
    return {
      categoryId,
      source: 'raw_category',
      detail: `categoria do banco: "${row.rawCategory}"`,
      ruleId: null,
    }
  }
}
