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
const CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 20
const verified = new Map<string, { userId: string; expiresAt: number }>()

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
export async function requireAdmin(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  if (!token) return c.json({ error: 'não autenticado' }, 401)

  const now = Date.now()
  const cached = verified.get(token)
  let userId: string

  if (cached && cached.expiresAt > now) {
    userId = cached.userId
  } else {
    const { data, error } = await authClient.auth.getUser(token)
    if (error || !data.user) return c.json({ error: 'sessão inválida ou expirada' }, 401)
    userId = data.user.id

    if (verified.size >= MAX_CACHE_ENTRIES) {
      // App de um usuário só: nunca deveria crescer de verdade, isto é só
      // um teto de segurança contra o Map crescer sem limite.
      const oldestKey = verified.keys().next().value
      if (oldestKey !== undefined) verified.delete(oldestKey)
    }
    verified.set(token, { userId, expiresAt: now + CACHE_TTL_MS })
  }

  if (userId !== ADMIN_USER_ID) return c.json({ error: 'acesso negado' }, 403)

  await next()
}
