import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { categories, categoryMemory, categoryRules, transactions } from '../db/schema'

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

/** The whole tree with usage counts, in one query plus one pass. */
export function categoryTree(): CategoryNode[] {
  const rows = db.all<{
    id: number
    parentId: number | null
    name: string
    kind: string
    color: string
    icon: string
    sortOrder: number
    transactionCount: number
  }>(sql`
    select
      c.id, c.parent_id as parentId, c.name, c.kind, c.color, c.icon,
      c.sort_order as sortOrder,
      (select count(*) from transactions t where t.category_id = c.id) as transactionCount
    from categories c
    where c.archived = 0
    order by c.parent_id is not null, c.sort_order, c.name
  `)

  const nodes = new Map<number, CategoryNode>()
  for (const row of rows) nodes.set(row.id, { ...row, children: [] })

  const roots: CategoryNode[] = []
  for (const node of nodes.values()) {
    if (node.parentId === null) roots.push(node)
    else nodes.get(node.parentId)?.children.push(node)
  }
  return roots
}

/** Flat list, used by every category picker in the UI. */
export function categoryOptions() {
  return db.all<{
    id: number
    name: string
    parentName: string | null
    path: string
    kind: string
    color: string
    isLeaf: number
  }>(sql`
    select
      c.id,
      c.name,
      p.name as parentName,
      case when p.name is null then c.name else p.name || ' / ' || c.name end as path,
      c.kind,
      c.color,
      case when exists (select 1 from categories k where k.parent_id = c.id and k.archived = 0) then 0 else 1 end as isLeaf
    from categories c
    left join categories p on p.id = c.parent_id
    where c.archived = 0
    order by coalesce(p.sort_order, c.sort_order), p.name is null desc, c.sort_order, c.name
  `)
}

export function createCategory(input: {
  name: string
  parentId?: number | null
  kind?: string
  color?: string
  icon?: string
}) {
  // A child always inherits its parent's kind and hue: the ring chart groups
  // by parent, so a child with a different colour would misreport the group.
  let kind = input.kind ?? 'expense'
  let color = input.color ?? '#007bff'
  let icon = input.icon ?? 'tag'

  if (input.parentId) {
    const parent = db.select().from(categories).where(eq(categories.id, input.parentId)).get()
    if (!parent) throw new Error(`categoria pai ${input.parentId} não encontrada`)
    kind = parent.kind
    color = input.color ?? parent.color
    icon = input.icon ?? parent.icon
  }

  const siblings = db
    .select({ n: sql<number>`count(*)` })
    .from(categories)
    .where(input.parentId ? eq(categories.parentId, input.parentId) : isNull(categories.parentId))
    .get()

  return db
    .insert(categories)
    .values({
      name: input.name.trim(),
      parentId: input.parentId ?? null,
      kind,
      color,
      icon,
      sortOrder: siblings?.n ?? 0,
    })
    .returning()
    .get()
}

export function updateCategory(
  id: number,
  patch: { name?: string; color?: string; icon?: string; kind?: string; sortOrder?: number },
) {
  const updated = db.update(categories).set(patch).where(eq(categories.id, id)).returning().get()
  if (!updated) return null
  // Recolouring a parent recolours its children, keeping the group coherent.
  if (patch.color && updated.parentId === null) {
    db.update(categories).set({ color: patch.color }).where(eq(categories.parentId, id)).run()
  }
  if (patch.kind && updated.parentId === null) {
    db.update(categories).set({ kind: patch.kind }).where(eq(categories.parentId, id)).run()
  }
  return updated
}

/**
 * Archives rather than deletes when a category is in use, so historical
 * transactions never lose their classification silently.
 */
