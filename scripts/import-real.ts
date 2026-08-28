/**
 * Imports the real bank statements from the client's CSV folder.
 *
 * Walks the per-bank/per-year tree, maps every file to a parser profile and an
 * account, then runs each one through the ordinary stage -> commit pipeline so
 * deduplication applies across the whole set. The Inter and Nubank exports
 * overlap heavily by design (multi-year ranges plus per-month files, and at
 * least three files are outright re-downloads), so most of the work here is
 * letting the dedupe fingerprint do its job.
 *
 * Run: npm run import:real -- "<pasta raiz>"
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { seed } from '../server/src/db/seed'
import { db } from '../server/src/db/client'
import { accounts } from '../server/src/db/schema'
import * as imports from '../server/src/services/imports'
import { recategorize } from '../server/src/services/categorization'
import { ledgerBounds } from '../server/src/services/transactions'
import { totals } from '../server/src/services/analytics'
import { normalizePicPay, toCsv } from './normalize-picpay'

const ROOT = resolve(
  process.argv[2] ?? 'D:/BEEKOFF®/02. Clientes/01. O BOB®/2026/CSV/CSV BANCOS',
)

if (!existsSync(ROOT)) {
  console.error(`pasta não encontrada: ${ROOT}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * Accounts that actually exist, replacing the demo ones.
 * ------------------------------------------------------------------ */
const REAL_ACCOUNTS = [
  { name: 'Nubank PF', institution: 'Nubank', kind: 'checking' },
  { name: 'Nubank PJ', institution: 'Nubank', kind: 'checking' },
  { name: 'Inter', institution: 'Banco Inter', kind: 'checking' },
  { name: 'PicPay', institution: 'PicPay', kind: 'checking' },
] as const

/**
 * Which profile and account each folder maps to. Order matters: the first
 * matching prefix wins, so "Nubank PJ/" must be tested before "Nubank/".
 */
const ROUTES: Array<{ prefix: string; profile: string; account: string }> = [
  { prefix: 'Nubank PJ/', profile: 'Nubank Conta', account: 'Nubank PJ' },
  { prefix: 'Nubank/', profile: 'Nubank Conta', account: 'Nubank PF' },
  { prefix: 'Inter/', profile: 'Banco Inter Extrato', account: 'Inter' },
]

await seed()

// Archive the demo accounts and bring up the real ones. Archiving rather than
// deleting keeps any history that already referenced them intact.
await db.update(accounts).set({ archived: true })
const accountId = new Map<string, number>()
for (const account of REAL_ACCOUNTS) {
  const existing = (await db.select().from(accounts)).find((a) => a.name === account.name)
  const row = existing
    ? (await db.update(accounts).set({ archived: false }).where(eq(accounts.id, existing.id)).returning())[0]!
    : (await db.insert(accounts).values(account).returning())[0]!
  accountId.set(account.name, row.id)
}

const profileId = new Map((await imports.listProfiles()).map((p) => [p.name, p.id] as const))

/* ------------------------------------------------------------------ *
 * Collect the files
 * ------------------------------------------------------------------ */
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })

const relative = (full: string) => full.slice(ROOT.length + 1).split('\\').join('/')

const allFiles = walk(ROOT)
const csvFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.csv'))
const otherFiles = allFiles.filter((f) => !f.toLowerCase().endsWith('.csv'))

console.log(`\nRaiz: ${ROOT}`)
console.log(`${csvFiles.length} arquivos .csv encontrados` + (otherFiles.length > 0 ? `, ${otherFiles.length} não-CSV ignorados` : ''))
for (const other of otherFiles) console.log(`  ignorado (não é CSV): ${relative(other)}`)

/* ------------------------------------------------------------------ *
 * PicPay needs pre-normalization before it can be routed.
 * ------------------------------------------------------------------ */
const WORK_DIR = resolve('data/normalizado')
mkdirSync(WORK_DIR, { recursive: true })

type Job = { label: string; path: string; profile: string; account: string }
const jobs: Job[] = []

for (const file of csvFiles) {
  const rel = relative(file)

  if (rel.startsWith('PicPay/')) {
    const { records, skipped } = normalizePicPay(readFileSync(file, 'utf8'))
    const out = join(WORK_DIR, `picpay-${records.length}.csv`)
    writeFileSync(out, toCsv(records), 'utf8')
    console.log(
      `\n[normalizado] ${rel} -> ${records.length} registros` +
        (skipped > 0 ? `, ${skipped} linhas ignoradas` : ''),
    )
    jobs.push({
      label: `${rel} (normalizado)`,
      path: out,
      profile: 'PicPay Relatório normalizado',
      account: 'PicPay',
    })
    continue
  }

  const route = ROUTES.find((r) => rel.startsWith(r.prefix))
  if (!route) {
    console.log(`  SEM ROTA: ${rel}`)
    continue
  }
  jobs.push({ label: rel, path: file, profile: route.profile, account: route.account })
}

