import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import * as tasksService from '../services/tasks'
import * as google from '../services/googleCalendar'

/**
 * Tarefas financeiras (docs/specs/tarefas-comercial-contador, fase 1). Mesmas
 * rotas na função Edge `insights`. Erro de regra (TaskError) vira 422.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const taskListQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() })
const taskFields = {
  title: z.string().trim().min(1).max(160),
  kind: z.enum(['custom', 'nf']).optional(),
  clientId: z.number().int().positive().nullable().optional(),
  amountCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  recurrence: z.enum(['once', 'monthly', 'yearly']).optional(),
  dueOn: isoDate.nullable().optional(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  dueMonth: z.number().int().min(1).max(12).nullable().optional(),
  startsOn: isoDate.nullable().optional(),
  endsOn: isoDate.nullable().optional(),
  active: z.boolean().optional(),
}
export const taskCreateBody = z.object(taskFields)
export const taskPatchBody = z.object(taskFields).partial()
export const taskCompleteBody = z.object({
  key: z.string().min(3).max(120),
  done: z.boolean(),
  status: z.enum(['done', 'skipped']).optional(),
  reference: z.string().max(120).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
})

async function guarded<T>(reply: FastifyReply, work: () => Promise<T>) {
  try {
    return await work()
  } catch (error) {
    if (error instanceof tasksService.TaskError || error instanceof google.GoogleCalendarError) return reply.code(422).send({ error: error.message })
    throw error
  }
}

const googleConfig = () => google.googleConfigFromEnv((name) => process.env[name])

export async function tasksRoutes(app: FastifyInstance) {
  app.get('/tasks', async (req) => {
    const query = taskListQuery.parse(req.query)
    const fallback = tasksService.defaultWindow()
    return tasksService.listTasks({ from: query.from ?? fallback.from, to: query.to ?? fallback.to })
  })
  app.get('/tasks/manual', async () => ({ tasks: await tasksService.listManualTasks() }))
  app.post('/tasks', async (req, reply) =>
    guarded(reply, async () => {
      const task = await tasksService.createTask(taskCreateBody.parse(req.body))
      await google.syncQuietly(googleConfig())
      return task
    }),
  )
  app.patch('/tasks/:id', async (req, reply) =>
    guarded(reply, async () => {
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params)
      const task = await tasksService.updateTask(id, taskPatchBody.parse(req.body))
      if (!task) return reply.code(404).send({ error: 'tarefa não encontrada' })
      await google.syncQuietly(googleConfig())
      return task
    }),
  )
  app.delete('/tasks/:id', async (req) => {
    const result = await tasksService.deleteTask(z.object({ id: z.coerce.number().int().positive() }).parse(req.params).id)
    await google.syncQuietly(googleConfig())
    return result
  })
  app.post('/tasks/complete', async (req, reply) =>
    guarded(reply, async () => {
      const body = taskCompleteBody.parse(req.body)
      const result = body.done ? await tasksService.completeTask(body.key, body) : await tasksService.reopenTask(body.key)
      await google.syncQuietly(googleConfig(), [body.key])
      return result
    }),
  )

  /* ---- Google Agenda (fase 3) ---- */
  app.get('/google/status', async () => google.status(googleConfig()))
  app.post('/google/auth-url', async (req, reply) => {
    const config = googleConfig()
    if (!config) return reply.code(422).send({ error: 'o acesso ao Google ainda não foi configurado no servidor' })
    return { url: google.authUrl(config, z.object({ state: z.string().min(8).max(120) }).parse(req.body).state) }
  })
  app.post('/google/connect', async (req, reply) =>
    guarded(reply, async () => {
      const config = googleConfig()
      if (!config) return reply.code(422).send({ error: 'o acesso ao Google ainda não foi configurado no servidor' })
      const result = await google.connect(config, z.object({ code: z.string().min(4).max(2000) }).parse(req.body).code)
      await google.syncQuietly(config)
      return google.status(config).then((s) => ({ ...result, ...s }))
    }),
  )
  app.post('/google/sync', async (req, reply) =>
    guarded(reply, async () => {
      const config = googleConfig()
      if (!config) return reply.code(422).send({ error: 'o acesso ao Google ainda não foi configurado no servidor' })
      return google.sync(config)
    }),
  )
  app.delete('/google/connection', async () => google.disconnect(googleConfig()))
}
