import { and, asc, eq, inArray, like, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '../db/client.ts'
import { accounts, categories, clients, taskCompletions, tasks, transactions } from '../db/schema.ts'
import { periodBounds } from '../core/dates.ts'
import { companyOverview } from './company.ts'
import { linkedRevenue } from './clients.ts'
import { accountScope } from './withdrawals.ts'

/**
 * O mês da empresa como o contador vê (docs/specs/tarefas-comercial-contador,
 * fases 4 e 5): o MESMO recorte para o pacote do mês e para o login do contador.
 *
 * Só a conta PJ. O resumo da Minha empresa também traz o gasto pessoal, a
 * cobertura do custo de vida e o quanto dá para retirar; nada disso sai daqui.
 * Cada campo é escolhido à mão (lista de permissão), nunca "tudo menos".
 */

export type AccountantTransaction = {
  id: number
  postedOn: string
  description: string
  amountCents: number
  categoryName: string | null
  pending: boolean
  clientName: string | null
}

export type AccountantMonth = {
  period: string
  pjAccount: { id: number; name: string } | null
  summary: {
    revenueCents: number
    dasCents: number
    costsCents: number
    profitCents: number
    withdrawalsCents: number
    dasMonthlyCents: number
    dasPending: boolean
  } | null
  ceiling: { yearRevenueCents: number; limitCents: number; usedBps: number; projectedYearCents: number; state: 'ok' | 'attention' | 'critical' } | null
  revenueSeries: Array<{ period: string; revenueCents: number }>
  transactions: AccountantTransaction[]
  invoices: Array<{ title: string; clientName: string | null; dueOn: string; reference: string | null; doneAt: string }>
  totals: { inCents: number; outCents: number; count: number }
}

export async function accountantMonth(period: string, executor: DbExecutor = db): Promise<AccountantMonth> {
  const empty = { period, pjAccount: null, summary: null, ceiling: null, revenueSeries: [], transactions: [], invoices: [], totals: { inCents: 0, outCents: 0, count: 0 } }
  const scope = await accountScope()
  if (scope.pjAccountId === null) return empty
  const account = (await executor.select({ id: accounts.id, name: accounts.name }).from(accounts).where(eq(accounts.id, scope.pjAccountId)))[0]
  if (!account) return empty

  const overview = await companyOverview(period)
  // Sem conta PJ o resumo volta só { period, pjAccount: null }.
  type Full = Required<Extract<typeof overview, { cascade?: unknown }>>
  const o = overview.pjAccount && 'cascade' in overview ? (overview as Full) : null

  const { start, end } = periodBounds(period)
  const rows = await executor
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      description: transactions.description,
      amountCents: transactions.amountCents,
      categoryName: categories.name,
      pending: transactions.pending,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(eq(transactions.accountId, account.id), eq(transactions.ignored, false), sql`${transactions.postedOn} between ${start} and ${end}`))
    .orderBy(asc(transactions.postedOn), asc(transactions.id))

  const ids = new Set(rows.map((r) => r.id))
  const revenue = (await linkedRevenue(executor)).filter((r) => ids.has(r.id))
  const clientIds = [...new Set(revenue.map((r) => r.clientId))]
  const names = clientIds.length ? new Map((await executor.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, clientIds))).map((c) => [c.id, c.name] as const)) : new Map<number, string>()
  const clientOf = new Map(revenue.map((r) => [r.id, names.get(r.clientId) ?? null] as const))

  const list: AccountantTransaction[] = rows.map((r) => ({ ...r, amountCents: Number(r.amountCents), clientName: clientOf.get(r.id) ?? null }))

  // Notas fiscais marcadas como emitidas nas tarefas do mês (com o número, se informado).
  const done = await executor.select().from(taskCompletions).where(like(taskCompletions.taskKey, 'manual:%'))
  const invoiceTasks = await executor
    .select({ id: tasks.id, title: tasks.title, clientName: clients.name })
    .from(tasks)
    .leftJoin(clients, eq(clients.id, tasks.clientId))
    .where(eq(tasks.kind, 'nf'))
  const byTask = new Map(invoiceTasks.map((t) => [t.id, t] as const))
  const invoices = done
    .map((c) => {
      const [, taskId, dueOn] = c.taskKey.split(':')
      const task = byTask.get(Number(taskId))
      return task && dueOn && dueOn >= start && dueOn <= end && c.status === 'done'
        ? { title: task.title, clientName: task.clientName, dueOn, reference: c.reference, doneAt: c.doneAt }
        : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn))

  return {
    period,
    pjAccount: account,
    summary: o
      ? {
          revenueCents: o.cascade.revenueCents,
          dasCents: o.cascade.dasCents,
          costsCents: o.cascade.costsCents,
          profitCents: o.cascade.profitCents,
          withdrawalsCents: o.cascade.withdrawalsCents,
          dasMonthlyCents: o.dasMonthlyCents,
          dasPending: o.dasPending,
        }
      : null,
    ceiling: o
      ? {
          yearRevenueCents: o.ceiling.yearRevenueCents,
          limitCents: o.ceiling.limitCents,
          usedBps: o.ceiling.usedBps,
          projectedYearCents: o.ceiling.projectedYearCents,
          state: o.ceiling.state,
        }
      : null,
    revenueSeries: o ? o.series.map((p) => ({ period: p.period, revenueCents: p.revenueCents })) : [],
    transactions: list,
    invoices,
    totals: {
      inCents: list.filter((t) => t.amountCents > 0).reduce((s, t) => s + t.amountCents, 0),
      outCents: list.filter((t) => t.amountCents < 0).reduce((s, t) => s + t.amountCents, 0),
      count: list.length,
    },
  }
}
