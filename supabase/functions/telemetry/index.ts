import '@supabase/functions-js/edge-runtime.d.ts'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z, ZodError } from 'zod'
import { db, schema } from '../_shared/db/client.ts'

/**
 * Log de uso por feature — tela aberta, ação-chave feita, erro exibido
 * ao usuário. Nunca conteúdo financeiro, nunca clique a clique — base
 * para melhoria contínua de UX/UI (pedido explícito do usuário,
 * 28/08/2026). `detail` é livre mas cada evento já traz o essencial: a
 * própria intenção de instrumentar cada tela cuidou de nunca colocar
 * descrição/valor de lançamento ali, só o nome da ação e IDs.
 *
 * Fire-and-forget do lado do frontend (src/lib/telemetry.ts): uma falha
 * aqui nunca deve aparecer pro usuário nem bloquear a ação real.
 */

const eventSchema = z.object({
  sessionId: z.string().min(1).max(100),
  feature: z.string().min(1).max(60),
  kind: z.enum(['view', 'action', 'error']),
  name: z.string().min(1).max(120),
  detail: z.record(z.string(), z.unknown()).nullable().optional(),
  occurredAt: z.string().optional(),
})

const app = new Hono().basePath('/telemetry')
app.use('*', cors({ origin: '*' }))

app.onError((error, c) => {
  if (error instanceof ZodError) return c.json({ error: 'dados inválidos', issues: error.issues }, 400)
  console.error(error)
  return c.json({ error: 'erro interno' }, 500)
})

app.post('/events', async (c) => {
  const body = eventSchema.parse(await c.req.json())
  await db.insert(schema.usageEvents).values({
    sessionId: body.sessionId,
    feature: body.feature,
    kind: body.kind,
    name: body.name,
    detail: body.detail ?? null,
    ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}),
  })
  return c.json({ ok: true }, 201)
})

Deno.serve(app.fetch)
