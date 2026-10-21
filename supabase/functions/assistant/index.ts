import '@supabase/functions-js/edge-runtime.d.ts'
import { runInRequestScope } from '../_shared/core/requestCache.ts'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ZodError } from 'zod'
import { requireAdmin } from '../_shared/auth.ts'
import { assistantApplyRequest, assistantMessageRequest, assistantUndoRequest } from '../_shared/core/assistantTypes.ts'
import { applyProposal, undoApplied } from '../_shared/services/assistant/apply.ts'
import { assistantHttpError, describeUnexpected, handleMessage, optionsFromEnv } from '../_shared/services/assistant/service.ts'

/**
 * Assistente em linguagem natural (docs/specs/assistente/spec.md). Porta de
 * server/src/routes/assistant.ts (Fastify) para Hono. O modelo só lê e propõe;
 * `apply` grava o que o servidor guardou, depois do Confirmar.
 *
 * Segredos da função: `ASSISTANT_API_KEY` (chave da Anthropic `sk-ant-…` ou do Gemini), e,
 * se quiser, `ASSISTANT_PROVIDER` e `ASSISTANT_MODEL_CHEAP`/`ASSISTANT_MODEL_STRONG`.
 * Sem a chave a rota responde `unavailable` e nada é gravado.
 */
const app = new Hono().basePath('/assistant')

app.use('*', cors({ origin: '*' }))
app.use('*', (_c, next) => runInRequestScope(next))
app.use('*', requireAdmin)

app.onError((error, c) => {
  if (error instanceof ZodError) return c.json({ error: 'dados inválidos', issues: error.issues }, 400)
  const mapped = assistantHttpError(error)
  if (mapped) return c.json(mapped.body, mapped.status as 400)
  console.error(error)
  // Diz o que quebrou (nome e mensagem, sem segredo); o log tem o erro inteiro.
  return c.json({ error: 'erro interno', detail: describeUnexpected(error, Deno.env.get('ASSISTANT_API_KEY')) }, 500)
})

app.post('/message', async (c) =>
  c.json(await handleMessage(assistantMessageRequest.parse(await c.req.json()), optionsFromEnv((name) => Deno.env.get(name)))),
)

app.post('/apply', async (c) => {
  const body = assistantApplyRequest.parse(await c.req.json())
  return c.json(await applyProposal(body.proposalId, body.confirmedActionIds, body.edits))
})

app.post('/undo', async (c) => c.json(await undoApplied(assistantUndoRequest.parse(await c.req.json()).undoToken)))

Deno.serve(app.fetch)
