import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { accountantMonth } from '../services/accountantView'

/**
 * Área do contador no servidor local (docs/specs/tarefas-comercial-contador).
 * Aqui não há login: quem usa é sempre o dono. Convite, revogação e os pacotes
 * guardados no Storage só existem na função Edge `accountant`, que tem a chave
 * de serviço.
 */
const onlyPublished = { error: 'disponível só no app publicado (precisa do Supabase Auth e do Storage)' }

export async function accountantRoutes(app: FastifyInstance) {
  app.get('/accountant/me', async () => ({ role: 'owner', email: null }))
  app.get('/accountant/month', async (req) => accountantMonth(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query).period))
  app.get('/accountant/packages', async () => ({ packages: [] }))
  app.get('/accountant/users', async () => ({ users: [] }))
  app.post('/accountant/users', async (_req, reply) => reply.code(422).send(onlyPublished))
  app.delete('/accountant/users/:userId', async (_req, reply) => reply.code(422).send(onlyPublished))
}
