import { and, asc, desc, eq, like, ne, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '../db/client'
import { clients, investmentGoals, taskCompletions, taskNotes, tasks } from '../db/schema'
import { addDays, addMonths, periodBounds, todayIso } from '../core/dates'
import {
  TASK_STAGES,
  bucketOf,
  clampedDate,
  isResolved,
  occurrenceDates,
  stageOf,
  type TaskBucket,
  type TaskRecurrence,
  type TaskStage,
  type TaskStatus,
} from '../core/tasks'
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
  /** o que está gravado: feita, encerrada, em andamento ou pausada (null = a fazer) */
  status: TaskStatus | null
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
  /** coluna do Kanban */
  stage: TaskStage
  /** comentários escritos no detalhe da tarefa */
  noteCount: number
  /** a tarefa principal que junta esta: uma sua (com subtarefas) ou um grupo automático (contas a pagar) */
  group: TaskGroupRef | null
}

/**
 * Tarefa principal. As suas têm `taskId` (uma linha `kind = group`); as
 * automáticas juntam o que vem da mesma fonte (contas a pagar, a receber, o
 * fechamento do mês) e não existem no banco.
 */
export type TaskGroupRef = { key: string; title: string; taskId: number | null }

/** As suas tarefas principais, inclusive as ainda sem subtarefa na janela. */
export type TaskGroupInfo = TaskGroupRef & { taskId: number; notes: string | null; subtasks: number }

