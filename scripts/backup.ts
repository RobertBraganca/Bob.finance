/**
 * Backup CLI: `npm run db:backup [-- <rótulo>]`.
 *
 * Snapshots are cheap and non-destructive, so this one needs no
 * confirmation. Its destructive siblings (`db:restore`, `db:backup:prune`)
 * both do.
 */
import { createSnapshot } from '../server/src/db/backup'

const label = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim() || 'manual'
const entry = createSnapshot(label, 'manual')

const mb = (entry.sizeBytes / 1_048_576).toFixed(1)
console.log(`\n  Backup v${entry.version} criado`)
console.log(`  rótulo    ${entry.label}`)
console.log(`  arquivo   ${entry.filePath}`)
console.log(`  tamanho   ${mb} MB\n`)
