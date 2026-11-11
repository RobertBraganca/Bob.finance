import type { Context, Next } from 'hono'

/**
 * Cache das leituras da insights (perf, 11/11/2026).
 *
 * As telas pedem as mesmas rotas caras a cada navegação: o radar de risco (51
 * consultas) e o checklist do fechamento abrem em toda tela por causa do
 * sino, e Saúde, Patrimônio e Motor custam de 20 a 57 consultas cada. Num app
 * de uso esporádico a instância da Edge Function quase sempre está fria, então
 * um cache em memória não pegaria nada: a resposta pronta fica no banco
 * (`api_cache`) e uma leitura repetida custa UMA consulta.
 *
 * Quando vale: a chave é a rota com a query ordenada; a resposta guardada vale
 * enquanto a versão dos dados (`data_version`, que um trigger sobe a cada
 * escrita em qualquer tabela, por qualquer função) e o dia (as contas usam
 * "hoje") forem os mesmos de quando foi calculada. Grava-se a versão lida
 * ANTES de calcular: se uma escrita entra no meio, a leitura seguinte já vê a
 * versão nova e recalcula.
 *
 * Só para rotas cuja resposta depende só do banco e da data. Cotações,
 * benchmarks e Google entram pelo banco em rotas de escrita, então servem.
 * Rota que lê algo de fora numa leitura vai em `skip`.
 *
 * Deploy que muda o formato de uma resposta: `npm run deploy:fn` sobe a versão
 * depois de publicar. `CACHE_EPOCH` é a saída manual (mudou, nada guardado vale).
 */
export const CACHE_EPOCH = '1'

export type CacheStore = {
  /** A versão atual dos dados e o corpo guardado para a chave nessa versão e dia (ou null). */
  read(key: string, day: string): Promise<{ version: number; body: string | null }>
  /** Guarda o corpo; uma versão mais velha nunca sobrescreve uma mais nova. */
  write(key: string, version: number, day: string, body: string): Promise<void>
}

export type ResponseCacheOptions = {
  store: CacheStore
  today: () => string
  /** rotas que não passam pelo cache (leem algo fora do banco) */
  skip?: (path: string) => boolean
  /** agenda a gravação sem segurar a resposta (EdgeRuntime.waitUntil); sem isso, espera */
  defer?: (work: Promise<unknown>) => void
}

/** Chave estável: caminho + query ordenada, para `?a=1&b=2` e `?b=2&a=1` darem a mesma. */
export function cacheKey(url: string): string {
  const parsed = new URL(url)
  const params = [...parsed.searchParams.entries()].sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
  const query = new URLSearchParams(params).toString()
  return `${CACHE_EPOCH}:${parsed.pathname}${query ? `?${query}` : ''}`
}

export function responseCache(options: ResponseCacheOptions) {
  return async (c: Context, next: Next) => {
    if (c.req.method !== 'GET' || options.skip?.(c.req.path)) return next()
    const key = cacheKey(c.req.url)
    const day = options.today()

    let state: { version: number; body: string | null }
    try {
      state = await options.store.read(key, day)
    } catch (error) {
      // Cache fora do ar não pode derrubar a tela: calcula como antes.
      console.error('responseCache read', error)
      return next()
    }
    if (state.body !== null) {
      c.header('x-cache', 'hit')
      return c.body(state.body, 200, { 'content-type': 'application/json; charset=UTF-8' })
    }

    await next()
    if (c.res.status !== 200 || !(c.res.headers.get('content-type') ?? '').includes('application/json')) return
    const body = await c.res.clone().text()
    const write = options.store.write(key, state.version, day, body).catch((error) => console.error('responseCache write', error))
    if (options.defer) options.defer(write)
    else await write
    c.header('x-cache', 'miss')
  }
}
