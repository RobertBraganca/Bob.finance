/** Tarefas financeiras, no formato que `/tasks` devolve (docs/specs/tarefas-comercial-contador). */

export type TaskSource = 'manual' | 'nf' | 'pending_income' | 'pending_expense' | 'card' | 'das' | 'dasn' | 'closing' | 'goal' | 'partner'
export type TaskBucket = 'overdue' | 'today' | 'week' | 'later' | 'done'
/** Coluna do Kanban. "Atrasada" e "A fazer" saem da data; as outras, do que foi gravado. */
export type TaskStage = 'overdue' | 'todo' | 'doing' | 'paused' | 'done' | 'closed'
export type TaskStatus = 'done' | 'skipped' | 'doing' | 'paused'

export type TaskOccurrence = {
  key: string
  source: TaskSource
  title: string
  detail: string | null
  dueOn: string
  amountCents: number | null
  done: boolean
  doneAt: string | null
  status: TaskStatus | null
  reference: string | null
  auto: boolean
  completable: boolean
  link: string | null
  taskId: number | null
  clientId: number | null
  clientName: string | null
  bucket: TaskBucket
  stage: TaskStage
  noteCount: number
  /** a tarefa principal que junta esta (uma sua, ou um grupo automático como "Contas a pagar") */
  group: TaskGroupRef | null
}

/** Tarefa principal: as suas têm `taskId`; as automáticas (contas, fechamento), não. */
export type TaskGroupRef = { key: string; title: string; taskId: number | null }

/** As suas tarefas principais, inclusive as ainda sem subtarefa na janela. */
export type TaskGroupInfo = TaskGroupRef & { taskId: number; notes: string | null; subtasks: number }

export type TaskNote = {
  id: number
  taskKey: string
  kind: 'comment' | 'stage'
  body: string | null
  fromStage: TaskStage | null
  toStage: TaskStage | null
  createdAt: string
}

/** `/tasks/detail`: comentários e etapas da ocorrência e, nas manuais, das outras ocorrências. */
export type TaskDetailResponse = {
  key: string
  notes: TaskNote[]
  history: Array<{ key: string; dueOn: string; stage: TaskStage; doneAt: string | null; reference: string | null; notes: TaskNote[] }>
}

export type TasksResponse = {
  tasks: TaskOccurrence[]
  groups: TaskGroupInfo[]
  summary: Record<TaskBucket, number>
  stages: Record<TaskStage, number>
  window: { from: string; to: string; today: string }
}

/** Ordem das colunas do Kanban e das seções da lista. */
export const STAGES: TaskStage[] = ['overdue', 'todo', 'doing', 'paused', 'done', 'closed']

export const STAGE_LABEL: Record<TaskStage, string> = {
  overdue: 'Atrasadas',
  todo: 'A fazer',
  doing: 'Fazendo',
  paused: 'Pausadas',
  done: 'Feitas',
  closed: 'Encerradas',
}

/** A etapa de uma tarefa só, para selo e histórico ("Pausada", não "Pausadas"). */
export const STAGE_ONE: Record<TaskStage, string> = {
  overdue: 'Atrasada',
  todo: 'A fazer',
  doing: 'Fazendo',
  paused: 'Pausada',
  done: 'Feita',
  closed: 'Encerrada',
}

export const STAGE_HINT: Record<TaskStage, string> = {
  overdue: 'Venceram e ainda não começaram',
  todo: 'O que vem pela frente',
  doing: 'Em andamento',
  paused: 'Paradas por enquanto; saem do Google Agenda',
  done: 'Resolvidas',
  closed: 'Não vão ser feitas',
}

/** Tom do seletor de etapa (as classes `select--pill` que já existem). */
export const STAGE_TONE: Record<TaskStage, string> = {
  overdue: 'select--critical',
  todo: '',
  doing: 'select--info',
  paused: 'select--warning',
  done: 'select--good',
  closed: '',
}

/** Dá para mover de coluna aqui; as que a própria tela resolve (pendência a baixar, DAS pago) não. */
export const isMovable = (t: TaskOccurrence) => t.completable

/** Para onde a ocorrência pode ir. A revisão do fechamento só fica feita ou volta. */
export function stageOptions(t: TaskOccurrence): Array<{ value: TaskStage; label: string }> {
  const todo = { value: 'todo' as const, label: t.stage === 'overdue' ? 'Atrasada' : 'A fazer' }
  if (t.key.startsWith('closing:')) return [todo, { value: 'done', label: 'Feita' }]
  return [
    todo,
    { value: 'doing', label: 'Fazendo' },
    { value: 'paused', label: 'Pausada' },
    { value: 'done', label: 'Feita' },
    { value: 'closed', label: 'Encerrada' },
  ]
}

