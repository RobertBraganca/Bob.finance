import { createClient } from '@supabase/supabase-js'
import type { Context, Next } from 'hono'

/**
 * App de uma pessoa só — não é multi-tenant, é uma lista de permissão de
 * um usuário. Fixo aqui (não um secret) porque um UID não concede acesso
 * sozinho; quem concede é o par e-mail/senha verificado pelo Supabase Auth
 * antes de chegar aqui. Criado manualmente no painel do Supabase em
 * 29/08/2026 (robert.s.braganca@gmail.com).
 */
export const ADMIN_USER_ID = '23d255ea-c812-4733-aaff-fdb3ef838117'

// Criado uma vez por instância (não a cada requisição) — construção do
// client é barata, mas não há razão para refazer em toda invocação de uma
// instância já quente.
const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)

/**
 * Cache curto em memória: uma única tela (ex. o Painel) dispara várias
 * chamadas separadas para esta mesma function, todas com o MESMO token —
 * sem isto, cada uma pagava seu próprio round-trip de rede até o servidor
 * de Auth (achado ao vivo em 29/08/2026: ~0,5-1s por chamada, sete a dez
 * segundos sentidos na tela quando várias delas concorrem). TTL bem menor
 * que a validade do JWT (1h) — ainda revalida com o servidor de Auth
 * periodicamente, não é "verificar uma vez e confiar para sempre".
 */
const CACHE_TTL_MS = 10 * 60_000
const MAX_CACHE_ENTRIES = 20
const verified = new Map<string, { userId: string; expiresAt: number }>()
/**
 * A verificação em curso por token (11/11/2026): o Painel dispara ~15
 * chamadas ao mesmo tempo numa instância fria, todas erravam o cache juntas
 * e cada uma ia ao servidor de Auth. Agora a primeira vai e as outras
 * esperam a mesma resposta.
 */
const inFlight = new Map<string, Promise<string | null>>()

/** `exp` do JWT, em ms; só para não guardar no cache além da validade do token. */
function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * Até 29/08/2026 a anon key sozinha bastava para ler/escrever qualquer
 * dado financeiro desta API (achado da revisão de 28/08/2026: "sem
 * autenticação nenhuma"). Este middleware fecha isso: exige um JWT de
 * sessão de usuário real (não só a anon key) pertencente a `ADMIN_USER_ID`.
 *
 * `getUser(token)` (com o token explícito, não vazio) faz uma verificação
 * de verdade contra o servidor de Auth do Supabase — não é só decodificar o
 * JWT localmente sem checar assinatura/expiração.
 */
/** Verifica o token com o servidor de Auth (com o cache curto acima) e devolve o id do usuário, ou null. */
function verifiedUserId(token: string): Promise<string | null> {
  const now = Date.now()
  const cached = verified.get(token)
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.userId)
  const pending = inFlight.get(token)
  if (pending) return pending
  const check = verifyWithAuth(token).finally(() => inFlight.delete(token))
  inFlight.set(token, check)
  return check
}

async function verifyWithAuth(token: string): Promise<string | null> {
  // `getClaims` confere a assinatura localmente quando o projeto usa chaves
  // assimétricas (JWKS em cache) e cai no `getUser` (servidor de Auth) quando não.
  const { data, error } = await authClient.auth.getClaims(token)
  const userId = !error && typeof data?.claims?.sub === 'string' ? data.claims.sub : null
  if (!userId) return null
  if (verified.size >= MAX_CACHE_ENTRIES) {
    // App de um usuário só: nunca deveria crescer de verdade, isto é só
    // um teto de segurança contra o Map crescer sem limite.
    const oldestKey = verified.keys().next().value
    if (oldestKey !== undefined) verified.delete(oldestKey)
  }
  const now = Date.now()
  const exp = tokenExpiry(token)
  verified.set(token, { userId, expiresAt: Math.min(now + CACHE_TTL_MS, exp ?? now + CACHE_TTL_MS) })
  return userId
}

export async function requireAdmin(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  if (!token) return c.json({ error: 'não autenticado' }, 401)

  const userId = await verifiedUserId(token)
  if (!userId) return c.json({ error: 'sessão inválida ou expirada' }, 401)
  if (userId !== ADMIN_USER_ID) return c.json({ error: 'acesso negado' }, 403)

  await next()
}

export type AccessRole = 'owner' | 'accountant'

/**
 * Só para a função `accountant` (docs/specs/tarefas-comercial-contador, fase 5):
 * aceita o dono ou um contador ATIVO em `app_users` (convidado e não revogado).
 * Todas as outras funções continuam com `requireAdmin`, só o dono. O papel fica
 * em `c.get('role')` para as rotas que só o dono pode usar.
 */
export function requireAccountAccess(isActiveAccountant: (userId: string) => Promise<boolean>) {
  return async (c: Context, next: Next) => {
    const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) return c.json({ error: 'não autenticado' }, 401)
    const userId = await verifiedUserId(token)
    if (!userId) return c.json({ error: 'sessão inválida ou expirada' }, 401)
    let role: AccessRole
    if (userId === ADMIN_USER_ID) role = 'owner'
    else if (await isActiveAccountant(userId)) role = 'accountant'
    else return c.json({ error: 'acesso negado' }, 403)
    c.set('role', role)
    c.set('userId', userId)
    await next()
  }
}
