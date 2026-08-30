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
  dreGroup: string | null
  sortOrder: number
  transactionCount: number
  children: CategoryNode[]
}

/** The whole tree with usage counts, in one query plus one pass. */
export async function categoryTree(): Promise<CategoryNode[]> {
  const rows = await db.execute<{
    id: number
    parentId: number | null
    name: string
    kind: string
    color: string
    icon: string
    dreGroup: string | null
    sortOrder: number
    transactionCount: number
  }>(sql`
    select
      c.id, c.parent_id as "parentId", c.name, c.kind, c.color, c.icon,
      c.dre_group as "dreGroup",
      c.sort_order as "sortOrder",
      (select count(*) from transactions t where t.category_id = c.id) as "transactionCount"
    from categories c
    where c.archived = false
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
export async function categoryOptions() {
  return db.execute<{
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
      p.name as "parentName",
      case when p.name is null then c.name else p.name || ' / ' || c.name end as path,
      c.kind,
      c.color,
      case when exists (select 1 from categories k where k.parent_id = c.id and k.archived = false) then 0 else 1 end as "isLeaf"
    from categories c
    left join categories p on p.id = c.parent_id
    where c.archived = false
    order by coalesce(p.sort_order, c.sort_order), p.name is null desc, c.sort_order, c.name
  `)
}

/** Valores válidos de `dreGroup` por `kind` — specs/dre ("DRE PJ formal"): dedução/resultado financeiro só fazem sentido pro lado de receita, custo/imposto só pro lado de despesa. */
const DRE_GROUPS_BY_KIND: Record<string, readonly string[]> = {
  income: ['deduction', 'financial'],
  // 'deduction' também vale pro lado de despesa: dedução da receita pode
  // ser modelada como saída de verdade (ex. imposto sobre venda pago
  // separado), não só como redutor lançado direto na receita.
  expense: ['deduction', 'cost', 'financial', 'tax'],
}

function assertValidDreGroup(kind: string, dreGroup: string | null | undefined) {
  if (dreGroup === null || dreGroup === undefined) return
  const allowed = DRE_GROUPS_BY_KIND[kind] ?? []
  if (!allowed.includes(dreGroup)) {
    throw new Error(`"${dreGroup}" não é uma classificação de DRE válida para uma categoria de ${kind}`)
  }
}

export async function createCategory(input: {
  name: string
  parentId?: number | null
  kind?: string
  color?: string
  icon?: string
  dreGroup?: string | null
}) {
  // A child always inherits its parent's kind, hue and classificação de
  // DRE: o ring chart agrupa por mãe, e o DRE formal soma a filha dentro
  // do balde da mãe — uma filha com valor diferente relataria a classe
  // errada em ambos.
  let kind = input.kind ?? 'expense'
  let color = input.color ?? '#007bff'
  let icon = input.icon ?? 'tag'
  let dreGroup = input.dreGroup ?? null

  if (input.parentId) {
    const parent = (await db.select().from(categories).where(eq(categories.id, input.parentId)))[0]
    if (!parent) throw new Error(`categoria pai ${input.parentId} não encontrada`)
    kind = parent.kind
    color = input.color ?? parent.color
    icon = input.icon ?? parent.icon
    dreGroup = parent.dreGroup
  }
  assertValidDreGroup(kind, dreGroup)

  const siblings = (
    await db
      .select({ n: sql<number>`count(*)` })
      .from(categories)
      .where(input.parentId ? eq(categories.parentId, input.parentId) : isNull(categories.parentId))
  )[0]

  return (
    await db
      .insert(categories)
      .values({
        name: input.name.trim(),
        parentId: input.parentId ?? null,
        kind: kind as (typeof categories.$inferInsert)['kind'],
        color,
        icon,
        dreGroup: dreGroup as (typeof categories.$inferInsert)['dreGroup'],
        sortOrder: siblings?.n ?? 0,
      })
      .returning()
  )[0]!
}

