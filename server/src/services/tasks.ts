import { asc, eq, like, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '../db/client'
import { clients, investmentGoals, taskCompletions, tasks } from '../db/schema'
import { addDays, addMonths, periodBounds, todayIso } from '../core/dates'
import { bucketOf, clampedDate, occurrenceDates, type TaskBucket, type TaskRecurrence } from '../core/tasks'
import { listPending } from './cashFlow'
import { listCards } from './creditCards'
import { dasStatus } from './company'
import { closingChecklist, setClosingReview } from './monthlyClosing'
import { listPlatforms } from './partners'

/**
 * Tarefas financeiras (docs/specs/tarefas-comercial-contador, fase 1).
 *
 * Quase toda obrigação já mora em outra tabela, com data: pendências a pagar e
 * a receber, fatura do cartão, DAS, fechamento do mês, aporte de meta, saque de
 * parceiro. Essas tarefas são CALCULADAS na leitura, como o checklist de
 * fechamento: nada é copiado, e a que a fonte resolve sozinha (a pendência foi
 * baixada, o DAS apareceu no extrato) some ou fica feita. Só as tarefas manuais
 * (ex.: emitir nota fiscal todo mês) e o "feito" das demais são gravados.
 *
 * Só observa e lembra (decisions/0010): nada aqui diz quanto aportar ou o que
 * priorizar. Edge: leituras em sequência, nunca `Promise.all`.
 */

export class TaskError extends Error {}

export type TaskSource = 'manual' | 'nf' | 'pending_income' | 'pending_expense' | 'card' | 'das' | 'dasn' | 'closing' | 'goal' | 'partner'

export type TaskOccurrence = {
  /** chave estável da ocorrência, usada para marcar como feita */
  key: string
  source: TaskSource
  title: string
  detail: string | null
  dueOn: string
  amountCents: number | null
  done: boolean
  doneAt: string | null
  status: 'done' | 'skipped' | null
  /** número da nota ou comprovante informado ao concluir */
  reference: string | null
  /** some ou fecha sozinha quando a fonte resolve (a pendência foi baixada, o DAS foi pago) */
  auto: boolean
  /** dá para marcar como feita aqui */
  completable: boolean
  /** onde resolver, no app */
  link: string | null
  taskId: number | null
  clientId: number | null
  clientName: string | null
  bucket: TaskBucket
}

export type TaskInput = {
  title: string
  kind?: 'custom' | 'nf'
  clientId?: number | null
  amountCents?: number | null
  notes?: string | null
  recurrence?: TaskRecurrence
  dueOn?: string | null
  dueDay?: number | null
  dueMonth?: number | null
  startsOn?: string | null
  endsOn?: string | null
  active?: boolean
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const monthName = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]} de ${period.slice(0, 4)}`

const CLOSING_LINK: Record<string, string> = {
  categorization: '/lancamentos?uncategorized=1',
  reconciliation: '/',
  'daily-log': '/diario',
  'dre-review': '/dre',
}

const KEY_PATTERN = /^(manual:\d+:\d{4}-\d{2}-\d{2}|das:\d{4}-\d{2}|dasn:\d{4}|card:\d+:\d{4}-\d{2}-\d{2}|goal:\d+:\d{4}-\d{2}|closing:\d{4}-\d{2}:[a-z-]+)$/

/** Janela padrão: dois meses para trás (o que ficou atrasado) e um para a frente. */
export function defaultWindow(today = todayIso()) {
  return { from: addDays(today, -60), to: addDays(today, 30) }
}

export async function listTasks(window = defaultWindow(), executor: DbExecutor = db) {
  const today = todayIso()
  const weekEnd = addDays(today, 7)
  const period = today.slice(0, 7)
  const out: Omit<TaskOccurrence, 'bucket'>[] = []

  const completions = new Map(
    (await executor.select().from(taskCompletions)).map((c) => [c.taskKey, c] as const),
  )
  const doneOf = (key: string) => {
    const c = completions.get(key)
    return c
      ? { done: true, doneAt: c.doneAt, status: (c.status === 'skipped' ? 'skipped' : 'done') as 'done' | 'skipped', reference: c.reference }
      : { done: false, doneAt: null, status: null, reference: null }
  }
  const base = { taskId: null, clientId: null, clientName: null, amountCents: null, detail: null, link: null }

  // ---- manuais (inclui "emitir nota fiscal") ----
  const manual = await executor
    .select({ task: tasks, clientName: clients.name })
    .from(tasks)
    .leftJoin(clients, eq(clients.id, tasks.clientId))
    .where(eq(tasks.active, true))
    .orderBy(asc(tasks.id))
  for (const { task, clientName } of manual) {
    for (const dueOn of occurrenceDates(task, window.from, window.to)) {
      const key = `manual:${task.id}:${dueOn}`
      out.push({
        ...base,
        key,
        source: task.kind === 'nf' ? 'nf' : 'manual',
        title: task.title,
        detail: task.notes,
        dueOn,
        amountCents: task.amountCents === null ? null : Number(task.amountCents),
        ...doneOf(key),
        auto: false,
        completable: true,
        link: task.clientId ? `/precificacao/clientes/${task.clientId}` : null,
        taskId: task.id,
        clientId: task.clientId,
        clientName,
      })
    }
  }

  // ---- pendências a receber e a pagar (fecham sozinhas ao baixar ou conciliar) ----
  for (const flow of ['income', 'expense'] as const) {
    for (const p of await listPending(flow, window)) {
      out.push({
        ...base,
        key: `pending:${p.id}`,
        source: flow === 'income' ? 'pending_income' : 'pending_expense',
        title: `${flow === 'income' ? 'Receber' : 'Pagar'}: ${p.description}`,
        detail: [p.accountName, p.installmentLabel, p.categoryName].filter(Boolean).join(' · ') || null,
        dueOn: p.postedOn,
        amountCents: Math.abs(Number(p.amountCents)),
        done: false,
        doneAt: null,
        status: null,
        reference: null,
        auto: true,
        completable: false,
        link: '/',
      })
    }
  }

  // ---- fatura do cartão (sem "paga" no banco: marca-se aqui) ----
  for (const card of await listCards()) {
    if (card.nextDueOn > window.to) continue
    const key = `card:${card.id}:${card.nextDueOn}`
    out.push({
      ...base,
      key,
      source: 'card',
      title: `Pagar a fatura do ${card.name}`,
      detail: `Fecha em ${card.nextClosingOn.split('-').reverse().join('/')}`,
      dueOn: card.nextDueOn,
      ...doneOf(key),
      auto: false,
      completable: true,
      link: '/cartoes',
    })
  }

  // ---- DAS do MEI: vence dia 20, a competência é o mês anterior ----
  const das = await dasStatus()
  if (das.dasMonthlyCents > 0) {
    for (const p of [period, addMonths(period, 1)]) {
      const dueOn = `${p}-20`
      if (dueOn > window.to) continue
      const key = `das:${p}`
      const paidInMonth = das.lastPaid !== null && das.lastPaid.postedOn >= `${p}-01`
      const marked = doneOf(key)
      out.push({
        ...base,
        key,
        source: 'das',
        title: `Pagar o DAS de ${monthName(addMonths(p, -1))}`,
        detail: paidInMonth ? `Pago em ${das.lastPaid!.postedOn.split('-').reverse().join('/')}` : 'Fecha sozinha quando o DAS aparece no extrato da conta PJ',
        dueOn,
        amountCents: das.dasMonthlyCents,
        ...(paidInMonth ? { done: true, doneAt: das.lastPaid!.postedOn, status: 'done' as const, reference: null } : marked),
        auto: true,
        completable: !paidInMonth,
        link: '/dre',
      })
    }

    // DASN-SIMEI: a declaração anual do MEI, até 31 de maio
    const year = Number(today.slice(0, 4))
    const dueOn = `${year}-05-31`
    const key = `dasn:${year}`
    const state = doneOf(key)
    if ((dueOn >= window.from && dueOn <= window.to) || (dueOn < today && !state.done)) {
      out.push({
        ...base,
        key,
        source: 'dasn',
        title: `Entregar a DASN-SIMEI de ${year - 1}`,
        detail: 'Declaração anual do MEI, no Portal do Simples Nacional',
        dueOn,
        ...state,
        auto: false,
        completable: true,
      })
    }
  }

  // ---- fechamento do mês anterior: até o dia 5 ----
  const previous = addMonths(period, -1)
  const checklist = await closingChecklist(previous)
  const closingDue = `${period}-05`
  for (const item of checklist.items) {
    out.push({
      ...base,
      key: `closing:${previous}:${item.key}`,
      source: 'closing',
      title: `Fechamento de ${monthName(previous)}: ${item.label.charAt(0).toLowerCase()}${item.label.slice(1)}`,
      detail: item.detail,
      dueOn: closingDue,
      done: item.done,
      doneAt: item.key === 'dre-review' ? checklist.reviewedAt : null,
      status: item.done ? 'done' : null,
      reference: null,
      auto: item.kind === 'auto',
      completable: item.key === 'dre-review',
      link: CLOSING_LINK[item.key] ?? null,
    })
  }

  // ---- aporte mensal das metas: até o fim do mês ----
  const goals = await executor.select().from(investmentGoals).where(eq(investmentGoals.active, true))
  for (const goal of goals) {
    if (Number(goal.monthlyContributionCents) <= 0) continue
    const { end } = periodBounds(period)
    const key = `goal:${goal.id}:${period}`
    out.push({
      ...base,
      key,
      source: 'goal',
      title: `Aporte em ${goal.name}`,
      detail: 'Valor mensal planejado na meta',
      dueOn: end,
      amountCents: Number(goal.monthlyContributionCents),
      ...doneOf(key),
      auto: false,
      completable: true,
      link: '/investimentos',
    })
  }

  // ---- saque de parceiro: quando o saldo passa do mínimo (some ao sacar) ----
  for (const platform of await listPlatforms()) {
    if (!platform.active || !platform.readyToWithdraw || platform.balanceCents <= 0) continue
    out.push({
      ...base,
      key: `partner:${platform.id}`,
      source: 'partner',
      title: `Sacar o saldo da ${platform.name}`,
      detail: platform.minWithdrawalCents > 0 ? 'O saldo já passou do mínimo de saque' : null,
      dueOn: today,
      amountCents: platform.balanceCents,
      done: false,
      doneAt: null,
      status: null,
      reference: null,
      auto: true,
      completable: false,
      link: '/parceiros',
    })
  }

  const list = out
    .map((t) => ({ ...t, bucket: bucketOf(t.dueOn, t.done, today, weekEnd) }))
    .sort((a, b) => Number(a.done) - Number(b.done) || a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title, 'pt-BR'))
  const count = (bucket: TaskBucket) => list.filter((t) => t.bucket === bucket).length
  return {
    tasks: list,
    summary: { overdue: count('overdue'), today: count('today'), week: count('week'), later: count('later'), done: count('done') },
    window: { ...window, today },
  }
}

/* ------------------------------------------------------------------ *
 * Concluir
 * ------------------------------------------------------------------ */

export async function completeTask(
  key: string,
  input: { status?: 'done' | 'skipped'; reference?: string | null; note?: string | null } = {},
  executor: DbExecutor = db,
) {
  if (!KEY_PATTERN.test(key)) throw new TaskError('esta tarefa se resolve na própria tela (ela some ou fecha sozinha)')
  const closing = key.match(/^closing:(\d{4}-\d{2}):(.+)$/)
  if (closing) {
    if (closing[2] !== 'dre-review') throw new TaskError('este item do fechamento se resolve sozinho, na tela indicada')
    await setClosingReview(closing[1]!, true)
    return { key, done: true }
  }
  const values = { status: input.status ?? 'done', reference: input.reference?.trim() || null, note: input.note?.trim() || null }
  const existing = (await executor.select({ id: taskCompletions.id }).from(taskCompletions).where(eq(taskCompletions.taskKey, key)))[0]
  if (existing) await executor.update(taskCompletions).set(values).where(eq(taskCompletions.id, existing.id))
  else await executor.insert(taskCompletions).values({ taskKey: key, ...values })
  return { key, done: true }
}

export async function reopenTask(key: string, executor: DbExecutor = db) {
  const closing = key.match(/^closing:(\d{4}-\d{2}):dre-review$/)
  if (closing) {
    await setClosingReview(closing[1]!, false)
    return { key, done: false }
  }
  await executor.delete(taskCompletions).where(eq(taskCompletions.taskKey, key))
  return { key, done: false }
}

/* ------------------------------------------------------------------ *
 * Tarefas manuais
 * ------------------------------------------------------------------ */

const ISO = /^\d{4}-\d{2}-\d{2}$/

function validate(input: TaskInput, current?: typeof tasks.$inferSelect) {
  const recurrence = input.recurrence ?? current?.recurrence ?? 'once'
  const dueOn = input.dueOn !== undefined ? input.dueOn : (current?.dueOn ?? null)
  const dueDay = input.dueDay !== undefined ? input.dueDay : (current?.dueDay ?? null)
  const dueMonth = input.dueMonth !== undefined ? input.dueMonth : (current?.dueMonth ?? null)
  if (input.title !== undefined && !input.title.trim()) throw new TaskError('dê um título à tarefa')
  if (recurrence === 'once' && !(dueOn && ISO.test(dueOn))) throw new TaskError('informe a data da tarefa')
  if (recurrence !== 'once' && !(dueDay && dueDay >= 1 && dueDay <= 31)) throw new TaskError('informe o dia do vencimento (1 a 31)')
  if (recurrence === 'yearly' && !(dueMonth && dueMonth >= 1 && dueMonth <= 12)) throw new TaskError('informe o mês do vencimento')
  const kind = input.kind ?? current?.kind ?? 'custom'
  const clientId = input.clientId !== undefined ? input.clientId : (current?.clientId ?? null)
  if (kind === 'nf' && !clientId) throw new TaskError('a tarefa de nota fiscal precisa de um cliente')
}

export async function createTask(input: TaskInput, executor: DbExecutor = db) {
  validate(input)
  const recurrence = input.recurrence ?? 'once'
  return (
    await executor
      .insert(tasks)
      .values({
        title: input.title.trim(),
        kind: input.kind ?? 'custom',
        clientId: input.clientId ?? null,
        amountCents: input.amountCents ?? null,
        notes: input.notes?.trim() || null,
        recurrence,
        dueOn: recurrence === 'once' ? (input.dueOn ?? null) : null,
        dueDay: recurrence === 'once' ? null : (input.dueDay ?? null),
        dueMonth: recurrence === 'yearly' ? (input.dueMonth ?? null) : null,
        startsOn: input.startsOn ?? todayIso(),
        endsOn: input.endsOn ?? null,
        active: input.active ?? true,
      })
      .returning()
  )[0]!
}

export async function updateTask(id: number, patch: Partial<TaskInput>, executor: DbExecutor = db) {
  const current = (await executor.select().from(tasks).where(eq(tasks.id, id)))[0]
  if (!current) return null
  validate({ title: current.title, ...patch } as TaskInput, current)
  const set: Record<string, unknown> = { updatedAt: sql`now_iso()` }
  for (const field of ['title', 'kind', 'clientId', 'amountCents', 'notes', 'recurrence', 'dueOn', 'dueDay', 'dueMonth', 'startsOn', 'endsOn', 'active'] as const) {
    if (patch[field] !== undefined) set[field] = typeof patch[field] === 'string' && field !== 'dueOn' ? (patch[field] as string).trim() || null : patch[field]
  }
  return (await executor.update(tasks).set(set).where(eq(tasks.id, id)).returning())[0] ?? null
}

/** Apaga a tarefa e o "feito" das ocorrências dela. */
export async function deleteTask(id: number, executor: DbExecutor = db) {
  await executor.delete(taskCompletions).where(like(taskCompletions.taskKey, `manual:${id}:%`))
  return { removed: (await executor.delete(tasks).where(eq(tasks.id, id))).count }
}

export async function listManualTasks(executor: DbExecutor = db) {
  return executor
    .select({ task: tasks, clientName: clients.name })
    .from(tasks)
    .leftJoin(clients, eq(clients.id, tasks.clientId))
    .orderBy(asc(tasks.title))
}

export { clampedDate }
