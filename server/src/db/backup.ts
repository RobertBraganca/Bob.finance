import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

/**
 * Snapshots of the working database, versioned and indexed outside it.
 *
 * PENDING REDESIGN (decisions/0026, Fase 4): this file's mechanism —
 * `VACUUM INTO` a local SQLite file, close/reopen the connection to
 * restore — has no equivalent against Supabase Postgres, a live shared
 * database this process does not exclusively own. `createSnapshot` and
 * `restoreSnapshot` are stubbed to fail loudly rather than silently do
 * nothing or corrupt something, until that redesign happens. Manifest
 * read/write and pruning stay implemented (plain JSON file I/O, no DB
 * dialect involved) so the shape of the module doesn't change out from
 * under `routes/backups.ts` twice.
 */

/** Mirrors FINANCE_DB: the verification harness points both at throwaway paths. */
const BACKUP_DIR = process.env.FINANCE_BACKUP_DIR
  ? resolve(process.env.FINANCE_BACKUP_DIR)
  : resolve('data/backups')

const MANIFEST_PATH = resolve(BACKUP_DIR, 'manifest.json')
const MARKER_PATH = resolve(BACKUP_DIR, '.last-migration-marker.json')
const JOURNAL_PATH = resolve('server/drizzle/meta/_journal.json')

export type BackupTrigger = 'migration' | 'manual' | 'pre-restore'

export type ManifestEntry = {
  /** sequential, never reused */
  version: number
  timestampIso: string
  /** what motivated the snapshot */
  label: string
  trigger: BackupTrigger
  filePath: string
  sizeBytes: number
}

export const backupDir = () => BACKUP_DIR
export function readManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) return []
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as ManifestEntry[]) : []
  } catch {
    // A manifest we cannot parse is worse than no manifest only if it makes
    // the app crash on boot. The snapshot files are still on disk and still
    // named with their version; report empty and let the next write rebuild.
    return []
  }
}

/**
 * Temp file + atomic rename, never a direct overwrite: a partial write here
 * would lose the index to every snapshot at once.
 */
function writeManifest(entries: ManifestEntry[]) {
  mkdirSync(BACKUP_DIR, { recursive: true })
  const tmp = `${MANIFEST_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(entries, null, 2))
  renameSync(tmp, MANIFEST_PATH)
}

function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Keeps a label safe for a filename without silently renaming the entry. */
const slug = (label: string) =>
  label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'snapshot'

/**
 * The next version number. Read from the manifest's highest version, not its
 * length: a pruned manifest is shorter but must not hand out a number that
 * an existing (or deleted) snapshot already used.
 */
function nextVersion(entries: ManifestEntry[]): number {
  return entries.reduce((max, e) => Math.max(max, e.version), 0) + 1
}

export function createSnapshot(_label: string, _trigger: BackupTrigger): ManifestEntry {
  // See the module comment: `VACUUM INTO` has no Postgres equivalent, and
  // this needs a real design (supabase db dump? a separate managed backup?)
  // before it does anything, rather than silently no-op or write a fake
  // manifest entry pointing at a file that doesn't exist.
  throw new BackupError(
    'backup automático ainda não reimplementado para o Postgres/Supabase (decisions/0026, Fase 4). Pendente de decisão de design',
  )
}

/** Most recent first, the order the UI lists them in. */
export function listSnapshots(): ManifestEntry[] {
  return [...readManifest()].sort((a, b) => b.version - a.version)
}

export function findSnapshot(version: number): ManifestEntry | null {
  return readManifest().find((e) => e.version === version) ?? null
}

/* ------------------------------------------------------------------ *
 * Migration trigger
 * ------------------------------------------------------------------ */

export function journalHash(): string {
  return createHash('sha256').update(readFileSync(JOURNAL_PATH)).digest('hex')
}

/**
 * True when the migration journal moved since the last successful migrate.
 *
 * A missing marker means "never migrated here", which is also true on a
 * brand-new database, and taking a snapshot of an empty database costs
 * nothing while missing the first real one would cost everything.
 */
export function hasPendingMigration(): boolean {
  if (!existsSync(MARKER_PATH)) return true
  try {
    const marker = JSON.parse(readFileSync(MARKER_PATH, 'utf-8')) as { journalHash?: string }
    return marker.journalHash !== journalHash()
  } catch {
    return true
  }
}

export function markMigrationApplied() {
  mkdirSync(BACKUP_DIR, { recursive: true })
  writeFileSync(MARKER_PATH, JSON.stringify({ journalHash: journalHash(), atIso: new Date().toISOString() }, null, 2))
}

/* ------------------------------------------------------------------ *
 * Restore + prune — both destructive, both explicit
 * ------------------------------------------------------------------ */

export class BackupError extends Error {}

/**
 * Overwrites the working database with a snapshot.
 *
 * Always snapshots the CURRENT state first, unconditionally, even when the
 * caller is sure they want to discard it: this function has no way to know
 * whether the state being replaced was the good one.
 *
 * The caller must have closed the SQLite connection first (Windows refuses
 * to overwrite a file with an open handle), and the process must exit
 * afterwards rather than keep serving from a handle to a file that no longer
 * exists.
 */
export function restoreSnapshot(_version: number): { restored: ManifestEntry; preRestore: ManifestEntry } {
  // See the module comment: restoring against a live, shared Postgres
  // database is a fundamentally different (and riskier) operation than
  // overwriting a local SQLite file, and needs its own explicit design
  // before this does anything.
  throw new BackupError(
    'restauração ainda não reimplementada para o Postgres/Supabase (decisions/0026, Fase 4). Pendente de decisão de design',
  )
}

export type PruneResult = { removed: ManifestEntry[]; kept: ManifestEntry[] }

/**
 * Keeps the N most recent versions plus EVERY manual snapshot. A manual
 * backup was asked for on purpose, usually right before something risky, so
 * age is not a reason to drop it.
 */
export function pruneSnapshots(keep: number): PruneResult {
  const entries = readManifest()
  const recent = new Set(
    [...entries]
      .sort((a, b) => b.version - a.version)
      .slice(0, Math.max(0, keep))
      .map((e) => e.version),
  )

  const kept: ManifestEntry[] = []
  const removed: ManifestEntry[] = []
  for (const entry of entries) {
    if (recent.has(entry.version) || entry.trigger === 'manual') kept.push(entry)
    else removed.push(entry)
  }

  for (const entry of removed) rmSync(entry.filePath, { force: true })
  if (removed.length > 0) writeManifest(kept)
  return { removed, kept }
}
