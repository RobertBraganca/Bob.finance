import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { sql } from 'drizzle-orm'
import { bucketOf, clampedDate, occurrenceDates, type TaskTemplate } from '../../server/src/core/tasks'

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

const MIGRATION = readFileSync(new URL('../../supabase/migrations/20261022120000_tasks.sql', import.meta.url), 'utf8')
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
