import type { FastifyInstance, FastifyReply } from 'fastify'
import { assistantApplyRequest, assistantMessageRequest, assistantUndoRequest } from '../core/assistantTypes'
import { applyProposal, undoApplied } from '../services/assistant/apply'
import { assistantHttpError, describeUnexpected, handleMessage, optionsFromEnv } from '../services/assistant/service'

/**
 * Assistente em linguagem natural (docs/specs/assistente/spec.md). O modelo só lê
 * e propõe; `apply` grava o que o servidor guardou, depois do Confirmar.
 * Erros esperados saem com `{ error, code }` para a tela tratar pelo `code`.
 */
async function guarded<T>(app: FastifyInstance, reply: FastifyReply, work: () => Promise<T>) {
  try {
    return await work()
  } catch (error) {
    const mapped = assistantHttpError(error)
    if (mapped) return reply.code(mapped.status).send(mapped.body)
    // Zod (corpo inválido) segue o tratamento geral do servidor; o resto diz o que quebrou, sem segredo.
    if (error instanceof Error && error.name === 'ZodError') throw error
    app.log.error(error)
    return reply.code(500).send({ error: 'erro interno', detail: describeUnexpected(error, process.env.ASSISTANT_API_KEY) })
  }
}

export async function assistantRoutes(app: FastifyInstance) {
  app.post('/assistant/message', async (req, reply) =>
    guarded(app, reply, () => handleMessage(assistantMessageRequest.parse(req.body), optionsFromEnv((name) => process.env[name]))),
  )

  app.post('/assistant/apply', async (req, reply) =>
    guarded(app, reply, () => {
      const body = assistantApplyRequest.parse(req.body)
      return applyProposal(body.proposalId, body.confirmedActionIds, body.edits)
    }),
  )

  app.post('/assistant/undo', async (req, reply) =>
    guarded(app, reply, () => undoApplied(assistantUndoRequest.parse(req.body).undoToken)),
  )
}
