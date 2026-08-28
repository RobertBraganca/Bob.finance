/**
 * Restore CLI.
 *
 *   npm run db:restore                  lista os backups disponíveis
 *   npm run db:restore -- 3 --yes       restaura a versão 3
 *
 * Without `--yes` this prints what WOULD happen and exits without touching
 * anything: overwriting the working database is the most destructive action
 * in the project, and `specs/backup-and-recovery` requires the confirmation
 * to be explicit rather than implied by having typed a version number.
 */
import { findSnapshot, listSnapshots, restoreSnapshot } from '../server/src/db/backup'

const args = process.argv.slice(2)
const yes = args.includes('--yes')
const versionArg = args.find((a) => /^\d+$/.test(a))

const fmt = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`
const when = (iso: string) => iso.replace('T', ' ').slice(0, 19)

function printList() {
  const snapshots = listSnapshots()
  if (snapshots.length === 0) {
    console.log('\n  Nenhum backup ainda. O primeiro roda automaticamente na próxima migração,')
    console.log('  ou agora mesmo com `npm run db:backup`.\n')
    return
  }
  console.log(`\n  ${snapshots.length} backup(s), mais recente primeiro:\n`)
  console.log('  ver  quando               origem       tamanho   rótulo')
  for (const s of snapshots) {
    console.log(
      `  ${String(s.version).padStart(3)}  ${when(s.timestampIso)}  ${s.trigger.padEnd(11)}  ${fmt(s.sizeBytes).padStart(8)}  ${s.label}`,
    )
  }
  console.log('\n  Para restaurar:  npm run db:restore -- <versão> --yes\n')
}

if (!versionArg) {
  printList()
  process.exit(0)
}

const version = Number(versionArg)
const target = findSnapshot(version)
if (!target) {
  console.error(`\n  Backup versão ${version} não encontrado no manifesto.\n`)
  printList()
  process.exit(1)
}

if (!yes) {
  console.log(`\n  Isto sobrescreveria o banco de trabalho com o backup v${version}:`)
  console.log(`    ${when(target.timestampIso)}  ${target.label}  ${fmt(target.sizeBytes)}`)
  console.log('\n  O estado atual seria salvo antes, como um backup pre-restore.')
  console.log(`  Nada foi alterado. Para confirmar:  npm run db:restore -- ${version} --yes\n`)
  process.exit(0)
}

const { restored, preRestore } = restoreSnapshot(version)
console.log(`\n  Estado anterior salvo como backup v${preRestore.version} (pre-restore).`)
console.log(`  Banco restaurado a partir do backup v${restored.version} (${restored.label}).`)
console.log('  Reinicie o servidor (npm run dev) para usar o banco restaurado.\n')
