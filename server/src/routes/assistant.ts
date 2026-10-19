import type { FastifyInstance, FastifyReply } from 'fastify'
import { assistantApplyRequest, assistantMessageRequest, assistantUndoRequest } from '../core/assistantTypes'
import { applyProposal, undoApplied } from '../services/assistant/apply'
import { assistantHttpError, handleMessage } from '../services/assistant/service'

/**
 * Assistente em linguagem natural (docs/specs/assistente/spec.md). O modelo só lê
 * e propõe; `apply` grava o que o servidor guardou, depois do Confirmar.
 * Erros esperados saem com `{ error, code }` para a tela tratar pelo `code`.
 */
async function guarded<T>(reply: FastifyReply, work: () => Promise<T>) {
  try {
    return await work()
  } catch (error) {
    const mapped = assistantHttpError(error)
    if (mapped) return reply.code(mapped.status).send(mapped.body)
    throw error
  }
}

export async function assistantRoutes(app: FastifyInstance) {
  app.post('/assistant/message', async (req, reply) =>
    guarded(reply, () => handleMessage(assistantMessageRequest.parse(req.body), { apiKey: process.env.ASSISTANT_API_KEY })),
  )

  app.post('/assistant/apply', async (req, reply) =>
    guarded(reply, () => {
      const body = assistantApplyRequest.parse(req.body)
      return applyProposal(body.proposalId, body.confirmedActionIds, body.edits)
    }),
  )

  app.post('/assistant/undo', async (req, reply) =>
    guarded(reply, () => undoApplied(assistantUndoRequest.parse(req.body).undoToken)),
  )
}