export type ManualTask = {
  id: number
  /** a tarefa principal desta, quando é uma subtarefa */
  parentId: number | null
  title: string
  /** `group`: tarefa principal, só junta subtarefas (sem data) */
  kind: 'custom' | 'nf' | 'group'
  clientId: number | null
  amountCents: number | null
  notes: string | null
  /** na semanal, `dueDay` é o dia da semana: 1 (segunda) a 7 (domingo) */
  recurrence: 'once' | 'monthly' | 'yearly' | 'weekly'
  dueOn: string | null
  dueDay: number | null
  dueMonth: number | null
  startsOn: string | null
  endsOn: string | null
  active: boolean
}

export const SOURCE_LABEL: Record<TaskSource, string> = {
  manual: 'Sua tarefa',
  nf: 'Nota fiscal',
  pending_income: 'A receber',
  pending_expense: 'A pagar',
  card: 'Cartão',
  das: 'DAS',
  dasn: 'MEI',
  closing: 'Fechamento do mês',
  goal: 'Aporte',
  partner: 'Parceiro',
}

export const BUCKET_LABEL: Record<TaskBucket, string> = {
  overdue: 'Atrasadas',
  today: 'Hoje',
  week: 'Próximos 7 dias',
  later: 'Mais adiante',
  done: 'Feitas',
}

export const MONTH_LABEL = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

/** Dia da semana da recorrência semanal: índice 0 = 1 (segunda), como na ISO 8601. */
export const WEEKDAY_LABEL = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']

/**
 * O título do passo dentro da principal: "Fechamento de outubro de 2026: todas
 * as transações..." vira "Todas as transações..." quando já está no grupo dele.
 * Em "Contas a pagar" e "Contas a receber" o "Pagar: " / "Receber: " sai.
 */
export function stepTitle(t: TaskOccurrence): string {
  const verb = t.group?.key === 'auto:pending_expense' ? 'Pagar: ' : t.group?.key === 'auto:pending_income' ? 'Receber: ' : null
  const prefix = verb ?? (t.group ? `${t.group.title}: ` : null)
  if (!prefix || !t.title.startsWith(prefix)) return t.title
  const rest = t.title.slice(prefix.length)
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

/** "venceu há 3 dias", "vence hoje", "vence em 5 dias": a distância, sem julgamento. */
export function dueLabel(dueOn: string, today: string): string {
  const days = Math.round((Date.parse(`${dueOn}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)
  if (days === 0) return 'vence hoje'
  if (days === 1) return 'vence amanhã'
  if (days === -1) return 'venceu ontem'
  return days > 0 ? `vence em ${days} dias` : `venceu há ${-days} dias`
}

export function recurrenceLabel(t: ManualTask): string {
  if (t.kind === 'group') return 'tarefa principal'
  if (t.recurrence === 'once') return t.dueOn ? `em ${t.dueOn.split('-').reverse().join('/')}` : 'uma vez'
  if (t.recurrence === 'weekly') {
    const day = WEEKDAY_LABEL[(t.dueDay ?? 1) - 1] ?? 'semana'
    const until = t.endsOn ? ` até ${t.endsOn.split('-').reverse().slice(0, 2).join('/')}` : ''
    return `${day === 'sábado' || day === 'domingo' ? 'todo' : 'toda'} ${day}${until}`
  }
  if (t.recurrence === 'monthly') return `todo dia ${t.dueDay}`
  return `todo ${t.dueDay} de ${MONTH_LABEL[(t.dueMonth ?? 1) - 1]}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Dia local de um instante gravado ("2026-11-03T17:17:00Z"); uma data pura fica como está. */
export function localDay(iso: string): string {
  if (iso.length <= 10) return iso
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "03/11", ou "03/11/2025" quando não é deste ano. */
export function dayLabel(iso: string, today: string): string {
  const [y, m, d] = localDay(iso).split('-')
  return y === today.slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${y}`
}

/** "03/11 às 14:17": quando um comentário ou mudança de etapa foi gravado. */
export function whenLabel(iso: string, today: string): string {
  const d = new Date(iso)
  if (iso.length <= 10 || Number.isNaN(d.getTime())) return dayLabel(iso, today)
  return `${dayLabel(iso, today)} às ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
