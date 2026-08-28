/**
 * Loads the fixture statements plus sample debts, investments and goals into
 * the working database, so the app can be explored with realistic data.
 *
 * This is DEMO DATA, not real finances. Run `npm run db:reset` to clear it
 * before importing actual statements.
 *
 * Run: npm run demo
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { seed } from '../server/src/db/seed'
import { db } from '../server/src/db/client'
import { accounts } from '../server/src/db/schema'
import * as imports from '../server/src/services/imports'
import * as debtService from '../server/src/services/debt'
import * as investments from '../server/src/services/investments'
import * as goals from '../server/src/services/goals'
import { totals } from '../server/src/services/analytics'

await seed()

/**
 * Guard: this script writes synthetic transactions. Running it on a ledger
 * that already holds real statements would silently mix fake data into real
 * finances, and the two are indistinguishable afterwards.
 */
{
  const existing = (await db.execute<{ n: number }>(sql`select count(*) as n from transactions`))[0]?.n ?? 0
  if (existing > 0 && process.env.FINANCE_DEMO_FORCE !== '1') {
    console.error(
      `\nO banco já tem ${existing} lançamentos.\n` +
        `Este script insere dados FICTÍCIOS e misturá-los com extratos reais é irreversível.\n\n` +
        `  Para começar do zero:        npm run db:reset && npm run demo\n` +
        `  Para forçar mesmo assim:     FINANCE_DEMO_FORCE=1 npm run demo\n`,
    )
    process.exit(1)
  }
}

const accountByName = new Map((await db.select().from(accounts)).map((a) => [a.name, a.id] as const))
const profileByName = new Map((await imports.listProfiles()).map((p) => [p.name, p.id] as const))

const FILES = [
  ['itau-extrato-2026-06_08.csv', 'Itaú Extrato', 'Conta Corrente'],
  ['nubank-conta-2026-06_08.csv', 'Nubank Conta', 'Conta Nubank'],
  ['nubank-cartao-2026-06_08.csv', 'Nubank Cartão de Crédito', 'Cartão de Crédito Nubank'],
  ['bradesco-extrato-2026-06_08.csv', 'Bradesco Extrato', 'Conta PJ'],
  ['santander-extrato-2026-06_08.csv', 'Santander Extrato', 'Conta Corrente'],
  ['inter-extrato-2026-06_08.csv', 'Banco Inter Extrato', 'Conta PJ'],
] as const

console.log('\n--- extratos ---')
for (const [file, profileName, accountName] of FILES) {
  const staged = await imports.stageImport({
    buffer: readFileSync(resolve('fixtures', file)),
    filename: file,
    profileId: profileByName.get(profileName)!,
    accountId: accountByName.get(accountName)!,
  })
  const committed = await imports.commitImport(staged.batchId)
  console.log(
    `${file.padEnd(34)} ${String(committed.committed).padStart(3)} gravados, ` +
      `${staged.duplicateCount} duplicatas, ${staged.errorCount} erros, ${staged.ignoredCount} ignoradas`,
  )
}

/**
 * Demonstrate the learning layer end to end: the seeded rules leave a few
 * genuinely ambiguous merchants uncategorized, and correcting one of them
 * three times promotes the correction into a real rule.
 */
console.log('\n--- aprendizado ---')
{
  const { like } = await import('drizzle-orm')
  const { transactions } = await import('../server/src/db/schema')
  const txn = await import('../server/src/services/transactions')
  const categories = await import('../server/src/services/categories')

  const vestuario = (await categories.categoryOptions()).find((option) => option.path === 'Pessoal / Vestuário')!

  const magalu = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(like(transactions.descriptionNorm, '%magazine luiza%'))

  for (let i = 0; i < 3 && magalu.length > 0; i++) {
    const target = magalu[i % magalu.length]!
    const result = await txn.setCategory([target.id], vestuario.id)
    const learned = result.learned[0]
    if (learned) {
      console.log(
        `correção ${i + 1}/3 em "magazine luiza" -> ${vestuario.path}` +
          (learned.promoted ? '  ** promovida a regra **' : ` (${learned.hits} confirmação(ões))`),
      )
    }
  }
  // Apply the freshly learned rule to everything still matching it.
  const { recategorize } = await import('../server/src/services/categorization')
  console.log('recategorização após aprendizado:', await recategorize({ onlyUncategorized: true }))
}

