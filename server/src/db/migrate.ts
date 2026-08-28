import { sep } from 'node:path'

/**
 * Schema migrations are no longer this file's job as of decisions/0026
 * (Fase 3). The schema now lives in `supabase/migrations/*.sql`, applied
 * with `supabase db push` against the real Supabase project — not by a
 * Drizzle migrator run from the app at boot. `server/drizzle/*` (the old
 * SQLite migration history) is kept only as historical record.
 *
 * `isEntryPoint` is still used by seed.ts to detect being run directly
 * (`npx tsx server/src/db/seed.ts`).
 */

/** True when this file is the process entry point (cross-platform path check). */
export function isEntryPoint(relativePath: string): boolean {
  return (process.argv[1] ?? '').split(sep).join('/').endsWith(relativePath)
}
