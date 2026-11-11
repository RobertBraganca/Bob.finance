/**
 * Reorganiza as tarefas das "Metas até 31/12" (10/11/2026) em tarefa principal
 * e subtarefas, e limpa as repetidas. Roda uma vez, depois da migração
 * 20261110120000_task_subtasks.
 *
 *   npx tsx scripts/tasks/organize-goals.ts            # só mostra o plano
 *   npx tsx scripts/tasks/organize-goals.ts --apply    # grava, numa transação
 *
 * O que faz:
 * 1. Cada prefixo de título ("Dentista: marcar a consulta") vira uma tarefa
 *    principal ("Dentista"); o passo fica com o resto do título ("Marcar a
 *    consulta"). O nome da principal vem da observação quando ela é a versão
 *    completa do prefixo ("Notas fiscais (dedução no imposto)"). A observação
 *    comum ("Metas até 31/12 · Nível 2 ...") passa para a principal.
 * 2. As 6 "revisar a agenda antes de encerrar a sexta" viram uma semanal (toda
 *    sexta, de 13/11 a 18/12): fica a de 13/11, que tem histórico; as outras
 *    cinco, sem nada gravado, saem.
 *
 * Os ids das subtarefas não mudam, então o "feito", os comentários e os
 * eventos da agenda de cada passo continuam ligados.
 */
import { eq, inArray, like, or } from 'drizzle-orm'

process.loadEnvFile(process.env.BOB_ENV_FILE ?? '.env')
const apply = process.argv.includes('--apply')
const { db } = await import('../../server/src/db/client')
const { tasks, taskCompletions, taskNotes } = await import('../../server/src/db/schema')
const { sql } = await import('drizzle-orm')

const kinds = String((await db.execute(sql`select enum_range(null::task_kind)::text as k`))[0]?.k ?? '')
const migrated = kinds.includes('group')
if (!migrated && apply) {
  console.error('A migração 20261110120000_task_subtasks ainda não foi aplicada (task_kind sem "group").')
  process.exit(1)
}

// Antes da migração não existe parent_id: a simulação lê só as colunas de sempre.
const all = migrated
  ? await db.select().from(tasks)
  : ((await db.execute(sql`select id, title, kind, notes, recurrence, due_on as "dueOn", null as "parentId" from tasks`)) as unknown as Array<typeof tasks.$inferSelect>)

// As revisões semanais da agenda: fica a mais antiga (tem histórico), as outras saem.
const REVIEW = 'Organizar a agenda de demandas da Bera: revisar a agenda antes de encerrar a sexta'
const reviews = all.filter((t) => t.title === REVIEW && t.recurrence === 'once').sort((a, b) => String(a.dueOn).localeCompare(String(b.dueOn)))
const keepReview = reviews[0] ?? null
const dropReviews = reviews.slice(1)
const dropIds = new Set(dropReviews.map((t) => t.id))
const lastReview = reviews[reviews.length - 1]?.dueOn ?? null

const goalSteps = all.filter((t) => !dropIds.has(t.id) && t.kind !== 'group' && t.parentId === null && t.notes?.startsWith('Metas ') && t.title.includes(': '))

/** "Metas até 31/12 · Nível 2 (...) · Dentista" → ["Metas até 31/12 · Nível 2 (...)", "Dentista"] */
const splitNote = (notes: string): [string, string] => {
  const cut = notes.lastIndexOf(' · ')
  return cut > 0 ? [notes.slice(0, cut), notes.slice(cut + 3)] : [notes, '']
}
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

type Plan = { title: string; notes: string; steps: Array<{ id: number; from: string; to: string }> }
const plans = new Map<string, Plan>()
for (const t of goalSteps) {
  const cut = t.title.indexOf(': ')
  const prefix = t.title.slice(0, cut)
  const [common, goalName] = splitNote(t.notes!)
  const title = goalName === prefix || goalName.startsWith(`${prefix} (`) ? goalName : prefix
  const plan: Plan = plans.get(prefix) ?? { title, notes: common, steps: [] }
  plan.steps.push({ id: t.id, from: t.title, to: capitalize(t.title.slice(cut + 2)) })
  plans.set(prefix, plan)
}

// Nada gravado nas que saem: se houver, para e avisa.
if (dropReviews.length > 0) {
  const ids = dropReviews.map((t) => t.id)
  const recorded = [
    ...(await db.select({ key: taskCompletions.taskKey }).from(taskCompletions).where(or(...ids.map((id) => like(taskCompletions.taskKey, `manual:${id}:%`))))),
    ...(await db.select({ key: taskNotes.taskKey }).from(taskNotes).where(inArray(taskNotes.taskId, ids))),
  ]
  if (recorded.length > 0) {
    console.error('As revisões repetidas têm algo gravado; nada foi feito:', recorded)
    process.exit(1)
  }
}

console.log(`${goalSteps.length} passos em ${plans.size} tarefas principais:\n`)
for (const plan of [...plans.values()].sort((a, b) => a.notes.localeCompare(b.notes) || a.title.localeCompare(b.title, 'pt-BR'))) {
  console.log(`■ ${plan.title}  (${plan.steps.length})  · ${plan.notes}`)
  for (const s of plan.steps) console.log(`    ${s.id}: ${s.to}`)
}
if (keepReview) {
  console.log(`\nRevisão semanal: tarefa ${keepReview.id} vira "toda sexta" de ${keepReview.dueOn} a ${lastReview}; saem ${dropReviews.map((t) => `${t.id} (${t.dueOn})`).join(', ')}`)
}

if (!apply) {
  console.log('\nSó o plano. Para gravar: --apply')
  process.exit(0)
}

await db.transaction(async (tx) => {
  for (const plan of plans.values()) {
    const group = (await tx.insert(tasks).values({ title: plan.title, kind: 'group', notes: plan.notes, recurrence: 'once', startsOn: '2026-11-02' }).returning())[0]!
    for (const s of plan.steps) {
      await tx.update(tasks).set({ parentId: group.id, title: s.to, notes: null, updatedAt: sql`now_iso()` }).where(eq(tasks.id, s.id))
    }
  }
  if (keepReview) {
    await tx
      .update(tasks)
      .set({ title: 'Revisar a agenda antes de encerrar a sexta', recurrence: 'weekly', dueOn: null, dueDay: 5, startsOn: keepReview.dueOn, endsOn: lastReview, updatedAt: sql`now_iso()` })
      .where(eq(tasks.id, keepReview.id))
    if (dropReviews.length > 0) await tx.delete(tasks).where(inArray(tasks.id, dropReviews.map((t) => t.id)))
  }
})
console.log('\nGravado.')
process.exit(0)