export async function updateCategory(
  id: number,
  patch: { name?: string; color?: string; icon?: string; kind?: string; dreGroup?: string | null; sortOrder?: number },
) {
  if (patch.dreGroup !== undefined) assertValidDreGroup(patch.kind ?? (await currentKind(id)), patch.dreGroup)

  const updated = (
    await db
      .update(categories)
      .set(patch as Partial<typeof categories.$inferInsert>)
      .where(eq(categories.id, id))
      .returning()
  )[0]
  if (!updated) return null
  // Recolouring/reclassifying a parent propaga pros filhos, mantendo o
  // grupo coerente — mesma razão de sempre: quem lê depois (ring chart,
  // DRE formal) agrupa pela mãe.
  if (patch.color && updated.parentId === null) {
    await db.update(categories).set({ color: patch.color }).where(eq(categories.parentId, id))
  }
  if (patch.kind && updated.parentId === null) {
    await db
      .update(categories)
      .set({ kind: patch.kind as (typeof categories.$inferInsert)['kind'] })
      .where(eq(categories.parentId, id))
  }
  if (patch.dreGroup !== undefined && updated.parentId === null) {
    await db
      .update(categories)
      .set({ dreGroup: patch.dreGroup as (typeof categories.$inferInsert)['dreGroup'] })
      .where(eq(categories.parentId, id))
  }
  return updated
}

async function currentKind(id: number): Promise<string> {
  const row = (await db.select({ kind: categories.kind }).from(categories).where(eq(categories.id, id)))[0]
  return row?.kind ?? 'expense'
}

/**
 * Archives rather than deletes when a category is in use, so historical
 * transactions never lose their classification silently.
 */
export async function removeCategory(id: number, options: { reassignTo?: number | null } = {}) {
  const used =
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(transactions)
        .where(eq(transactions.categoryId, id))
    )[0]?.n ?? 0

  const hasChildren =
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(categories)
        .where(eq(categories.parentId, id))
    )[0]?.n ?? 0

  if (used > 0 && options.reassignTo === undefined) {
    await db.update(categories).set({ archived: true }).where(eq(categories.id, id))
    return { archived: true, deleted: false, affected: used }
  }

  if (options.reassignTo !== undefined) {
    await db
      .update(transactions)
      .set({ categoryId: options.reassignTo ?? null })
      .where(eq(transactions.categoryId, id))
  }

  if (hasChildren > 0) {
    await db.update(categories).set({ archived: true }).where(eq(categories.id, id))
    return { archived: true, deleted: false, affected: used }
  }

  await db.delete(categories).where(eq(categories.id, id))
  return { archived: false, deleted: true, affected: used }
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */
export async function listRules() {
  return db.execute<{
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
    active: boolean
  }>(sql`
    select
      r.id, r.category_id as "categoryId",
      case when p.name is null then c.name else p.name || ' / ' || c.name end as "categoryPath",
      c.color,
      r.field, r.match_type as "matchType", r.pattern, r.direction,
      r.priority, r.origin, r.hit_count as "hitCount", r.active
    from category_rules r
    join categories c on c.id = r.category_id
    left join categories p on p.id = c.parent_id
    order by r.priority, r.id
  `)
}

export async function createRule(input: {
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
  return (
    await db
      .insert(categoryRules)
      .values({ ...input, origin: 'user', priority: input.priority ?? 60 } as typeof categoryRules.$inferInsert)
      .onConflictDoUpdate({
        target: [categoryRules.field, categoryRules.matchType, categoryRules.pattern, categoryRules.direction],
        set: { categoryId: input.categoryId, active: true },
      })
      .returning()
  )[0]!
}

export async function updateRule(id: number, patch: Record<string, unknown>) {
  return (
    (
      await db
        .update(categoryRules)
        .set(patch as Partial<typeof categoryRules.$inferInsert>)
        .where(eq(categoryRules.id, id))
        .returning()
    )[0] ?? null
  )
}

export async function deleteRule(id: number) {
  await db.update(categoryMemory).set({ promotedRuleId: null }).where(eq(categoryMemory.promotedRuleId, id))
  return { removed: (await db.delete(categoryRules).where(eq(categoryRules.id, id))).count }
}

/** What the app has learned so far — shown so the user can audit it. */
export async function listMemory() {
  return db.execute<{
    signature: string
    categoryPath: string
    color: string
    hits: number
    promotedRuleId: number | null
    lastSeenAt: string
  }>(sql`
    select
      m.signature,
      case when p.name is null then c.name else p.name || ' / ' || c.name end as "categoryPath",
      c.color,
      m.hits, m.promoted_rule_id as "promotedRuleId", m.last_seen_at as "lastSeenAt"
    from category_memory m
    join categories c on c.id = m.category_id
    left join categories p on p.id = c.parent_id
    order by m.hits desc, m.last_seen_at desc
  `)
}

export async function forgetMemory(signature: string) {
  return {
    removed: (await db.delete(categoryMemory).where(eq(categoryMemory.signature, signature))).count,
  }
}

/** Categories with no transactions and no rules — safe cleanup candidates. */
export async function unusedCategories() {
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
}
