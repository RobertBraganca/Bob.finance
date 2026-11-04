import type { TaskOccurrence } from './types'

/**
 * Filtros da tela de Tarefas, todos no navegador: a lista já vem inteira da
 * janela (60 dias para trás, 90 para a frente), então filtrar e buscar não
 * custa outra ida ao servidor.
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

export type GoalInfo = { name: string; level: number | null; step: string }

/**
 * A meta de um passo. As metas entram como tarefas suas com a observação
 * "Metas até 31/12 · Nível 2 (organização e agendamento) · Dentista": o nome
 * vem do fim da observação (o prefixo do título varia: "Mimar a Rafa" é da
 * meta "Cuidar da aparência e mimar a Rafa"), e o passo, do título sem o prefixo.
 */
export function goalOf(t: TaskOccurrence): GoalInfo | null {
  if (t.source !== 'manual' || !t.detail?.startsWith('Metas ')) return null
  const parts = t.detail.split(' · ')
  if (parts.length < 3) return null
  const level = Number(t.detail.match(/Nível (\d)/)?.[1]) || null
  const cut = t.title.indexOf(': ')
  return { name: parts[parts.length - 1]!.trim(), level, step: cut > 0 ? t.title.slice(cut + 2) : t.title }
}

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

/** Todas as palavras da busca, sem acento nem caixa, no título, na observação, no cliente ou na nota. */
export function matchesSearch(t: TaskOccurrence, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = fold([t.title, t.detail, t.clientName, t.reference].filter(Boolean).join(' '))
  return words.every((w) => haystack.includes(w))
}

export type GoalProgress = { name: string; level: number | null; resolved: number; total: number }

/** Progresso por meta: quantos passos já foram feitos ou encerrados, do nível 1 ao 5. */
export function goalProgress(tasks: TaskOccurrence[]): GoalProgress[] {
  const byName = new Map<string, GoalProgress>()
  for (const t of tasks) {
    const goal = goalOf(t)
    if (!goal) continue
    const entry = byName.get(goal.name) ?? { name: goal.name, level: goal.level, resolved: 0, total: 0 }
    entry.total += 1
    if (t.done) entry.resolved += 1
    byName.set(goal.name, entry)
  }
  return [...byName.values()].sort((a, b) => (a.level ?? 9) - (b.level ?? 9) || a.name.localeCompare(b.name, 'pt-BR'))
}

export type PeriodKey = 'week' | 'soon' | 'later'
export const PERIOD_LABEL: Record<PeriodKey, string> = {
  week: 'Próximos 7 dias',
  soon: 'Próximas semanas',
  later: 'Mais adiante',
}
/** O botão que abre uma faixa recolhida: "Mostrar 62 das próximas semanas". */
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
 */
export function periodGroups(tasks: TaskOccurrence[], today: string): Array<{ key: PeriodKey; tasks: TaskOccurrence[] }> {
  const week = addDays(today, 7)
  const month = addDays(today, 30)
  const groups: Record<PeriodKey, TaskOccurrence[]> = { week: [], soon: [], later: [] }
  for (const t of tasks) groups[t.dueOn <= week ? 'week' : t.dueOn <= month ? 'soon' : 'later'].push(t)
  return (['week', 'soon', 'later'] as const).filter((key) => groups[key].length > 0).map((key) => ({ key, tasks: groups[key] }))
}