export type TaskInput = {
  title: string
  kind?: 'custom' | 'nf' | 'group'
  /** a tarefa principal desta (só para subtarefas) */
  parentId?: number | null
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
  const out: Omit<TaskOccurrence, 'bucket' | 'stage' | 'noteCount' | 'group'>[] = []
  const groupOf = new Map<string, TaskGroupRef>()

  const completions = new Map(
    (await executor.select().from(taskCompletions)).map((c) => [c.taskKey, c] as const),
  )
  const doneOf = (key: string) => {
    const c = completions.get(key)
    if (!c) return { done: false, doneAt: null, status: null, reference: null }
    const status = (['skipped', 'doing', 'paused'].includes(c.status) ? c.status : 'done') as TaskStatus
    return { done: isResolved(status), doneAt: isResolved(status) ? c.doneAt : null, status, reference: c.reference }
  }
  const noteCounts = new Map(
    (
      await executor
        .select({ key: taskNotes.taskKey, count: sql<number>`count(*)::int` })
        .from(taskNotes)
        .where(eq(taskNotes.kind, 'comment'))
        .groupBy(taskNotes.taskKey)
    ).map((n) => [n.key, Number(n.count)] as const),
  )
  const base = { taskId: null, clientId: null, clientName: null, amountCents: null, detail: null, link: null }

  // ---- manuais (inclui "emitir nota fiscal") ----
  const manual = await executor
    .select({ task: tasks, clientName: clients.name })
    .from(tasks)
    .leftJoin(clients, eq(clients.id, tasks.clientId))
    .where(eq(tasks.active, true))
    .orderBy(asc(tasks.id))
  // A principal não vence: só junta as subtarefas. Pausada, leva as subtarefas junto.
  const groups = new Map<number, TaskGroupInfo>()
  for (const { task } of manual) {
    if (task.kind === 'group') groups.set(task.id, { key: `group:${task.id}`, title: task.title, taskId: task.id, notes: task.notes, subtasks: 0 })
  }
  for (const { task, clientName } of manual) {
    if (task.kind === 'group') continue
    const parent = task.parentId ? groups.get(task.parentId) : undefined
    if (task.parentId && !parent) continue
    if (parent) parent.subtasks += 1
    for (const dueOn of occurrenceDates(task, window.from, window.to)) {
      const key = `manual:${task.id}:${dueOn}`
      if (parent) groupOf.set(key, { key: parent.key, title: parent.title, taskId: parent.taskId })
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

  const list: TaskOccurrence[] = out
    .map((t) => ({
      ...t,
      bucket: bucketOf(t.dueOn, t.done, today, weekEnd),
      stage: stageOf(t.dueOn, t.status, t.done, today),
      noteCount: noteCounts.get(t.key) ?? 0,
      group: groupOf.get(t.key) ?? autoGroup(t.source, previous),
    }))
    .sort((a, b) => Number(a.done) - Number(b.done) || a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title, 'pt-BR'))
  const count = (bucket: TaskBucket) => list.filter((t) => t.bucket === bucket).length
  const stages = Object.fromEntries(TASK_STAGES.map((s) => [s, list.filter((t) => t.stage === s).length])) as Record<TaskStage, number>
  return {
    tasks: list,
    groups: [...groups.values()],
    summary: { overdue: count('overdue'), today: count('today'), week: count('week'), later: count('later'), done: count('done') },
    stages,
    window: { ...window, today },
  }
}

/**
 * Grupos automáticos: as contas a pagar e a receber e os itens do fechamento
 * viram uma tarefa principal cada, em vez de um cartão por conta.
 */
function autoGroup(source: TaskSource, closingPeriod: string): TaskGroupRef | null {
  if (source === 'pending_expense') return { key: 'auto:pending_expense', title: 'Contas a pagar', taskId: null }
  if (source === 'pending_income') return { key: 'auto:pending_income', title: 'Contas a receber', taskId: null }
  if (source === 'closing') return { key: `auto:closing:${closingPeriod}`, title: `Fechamento de ${monthName(closingPeriod)}`, taskId: null }
  return null
}

/* ------------------------------------------------------------------ *
 * Concluir
 * ------------------------------------------------------------------ */

export async function completeTask(
  key: string,
  input: { status?: TaskStatus; reference?: string | null; note?: string | null } = {},
  executor: DbExecutor = db,
) {
  if (!KEY_PATTERN.test(key)) throw new TaskError('esta tarefa se resolve na própria tela (ela some ou fecha sozinha)')
  const status = input.status ?? 'done'
  const closing = key.match(/^closing:(\d{4}-\d{2}):(.+)$/)
  if (closing) {
    if (closing[2] !== 'dre-review') throw new TaskError('este item do fechamento se resolve sozinho, na tela indicada')
    if (status !== 'done') throw new TaskError('a revisão do fechamento só pode ser marcada como feita ou reaberta')
    await setClosingReview(closing[1]!, true)
    await logStage(key, 'todo', 'done', null, executor)
    return { key, done: true }
  }
  const values = { status, reference: input.reference?.trim() || null, note: input.note?.trim() || null }
  const existing = (
    await executor
      .select({ id: taskCompletions.id, status: taskCompletions.status })
      .from(taskCompletions)
      .where(eq(taskCompletions.taskKey, key))
  )[0]
  if (existing) await executor.update(taskCompletions).set({ ...values, doneAt: sql`now_iso()` }).where(eq(taskCompletions.id, existing.id))
  else await executor.insert(taskCompletions).values({ taskKey: key, ...values })
  await logStage(key, stageOfStatus(existing?.status ?? null), stageOfStatus(status), values.note, executor)
  return { key, done: isResolved(status) }
}

/** Colunas do Kanban que se gravam. "A fazer" (e "Atrasada", que é a mesma coisa vencida) apaga o estado. */
const STATUS_OF_STAGE: Record<Exclude<TaskStage, 'overdue' | 'todo'>, TaskStatus> = {
  doing: 'doing',
  paused: 'paused',
  done: 'done',
  closed: 'skipped',
}

/** Move a ocorrência de coluna no Kanban (ou pelo seletor de etapa da lista). */
export async function setTaskStage(
  key: string,
  stage: TaskStage,
  input: { reference?: string | null; note?: string | null } = {},
  executor: DbExecutor = db,
) {
  if (stage === 'todo' || stage === 'overdue') {
    if (!KEY_PATTERN.test(key)) throw new TaskError('esta tarefa se resolve na própria tela (ela some ou fecha sozinha)')
    return reopenTask(key, executor)
  }
  return completeTask(key, { status: STATUS_OF_STAGE[stage], reference: input.reference, note: input.note }, executor)
}

export async function reopenTask(key: string, executor: DbExecutor = db) {
  const closing = key.match(/^closing:(\d{4}-\d{2}):dre-review$/)
  if (closing) {
    await setClosingReview(closing[1]!, false)
    await logStage(key, 'done', 'todo', null, executor)
    return { key, done: false }
  }
  const removed = await executor
    .delete(taskCompletions)
    .where(eq(taskCompletions.taskKey, key))
    .returning({ status: taskCompletions.status })
  if (removed[0]) await logStage(key, stageOfStatus(removed[0].status), 'todo', null, executor)
  return { key, done: false }
}

/* ------------------------------------------------------------------ *
 * Detalhe: comentários e histórico de etapas
 * ------------------------------------------------------------------ */

export type TaskNote = {
  id: number
  taskKey: string
  kind: 'comment' | 'stage'
  body: string | null
  fromStage: TaskStage | null
  toStage: TaskStage | null
  createdAt: string
}

export type TaskHistoryEntry = {
  key: string
  dueOn: string
  stage: TaskStage
  doneAt: string | null
  reference: string | null
  notes: TaskNote[]
}

/** O que está gravado vira etapa; sem linha, "A fazer" (a data decide se está atrasada). */
const stageOfStatus = (status: string | null): TaskStage =>
  status === 'skipped' ? 'closed' : status === 'doing' || status === 'paused' || status === 'done' ? status : 'todo'

/** Toda ocorrência que a tela lista tem detalhe, inclusive as que fecham sozinhas. */
const isTaskKey = (key: string) => KEY_PATTERN.test(key) || /^(pending|partner):\d+$/.test(key)
const taskIdOf = (key: string) => {
  const match = key.match(/^manual:(\d+):/)
  return match ? Number(match[1]) : null
}

const toNote = (n: typeof taskNotes.$inferSelect): TaskNote => ({
  id: Number(n.id),
  taskKey: n.taskKey,
  kind: n.kind === 'stage' ? 'stage' : 'comment',
  body: n.body,
  fromStage: (n.fromStage as TaskStage | null) ?? null,
  toStage: (n.toStage as TaskStage | null) ?? null,
  createdAt: n.createdAt,
})

/** Grava a mudança de etapa no histórico; mover para onde já estava, sem motivo, não conta. */
async function logStage(key: string, from: TaskStage, to: TaskStage, reason: string | null, executor: DbExecutor) {
  if (from === to && !reason) return
  await executor.insert(taskNotes).values({ taskKey: key, taskId: taskIdOf(key), kind: 'stage', body: reason, fromStage: from, toStage: to })
}

/**
 * Detalhe de uma ocorrência: comentários e mudanças de etapa, do mais novo ao
 * mais antigo. Nas manuais, também as outras ocorrências da mesma tarefa com
 * algo gravado, sem o limite de 60 dias da tela.
 */
export async function taskDetail(key: string, executor: DbExecutor = db) {
  if (!isTaskKey(key)) throw new TaskError('tarefa não encontrada')
  const today = todayIso()
  const notes = (
    await executor.select().from(taskNotes).where(eq(taskNotes.taskKey, key)).orderBy(desc(taskNotes.createdAt), desc(taskNotes.id))
  ).map(toNote)

  const taskId = taskIdOf(key)
  const history: TaskHistoryEntry[] = []
  if (taskId !== null) {
    const byKey = new Map<string, TaskHistoryEntry>()
    const entry = (k: string) => {
      let e = byKey.get(k)
      if (!e) {
        const dueOn = k.slice(-10)
        e = { key: k, dueOn, stage: stageOf(dueOn, null, false, today), doneAt: null, reference: null, notes: [] }
        byKey.set(k, e)
      }
      return e
    }
    const completions = await executor
      .select()
      .from(taskCompletions)
      .where(and(like(taskCompletions.taskKey, `manual:${taskId}:%`), ne(taskCompletions.taskKey, key)))
    for (const c of completions) {
      const e = entry(c.taskKey)
      const stage = stageOfStatus(c.status)
      if (stage !== 'todo') e.stage = stage
      e.doneAt = stage === 'done' || stage === 'closed' ? c.doneAt : null
      e.reference = c.reference
    }
    const others = await executor
      .select()
      .from(taskNotes)
      .where(and(eq(taskNotes.taskId, taskId), ne(taskNotes.taskKey, key)))
      .orderBy(desc(taskNotes.createdAt), desc(taskNotes.id))
    for (const n of others) entry(n.taskKey).notes.push(toNote(n))
    history.push(...[...byKey.values()].sort((a, b) => b.dueOn.localeCompare(a.dueOn)).slice(0, 24))
  }
  return { key, notes, history }
}

export async function addTaskNote(key: string, body: string, executor: DbExecutor = db) {
  if (!isTaskKey(key)) throw new TaskError('tarefa não encontrada')
  const text = body.trim()
  if (!text) throw new TaskError('escreva o comentário')
  const row = (
    await executor.insert(taskNotes).values({ taskKey: key, taskId: taskIdOf(key), kind: 'comment', body: text }).returning()
  )[0]!
  return toNote(row)
}

/** Só comentário se apaga; o histórico de etapas fica. */
export async function deleteTaskNote(id: number, executor: DbExecutor = db) {
  const removed = await executor
    .delete(taskNotes)
    .where(and(eq(taskNotes.id, id), eq(taskNotes.kind, 'comment')))
    .returning({ id: taskNotes.id })
  return { removed: removed.length }
}

/* ------------------------------------------------------------------ *
 * Tarefas manuais
 * ------------------------------------------------------------------ */

const ISO = /^\d{4}-\d{2}-\d{2}$/

async function validate(input: TaskInput, executor: DbExecutor, current?: typeof tasks.$inferSelect) {
  if (input.title !== undefined && !input.title.trim()) throw new TaskError('dê um título à tarefa')
  const kind = input.kind ?? current?.kind ?? 'custom'
  const parentId = input.parentId !== undefined ? input.parentId : (current?.parentId ?? null)

  if (kind === 'group') {
    // A principal só junta: não vence, não tem cliente, e não fica dentro de outra.
    if (parentId) throw new TaskError('uma tarefa principal não fica dentro de outra')
    return
  }
  if (current?.kind === 'group') {
    const children = await executor.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentId, current.id)).limit(1)
    if (children.length > 0) throw new TaskError('esta tarefa principal tem subtarefas: mova ou exclua as subtarefas antes de mudar o tipo')
  }
  if (parentId) {
    if (current && parentId === current.id) throw new TaskError('a tarefa não pode ficar dentro dela mesma')
    const parent = (await executor.select({ kind: tasks.kind }).from(tasks).where(eq(tasks.id, parentId)))[0]
    if (!parent || parent.kind !== 'group') throw new TaskError('escolha uma tarefa principal que exista')
  }

  const recurrence = input.recurrence ?? current?.recurrence ?? 'once'
  const dueOn = input.dueOn !== undefined ? input.dueOn : (current?.dueOn ?? null)
  const dueDay = input.dueDay !== undefined ? input.dueDay : (current?.dueDay ?? null)
  const dueMonth = input.dueMonth !== undefined ? input.dueMonth : (current?.dueMonth ?? null)
  if (recurrence === 'once' && !(dueOn && ISO.test(dueOn))) throw new TaskError('informe a data da tarefa')
  if (recurrence === 'weekly' && !(dueDay && dueDay >= 1 && dueDay <= 7)) throw new TaskError('informe o dia da semana')
  if ((recurrence === 'monthly' || recurrence === 'yearly') && !(dueDay && dueDay >= 1 && dueDay <= 31))
    throw new TaskError('informe o dia do vencimento (1 a 31)')
  if (recurrence === 'yearly' && !(dueMonth && dueMonth >= 1 && dueMonth <= 12)) throw new TaskError('informe o mês do vencimento')
  const clientId = input.clientId !== undefined ? input.clientId : (current?.clientId ?? null)
  if (kind === 'nf' && !clientId) throw new TaskError('a tarefa de nota fiscal precisa de um cliente')
}

