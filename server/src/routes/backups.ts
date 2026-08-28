import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as backup from '../db/backup'

/**
 * Backup and restore. Its own route module rather than another section of
 * `insights.ts`: nothing here is a derived metric, and restore is the only
 * endpoint in the whole API that destroys data.
 *
 * See `specs/backup-and-recovery` and `decisions/0014`.
 */
export async function backupRoutes(app: FastifyInstance) {
  app.get('/backups', async () => ({
    backups: backup.listSnapshots(),
    directory: backup.backupDir(),
    pendingMigration: backup.hasPendingMigration(),
  }))

  app.post('/backups', async (req) => {
    const body = z.object({ label: z.string().min(1).max(60).optional() }).parse(req.body ?? {})
    const entry = backup.createSnapshot(body.label ?? 'manual', 'manual')
    return { created: entry, backups: backup.listSnapshots() }
  })

  /**
   * Restore. Two guards, both deliberate:
   *
   *  - `confirm: true` in the BODY, never a query string or a header, so a
   *    stray click on a link can never trigger it.
   *  - a `pre-restore` snapshot of the current state first, unconditionally.
   *
   * The connection is closed to overwrite the file (Windows will not
   * overwrite a file with an open handle), so the process cannot keep
   * serving afterwards: the response says to restart, and no further request
   * on this process will find a live database.
   */
  app.post('/backups/:version/restore', async (req, reply) => {
    const { version } = z.object({ version: z.coerce.number().int().positive() }).parse(req.params)
    const body = z.object({ confirm: z.boolean().optional() }).parse(req.body ?? {})

    if (body.confirm !== true) {
      return reply.code(400).send({
        error:
          'restauração não confirmada: envie {"confirm": true} no corpo da requisição. O estado atual será salvo como um backup pre-restore antes de qualquer sobrescrita.',
      })
    }

    const target = backup.findSnapshot(version)
    if (!target) return reply.code(404).send({ error: `backup versão ${version} não encontrado` })

    const { restored, preRestore } = backup.restoreSnapshot(version)
    return {
      restored,
      preRestore,
      restartRequired: true,
      message:
        'Banco restaurado. O estado anterior foi salvo como um backup pre-restore. Reinicie o servidor (npm run dev) para voltar a usar o app.',
    }
  })
}