export function removeCategory(id: number, options: { reassignTo?: number | null } = {}) {
  const used =
    db
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(eq(transactions.categoryId, id))
      .get()?.n ?? 0

  const hasChildren =
    db
      .select({ n: sql<number>`count(*)` })
      .from(categories)
      .where(eq(categories.parentId, id))
      .get()?.n ?? 0

  if (used > 0 && options.reassignTo === undefined) {
    db.update(categories).set({ archived: true }).where(eq(categories.id, id)).run()
    return { archived: true, deleted: false, affected: used }
  }

  if (options.reassignTo !== undefined) {
    db.update(transactions)
      .set({ categoryId: options.reassignTo ?? null })
      .where(eq(transactions.categoryId, id))
      .run()
  }

  if (hasChildren > 0) {
    db.update(categories).set({ archived: true }).where(eq(categories.id, id)).run()
    return { archived: true, deleted: false, affected: used }
  }

  db.delete(categories).where(eq(categories.id, id)).run()
  return { archived: false, deleted: true, affected: used }
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */
export function listRules() {
  return db.all<{
    id: number
    categoryId: number
    categoryPath: string
    color: string
    field: string
    matchType: string
    pattern: string
    direction: string
    priority: number
    origin: string
    hitCount: number
    active: number
  }>(sql`
    select
      r.id, r.category_id as categoryId,
      case when p.name is null then c.name else p.name || ' / ' || c.name end as categoryPath,
      c.color,
      r.field, r.match_type as matchType, r.pattern, r.direction,
      r.priority, r.origin, r.hit_count as hitCount, r.active
    from category_rules r
    join categories c on c.id = r.category_id
    left join categories p on p.id = c.parent_id
    order by r.priority, r.id
  `)
}

export function createRule(input: {
  categoryId: number
  pattern: string
  field?: string
  matchType?: string
  direction?: string
  priority?: number
  amountMinCents?: number | null
  amountMaxCents?: number | null
  accountId?: number | null
}) {
  return db
    .insert(categoryRules)
    .values({ ...input, origin: 'user', priority: input.priority ?? 60 })
    .onConflictDoUpdate({
      target: [categoryRules.field, categoryRules.matchType, categoryRules.pattern, categoryRules.direction],
      set: { categoryId: input.categoryId, active: true },
    })
    .returning()
    .get()
}

export function updateRule(id: number, patch: Record<string, unknown>) {
  return db.update(categoryRules).set(patch).where(eq(categoryRules.id, id)).returning().get() ?? null
}

export function deleteRule(id: number) {
  db.update(categoryMemory).set({ promotedRuleId: null }).where(eq(categoryMemory.promotedRuleId, id)).run()
  return { removed: db.delete(categoryRules).where(eq(categoryRules.id, id)).run().changes }
}

/** What the app has learned so far — shown so the user can audit it. */
export function listMemory() {
  return db.all<{
    signature: string
    categoryPath: string
    color: string
    hits: number
    promotedRuleId: number | null
    lastSeenAt: string
  }>(sql`
    select
      m.signature,
      case when p.name is null then c.name else p.name || ' / ' || c.name end as categoryPath,
      c.color,
      m.hits, m.promoted_rule_id as promotedRuleId, m.last_seen_at as lastSeenAt
    from category_memory m
    join categories c on c.id = m.category_id
    left join categories p on p.id = c.parent_id
    order by m.hits desc, m.last_seen_at desc
  `)
}

export function forgetMemory(signature: string) {
  return {
    removed: db.delete(categoryMemory).where(eq(categoryMemory.signature, signature)).run().changes,
  }
}

/** Categories with no transactions and no rules — safe cleanup candidates. */
export function unusedCategories() {
  return db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(
      and(
        eq(categories.archived, false),
        sql`not exists (select 1 from transactions t where t.category_id = ${categories.id})`,
        sql`not exists (select 1 from category_rules r where r.category_id = ${categories.id})`,
        sql`not exists (select 1 from categories k where k.parent_id = ${categories.id})`,
      ),
    )
    .orderBy(asc(categories.name))
    .all()
}
