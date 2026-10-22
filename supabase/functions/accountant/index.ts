import '@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z, ZodError } from 'zod'
import { runInRequestScope } from '../_shared/core/requestCache.ts'
import { friendlyErrorMessage } from '../_shared/core/errors.ts'
import { requireAccountAccess, type AccessRole } from '../_shared/auth.ts'
import * as access from '../_shared/services/accountantAccess.ts'
import { accountantMonth } from '../_shared/services/accountantView.ts'

/**
 * Área do contador (docs/specs/tarefas-comercial-contador, fases 4 e 5).
 *
 * Negar por padrão: esta é a ÚNICA função que aceita alguém além do dono, e ela
 * só tem leituras da parte PJ (o mês da empresa, o extrato PJ, as notas
 * emitidas e os pacotes do mês). Nenhuma rota grava dado financeiro. As rotas de
 * convidar e revogar o contador são só do dono. Todas as outras funções seguem
 * com `requireAdmin`, só o dono.
 */

type Vars = { Variables: { role: AccessRole; userId: string } }
const app = new Hono<Vars>().basePath('/accountant')
const BUCKET = 'accountant-packages'

// Chave de serviço só aqui dentro: convite e remoção de conta, e links assinados dos pacotes.
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

app.use('*', cors({ origin: '*' }))
app.use('*', (_c, next) => runInRequestScope(next))
app.use('*', requireAccountAccess((userId) => access.isActiveAccountant(userId)))

app.onError((error, c) => {
  if (error instanceof ZodError) return c.json({ error: 'dados inválidos', issues: error.issues }, 400)
  if (error instanceof access.AccessError) return c.json({ error: error.message }, 422)
  console.error(error)
  return c.json({ error: friendlyErrorMessage(error) }, 500)
})

const period = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) })
const ownerOnly = (c: { get: (k: 'role') => AccessRole }) => c.get('role') === 'owner'

app.get('/me', async (c) => {
  const role = c.get('role')
  return c.json({ role, email: role === 'accountant' ? await access.accountantEmail(c.get('userId')) : null })
})

app.get('/month', async (c) => c.json(await accountantMonth(period.parse(c.req.query()).period)))

/** Os pacotes gerados pelo dono, mais recentes primeiro, com link assinado de 1 hora. */
app.get('/packages', async (c) => {
  const out: Array<{ period: string; createdAt: string; files: Array<{ name: string; url: string | null }> }> = []
  const { data: periods } = await admin.storage.from(BUCKET).list('pacotes', { limit: 100, sortBy: { column: 'name', order: 'desc' } })
  for (const p of (periods ?? []).slice(0, 12)) {
    const { data: stamps } = await admin.storage.from(BUCKET).list(`pacotes/${p.name}`, { limit: 20, sortBy: { column: 'name', order: 'desc' } })
    for (const s of stamps ?? []) {
      const { data: files } = await admin.storage.from(BUCKET).list(`pacotes/${p.name}/${s.name}`, { limit: 10 })
      const signed: Array<{ name: string; url: string | null }> = []
      for (const f of files ?? []) {
        const { data } = await admin.storage.from(BUCKET).createSignedUrl(`pacotes/${p.name}/${s.name}/${f.name}`, 3600)
        signed.push({ name: f.name, url: data?.signedUrl ?? null })
      }
      if (signed.length) out.push({ period: p.name, createdAt: s.name, files: signed })
    }
  }
  return c.json({ packages: out })
})

/* ---- só o dono: quem tem acesso ---- */
app.get('/users', async (c) => {
  if (!ownerOnly(c)) return c.json({ error: 'acesso negado' }, 403)
  return c.json({ users: await access.listAccessUsers() })
})

app.post('/users', async (c) => {
  if (!ownerOnly(c)) return c.json({ error: 'acesso negado' }, 403)
  const { email } = z.object({ email: z.string().trim().max(200) }).parse(await c.req.json())
  access.assertEmail(email)
  const redirectTo = Deno.env.get('APP_URL') ?? c.req.header('origin') ?? undefined
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email.trim().toLowerCase(), { redirectTo })
  if (error || !data.user) return c.json({ error: `o convite não foi enviado: ${error?.message ?? 'sem resposta do Supabase'}` }, 422)
  return c.json(await access.recordAccountant(data.user.id, email))
})

app.delete('/users/:userId', async (c) => {
  if (!ownerOnly(c)) return c.json({ error: 'acesso negado' }, 403)
  const { userId } = z.object({ userId: z.string().uuid() }).parse(c.req.param())
  const row = await access.revokeAccountant(userId)
  if (!row) return c.json({ error: 'acesso não encontrado' }, 404)
  // Sem conta, sem login: a revogação no banco já bloqueia, e a remoção fecha a porta de vez.
  await admin.auth.admin.deleteUser(userId)
  return c.json(row)
})

Deno.serve(app.fetch)
