import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { budgetGroups, budgetPlans, categories } from '../db/schema'
import { addMonths, periodBounds, todayIso } from '../core/dates'
import { medianCents } from '../core/money'
import {
  FULL_BPS,
  METHOD_SEED,
  budgetIncome,
  effectiveGroupOf,
  groupLine,
  historyShares,
  planFor,
  suggestGroup,
  type Allocation,
  type BudgetGroupSource,
  type BudgetPlanRow,
  type CategoryNode,
} from '../core/budget'
import { accountScope, idList, pjWithdrawals, type AccountScope } from './withdrawals'

/**
 * Orçamento por grupos de % da renda (specs/budget-groups, decisions/0042).
 * Leitura sobre o extrato e as operações de investimento: nenhum número é
 * guardado além dos percentuais e da ligação TAG → grupo.
 */

/** Entrada que viola uma regra do orçamento (soma ≠ 100%, grupo arquivado...). */
export class BudgetError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

type GroupRow = typeof budgetGroups.$inferSelect

const currentPeriod = () => todayIso().slice(0, 7)

/**
 * Os seis grupos do método e um plano com os % dele, na primeira leitura.
 * Trava de transação para duas abas abertas ao mesmo tempo não semearem
 * duas vezes.
 */
async function ensureSeed(): Promise<void> {
  const existing = await db.select({ id: budgetGroups.id }).from(budgetGroups).limit(1)
  if (existing.length > 0) return
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(420042)`)
    const again = await tx.select({ id: budgetGroups.id }).from(budgetGroups).limit(1)
    if (again.length > 0) return
    const rows = await tx
      .insert(budgetGroups)
      .values(METHOD_SEED.map((g, i) => ({ name: g.name, color: g.color, source: g.source, sortOrder: i })))
      .returning()
    const allocations: Allocation[] = rows.map((row, i) => ({ groupId: row.id, targetBps: METHOD_SEED[i]!.targetBps }))
    await tx.insert(budgetPlans).values({ effectivePeriod: currentPeriod(), allocations }).onConflictDoNothing()
  })
}

async function allGroups(): Promise<GroupRow[]> {
  return db.select().from(budgetGroups).orderBy(asc(budgetGroups.sortOrder), asc(budgetGroups.id))
}

async function allPlans(): Promise<BudgetPlanRow[]> {
  const rows = await db.select().from(budgetPlans)
  return rows.map((r) => ({ effectivePeriod: r.effectivePeriod, allocations: r.allocations as Allocation[] }))
}

/**
 * Renda por mês: receitas confirmadas nas contas pessoais, mais a entrada
 * numa conta pessoal que pareia (mesmo valor, até 1 dia) com uma saída da
 * conta PJ e não está lançada como receita, ou seja, o pró-labore lançado
 * como transferência. Um repasse já lançado como receita entra só uma vez.
 */
async function incomeByMonth(fromPeriod: string, toPeriod: string, scope: AccountScope) {
  const from = periodBounds(fromPeriod).start
  const to = periodBounds(toPeriod).end
  const out = new Map<string, number>()
  if (scope.personal.length === 0) return out
  const [income, transfers] = await Promise.all([
    db.execute<{ period: string; cents: number }>(sql`
      select substr(t.posted_on, 1, 7) as period, coalesce(sum(t.amount_cents), 0) as cents
      from transactions t
      join categories c on c.id = t.category_id
      where c.kind = 'income' and t.pending = false and t.ignored = false
        and t.account_id in (${idList(scope.personal)})
        and t.posted_on between ${from} and ${to}
      group by 1`),
    // O repasse PJ → PF não lançado como receita: a mesma função de "Minha empresa".
    pjWithdrawals(fromPeriod, toPeriod, scope),
  ])
  for (const row of income) out.set(row.period, Number(row.cents))
  for (const [period, t] of transfers) out.set(period, (out.get(period) ?? 0) + t.toPersonalCents)
  return out
}

type ExpenseRow = { period: string; categoryId: number; pending: boolean; cents: number; n: number }
type TradeRow = { period: string; toGoal: boolean; cents: number; n: number }

/** Despesas por mês e TAG nas contas pessoais (valor positivo = saiu dinheiro). */
async function expenseRows(fromPeriod: string, toPeriod: string, personal: number[]): Promise<ExpenseRow[]> {
  if (personal.length === 0) return []
  const rows = await db.execute<ExpenseRow>(sql`
    select substr(t.posted_on, 1, 7) as period, t.category_id as "categoryId", t.pending,
      -coalesce(sum(t.amount_cents), 0) as cents, count(*) as n
    from transactions t
    join categories c on c.id = t.category_id
    where c.kind = 'expense' and t.ignored = false
      and t.account_id in (${idList(personal)})
      and t.posted_on between ${periodBounds(fromPeriod).start} and ${periodBounds(toPeriod).end}
    group by 1, 2, 3`)
  return rows.map((r) => ({ ...r, categoryId: Number(r.categoryId), cents: Number(r.cents), n: Number(r.n) }))
}

/** Compras de ativos negociáveis por mês, separadas entre ativos com meta e os demais. */
async function tradeRows(fromPeriod: string, toPeriod: string): Promise<TradeRow[]> {
  const rows = await db.execute<TradeRow>(sql`
    select substr(t.traded_on, 1, 7) as period, (a.goal_id is not null) as "toGoal",
      coalesce(sum(round(t.quantity * t.unit_price_cents) + t.fees_cents), 0) as cents, count(*) as n
    from asset_trades t
    join assets a on a.id = t.asset_id
    where t.kind = 'buy' and a.asset_class <> 'illiquid'
      and t.traded_on between ${periodBounds(fromPeriod).start} and ${periodBounds(toPeriod).end}
    group by 1, 2`)
  return rows.map((r) => ({ ...r, toGoal: Boolean(r.toGoal), cents: Number(r.cents), n: Number(r.n) }))
}

async function categoryMap(): Promise<Map<number, CategoryNode & { name: string }>> {
  const rows = await db
    .select({
      id: categories.id,
      parentId: categories.parentId,
      kind: categories.kind,
      name: categories.name,
      budgetGroupId: categories.budgetGroupId,
      budgetExcluded: categories.budgetExcluded,
    })
    .from(categories)
  return new Map(rows.map((r) => [r.id, r]))
}

type MonthActuals = {
  byGroup: Map<number, { actualCents: number; pendingCents: number; count: number }>
  ungrouped: { actualCents: number; pendingCents: number; count: number }
}

/** Realizado e pendente de cada grupo num mês, a partir das linhas já agrupadas. */
function actualsFor(
  period: string,
  groups: GroupRow[],
  expenses: ExpenseRow[],
  trades: TradeRow[],
  cats: Map<number, CategoryNode>,
): MonthActuals {
  const byGroup = new Map<number, { actualCents: number; pendingCents: number; count: number }>()
  const ungrouped = { actualCents: 0, pendingCents: 0, count: 0 }
  const slot = (id: number) => {
    let s = byGroup.get(id)
    if (!s) byGroup.set(id, (s = { actualCents: 0, pendingCents: 0, count: 0 }))
    return s
  }
  const categoryGroups = new Set(groups.filter((g) => g.source === 'categories').map((g) => g.id))
  for (const row of expenses) {
    if (row.period !== period) continue
    const eff = effectiveGroupOf(row.categoryId, cats)
    if (eff.excluded) continue
    const target = eff.groupId !== null && categoryGroups.has(eff.groupId) ? slot(eff.groupId) : ungrouped
    if (row.pending) target.pendingCents += row.cents
    else {
      target.actualCents += row.cents
      target.count += row.n
    }
  }
  const goalGroup = groups.find((g) => g.source === 'goal_contributions' && !g.archived)
  const otherGroup = groups.find((g) => g.source === 'other_contributions' && !g.archived)
  for (const row of trades) {
    if (row.period !== period) continue
    const group = row.toGoal ? goalGroup : otherGroup
    if (!group) continue
    const s = slot(group.id)
    s.actualCents += row.cents
    s.count += row.n
  }
  return { byGroup, ungrouped }
}

/** Mediana da renda dos 6 meses fechados antes de `period`, só meses com alguma renda. */
function typicalIncome(period: string, incomes: Map<string, number>): number {
  const values: number[] = []
  for (let i = 1; i <= 6; i++) {
    const v = incomes.get(addMonths(period, -i)) ?? 0
    if (v > 0) values.push(v)
  }
  return medianCents(values)
}

export async function budgetFor(period: string) {
  await ensureSeed()
  const scope = await accountScope()
  const [groups, plans, cats, incomes, expenses, trades] = await Promise.all([
    allGroups(),
    allPlans(),
    categoryMap(),
    incomeByMonth(addMonths(period, -6), period, scope),
    expenseRows(period, period, scope.personal),
    tradeRows(period, period),
  ])
  const plan = planFor(period, plans)
  const income = budgetIncome({
    receivedCents: incomes.get(period) ?? 0,
    typicalCents: typicalIncome(period, incomes),
    isCurrentMonth: period === currentPeriod(),
  })
  const actuals = actualsFor(period, groups, expenses, trades, cats)
  const targetOf = new Map((plan?.allocations ?? []).map((a) => [a.groupId, a.targetBps]))
  // O mês mostra os grupos do plano dele (mesmo arquivados depois) e os ativos de hoje.
  const shown = groups.filter((g) => targetOf.has(g.id) || !g.archived)
  const lines = shown.map((g) => {
    const a = actuals.byGroup.get(g.id) ?? { actualCents: 0, pendingCents: 0, count: 0 }
    return {
      id: g.id,
      name: g.name,
      color: g.color,
      source: g.source,
      archived: g.archived,
      ...groupLine(g.id, targetOf.get(g.id) ?? 0, income.cents, a.actualCents),
      pendingCents: a.pendingCents,
      count: a.count,
    }
  })
  const spentCents =
    lines.filter((l) => l.source === 'categories').reduce((sum, l) => sum + l.actualCents, 0) + actuals.ungrouped.actualCents
  const contributedCents = lines.filter((l) => l.source !== 'categories').reduce((sum, l) => sum + l.actualCents, 0)
  return {
    period,
    income,
    totals: {
      spentCents,
      contributedCents,
      remainingCents: income.cents - spentCents - contributedCents,
      spentShareBps: income.cents > 0 ? Math.round((spentCents / income.cents) * FULL_BPS) : null,
    },
    groups: lines,
    ungrouped: actuals.ungrouped,
    plan: plan ? { effectivePeriod: plan.effectivePeriod } : null,
    assumptions: {
      formula: 'previsto = renda do mês × % do grupo; realizado = despesas confirmadas das TAGs do grupo, ou compras de ativos nos grupos de aporte',
      contas: scope.pjAccountId === null ? 'todas as contas (nenhuma conta PJ configurada no Motor)' : 'todas as contas, menos a conta PJ do Motor financeiro',
      renda: income.estimated
        ? 'renda típica (mediana de 6 meses fechados), porque a renda do mês ainda não entrou toda'
        : 'receitas confirmadas do mês, mais o repasse da conta PJ lançado como transferência',
      foraDoOrcamento: 'lançamentos sem TAG, transferências, investimentos e TAGs marcadas "fora do orçamento"',
      aportes: 'Metas: compras em ativos separados para uma meta; Liberdade Financeira: compras nos demais ativos (reserva inclusa). Vendas não abatem.',
    },
  }
}

/** Configuração: grupos, plano do mês corrente, histórico de 6 meses e TAGs com sugestão. */
export async function budgetSettings() {
  await ensureSeed()
  const period = currentPeriod()
  const first = addMonths(period, -6)
  const last = addMonths(period, -1)
  const scope = await accountScope()
  const [groups, plans, cats, incomes, expenses, trades] = await Promise.all([
    allGroups(),
    allPlans(),
    categoryMap(),
    incomeByMonth(addMonths(first, -6), period, scope),
    expenseRows(first, last, scope.personal),
    tradeRows(first, last),
  ])
  const months = Array.from({ length: 6 }, (_, i) => addMonths(first, i)).map((m) => {
    const a = actualsFor(m, groups, expenses, trades, cats)
    return { incomeCents: incomes.get(m) ?? 0, actuals: new Map([...a.byGroup].map(([id, v]) => [id, v.actualCents])) }
  })
  const shares = historyShares(months, groups.map((g) => g.id))
  const groupByName = new Map(groups.filter((g) => !g.archived).map((g) => [g.name, g.id]))
  const list = [...cats.values()].filter((c) => c.kind === 'expense')
  const suggestionFor = (c: (typeof list)[number]): { groupId: number | null; excluded: boolean } | null => {
    const parent = c.parentId === null ? null : cats.get(c.parentId) ?? null
    // Só a TAG cujo próprio nome tem sugestão recebe uma; a filha cuja
    // sugestão é a mesma da mãe fica em "Herdar", sem repetir o grupo.
    const own = suggestGroup(c.name, null)
    if (!own) return null
    if (parent && suggestGroup(parent.name, null) === own) return null
    if (own === 'excluded') return { groupId: null, excluded: true }
    const id = groupByName.get(own)
    return id ? { groupId: id, excluded: false } : null
  }
  const income = budgetIncome({
    receivedCents: incomes.get(period) ?? 0,
    typicalCents: typicalIncome(period, incomes),
    isCurrentMonth: true,
  })
  return {
    groups,
    plan: planFor(period, plans),
    period,
    income,
    history: groups.map((g) => ({ groupId: g.id, shareBps: shares.get(g.id) ?? 0 })),
    historyMonths: months.filter((m) => m.incomeCents > 0).length,
    categories: list
      .map((c) => {
        const eff = effectiveGroupOf(c.id, cats)
        const suggestion = suggestionFor(c)
        return {
          id: c.id,
          parentId: c.parentId,
          name: c.name,
          budgetGroupId: c.budgetGroupId,
          budgetExcluded: c.budgetExcluded,
          effectiveGroupId: eff.groupId,
          effectiveExcluded: eff.excluded,
          suggestedGroupId: suggestion?.groupId ?? null,
          suggestedExcluded: suggestion?.excluded ?? false,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
  }
}

export async function createGroup(input: { name: string; color: string }) {
  await ensureSeed()
  const groups = await allGroups()
  const name = input.name.trim()
  if (!name) throw new BudgetError('informe o nome do grupo')
  if (groups.some((g) => !g.archived && g.name.toLowerCase() === name.toLowerCase())) throw new BudgetError('já existe um grupo com esse nome', 409)
  const sortOrder = groups.reduce((max, g) => Math.max(max, g.sortOrder), -1) + 1
  return (await db.insert(budgetGroups).values({ name, color: input.color, sortOrder, source: 'categories' }).returning())[0]!
}

export async function updateGroup(id: number, patch: { name?: string; color?: string; sortOrder?: number; archived?: boolean }) {
  const groups = await allGroups()
  const group = groups.find((g) => g.id === id)
  if (!group) throw new BudgetError('grupo não encontrado', 404)
  if (patch.archived === false && group.source !== 'categories') {
    const clash = groups.find((g) => g.id !== id && !g.archived && g.source === group.source)
    if (clash) throw new BudgetError(`já existe um grupo ativo para esses aportes (${clash.name})`, 409)
  }
  const name = patch.name?.trim()
  if (patch.name !== undefined && !name) throw new BudgetError('informe o nome do grupo')
  return (
    await db
      .update(budgetGroups)
      .set({ ...patch, ...(name ? { name } : {}) })
      .where(eq(budgetGroups.id, id))
      .returning()
  )[0]!
}

/** Grava (ou substitui) os % do mês corrente; os meses passados guardam os seus. */
export async function savePlan(allocations: Allocation[]) {
  await ensureSeed()
  const groups = await allGroups()
  const active = new Map(groups.filter((g) => !g.archived).map((g) => [g.id, g]))
  const seen = new Set<number>()
  for (const a of allocations) {
    if (!active.has(a.groupId)) throw new BudgetError('um dos grupos não existe ou foi removido')
    if (seen.has(a.groupId)) throw new BudgetError('grupo repetido no plano')
    seen.add(a.groupId)
  }
  const total = allocations.reduce((sum, a) => sum + a.targetBps, 0)
  if (total !== FULL_BPS) throw new BudgetError(`os percentuais precisam somar 100% (estão em ${(total / 100).toLocaleString('pt-BR')}%)`)
  const clean = allocations.filter((a) => a.targetBps > 0)
  const period = currentPeriod()
  await db
    .insert(budgetPlans)
    .values({ effectivePeriod: period, allocations: clean })
    .onConflictDoUpdate({ target: budgetPlans.effectivePeriod, set: { allocations: clean, updatedAt: new Date().toISOString() } })
  return planFor(period, await allPlans())
}

/** Liga TAGs de despesa a grupos (ou "fora do orçamento"). Nulo e não excluída = herda da mãe. */
export async function saveCategoryGroups(items: Array<{ categoryId: number; budgetGroupId: number | null; budgetExcluded: boolean }>) {
  const [groups, cats] = await Promise.all([allGroups(), categoryMap()])
  const valid = new Set(groups.filter((g) => !g.archived && g.source === 'categories').map((g) => g.id))
  for (const item of items) {
    const cat = cats.get(item.categoryId)
    if (!cat || cat.kind !== 'expense') throw new BudgetError('só TAGs de despesa entram em grupos')
    if (item.budgetGroupId !== null && !valid.has(item.budgetGroupId)) throw new BudgetError('grupo inválido para TAGs (os de aporte medem compras de ativos)')
  }
  await db.transaction(async (tx) => {
    for (const item of items) {
      await tx
        .update(categories)
        .set({ budgetGroupId: item.budgetGroupId, budgetExcluded: item.budgetGroupId === null && item.budgetExcluded })
        .where(eq(categories.id, item.categoryId))
    }
  })
  return budgetSettings()
}

/**
 * Filtro "N transações" de um grupo em Lançamentos: as TAGs de despesa cujo
 * grupo efetivo é este (ou nenhum, para "Sem grupo"), nas contas pessoais.
 */
export async function groupTransactionScope(group: number | 'none'): Promise<{ categoryIds: number[]; accountIds: number[] }> {
  const [cats, scope] = await Promise.all([categoryMap(), accountScope()])
  const categoryIds = [...cats.values()]
    .filter((c) => c.kind === 'expense')
    .filter((c) => {
      const eff = effectiveGroupOf(c.id, cats)
      return group === 'none' ? eff.groupId === null && !eff.excluded : eff.groupId === group
    })
    .map((c) => c.id)
  return { categoryIds, accountIds: scope.personal }
}

/** Só para a rota de Lançamentos validar o id recebido. */
export async function groupExists(id: number): Promise<boolean> {
  return (await db.select({ id: budgetGroups.id }).from(budgetGroups).where(inArray(budgetGroups.id, [id]))).length > 0
}

/**
 * Gastos do Orçamento por mês (despesas confirmadas das contas pessoais,
 * fora as TAGs "fora do orçamento"): o "gasto pessoal" que "Minha empresa"
 * compara com as retiradas (specs/company-mei).
 */
export async function monthlySpending(fromPeriod: string, toPeriod: string): Promise<Map<string, number>> {
  const scope = await accountScope()
  const [expenses, cats] = await Promise.all([expenseRows(fromPeriod, toPeriod, scope.personal), categoryMap()])
  const out = new Map<string, number>()
  for (const row of expenses) {
    if (row.pending) continue
    if (effectiveGroupOf(row.categoryId, cats).excluded) continue
    out.set(row.period, (out.get(row.period) ?? 0) + row.cents)
  }
  return out
}