/**
 * Import oldest-first so that when two exports overlap, the earlier file
 * establishes the row and the later one is the flagged duplicate. Sorting by
 * name gets this right for both naming schemes in this tree.
 */
jobs.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))

/* ------------------------------------------------------------------ *
 * Stage and commit
 * ------------------------------------------------------------------ */
console.log(`\n${'='.repeat(96)}`)
console.log('ARQUIVO'.padEnd(52) + 'LIDAS'.padStart(7) + 'NOVAS'.padStart(7) + 'DUPL'.padStart(7) + 'ERRO'.padStart(6) + 'IGN'.padStart(6))
console.log('='.repeat(96))

let totalRead = 0
let totalCommitted = 0
let totalDuplicates = 0
let totalErrors = 0
let totalIgnored = 0
const errorSamples: string[] = []

for (const job of jobs) {
  const profile = profileId.get(job.profile)
  const account = accountId.get(job.account)
  if (!profile || !account) {
    console.log(`${job.label.padEnd(52)}  perfil/conta não resolvidos`)
    continue
  }

  const staged = await imports.stageImport({
    buffer: readFileSync(job.path),
    filename: job.label,
    profileId: profile,
    accountId: account,
  })

  if (staged.errorCount > 0 && errorSamples.length < 12) {
    const batch = (await imports.getBatch(staged.batchId))!
    for (const row of batch.rows.filter((r) => r.parseError !== null).slice(0, 3)) {
      errorSamples.push(`${job.label} linha ${row.rowIndex}: ${row.parseError} | ${String(row.rawLine).slice(0, 70)}`)
    }
  }

  const committed = await imports.commitImport(staged.batchId)

  totalRead += staged.rowCount
  totalCommitted += committed.committed
  totalDuplicates += staged.duplicateCount
  totalErrors += staged.errorCount
  totalIgnored += staged.ignoredCount

  const short = job.label.length > 50 ? '…' + job.label.slice(-49) : job.label
  console.log(
    short.padEnd(52) +
      String(staged.rowCount).padStart(7) +
      String(committed.committed).padStart(7) +
      String(staged.duplicateCount).padStart(7) +
      String(staged.errorCount).padStart(6) +
      String(staged.ignoredCount).padStart(6),
  )
}

console.log('='.repeat(96))
console.log(
  'TOTAL'.padEnd(52) +
    String(totalRead).padStart(7) +
    String(totalCommitted).padStart(7) +
    String(totalDuplicates).padStart(7) +
    String(totalErrors).padStart(6) +
    String(totalIgnored).padStart(6),
)

if (errorSamples.length > 0) {
  console.log('\n--- amostras de linhas com erro de leitura (não gravadas) ---')
  for (const sample of errorSamples) console.log(`  ${sample}`)
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
console.log('\n--- recategorização final ---')
console.log(await recategorize({ onlyUncategorized: true }))
console.log('  (rode `npm run regras:locais` para aplicar as regras de clientes/contrapartes)')

const bounds = await ledgerBounds()
console.log('\n--- ledger ---')
console.log(`lançamentos: ${bounds.count}`)
console.log(`período:     ${bounds.min} .. ${bounds.max}`)

const all = await totals({ from: bounds.min ?? '1970-01-01', to: bounds.max ?? '2100-01-01' })
const fmt = (cents: number) => `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
console.log(`entradas:      ${fmt(all.incomeCents)}`)
console.log(`saídas:        ${fmt(all.expenseCents)}`)
console.log(`transferências:${fmt(all.transferCents)} (fora dos dois lados)`)
console.log(`investido:     ${fmt(all.investedCents)}`)
console.log(
  `sem categoria: ${all.uncategorizedCount} de ${all.transactionCount} ` +
    `(${Math.round((1 - all.uncategorizedCount / Math.max(1, all.transactionCount)) * 100)}% categorizado)`,
)

console.log('\n--- saldo por conta (derivado dos lançamentos) ---')
for (const account of (await db.select().from(accounts)).filter((a) => !a.archived)) {
  const row = (
    await db.execute<{ total: number; n: number }>(
      sql`select coalesce(sum(amount_cents),0) as total, count(*) as n
        from transactions where account_id = ${account.id}`,
    )
  )[0]
  console.log(
    `${account.name.padEnd(12)} ${fmt(row?.total ?? 0).padStart(18)}  ${String(row?.n ?? 0).padStart(6)} lançamentos`,
  )
}
console.log('')
