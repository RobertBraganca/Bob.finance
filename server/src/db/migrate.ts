import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve, sep } from 'node:path'
import { db, DB_PATH } from './client'
import { createSnapshot, hasPendingMigration, markMigrationApplied } from './backup'

/**
 * Migrations run on every boot because the Drizzle migrator is idempotent.
 * The BACKUP, however, must not be: a snapshot per boot would fill
 * `data/backups/` with identical copies and turn the one signal that matters
 * into noise. So the snapshot is gated on the migration journal actually
 * having moved since the last successful run (see `decisions/0014`).
 *
 * If the snapshot fails (no disk space, for one), the migration does not
 * run either. Migrating without the safety net is the situation this whole
 * mechanism exists to prevent.
 */
export function runMigrations() {
  const pending = hasPendingMigration()

  if (pending) {
    try {
      const snapshot = createSnapshot('pre-migration', 'migration')
      console.log(`[db] snapshot v${snapshot.version} antes da migração -> ${snapshot.filePath}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `[db] migração abortada: não foi possível criar o snapshot de segurança antes de migrar (${reason})`,
      )
    }
  }

  migrate(db, { migrationsFolder: resolve('server/drizzle') })

  // Only after a clean migrate: a marker written before it would make a
  // failed migration look applied and skip the snapshot on the next try.
  if (pending) markMigrationApplied()
}

/** True when this file is the process entry point (cross-platform path check). */
export function isEntryPoint(relativePath: string): boolean {
  return (process.argv[1] ?? '').split(sep).join('/').endsWith(relativePath)
}

if (isEntryPoint('db/migrate.ts')) {
  runMigrations()
  console.log(`[db] migrated ${DB_PATH}`)
}
