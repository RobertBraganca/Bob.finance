import { addMonths, daysInMonth } from './dates.ts'

/**
 * Núcleo puro das tarefas financeiras (docs/specs/tarefas-comercial-contador):
 * de quais datas uma tarefa recorrente vence dentro de uma janela, e quais
 * ocorrências entram na lista. Sem banco, para testar.
 */

export type TaskRecurrence = 'once' | 'monthly' | 'yearly'

export type TaskTemplate = {
  recurrence: TaskRecurrence
  dueOn: string | null
  dueDay: number | null
  dueMonth: number | null
  startsOn: string | null
  endsOn: string | null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** O dia pedido, preso ao fim do mês: dia 31 em fevereiro vira 28 (ou 29). */
export function clampedDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`
}

/** Datas em que a tarefa vence entre `from` e `to` (inclusive), respeitando início e fim. */
export function occurrenceDates(t: TaskTemplate, from: string, to: string): string[] {
  const lower = t.startsOn && t.startsOn > from ? t.startsOn : from
  const upper = t.endsOn && t.endsOn < to ? t.endsOn : to
  if (lower > upper) return []
  if (t.recurrence === 'once') return t.dueOn && t.dueOn >= lower && t.dueOn <= upper ? [t.dueOn] : []

  const out: string[] = []
  if (t.recurrence === 'monthly') {
    if (!t.dueDay) return []
    for (let p = lower.slice(0, 7); p <= upper.slice(0, 7); p = addMonths(p, 1)) {
      const date = clampedDate(Number(p.slice(0, 4)), Number(p.slice(5, 7)), t.dueDay)
      if (date >= lower && date <= upper) out.push(date)
    }
    return out
  }
  if (!t.dueDay || !t.dueMonth) return []
  for (let y = Number(lower.slice(0, 4)); y <= Number(upper.slice(0, 4)); y++) {
    const date = clampedDate(y, t.dueMonth, t.dueDay)
    if (date >= lower && date <= upper) out.push(date)
  }
  return out
}

export type TaskBucket = 'overdue' | 'today' | 'week' | 'later' | 'done'

/** Em que grupo da tela a ocorrência cai. */
export function bucketOf(dueOn: string, done: boolean, today: string, weekEnd: string): TaskBucket {
  if (done) return 'done'
  if (dueOn < today) return 'overdue'
  if (dueOn === today) return 'today'
  if (dueOn <= weekEnd) return 'week'
  return 'later'
}
