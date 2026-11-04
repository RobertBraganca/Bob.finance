import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { sql } from 'drizzle-orm'
import { bucketOf, clampedDate, occurrenceDates, stageOf, type TaskTemplate } from '../../server/src/core/tasks'

/**
 * Tarefas financeiras (docs/specs/tarefas-comercial-contador, fase 1). A parte
 * pura roda sempre; a de banco roda numa transação que sempre desfaz, e só lê
 * as fontes reais (pendências, cartões, DAS, fechamento), nunca grava nelas.
 */

const template = (patch: Partial<TaskTemplate>): TaskTemplate => ({
  recurrence: 'once',
  dueOn: null,
  dueDay: null,
  dueMonth: null,
  startsOn: null,
  endsOn: null,
  ...patch,
})

test('dia do vencimento preso ao fim do mês', () => {
  assert.equal(clampedDate(2026, 2, 31), '2026-02-28')
  assert.equal(clampedDate(2028, 2, 31), '2028-02-29')
  assert.equal(clampedDate(2026, 11, 5), '2026-11-05')
})

test('ocorrências: uma vez, todo mês e todo ano, dentro da janela e respeitando início e fim', () => {
  assert.deepEqual(occurrenceDates(template({ dueOn: '2026-11-10' }), '2026-10-01', '2026-11-30'), ['2026-11-10'])
  assert.deepEqual(occurrenceDates(template({ dueOn: '2026-12-10' }), '2026-10-01', '2026-11-30'), [])
  assert.deepEqual(
    occurrenceDates(template({ recurrence: 'monthly', dueDay: 31 }), '2026-01-15', '2026-04-15'),
    ['2026-01-31', '2026-02-28', '2026-03-31'],
  )
  assert.deepEqual(
    occurrenceDates(template({ recurrence: 'monthly', dueDay: 5, startsOn: '2026-10-20' }), '2026-09-01', '2026-12-31'),
    ['2026-11-05', '2026-12-05'],
    'antes do início não conta',
  )
  assert.deepEqual(
    occurrenceDates(template({ recurrence: 'monthly', dueDay: 5, endsOn: '2026-11-30' }), '2026-10-01', '2026-12-31'),
    ['2026-10-05', '2026-11-05'],
  )
  assert.deepEqual(
    occurrenceDates(template({ recurrence: 'yearly', dueDay: 31, dueMonth: 5 }), '2026-01-01', '2027-12-31'),
    ['2026-05-31', '2027-05-31'],
  )
  assert.deepEqual(occurrenceDates(template({ recurrence: 'monthly' }), '2026-01-01', '2026-12-31'), [], 'sem dia, nada')
})

test('grupos da tela: feita, atrasada, hoje, semana e depois', () => {
  const today = '2026-10-22'
  const weekEnd = '2026-10-29'
  assert.equal(bucketOf('2026-10-01', true, today, weekEnd), 'done')
  assert.equal(bucketOf('2026-10-21', false, today, weekEnd), 'overdue')
  assert.equal(bucketOf('2026-10-22', false, today, weekEnd), 'today')
  assert.equal(bucketOf('2026-10-29', false, today, weekEnd), 'week')
  assert.equal(bucketOf('2026-10-30', false, today, weekEnd), 'later')
})

test('colunas do Kanban: a fazer e atrasada saem da data; o resto, do que foi gravado', () => {
  const today = '2026-11-03'
  assert.equal(stageOf('2026-11-02', null, false, today), 'overdue')
  assert.equal(stageOf('2026-11-03', null, false, today), 'todo')
  assert.equal(stageOf('2026-11-02', 'doing', false, today), 'doing', 'em andamento não vira atrasada')
  assert.equal(stageOf('2026-11-10', 'paused', false, today), 'paused')
  assert.equal(stageOf('2026-11-10', 'done', true, today), 'done')
  assert.equal(stageOf('2026-11-10', 'skipped', true, today), 'closed')
  assert.equal(stageOf('2026-10-20', null, true, today), 'done', 'a fonte fechou sozinha (DAS pago)')
})

/* ------------------------------------------------------------------ *
 * Banco (em transação que sempre desfaz)
 * ------------------------------------------------------------------ */
try {
  process.loadEnvFile(process.env.BOB_ENV_FILE)
} catch {
  // sem .env: a parte de banco é pulada
}
const hasDb = Boolean(process.env.SUPABASE_DB_HOST && process.env.SUPABASE_DB_PASSWORD)
const skip = hasDb ? false : 'sem credenciais do banco (.env ou BOB_ENV_FILE)'
const loaded = hasDb
  ? {
      client: await import('../../server/src/db/client'),
      tasks: await import('../../server/src/services/tasks'),
      dates: await import('../../server/src/core/dates'),
    }
  : null

