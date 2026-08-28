/**
 * Verification for the backup layer.
 *
 * A separate process from `scripts/verify.ts` on purpose: this one needs its
 * own database AND its own backup directory, and both are chosen by env vars
 * read at module load. It never touches `data/finance.db` nor the real
 * `data/backups/manifest.json`.
 *
 * Run: npm run verify:backup  (also chained into `npm run verify`)
 */
process.env.FINANCE_DB = 'data/verify-backup.db'
process.env.FINANCE_BACKUP_DIR = 'data/verify-backups'

import Database from 'better-sqlite3'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

let passed = 0
let failed = 0
const failures: string[] = []

function section(title: string) {
  console.log(`\n${'─'.repeat(72)}\n  ${title}\n${'─'.repeat(72)}`)
}

function ok(condition: unknown, label: string, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}${detail === undefined ? '' : `  ->  ${detail}`}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : `  ->  ${detail}`}`)
  }
}

const eq = (actual: unknown, expected: unknown, label: string) =>
  ok(actual === expected, label, actual === expected ? String(actual) : `esperado ${expected}, recebido ${actual}`)

/* Fresh state — delete before anything opens a handle. */
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(resolve(`data/verify-backup.db${suffix}`), { force: true })
}
rmSync(resolve('data/verify-backups'), { recursive: true, force: true })

const { runMigrations } = await import('../server/src/db/migrate')
const backup = await import('../server/src/db/backup')
const { seed } = await import('../server/src/db/seed')

section('BACKUP — snapshot versionado, marcador de migração, prune')

/* ---------------------------------------------------------------- *
 * A. First boot: no marker yet, so a migration is pending and the
 *    migrator takes a snapshot before touching the schema.
 * ---------------------------------------------------------------- */
ok(backup.hasPendingMigration(), 'banco novo sem marcador: migração pendente')
eq(backup.listSnapshots().length, 0, 'nenhum snapshot antes da primeira migração')

runMigrations()

const afterMigration = backup.listSnapshots()
eq(afterMigration.length, 1, 'a primeira migração criou exatamente um snapshot')
eq(afterMigration[0]!.trigger, 'migration', 'o snapshot automático é marcado com trigger "migration"')
eq(afterMigration[0]!.version, 1, 'a primeira versão é 1')
ok(backup.hasPendingMigration() === false, 'depois de migrar com sucesso, não há migração pendente')

// A second boot must NOT produce a second snapshot: the migrator is
// idempotent, the backup must not be.
runMigrations()
eq(backup.listSnapshots().length, 1, 'reiniciar sem mudança no journal não cria snapshot novo')

seed()

/* ---------------------------------------------------------------- *
 * B. The snapshot file is a real, readable database.
 *
 * Note WHICH snapshot is inspected. v1 was taken BEFORE the first
 * migration, so on a brand-new database it is correctly an empty file with
 * no tables — that is the point of a pre-migration snapshot, not a defect.
 * The schema assertions belong on a snapshot taken after the schema exists.
 * ---------------------------------------------------------------- */
const preMigration = backup.findSnapshot(1)!
ok(existsSync(preMigration.filePath), 'o arquivo .db do snapshot pré-migração existe em disco')
{
  const empty = new Database(preMigration.filePath, { readonly: true })
  const tables = empty
    .prepare<[], { name: string }>("select name from sqlite_master where type = 'table'")
    .all()
  empty.close()
  eq(tables.length, 0, 'o snapshot pré-migração retrata o banco ANTES do schema, ou seja, vazio')
}

const afterSchema = backup.createSnapshot('com schema', 'manual')
ok(afterSchema.sizeBytes > preMigration.sizeBytes, 'um snapshot com schema é maior que o do banco vazio', `${afterSchema.sizeBytes} bytes`)
{
  const copy = new Database(afterSchema.filePath, { readonly: true })
  const tables = copy
    .prepare<[], { name: string }>("select name from sqlite_master where type = 'table'")
    .all()
    .map((r) => r.name)
  const contas = copy.prepare<[], { n: number }>('select count(*) as n from accounts').get()!.n
  copy.close()
  ok(tables.includes('transactions'), 'o snapshot abre e contém a tabela transactions')
  ok(tables.includes('accounts'), 'o snapshot contém a tabela accounts')
  ok(tables.length > 20, 'o snapshot contém o schema inteiro, não um subconjunto', `${tables.length} tabelas`)
  ok(contas > 0, 'o snapshot carrega o dado semeado, não só a estrutura', `${contas} contas`)
}

/* ---------------------------------------------------------------- *
 * C. Versions increment and are never reused.
 * ---------------------------------------------------------------- */
const manualA = backup.createSnapshot('antes de importar extrato', 'manual')
const manualB = backup.createSnapshot('manual', 'manual')
eq(manualA.version, 3, 'cada snapshot novo recebe a próxima versão sequencial')
eq(manualB.version, 4, 'e a seguinte recebe a próxima ainda')
ok(manualA.filePath !== manualB.filePath, 'dois snapshots seguidos nunca gravam no mesmo arquivo')
ok(
  new Set(backup.listSnapshots().map((s) => s.version)).size === backup.listSnapshots().length,
  'nenhum número de versão se repete no manifesto',
)
ok(
  manualA.filePath.includes('antes-de-importar-extrato'),
  'o rótulo vira parte do nome do arquivo, sem acento nem espaço',
  manualA.filePath.split(/[\\/]/).pop(),
)
eq(backup.listSnapshots()[0]!.version, manualB.version, 'a listagem vem com o mais recente primeiro')

/* ---------------------------------------------------------------- *
 * D. The marker detects a journal that moved.
 * ---------------------------------------------------------------- */
const markerPath = resolve('data/verify-backups/.last-migration-marker.json')
ok(existsSync(markerPath), 'o marcador de migração foi gravado')
eq(
  (JSON.parse(readFileSync(markerPath, 'utf-8')) as { journalHash: string }).journalHash,
  backup.journalHash(),
  'o marcador guarda o hash atual do journal',
)
writeFileSync(markerPath, JSON.stringify({ journalHash: 'hash-de-um-journal-diferente' }))
ok(backup.hasPendingMigration(), 'journal diferente do marcador -> migração pendente de novo')
backup.markMigrationApplied()
ok(backup.hasPendingMigration() === false, 'regravar o marcador zera a pendência')

/* ---------------------------------------------------------------- *
 * E. Prune keeps the recent ones AND every manual one.
 * ---------------------------------------------------------------- */
const beforePrune = backup.listSnapshots()
const manualCount = beforePrune.filter((s) => s.trigger === 'manual').length
ok(manualCount >= 2, 'o cenário tem snapshots manuais para proteger', manualCount)

const pruned = backup.pruneSnapshots(1)
ok(
  pruned.kept.every((s) => s.trigger === 'manual' || s.version === beforePrune[0]!.version),
  'prune mantém só os mais recentes e os manuais',
)
ok(
  pruned.removed.every((s) => s.trigger !== 'manual'),
  'prune nunca remove um backup manual, por mais antigo que seja',
)
ok(
  pruned.removed.every((s) => !existsSync(s.filePath)),
  'o arquivo .db de cada backup removido saiu do disco',
)
ok(
  pruned.kept.every((s) => existsSync(s.filePath)),
  'todo backup mantido continua em disco',
)

// The pruned version number must never come back.
const afterPrune = backup.createSnapshot('depois do prune', 'manual')
ok(
  afterPrune.version > beforePrune[0]!.version,
  'depois do prune, a próxima versão continua avançando, nunca reaproveita um número',
  `v${afterPrune.version}`,
)

/* ---------------------------------------------------------------- *
 * F. Restore always snapshots the current state first.
 * ---------------------------------------------------------------- */
const restoreTarget = backup.listSnapshots().find((s) => s.trigger === 'manual')!
const versionsBeforeRestore = backup.listSnapshots().length
const { restored, preRestore } = backup.restoreSnapshot(restoreTarget.version)
eq(restored.version, restoreTarget.version, 'restaurou a versão pedida')
eq(preRestore.trigger, 'pre-restore', 'o estado anterior virou um snapshot pre-restore')
eq(
  backup.listSnapshots().length,
  versionsBeforeRestore + 1,
  'restaurar acrescenta exatamente uma entrada (o pre-restore) ao manifesto',
)
ok(existsSync(preRestore.filePath), 'o arquivo do pre-restore existe em disco')
ok(
  preRestore.version > restored.version,
  'o pre-restore recebe uma versão nova, mais alta que a restaurada',
)

// The restored file must be a working database.
{
  const restoredDb = new Database(resolve('data/verify-backup.db'), { readonly: true })
  const count = restoredDb
    .prepare<[], { n: number }>("select count(*) as n from sqlite_master where type = 'table'")
    .get()!.n
  restoredDb.close()
  ok(count > 20, 'o banco restaurado abre e tem o schema completo', `${count} tabelas`)
}

/* ---------------------------------------------------------------- *
 * G. A version that does not exist fails loudly, never silently.
 * ---------------------------------------------------------------- */
try {
  backup.restoreSnapshot(9999)
  ok(false, 'restaurar uma versão inexistente deveria falhar')
} catch (error) {
  ok(error instanceof backup.BackupError, 'restaurar versão inexistente lança BackupError, não erro genérico')
}

/* ---------------------------------------------------------------- */
section(`RESULTADO BACKUP — ${passed} passaram, ${failed} falharam`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('  Todos os checks de backup passaram.\n')
