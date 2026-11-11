import type { TaskGroupInfo, TaskOccurrence, TaskSource, TaskStage } from './types'

/**
 * Filtros e agrupamento da tela de Tarefas, todos no navegador: a lista já vem
 * inteira da janela (60 dias para trás, 90 para a frente), então filtrar,
 * buscar e agrupar não custa outra ida ao servidor.
 */

/** Tudo, só as que você criou, ou só as que saem das contas (pendências, fatura, DAS, notas). */
export type TaskScope = 'all' | 'mine' | 'money'

export const SCOPE_OPTIONS: Array<{ value: TaskScope; label: string }> = [
  { value: 'all', label: 'Tudo' },
  { value: 'mine', label: 'Suas tarefas' },
  { value: 'money', label: 'Financeiro' },
]

export const inScope = (t: TaskOccurrence, scope: TaskScope) =>
  scope === 'all' || (scope === 'mine' ? t.source === 'manual' : t.source !== 'manual')

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

/** Todas as palavras da busca, sem acento nem caixa, no título, na principal, na observação, no cliente ou na nota. */
export function matchesSearch(t: TaskOccurrence, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = fold([t.title, t.group?.title, t.detail, t.clientName, t.reference].filter(Boolean).join(' '))
  return words.every((w) => haystack.includes(w))
}

/* ------------------------------------------------------------------ *
 * Recorrentes: só a próxima
 * ------------------------------------------------------------------ */

/**
 * A série de uma ocorrência: a mesma tarefa sua, a mesma conta (Internet todo
 * mês), o mesmo cartão, o mesmo aporte. Uma tarefa de uma vez só é a sua série.
 */
function seriesOf(t: TaskOccurrence): string {
  if (t.taskId !== null) return `task:${t.taskId}`
  if (t.source === 'pending_expense' || t.source === 'pending_income') return `${t.source}:${t.title}`
  const match = t.key.match(/^(card|goal):(\d+):/)
  if (match) return `${match[1]}:${match[2]}`
  if (t.source === 'das') return 'das'
  return t.key
}

/**
 * Das recorrentes, só as atrasadas e a próxima de cada uma: Internet de
 * outubro (vencida) e a de novembro aparecem; a de dezembro espera a vez. As
 * resolvidas ficam. Devolve também quantas foram escondidas.
 */
export function nextOnly(tasks: TaskOccurrence[]): { tasks: TaskOccurrence[]; hidden: number } {
  const seen = new Set<string>()
  const out: TaskOccurrence[] = []
  const ordered = [...tasks].sort((a, b) => a.dueOn.localeCompare(b.dueOn))
  const keep = new Set<string>()
  for (const t of ordered) {
    if (t.done || t.stage === 'overdue' || t.stage === 'doing' || t.stage === 'paused') {
      keep.add(t.key)
      continue
    }
    const series = seriesOf(t)
    if (seen.has(series)) continue
    seen.add(series)
    keep.add(t.key)
  }
  for (const t of tasks) if (keep.has(t.key)) out.push(t)
  return { tasks: out, hidden: tasks.length - out.length }
}

/* ------------------------------------------------------------------ *
 * Tarefa principal e subtarefas
 * ------------------------------------------------------------------ */

export type TaskGroupItem = {
  kind: 'group'
  key: string
  title: string
  /** a sua tarefa principal; null nos grupos automáticos */
  taskId: number | null
  /** "Nível 2", lido da observação da principal ("Metas até 31/12 · Nível 2 ...") */
  level: number | null
  notes: string | null
  /** as subtarefas na janela, por data */
  tasks: TaskOccurrence[]
  /** a coluna do cartão, tirada das subtarefas */
  stage: TaskStage
  /** a primeira subtarefa ainda aberta; null quando tudo foi resolvido */
  next: TaskOccurrence | null
  /** data do cartão: a da próxima subtarefa (ou a da última, se tudo foi resolvido) */
  dueOn: string
  resolved: number
  total: number
  /** soma dos valores das abertas (contas a pagar, a receber) */
  openCents: number | null
}

export type TaskItem = { kind: 'task'; key: string; task: TaskOccurrence; dueOn: string; stage: TaskStage } | TaskGroupItem

export const GROUP_SOURCE_LABEL: Partial<Record<TaskSource, string>> = {
  pending_expense: 'A pagar',
  pending_income: 'A receber',
  closing: 'Fechamento do mês',
}

const levelOf = (notes: string | null) => Number(notes?.match(/Nível (\d)/)?.[1]) || null

/**
 * A coluna de uma principal: feita (ou encerrada) quando tudo foi resolvido;
 * senão atrasada se algum passo venceu, fazendo se algum está em andamento,
 * pausada se tudo o que falta está pausado, e a fazer no resto.
 */
