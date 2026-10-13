import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Cache que vive só dentro de UMA requisição (revisão de banco de 10/10/2026).
 *
 * Saúde, Patrimônio, Diário e Endividamento leem as mesmas funções caras
 * (`debtOverviewV2`, `positions`, `accountBalances`, `reserveStatus`,
 * `companyOverview`), e uma rota chegava a pagar 70 consultas por refazer o
 * mesmo número. Aqui a primeira chamada guarda a PROMESSA e as seguintes, na
 * mesma requisição, esperam por ela (inclusive as simultâneas).
 *
 * Fora de uma requisição (scripts, testes) não há escopo e a função roda
 * direto, sem guardar nada. Nunca vale entre requisições: depois de uma
 * gravação, a requisição seguinte lê o banco de novo. Não memoize nada que a
 * MESMA requisição grave e releia depois.
 */
const scope = new AsyncLocalStorage<Map<string, Promise<unknown>>>()

/** Roda `fn` num escopo novo de requisição. */
export function runInRequestScope<T>(fn: () => T): T {
  return scope.run(new Map(), fn)
}

/** Descarta o que a requisição guardou: chame depois de gravar algo que ela vai reler. */
export function clearRequestCache(): void {
  scope.getStore()?.clear()
}

/** Lê `key` do escopo da requisição; calcula e guarda a promessa na primeira vez. */
export function memoPerRequest<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const store = scope.getStore()
  if (!store) return compute()
  const hit = store.get(key)
  if (hit) return hit as Promise<T>
  const promise = compute().catch((error: unknown) => {
    // Falha não fica guardada: a próxima chamada tenta de novo. Só apaga a própria
    // entrada: um clearRequestCache() pode ter aberto espaço para uma entrada nova.
    if (store.get(key) === promise) store.delete(key)
    throw error
  })
  store.set(key, promise)
  return promise
}