console.log('\n--- dívidas ---')
const DEBTS = [
  { name: 'Cartão Nubank', kind: 'credit_card', institution: 'Nubank', principalCents: 285_000, aprBps: 32_400, minimumPaymentCents: 45_000, scheduledPaymentCents: 120_000, dueDay: 8 },
  { name: 'Empréstimo pessoal', kind: 'personal_loan', institution: 'Itaú', principalCents: 1_450_000, aprBps: 4_900, minimumPaymentCents: 98_000, scheduledPaymentCents: 98_000, dueDay: 15 },
  { name: 'Financiamento veículo', kind: 'financing', institution: 'Bradesco', principalCents: 3_820_000, aprBps: 2_180, minimumPaymentCents: 112_000, scheduledPaymentCents: 112_000, dueDay: 20 },
]
for (const debt of DEBTS) {
  const created = await debtService.createDebt(debt)
  console.log(`${debt.name.padEnd(24)} ${(debt.principalCents / 100).toFixed(2)} @ ${(debt.aprBps / 100).toFixed(1)}% a.a.`)
  // A short measured history, so the debt trend is real data and not a guess.
  await debtService.recordSnapshot(created.id, '2026-06-01', Math.round(debt.principalCents * 1.09))
  await debtService.recordSnapshot(created.id, '2026-07-01', Math.round(debt.principalCents * 1.05))
  await debtService.recordSnapshot(created.id, '2026-08-01', debt.principalCents)
}

console.log('\n--- investimentos ---')
const ASSETS = [
  { name: 'Tesouro IPCA+ 2035', assetClass: 'fixed_income', ticker: null, unit: 100_000, qty: 12, price: 108_400 },
  { name: 'PETR4', assetClass: 'stocks', ticker: 'PETR4', unit: 3_240, qty: 400, price: 3_780 },
  { name: 'MXRF11', assetClass: 'fii', ticker: 'MXRF11', unit: 1_020, qty: 900, price: 1_095 },
  { name: 'CDB Inter 112% CDI', assetClass: 'fixed_income', ticker: null, unit: 100_00, qty: 80, price: 104_50 },
  { name: 'Bitcoin', assetClass: 'crypto', ticker: 'BTC', unit: 34_500_000, qty: 0.035, price: 39_800_000 },
]
for (const asset of ASSETS) {
  const created = await investments.createAsset({
    name: asset.name,
    ticker: asset.ticker,
    assetClass: asset.assetClass,
  })
  // Split into three monthly contributions so the performance chart has shape.
  for (const [index, month] of ['2026-06-05', '2026-07-05', '2026-08-05'].entries()) {
    await investments.createTrade({
      assetId: created.id,
      tradedOn: month,
      quantity: asset.qty / 3,
      unitPriceCents: Math.round(asset.unit * (1 + index * 0.012)),
      feesCents: 250,
    })
  }
  await investments.recordValuation(created.id, '2026-07-15', Math.round((asset.unit + asset.price) / 2))
  await investments.recordValuation(created.id, '2026-08-18', asset.price)
  console.log(`${asset.name.padEnd(24)} ${asset.assetClass}`)
}

await investments.setTargetAllocation(null, [
  { assetClass: 'fixed_income', targetBps: 4_500 },
  { assetClass: 'stocks', targetBps: 3_000 },
  { assetClass: 'fii', targetBps: 2_000 },
  { assetClass: 'crypto', targetBps: 500 },
])

await investments.createGoal({
  name: 'Reserva de oportunidade',
  targetValueCents: 15_000_000,
  targetDate: '2029-12-01',
  monthlyContributionCents: 250_000,
  expectedReturnBps: 950,
})
await investments.createGoal({
  name: 'Entrada do imóvel',
  targetValueCents: 40_000_000,
  targetDate: '2032-06-01',
  monthlyContributionCents: 400_000,
  expectedReturnBps: 800,
})

console.log('\n--- metas mensais ---')
for (const period of ['2026-06', '2026-07', '2026-08']) {
  const actual = await totals({ from: `${period}-01`, to: `${period}-31` })
  await goals.upsertGoal(period, {
    incomeTargetCents: Math.round((actual.incomeCents * 0.92) / 10_000) * 10_000,
    spendCapCents: Math.round((actual.expenseCents * 1.08) / 10_000) * 10_000,
    savingsRateTargetBps: 3_000,
  })
  for (const suggestion of (await goals.suggestCaps(period, 1)).slice(0, 5)) {
    await goals.upsertCap(period, suggestion.categoryId, Math.round(suggestion.suggestedCapCents * 1.1))
  }
  const progress = await goals.getPeriodProgress(period)
  console.log(
    `${period}  receita ${(progress.actual.incomeCents / 100).toFixed(2)} / saídas ${(progress.actual.expenseCents / 100).toFixed(2)} · ${progress.caps.length} tetos`,
  )
}

const final = await totals({ from: '2026-06-01', to: '2026-08-31' })
console.log(
  `\nPronto. ${final.transactionCount} lançamentos, ${final.uncategorizedCount} sem categoria.`,
)
console.log('Dados de demonstração — rode `npm run db:reset` antes de importar extratos reais.\n')