export function groupStage(tasks: TaskOccurrence[]): TaskStage {
  const open = tasks.filter((t) => !t.done)
  if (open.length === 0) return tasks.length > 0 && tasks.every((t) => t.stage === 'closed') ? 'closed' : 'done'
  if (open.some((t) => t.stage === 'overdue')) return 'overdue'
  if (open.some((t) => t.stage === 'doing')) return 'doing'
  if (open.every((t) => t.stage === 'paused')) return 'paused'
  return 'todo'
}

/**
 * Junta as subtarefas na tarefa principal delas: um cartão por principal, com
 * o progresso e o próximo passo, em vez de um cartão por passo. As principais
 * suas sem nenhum passo na janela não aparecem (não há o que fazer agora).
 */
export function buildItems(tasks: TaskOccurrence[], groups: TaskGroupInfo[]): TaskItem[] {
  const info = new Map(groups.map((g) => [g.key, g]))
  const byGroup = new Map<string, TaskOccurrence[]>()
  const items: TaskItem[] = []
  for (const t of tasks) {
    if (!t.group) {
      items.push({ kind: 'task', key: t.key, task: t, dueOn: t.dueOn, stage: t.stage })
      continue
    }
    const list = byGroup.get(t.group.key)
    if (list) list.push(t)
    else byGroup.set(t.group.key, [t])
  }
  for (const [key, children] of byGroup) {
    const sorted = [...children].sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title, 'pt-BR'))
    const ref = sorted[0]!.group!
    const open = sorted.filter((t) => !t.done)
    const next = open[0] ?? null
    const amounts = open.filter((t) => t.amountCents !== null)
    const notes = info.get(key)?.notes ?? null
    items.push({
      kind: 'group',
      key,
      title: ref.title,
      taskId: ref.taskId,
      level: levelOf(notes),
      notes,
      tasks: sorted,
      stage: groupStage(sorted),
      next,
      dueOn: next?.dueOn ?? sorted[sorted.length - 1]!.dueOn,
      resolved: sorted.length - open.length,
      total: sorted.length,
      openCents: amounts.length > 0 ? amounts.reduce((sum, t) => sum + (t.amountCents ?? 0), 0) : null,
    })
  }
  return items.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || itemTitle(a).localeCompare(itemTitle(b), 'pt-BR'))
}

const itemTitle = (item: TaskItem) => (item.kind === 'group' ? item.title : item.task.title)

export type GroupProgress = { key: string; title: string; level: number | null; resolved: number; total: number }

/** Progresso de cada tarefa principal sua (para o filtro), do nível 1 ao 5. */
export function groupProgress(tasks: TaskOccurrence[], groups: TaskGroupInfo[]): GroupProgress[] {
  const byKey = new Map<string, GroupProgress>()
  for (const g of groups) byKey.set(g.key, { key: g.key, title: g.title, level: levelOf(g.notes), resolved: 0, total: 0 })
  for (const t of tasks) {
    const entry = t.group?.taskId ? byKey.get(t.group.key) : undefined
    if (!entry) continue
    entry.total += 1
    if (t.done) entry.resolved += 1
  }
  return [...byKey.values()]
    .filter((g) => g.total > 0)
    .sort((a, b) => (a.level ?? 9) - (b.level ?? 9) || a.title.localeCompare(b.title, 'pt-BR'))
}

/* ------------------------------------------------------------------ *
 * "A fazer" por distância
 * ------------------------------------------------------------------ */

export type PeriodKey = 'week' | 'soon' | 'later'
export const PERIOD_LABEL: Record<PeriodKey, string> = {
  week: 'Próximos 7 dias',
  soon: 'Próximas semanas',
  later: 'Mais adiante',
}
/** O botão que abre uma faixa recolhida: "Mostrar 12 das próximas semanas". */
export const PERIOD_MORE: Record<PeriodKey, string> = {
  week: 'dos próximos 7 dias',
  soon: 'das próximas semanas',
  later: 'mais adiante',
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * "A fazer" partido pela distância: o que vence em 7 dias, até 30 dias, e o
 * resto. Grupos vazios saem; a ordem dentro de cada um é a da lista (por data).
 * Uma principal entra pela data do próximo passo.
 */
export function periodGroups<T extends { dueOn: string }>(items: T[], today: string): Array<{ key: PeriodKey; items: T[] }> {
  const week = addDays(today, 7)
  const month = addDays(today, 30)
  const groups: Record<PeriodKey, T[]> = { week: [], soon: [], later: [] }
  for (const item of items) groups[item.dueOn <= week ? 'week' : item.dueOn <= month ? 'soon' : 'later'].push(item)
  return (['week', 'soon', 'later'] as const).filter((key) => groups[key].length > 0).map((key) => ({ key, items: groups[key] }))
}
