/**
 * Prune CLI: `npm run db:backup:prune -- --keep 5 --yes`.
 *
 * Keeps the N most recent versions AND every manual snapshot, whatever its
 * age: a manual backup was asked for on purpose, usually right before
 * something risky, so being old is not a reason to drop it.
 *
 * Never runs silently and never runs automatically (`decisions/0014`):
 * without `--yes` it prints exactly what would be deleted and exits.
 */
import { listSnapshots, pruneSnapshots } from '../server/src/db/backup'

const args = process.argv.slice(2)
const yes = args.includes('--yes')
const keepIndex = args.indexOf('--keep')
const keepArg = keepIndex >= 0 ? args[keepIndex + 1] : undefined
const keep = keepArg && /^\d+$/.test(keepArg) ? Number(keepArg) : null

if (keep === null) {
  console.error('\n  Uso: npm run db:backup:prune -- --keep <N> [--yes]\n')
  process.exit(1)
}

const fmt = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`
const all = listSnapshots()
const recent = new Set(all.slice(0, keep).map((s) => s.version))
const doomed = all.filter((s) => !recent.has(s.version) && s.trigger !== 'manual')

if (doomed.length === 0) {
  console.log(`\n  Nada a remover: ${all.length} backup(s), mantendo os ${keep} mais recentes e todos os manuais.\n`)
  process.exit(0)
}

if (!yes) {
  console.log(`\n  Isto removeria ${doomed.length} backup(s), liberando ${fmt(doomed.reduce((s, d) => s + d.sizeBytes, 0))}:\n`)
  for (const s of doomed) console.log(`    v${s.version}  ${s.timestampIso.slice(0, 19).replace('T', ' ')}  ${s.label}`)
  console.log(`\n  Backups manuais nunca são removidos, independente da idade.`)
  console.log(`  Nada foi alterado. Para confirmar:  npm run db:backup:prune -- --keep ${keep} --yes\n`)
  process.exit(0)
}

const result = pruneSnapshots(keep)
console.log(`\n  ${result.removed.length} backup(s) removido(s), ${result.kept.length} mantido(s).`)
console.log('  Os números de versão removidos não serão reutilizados.\n')
