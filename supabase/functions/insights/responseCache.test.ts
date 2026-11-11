import { Hono } from 'hono'
import { cacheKey, responseCache, type CacheStore } from '../_shared/core/responseCache.ts'

/** Cache das leituras (core/responseCache.ts): `npx.cmd deno test` nesta pasta. */
function assertEquals(actual: unknown, expected: unknown, message = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message} esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`)
}

function memoryStore() {
  const rows = new Map<string, { version: number; day: string; body: string }>()
  const state = { version: 1, rows, writes: 0 }
  const store: CacheStore = {
    read: async (key, day) => {
      const row = rows.get(key)
      return { version: state.version, body: row && row.version === state.version && row.day === day ? row.body : null }
    },
    write: async (key, version, day, body) => {
      state.writes++
      const row = rows.get(key)
      if (row && row.day === day && row.version > version) return
      rows.set(key, { version, day, body })
    },
  }
  return { store, state }
}

function appWith(store: CacheStore, day: { value: string }) {
  let computed = 0
  const app = new Hono()
  app.use('*', responseCache({ store, today: () => day.value, skip: (path) => path.startsWith('/google') }))
  app.get('/score', (c) => c.json({ n: ++computed, q: c.req.query('period') ?? null }))
  app.get('/google/status', (c) => c.json({ n: ++computed }))
  app.get('/boom', (c) => c.json({ error: 'x' }, 500))
  app.post('/score', (c) => c.json({ ok: true }))
  return { app, computed: () => computed }
}

Deno.test('a mesma leitura sai do cache até a versão ou o dia mudarem', async () => {
  const { store, state } = memoryStore()
  const day = { value: '2026-11-11' }
  const { app, computed } = appWith(store, day)

  const first = await app.request('/score?period=2026-11')
  assertEquals(first.headers.get('x-cache'), 'miss')
  assertEquals(await first.json(), { n: 1, q: '2026-11' })

  const second = await app.request('/score?period=2026-11')
  assertEquals(second.headers.get('x-cache'), 'hit')
  assertEquals(await second.json(), { n: 1, q: '2026-11' }, 'hit devolve o corpo guardado')
  assertEquals(computed(), 1)

  state.version = 2 // uma escrita em qualquer tabela
  assertEquals(await (await app.request('/score?period=2026-11')).json(), { n: 2, q: '2026-11' }, 'versão nova recalcula')

  day.value = '2026-11-12'
  assertEquals(await (await app.request('/score?period=2026-11')).json(), { n: 3, q: '2026-11' }, 'dia novo recalcula')
  assertEquals((await app.request('/score?period=2026-11')).headers.get('x-cache'), 'hit')
})

Deno.test('query diferente é outra chave; a ordem dos parâmetros não importa', () => {
  assertEquals(cacheKey('http://x/insights/a?b=2&a=1'), cacheKey('http://x/insights/a?a=1&b=2'))
  if (cacheKey('http://x/insights/a?a=1') === cacheKey('http://x/insights/a?a=2')) throw new Error('chaves iguais')
})

Deno.test('erro, escrita e rota pulada não passam pelo cache', async () => {
  const { store, state } = memoryStore()
  const { app, computed } = appWith(store, { value: '2026-11-11' })
  assertEquals((await app.request('/boom')).status, 500)
  await app.request('/score', { method: 'POST' })
  await app.request('/google/status')
  await app.request('/google/status')
  assertEquals(state.writes, 0, 'nada gravado')
  assertEquals(computed(), 2, 'google calculou as duas vezes')
})

Deno.test('cache fora do ar: a rota responde calculando', async () => {
  const broken: CacheStore = {
    read: () => Promise.reject(new Error('sem tabela')),
    write: () => Promise.reject(new Error('sem tabela')),
  }
  const { app } = appWith(broken, { value: '2026-11-11' })
  const res = await app.request('/score')
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { n: 1, q: null })
})

Deno.test('a versão lida antes de calcular é a gravada', async () => {
  const { store, state } = memoryStore()
  const day = { value: '2026-11-11' }
  const app = new Hono()
  app.use('*', responseCache({ store, today: () => day.value }))
  app.get('/slow', (c) => {
    state.version = 5 // uma escrita entrou enquanto calculava
    return c.json({ ok: true })
  })
  await app.request('/slow')
  assertEquals(state.rows.values().next().value?.version, 1)
  assertEquals((await app.request('/slow')).headers.get('x-cache'), 'miss', 'a leitura seguinte recalcula')
})