const MIGRATION = ['20261022120000_tasks.sql', '20261103120000_task_stages.sql', '20261103130000_task_notes.sql']
  .map((name) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  .join(';\n')
const TAG = '[teste]'
class Rollback extends Error {}
type Tx = import('../../server/src/db/client').DbExecutor

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  const { db } = loaded!.client
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`)
      await tx.execute(sql.raw(MIGRATION))
      await fn(tx)
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
}

const rejectsTask = (run: () => Promise<unknown>, pattern: RegExp) =>
  assert.rejects(run, (error: unknown) => error instanceof loaded!.tasks.TaskError && pattern.test((error as Error).message))

describe('tarefas no banco (rollback)', { skip }, () => {
  test('manual recorrente aparece na janela, conclui com o número da nota e reabre', async () => {
    await inRollback(async (tx) => {
      const svc = loaded!.tasks
      const { todayIso, addDays } = loaded!.dates
      const today = todayIso()
      const task = await svc.createTask({ title: `${TAG} Pagar contador`, recurrence: 'monthly', dueDay: Number(today.slice(8, 10)), amountCents: 30_000 }, tx)
      const window = { from: addDays(today, -1), to: addDays(today, 1) }

      const first = await svc.listTasks(window, tx)
      const mine = first.tasks.filter((t) => t.taskId === task.id)
      assert.equal(mine.length, 1)
      assert.equal(mine[0]!.dueOn, today)
      assert.equal(mine[0]!.bucket, 'today')
      assert.equal(mine[0]!.amountCents, 30_000)

      await svc.completeTask(mine[0]!.key, { reference: 'NF 123' }, tx)
      const done = (await svc.listTasks(window, tx)).tasks.find((t) => t.key === mine[0]!.key)!
      assert.equal(done.done, true)
      assert.equal(done.bucket, 'done')
      assert.equal(done.reference, 'NF 123')

      await svc.reopenTask(mine[0]!.key, tx)
      assert.equal((await svc.listTasks(window, tx)).tasks.find((t) => t.key === mine[0]!.key)!.done, false)

      await svc.deleteTask(task.id, tx)
      assert.equal((await svc.listTasks(window, tx)).tasks.some((t) => t.taskId === task.id), false)
    })
  })

  test('regras: NF sem cliente, data faltando e chave que se resolve sozinha são recusadas', async () => {
    await inRollback(async (tx) => {
      const svc = loaded!.tasks
      await rejectsTask(() => svc.createTask({ title: `${TAG} NF`, kind: 'nf', recurrence: 'monthly', dueDay: 5 }, tx), /cliente/)
      await rejectsTask(() => svc.createTask({ title: `${TAG} Sem data` }, tx), /data/)
      await rejectsTask(() => svc.createTask({ title: `${TAG} Anual`, recurrence: 'yearly', dueDay: 31 }, tx), /mês/)
      await rejectsTask(() => svc.completeTask('pending:123', {}, tx), /resolve na própria tela/)
      await rejectsTask(() => svc.completeTask('closing:2026-09:categorization', {}, tx), /resolve na própria tela|sozinho/)
    })
  })

  test('etapas: fazendo e pausada ficam abertas; feita e encerrada resolvem; a fazer apaga o estado', async () => {
    await inRollback(async (tx) => {
      const svc = loaded!.tasks
      const { todayIso, addDays } = loaded!.dates
      const today = todayIso()
      const task = await svc.createTask({ title: `${TAG} Kanban`, recurrence: 'once', dueOn: addDays(today, 2) }, tx)
      const window = { from: addDays(today, -1), to: addDays(today, 5) }
      const key = `manual:${task.id}:${addDays(today, 2)}`
      const find = async () => (await svc.listTasks(window, tx)).tasks.find((t) => t.key === key)!

      assert.equal((await find()).stage, 'todo')
      await svc.setTaskStage(key, 'doing', {}, tx)
      let t = await find()
      assert.deepEqual([t.stage, t.status, t.done], ['doing', 'doing', false])
      await svc.setTaskStage(key, 'paused', {}, tx)
      t = await find()
      assert.deepEqual([t.stage, t.done], ['paused', false])
      await svc.setTaskStage(key, 'closed', {}, tx)
      t = await find()
      assert.deepEqual([t.stage, t.status, t.done, t.bucket], ['closed', 'skipped', true, 'done'])
      await svc.setTaskStage(key, 'done', { reference: 'NF 9' }, tx)
      t = await find()
      assert.deepEqual([t.stage, t.reference], ['done', 'NF 9'])
      await svc.setTaskStage(key, 'todo', {}, tx)
      t = await find()
      assert.deepEqual([t.stage, t.status, t.done], ['todo', null, false])

      const listed = await svc.listTasks(window, tx)
      const counted = Object.values(listed.stages).reduce((a, b) => a + b, 0)
      assert.equal(counted, listed.tasks.length, 'toda ocorrência cai em uma coluna')

      await rejectsTask(() => svc.setTaskStage('pending:123', 'doing', {}, tx), /resolve na própria tela/)
      await rejectsTask(() => svc.setTaskStage('closing:2026-09:dre-review', 'paused', {}, tx), /feita ou reaberta/)
    })
  })

  test('detalhe: comentário, histórico de etapas com motivo e as ocorrências anteriores da recorrente', async () => {
    await inRollback(async (tx) => {
      const svc = loaded!.tasks
      const { todayIso, addDays } = loaded!.dates
      const today = todayIso()
      const task = await svc.createTask({ title: `${TAG} Detalhe`, recurrence: 'monthly', dueDay: 10, startsOn: addDays(today, -70) }, tx)
      const window = { from: addDays(today, -65), to: addDays(today, 40) }
      const keys = (await svc.listTasks(window, tx)).tasks.filter((t) => t.taskId === task.id).map((t) => t.key)
      assert.ok(keys.length >= 2, 'a recorrente tem mais de uma ocorrência na janela')
      const [older, key] = [keys[0]!, keys[keys.length - 1]!]

      await svc.addTaskNote(key, '  ligar para o cliente  ', tx)
      await svc.setTaskStage(key, 'doing', {}, tx)
      await svc.setTaskStage(key, 'paused', { note: 'aguardando retorno' }, tx)
      await svc.setTaskStage(key, 'paused', {}, tx)
      let detail = await svc.taskDetail(key, tx)
      const kinds = detail.notes.map((n) => [n.kind, n.fromStage, n.toStage, n.body])
      assert.deepEqual(
        [...kinds].sort(),
        [
          ['comment', null, null, 'ligar para o cliente'],
          ['stage', 'doing', 'paused', 'aguardando retorno'],
          ['stage', 'todo', 'doing', null],
        ].sort(),
        'mover para onde já estava, sem motivo, não entra no histórico',
      )
      const listed = (await svc.listTasks(window, tx)).tasks.find((t) => t.key === key)!
      assert.equal(listed.noteCount, 1, 'só comentário conta no cartão')

      await svc.setTaskStage(older, 'done', { reference: 'NF 7' }, tx)
      await svc.addTaskNote(older, 'enviada por e-mail', tx)
      detail = await svc.taskDetail(key, tx)
      assert.equal(detail.history.length, 1)
      assert.deepEqual([detail.history[0]!.key, detail.history[0]!.stage, detail.history[0]!.reference], [older, 'done', 'NF 7'])
      assert.ok(detail.history[0]!.notes.some((n) => n.body === 'enviada por e-mail'))

      await svc.setTaskStage(key, 'todo', {}, tx)
      detail = await svc.taskDetail(key, tx)
      assert.ok(detail.notes.some((n) => n.kind === 'stage' && n.fromStage === 'paused' && n.toStage === 'todo'), 'voltar para a fazer também fica')

      const stageNote = detail.notes.find((n) => n.kind === 'stage')!
      assert.equal((await svc.deleteTaskNote(stageNote.id, tx)).removed, 0, 'o histórico de etapas não se apaga')
      const comment = detail.notes.find((n) => n.kind === 'comment')!
      assert.equal((await svc.deleteTaskNote(comment.id, tx)).removed, 1)

      await svc.addTaskNote('pending:123', 'cobrado por WhatsApp', tx)
      assert.equal((await svc.taskDetail('pending:123', tx)).notes.length, 1, 'as automáticas também aceitam comentário')
      await rejectsTask(() => svc.addTaskNote(key, '   ', tx), /escreva/)
      await rejectsTask(() => svc.taskDetail('qualquer:coisa', tx), /não encontrada/)

      await svc.deleteTask(task.id, tx)
      assert.equal((await svc.taskDetail(key, tx)).notes.length, 0, 'excluir a tarefa leva os comentários junto')
    })
  })

  test('as fontes automáticas entram com chave, data e se podem ser concluídas aqui', async () => {
    await inRollback(async (tx) => {
      const result = await loaded!.tasks.listTasks(loaded!.tasks.defaultWindow(), tx)
      for (const t of result.tasks) {
        assert.match(t.dueOn, /^\d{4}-\d{2}-\d{2}$/)
        assert.ok(t.title.length > 0)
        if (t.source.startsWith('pending') || t.source === 'partner') assert.equal(t.completable, false, `${t.key} se resolve na tela dona`)
      }
      const counted = result.summary.overdue + result.summary.today + result.summary.week + result.summary.later + result.summary.done
      assert.equal(counted, result.tasks.length)
    })
  })
})

after(async () => {
  if (loaded) await (loaded.client.db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
})