export async function createTask(input: TaskInput, executor: DbExecutor = db) {
  await validate(input, executor)
  const kind = input.kind ?? 'custom'
  const group = kind === 'group'
  const recurrence = group ? 'once' : (input.recurrence ?? 'once')
  return (
    await executor
      .insert(tasks)
      .values({
        title: input.title.trim(),
        kind,
        parentId: group ? null : (input.parentId ?? null),
        clientId: group ? null : (input.clientId ?? null),
        amountCents: group ? null : (input.amountCents ?? null),
        notes: input.notes?.trim() || null,
        recurrence,
        dueOn: !group && recurrence === 'once' ? (input.dueOn ?? null) : null,
        dueDay: group || recurrence === 'once' ? null : (input.dueDay ?? null),
        dueMonth: !group && recurrence === 'yearly' ? (input.dueMonth ?? null) : null,
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
  await validate({ title: current.title, ...patch } as TaskInput, executor, current)
  const set: Record<string, unknown> = { updatedAt: sql`now_iso()` }
  const fields = ['title', 'kind', 'parentId', 'clientId', 'amountCents', 'notes', 'recurrence', 'dueOn', 'dueDay', 'dueMonth', 'startsOn', 'endsOn', 'active'] as const
  for (const field of fields) {
    if (patch[field] !== undefined) set[field] = typeof patch[field] === 'string' && field !== 'dueOn' ? (patch[field] as string).trim() || null : patch[field]
  }
  return (await executor.update(tasks).set(set).where(eq(tasks.id, id)).returning())[0] ?? null
}

/**
 * Apaga a tarefa e o "feito" das ocorrências dela. Numa principal, as
 * subtarefas saem junto (o banco apaga em cascata; o "feito" delas, aqui).
 */
export async function deleteTask(id: number, executor: DbExecutor = db) {
  const children = await executor.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentId, id))
  for (const taskId of [id, ...children.map((c) => c.id)]) {
    await executor.delete(taskCompletions).where(like(taskCompletions.taskKey, `manual:${taskId}:%`))
  }
  return { removed: (await executor.delete(tasks).where(eq(tasks.id, id))).count, subtasks: children.length }
}

export async function listManualTasks(executor: DbExecutor = db) {
  return executor
    .select({ task: tasks, clientName: clients.name })
    .from(tasks)
    .leftJoin(clients, eq(clients.id, tasks.clientId))
    .orderBy(asc(tasks.title))
}

export { clampedDate }
