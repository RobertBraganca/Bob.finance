/** Tarefas financeiras, no formato que `/tasks` devolve (docs/specs/tarefas-comercial-contador). */

export type TaskSource = 'manual' | 'nf' | 'pending_income' | 'pending_expense' | 'card' | 'das' | 'dasn' | 'closing' | 'goal' | 'partner'
export type TaskBucket = 'overdue' | 'today' | 'week' | 'later' | 'done'

export type TaskOccurrence = {
  key: string
  source: TaskSource
  title: string
  detail: string | null
  dueOn: string
  amountCents: number | null
  done: boolean
  doneAt: string | null
  status: 'done' | 'skipped' | null
  reference: string | null
  auto: boolean
  completable: boolean
  link: string | null
  taskId: number | null
  clientId: number | null
  clientName: string | null
  bucket: TaskBucket
}

export type TasksResponse = {
  tasks: TaskOccurrence[]
  summary: Record<TaskBucket, number>
  window: { from: string; to: string; today: string }
}

export type ManualTask = {
  id: number
  title: string
  kind: 'custom' | 'nf'
  clientId: number | null
  amountCents: number | null
  notes: string | null
  recurrence: 'once' | 'monthly' | 'yearly'
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

/** "venceu há 3 dias", "vence hoje", "vence em 5 dias": a distância, sem julgamento. */
export function dueLabel(dueOn: string, today: string): string {
  const days = Math.round((Date.parse(`${dueOn}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)
  if (days === 0) return 'vence hoje'
  if (days === 1) return 'vence amanhã'
  if (days === -1) return 'venceu ontem'
  return days > 0 ? `vence em ${days} dias` : `venceu há ${-days} dias`
}

export function recurrenceLabel(t: ManualTask): string {
  if (t.recurrence === 'once') return t.dueOn ? `em ${t.dueOn.split('-').reverse().join('/')}` : 'uma vez'
  if (t.recurrence === 'monthly') return `todo dia ${t.dueDay}`
  return `todo ${t.dueDay} de ${MONTH_LABEL[(t.dueMonth ?? 1) - 1]}`
}
