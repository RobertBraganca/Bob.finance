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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const client = createClient(supabaseUrl, anonKey)
  const { data, error } = await client.auth.getUser(token)

  if (error || !data.user) return c.json({ error: 'sessão inválida ou expirada' }, 401)
  if (data.user.id !== ADMIN_USER_ID) return c.json({ error: 'acesso negado' }, 403)

  await next()
}
