import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { sql } from 'drizzle-orm'

/**
 * Google Agenda (docs/specs/tarefas-comercial-contador, fase 3), sem falar com o
 * Google: o `fetch` é trocado por um falso que registra as chamadas. Banco numa
 * transação que sempre desfaz.
 */

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
      schema: await import('../../server/src/db/schema'),
      tasks: await import('../../server/src/services/tasks'),
      google: await import('../../server/src/services/googleCalendar'),
      dates: await import('../../server/src/core/dates'),
    }
  : null

const MIGRATION = ['../../supabase/migrations/20261022120000_tasks.sql', '../../supabase/migrations/20261022130000_google_calendar.sql']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')
class Rollback extends Error {}
type Tx = import('../../server/src/db/client').DbExecutor
const config = { clientId: 'cid', clientSecret: 'segredo', redirectUri: 'https://exemplo.test/tarefas/google' }

type Call = { method: string; url: string; body?: string }
function fakeGoogle() {
  const calls: Call[] = []
  let nextId = 1
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : undefined })
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'acesso' }), { status: 200 })
    if (method === 'POST') return new Response(JSON.stringify({ id: `evt${nextId++}` }), { status: 200 })
    if (method === 'PATCH') return new Response('{}', { status: 200 })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

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

test('endereço de consentimento: acesso offline, só eventos da agenda, com o state', async () => {
  const { authUrl } = await import('../../server/src/services/googleCalendar')
  const url = new URL(authUrl(config, 'estado-123'))
  assert.equal(url.hostname, 'accounts.google.com')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('state'), 'estado-123')
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri)
  assert.match(url.searchParams.get('scope') ?? '', /calendar\.events/)
  assert.doesNotMatch(url.searchParams.get('scope') ?? '', /calendar(\s|$)/, 'nunca a agenda inteira')
})

describe('sincronismo com a agenda (fetch falso, rollback)', { skip }, () => {
  test('cria um evento por tarefa aberta, não repete, apaga a que foi feita', async () => {
    await inRollback(async (tx) => {
      const { googleCalendarConnection, googleCalendarEvents } = loaded!.schema
      const svc = loaded!.tasks
      const google = loaded!.google
      const today = loaded!.dates.todayIso()
      await tx.insert(googleCalendarConnection).values({ id: 1, email: 'dono@exemplo.test', refreshToken: 'token-de-atualizacao' })
      const task = await svc.createTask({ title: '[teste] Emitir nota', recurrence: 'once', dueOn: loaded!.dates.addDays(today, 3) }, tx)

      const fake = fakeGoogle()
      try {
        const first = await google.sync(config, {}, tx)
        const open = (await svc.listTasks({ from: loaded!.dates.addDays(today, -7), to: loaded!.dates.addDays(today, 30) }, tx)).tasks.filter(
          (t) => !t.done && t.dueOn >= loaded!.dates.addDays(today, -7),
        )
        assert.equal(first.created, open.length)
        assert.equal((await tx.select().from(googleCalendarEvents)).length, open.length)
        const mine = fake.calls.find((c) => c.method === 'POST' && c.body?.includes('[teste] Emitir nota'))!
        const event = JSON.parse(mine.body!)
        assert.equal(event.start.timeZone, 'America/Sao_Paulo')
        assert.match(event.start.dateTime, /T09:00:00$/)
        assert.equal(event.reminders.useDefault, false)
        for (const call of fake.calls) assert.ok(!call.url.includes('token-de-atualizacao') || call.url.includes('oauth2'), 'o token só vai ao endpoint de token')

        fake.calls.length = 0
        const second = await google.sync(config, {}, tx)
        assert.deepEqual([second.created, second.updated, second.removed], [0, 0, 0], 'nada mudou, nada enviado')
        assert.equal(fake.calls.filter((c) => c.method !== 'POST' || !c.url.includes('oauth2')).length, 0)

        const key = `manual:${task.id}:${loaded!.dates.addDays(today, 3)}`
        await svc.completeTask(key, {}, tx)
        fake.calls.length = 0
        const third = await google.sync(config, { onlyKeys: [key] }, tx)
        assert.equal(third.removed, 1)
        assert.equal(fake.calls.filter((c) => c.method === 'DELETE').length, 1)
        const status = await google.status(config, tx)
        assert.equal(status.connected, true)
        assert.equal(status.lastError, null)
      } finally {
        fake.restore()
      }
    })
  })

  test('falha do Google fica registrada e não apaga a conexão', async () => {
    await inRollback(async (tx) => {
      const { googleCalendarConnection } = loaded!.schema
      await tx.insert(googleCalendarConnection).values({ id: 1, refreshToken: 'x' })
      const original = globalThis.fetch
      globalThis.fetch = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as typeof fetch
      try {
        await assert.rejects(() => loaded!.google.sync(config, {}, tx), /reconecte/)
      } finally {
        globalThis.fetch = original
      }
      const status = await loaded!.google.status(config, tx)
      assert.equal(status.connected, true)
      assert.match(status.lastError ?? '', /reconecte/)
    })
  })
})

after(async () => {
  if (loaded) await (loaded.client.db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
})
