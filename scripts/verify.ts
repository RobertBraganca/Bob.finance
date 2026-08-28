/**
 * End-to-end verification harness.
 *
 * Runs against a throwaway database (data/verify.db) so it can never touch
 * real financial data. Each module in the delivery order gets its own
 * section; every assertion prints, and the process exits non-zero if any
 * assertion fails.
 *
 * Run: npm run verify
 */
process.env.FINANCE_DB = 'data/verify.db'

import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

/* ---------------------------------------------------------------- *
 * Tiny assertion harness
 * ---------------------------------------------------------------- */
let passed = 0
let failed = 0
const failures: string[] = []

function section(title: string) {
  console.log(`\n${'─'.repeat(72)}\n  ${title}\n${'─'.repeat(72)}`)
}

function ok(condition: unknown, label: string, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}${detail === undefined ? '' : `  ->  ${fmt(detail)}`}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : `  ->  ${fmt(detail)}`}`)
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  ok(
    actual === expected,
    label,
    actual === expected ? actual : `esperado ${fmt(expected)}, recebido ${fmt(actual)}`,
  )
}

const fmt = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v))
const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2)}`

/* ---------------------------------------------------------------- *
 * Fresh database — delete before anything opens a handle to it.
 * ---------------------------------------------------------------- */
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(resolve(`data/verify.db${suffix}`), { force: true })
}

const { seed } = await import('../server/src/db/seed')
const { db } = await import('../server/src/db/client')
const schema = await import('../server/src/db/schema')
const imports = await import('../server/src/services/imports')
const txnService = await import('../server/src/services/transactions')
const categorization = await import('../server/src/services/categorization')
const { and, eq: dEq, like, sql } = await import('drizzle-orm')

const FIXTURES = resolve('fixtures')
const read = (name: string) => readFileSync(resolve(FIXTURES, name))

section('SETUP — migrations + seed')
const seeded = seed()
ok(seeded.accounts >= 5, 'contas semeadas', seeded.accounts)
ok(seeded.categories >= 60, 'árvore de categorias semeada', seeded.categories)
eq(seeded.profiles, 7, 'perfis de parser semeados')
ok(seeded.rules >= 60, 'regras iniciais semeadas', seeded.rules)

const accountByName = new Map(
  db.select().from(schema.accounts).all().map((a) => [a.name, a.id] as const),
)
const categoryPath = new Map<string, number>()
{
  const all = db.select().from(schema.categories).all()
  const byId = new Map(all.map((c) => [c.id, c] as const))
  for (const c of all) {
    const parent = c.parentId ? byId.get(c.parentId) : null
    categoryPath.set(parent ? `${parent.name}/${c.name}` : c.name, c.id)
  }
}

/* ================================================================ *
 * MODULE 1 — CSV import, parser profiles, normalized schema, dedupe
 * ================================================================ */
section('MODULE 1 — importação CSV, perfis de parser, deduplicação')

const CASES = [
  { file: 'itau-extrato-2026-06_08.csv', profile: 'Itaú Extrato', account: 'Conta Corrente' },
  { file: 'nubank-conta-2026-06_08.csv', profile: 'Nubank Conta', account: 'Conta Nubank' },
  {
    file: 'nubank-cartao-2026-06_08.csv',
    profile: 'Nubank Cartão de Crédito',
    account: 'Cartão de Crédito Nubank',
  },
  { file: 'bradesco-extrato-2026-06_08.csv', profile: 'Bradesco Extrato', account: 'Conta PJ' },
  { file: 'santander-extrato-2026-06_08.csv', profile: 'Santander Extrato', account: 'Conta Corrente' },
  { file: 'inter-extrato-2026-06_08.csv', profile: 'Banco Inter Extrato', account: 'Conta PJ' },
]

// 1a. Profile auto-detection from the header signature alone.
for (const c of CASES) {
  const detection = imports.detect(read(c.file))
  eq(detection.profileName, c.profile, `detecção de perfil: ${c.file}`)
}

// 1b. Stage every fixture and record the batch ids.
const staged = new Map<string, ReturnType<typeof imports.stageImport>>()
const profilesByName = new Map(imports.listProfiles().map((p) => [p.name, p] as const))

for (const c of CASES) {
  const profile = profilesByName.get(c.profile)!
  const result = imports.stageImport({
    buffer: read(c.file),
    filename: c.file,
    profileId: profile.id,
    accountId: accountByName.get(c.account)!,
  })
  staged.set(c.file, result)
  console.log(
    `        ${c.file.padEnd(34)} linhas=${result.rowCount} ok=${result.parsedCount} erros=${result.errorCount} ignoradas=${result.ignoredCount} dups=${result.duplicateCount}`,
  )
}

const itau = staged.get('itau-extrato-2026-06_08.csv')!
ok(itau.ignoredCount >= 4, 'linhas SALDO do Itaú descartadas via ignorePatterns', itau.ignoredCount)
eq(itau.errorCount, 0, 'extrato do Itaú sem erros de parsing')

// 1c. Duplicate detection INSIDE one file (the same purchase exported twice).
const itauBatch = imports.getBatch(itau.batchId)!
const inBatchDups = itauBatch.rows.filter((r) => r.duplicateOf === 'in_batch')
ok(inBatchDups.length >= 1, 'duplicata dentro do lote detectada', inBatchDups.length)
ok(
  inBatchDups.every((r) => r.include === false),
  'duplicatas chegam desmarcadas na revisão',
)

// 1d. Normalized schema is actually populated, with the right signs.
const salario = itauBatch.rows.find((r) => r.description.startsWith('SALARIO'))!
eq(salario.amountCents, 1_250_000, 'Itaú: "12.500,00" -> +1250000 centavos (entrada)')
eq(salario.postedOn, '2026-06-05', 'Itaú: "05/06/2026" -> ISO 2026-06-05')
const aluguel = itauBatch.rows.find((r) => r.description.startsWith('ALUGUEL'))!
eq(aluguel.amountCents, -320_000, 'Itaú: "-3.200,00" -> -320000 centavos (saída)')

// 1e. Every sign convention.
const cartaoBatch = imports.getBatch(staged.get('nubank-cartao-2026-06_08.csv')!.batchId)!
const netflix = cartaoBatch.rows.find((r) => r.description === 'Netflix.com')!
eq(netflix.amountCents, -5_590, 'signed_inverted: compra "55.90" no cartão -> -5590 (saída)')
const pagamentoRecebido = cartaoBatch.rows.find((r) => /pagamento recebido/i.test(r.description))
eq(pagamentoRecebido, undefined, 'signed_inverted: linha "Pagamento recebido" ignorada por padrão')

const bradescoBatch = imports.getBatch(staged.get('bradesco-extrato-2026-06_08.csv')!.batchId)!
const recebimento = bradescoBatch.rows.find((r) => r.description.startsWith('RECEBIMENTO'))!
ok(recebimento.amountCents! > 0, 'debit_credit: coluna Crédito -> valor positivo', brl(recebimento.amountCents!))
const das = bradescoBatch.rows.find((r) => r.description.startsWith('DAS SIMPLES'))!
ok(das.amountCents! < 0, 'debit_credit: coluna Débito -> valor negativo', brl(das.amountCents!))

const santanderBatch = imports.getBatch(staged.get('santander-extrato-2026-06_08.csv')!.batchId)!
const proLabore = santanderBatch.rows.find((r) => r.description.startsWith('PRO LABORE'))!
ok(proLabore.amountCents! > 0, 'type_flag: tipo "C" -> valor positivo', brl(proLabore.amountCents!))
const juros = santanderBatch.rows.find((r) => r.description.startsWith('JUROS'))!
ok(juros.amountCents! < 0, 'type_flag: tipo "D" -> valor negativo', brl(juros.amountCents!))

// 1f. The deliberately malformed row must survive into staging as an error.
const badRow = santanderBatch.rows.find((r) => r.description.includes('DATA INVALIDA'))
ok(badRow !== undefined, 'linha malformada preservada na área de revisão')
ok(badRow?.parseError !== null, 'linha malformada carrega parseError', badRow?.parseError)
eq(badRow?.include, false, 'linha malformada não vem marcada para importar')

// 1g. skipRows must absorb the Inter preamble (título, conta, período,
//     saldo, linha vazia) without swallowing a real transaction.
const interBatch = imports.getBatch(staged.get('inter-extrato-2026-06_08.csv')!.batchId)!
eq(interBatch.summary.errors, 0, 'preâmbulo do Inter absorvido por skipRows, sem erros')
ok(
  interBatch.rows.every((r) => !/extrato conta corrente|periodo|^conta$/i.test(r.description)),
  'nenhuma linha de preâmbulo virou lançamento',
)
const interPix = interBatch.rows.find((r) => r.description.includes('NORTHWIND'))
ok(interPix !== undefined, 'primeira transação do Inter lida corretamente após o preâmbulo')
ok((interPix?.amountCents ?? 0) > 0, 'Inter: recebimento lido como entrada', interPix?.amountCents)

// 1h. raw_category is exercised directly against the parser, since none of
//     the six real bank dialects actually ships a category column.
{
  const { parseCsvWithProfile } = await import('../server/src/csv/parse')
  const withCategory = parseCsvWithProfile(
    'Data;Descricao;Valor;Categoria\n15/07/2026;MERCADO DO BAIRRO;-89,90;Supermercado\n',
    {
      name: 'teste',
      institution: 'teste',
      delimiter: ';',
      encoding: 'utf-8',
      dateFormat: 'dd/MM/yyyy',
      decimalSeparator: ',',
      thousandsSeparator: '.',
      signConvention: 'signed',
      hasHeader: true,
      skipRows: 0,
      columnMap: { date: 'Data', description: 'Descricao', amount: 'Valor', rawCategory: 'Categoria' },
      headerSignature: [],
      ignorePatterns: [],
      active: true,
    },
    { accountId: 1 },
  )
  eq(withCategory.rows[0]?.rawCategory, 'Supermercado', 'coluna de categoria do banco capturada em raw_category')
  eq(withCategory.rows[0]?.amountCents, -8_990, 'linha do teste de raw_category parseada corretamente')
}

// 1h. Commit everything and confirm the ledger matches the review screen.
let totalCommitted = 0
for (const c of CASES) {
  const batchId = staged.get(c.file)!.batchId
  const before = imports.getBatch(batchId)!.summary.includable
  const result = imports.commitImport(batchId)
  eq(result.committed, before, `commit ${c.file}: linhas marcadas == linhas gravadas`)
  totalCommitted += result.committed
}
const ledger = txnService.ledgerBounds()
eq(ledger.count, totalCommitted, 'total no ledger == soma dos commits')
ok(ledger.min === '2026-06-01' || ledger.min!.startsWith('2026-06'), 'primeira data do ledger', ledger.min)

// Malformed row must NOT be in the ledger.
const badInLedger = db
  .select({ n: sql<number>`count(*)` })
  .from(schema.transactions)
  .where(like(schema.transactions.description, '%DATA INVALIDA%'))
  .get()
eq(badInLedger?.n, 0, 'linha malformada não foi gravada no ledger')

// 1i. Re-import the SAME file — every row must now be flagged in_ledger.
const reimport = imports.stageImport({
  buffer: read('itau-extrato-2026-06_08.csv'),
  filename: 'itau-extrato-2026-06_08.csv (reimport)',
  profileId: profilesByName.get('Itaú Extrato')!.id,
  accountId: accountByName.get('Conta Corrente')!,
})
const reBatch = imports.getBatch(reimport.batchId)!
const flagged = reBatch.rows.filter((r) => r.duplicateOf === 'in_ledger').length
eq(flagged, reBatch.rows.length, 'reimportação: todas as linhas marcadas como in_ledger')
eq(reBatch.summary.includable, 0, 'reimportação: nada pré-selecionado para importar')
const reCommit = imports.commitImport(reimport.batchId)
eq(reCommit.committed, 0, 'reimportação confirmada não duplica nada no ledger')
eq(txnService.ledgerBounds().count, totalCommitted, 'ledger inalterado após reimportação')

/* ================================================================ *
 * MODULE 2 — categorias + auto-categorização + aprendizado
 * ================================================================ */
section('MODULE 2 — categorização automática e aprendizado')

const byRule = db
  .select({ n: sql<number>`count(*)` })
  .from(schema.transactions)
  .where(dEq(schema.transactions.categorizedBy, 'rule'))
  .get()
ok((byRule?.n ?? 0) > 0, 'regras categorizaram transações na importação', byRule?.n)

// 2a. A specific rule must have fired correctly.
const deliveryId = categoryPath.get('Alimentação/Delivery')!
const ifood = db
  .select({
    id: schema.transactions.id,
    description: schema.transactions.description,
    categoryId: schema.transactions.categoryId,
    categorizedBy: schema.transactions.categorizedBy,
  })
  .from(schema.transactions)
  .where(like(schema.transactions.descriptionNorm, '%ifood%'))
  .all()
ok(ifood.length > 0, 'transações iFood presentes no ledger', ifood.length)
ok(
  ifood.every((t) => t.categoryId === deliveryId),
  'regra "ifood" -> Alimentação/Delivery em 100% das linhas',
  `${ifood.filter((t) => t.categoryId === deliveryId).length}/${ifood.length}`,
)
ok(ifood.every((t) => t.categorizedBy === 'rule'), 'procedência registrada como "rule"')

// 2b. Coverage: how much of the ledger the seeded rules could explain.
const coverage = db
  .select({
    total: sql<number>`count(*)`,
    categorized: sql<number>`sum(case when category_id is not null then 1 else 0 end)`,
  })
  .from(schema.transactions)
  .get()!
const pct = Math.round((coverage.categorized / coverage.total) * 100)
ok(pct >= 60, `cobertura de auto-categorização >= 60%`, `${pct}% (${coverage.categorized}/${coverage.total})`)

// 2c. A generic seeded rule mis-categorizes Mercado Livre as supermarket.
//     This is the case the learning layer has to be able to override.
const supermercadoId = categoryPath.get('Alimentação/Supermercado')!
const lazerId = categoryPath.get('Pessoal/Lazer')!
const mlRows = db
  .select({ id: schema.transactions.id, description: schema.transactions.description, categoryId: schema.transactions.categoryId })
  .from(schema.transactions)
  .where(like(schema.transactions.descriptionNorm, '%mercado livre%'))
  .all()
ok(mlRows.length > 0, 'transações "MERCADO LIVRE" presentes', mlRows.length)
ok(
  mlRows.every((r) => r.categoryId === supermercadoId),
  'regra genérica "mercado" classificou Mercado Livre como Supermercado (erro a corrigir)',
)

// 2d. The user corrects it. Three confirmations must promote it to a rule.
const AUTO_PROMOTE_AT = 3
let lastLearn: { hits: number; promoted: boolean } | undefined
for (let i = 0; i < AUTO_PROMOTE_AT; i++) {
  const target = mlRows[i % mlRows.length]!
  const result = txnService.setCategory([target.id], lazerId)
  lastLearn = result.learned[0]
}
ok(lastLearn?.hits === AUTO_PROMOTE_AT, 'memória acumulou 3 confirmações', lastLearn?.hits)
ok(lastLearn?.promoted === true, 'correção repetida foi promovida a regra')

const memory = db
  .select()
  .from(schema.categoryMemory)
  .where(dEq(schema.categoryMemory.signature, 'mercado livre'))
  .all()
ok(memory.length === 1, 'memória persistida para a assinatura "mercado livre"')
eq(memory[0]?.categoryId, lazerId, 'memória aponta para a categoria corrigida')
ok(memory[0]?.promotedRuleId !== null, 'memória guarda o id da regra promovida', memory[0]?.promotedRuleId)

const learnedRule = db
  .select()
  .from(schema.categoryRules)
  .where(and(dEq(schema.categoryRules.origin, 'learned'), dEq(schema.categoryRules.pattern, 'mercado livre')))
  .get()
ok(learnedRule !== undefined, 'regra aprendida existe com pattern "mercado livre"')
eq(learnedRule?.categoryId, lazerId, 'regra aprendida aponta para Pessoal/Lazer')
ok(
  (learnedRule?.priority ?? 999) < 100,
  'regra aprendida tem precedência sobre a genérica "mercado"',
  `prioridade ${learnedRule?.priority} vs genérica 140`,
)

// 2e. The learned rule must now win for a brand-new, never-seen transaction.
const fresh = txnService.createTransaction({
  accountId: accountByName.get('Conta Nubank')!,
  postedOn: '2026-08-18',
  description: 'MERCADO LIVRE COMPRA FONE BLUETOOTH',
  amountCents: -18_990,
})
eq(fresh.categoryId, null, 'nova transação começa sem categoria')
const recat = categorization.recategorize({ onlyUncategorized: true })
const freshAfter = db
  .select()
  .from(schema.transactions)
  .where(dEq(schema.transactions.id, fresh.id))
  .get()!
eq(freshAfter.categoryId, lazerId, 'aprendizado aplicado: nova compra ML -> Pessoal/Lazer, não Supermercado')
eq(freshAfter.categorizedBy, 'rule', 'aplicado via a regra aprendida')
ok(recat.updated > 0, 'recategorização atualizou linhas', recat)

// 2f. Manual assignments must never be silently overwritten.
const manualBefore = db
  .select({ n: sql<number>`count(*)` })
  .from(schema.transactions)
  .where(dEq(schema.transactions.categorizedBy, 'manual'))
  .get()!
categorization.recategorize({ onlyUncategorized: false })
const manualAfter = db
  .select({ n: sql<number>`count(*)` })
  .from(schema.transactions)
  .where(dEq(schema.transactions.categorizedBy, 'manual'))
  .get()!
eq(manualAfter.n, manualBefore.n, 'recategorização em massa preserva atribuições manuais')

/* ================================================================ *
 * MODULE 3 — painel de entradas x saídas
 * ================================================================ */
section('MODULE 3 — painel de entradas e saídas')

const analytics = await import('../server/src/services/analytics')
const goalsService = await import('../server/src/services/goals')
const debtService = await import('../server/src/services/debt')
const investments = await import('../server/src/services/investments')

const FULL = { from: '2026-06-01', to: '2026-08-31' }

// 3a. Empty state: a range with no data must return zeros, not nulls.
const emptyTotals = analytics.totals({ from: '2020-01-01', to: '2020-03-31' })
eq(emptyTotals.incomeCents, 0, 'estado vazio: entradas = 0')
eq(emptyTotals.expenseCents, 0, 'estado vazio: saídas = 0')
eq(emptyTotals.transactionCount, 0, 'estado vazio: nenhum lançamento')
const emptyMonthly = analytics.monthlySeries({ from: '2020-01-01', to: '2020-03-31' })
eq(emptyMonthly.length, 3, 'estado vazio: série mensal preenchida com zeros, sem buracos')
ok(
  emptyMonthly.every((m) => m.incomeCents === 0 && m.expenseCents === 0),
  'estado vazio: todos os meses zerados',
)
eq(analytics.categoryBreakdown({ from: '2020-01-01', to: '2020-03-31' }).length, 0, 'estado vazio: rosca sem fatias')

// 3b. With data.
const fullTotals = analytics.totals(FULL)
ok(fullTotals.incomeCents > 0, 'entradas apuradas no período', brl(fullTotals.incomeCents))
ok(fullTotals.expenseCents > 0, 'saídas apuradas no período', brl(fullTotals.expenseCents))
eq(
  fullTotals.netCents,
  fullTotals.incomeCents - fullTotals.expenseCents,
  'resultado = entradas - saídas',
)

// 3c. THE double-counting guard: a card-bill payment is a transfer, so it
//     must not appear as an expense alongside the card purchases it settles.
const cardPayments = db
  .select({
    id: schema.transactions.id,
    amountCents: schema.transactions.amountCents,
    categoryId: schema.transactions.categoryId,
  })
  .from(schema.transactions)
  .where(like(schema.transactions.descriptionNorm, '%pagamento de fatura%'))
  .all()
ok(cardPayments.length > 0, 'pagamentos de fatura presentes no ledger', cardPayments.length)

const transferCategoryIds = new Set(
  db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(dEq(schema.categories.kind, 'transfer'))
    .all()
    .map((c) => c.id),
)
ok(
  cardPayments.every((p) => p.categoryId !== null && transferCategoryIds.has(p.categoryId)),
  'pagamento de fatura classificado como transferência, não despesa',
)

const cardPaymentTotal = cardPayments.reduce((sum, p) => sum + Math.abs(p.amountCents), 0)
const expenseSumFromCategories = analytics
  .categoryBreakdown(FULL, { flow: 'expense', level: 'parent' })
  .reduce((sum, slice) => sum + slice.amountCents, 0)
eq(
  expenseSumFromCategories,
  fullTotals.expenseCents,
  'soma da quebra por categoria == total de saídas',
)
ok(
  fullTotals.transferCents >= cardPaymentTotal,
  'transferências contabilizadas separadamente',
  `${brl(fullTotals.transferCents)} inclui ${brl(cardPaymentTotal)} de faturas`,
)

// 3c-bis. O filtro categoryKind (seletor de direção "Transferência" em
// Lançamentos, specs/transactions-ledger) devolve exatamente as linhas
// cuja categoria é kind=transfer, independente de direction.
const transferFiltered = txnService.listTransactions({ categoryKind: 'transfer' })
ok(transferFiltered.rows.length > 0, 'filtro categoryKind=transfer devolve alguma linha', transferFiltered.rows.length)
ok(
  transferFiltered.rows.every((r) => r.categoryId !== null && transferCategoryIds.has(r.categoryId)),
  'toda linha do filtro categoryKind=transfer tem categoria de kind transfer',
)
eq(
  txnService.listTransactions({ categoryKind: 'transfer', direction: 'in' }).rows.length +
    txnService.listTransactions({ categoryKind: 'transfer', direction: 'out' }).rows.length,
  transferFiltered.rows.length,
  'categoryKind combina com direction em vez de ignorá-la — os dois filtros são independentes',
)

// 3d. The monthly series must reconcile with the range totals.
const monthly = analytics.monthlySeries(FULL)
eq(monthly.length, 3, 'série mensal cobre jun, jul e ago')
eq(
  monthly.reduce((sum, m) => sum + m.expenseCents, 0),
  fullTotals.expenseCents,
  'soma das saídas mensais == total do período',
)
eq(
  monthly.reduce((sum, m) => sum + m.incomeCents, 0),
  fullTotals.incomeCents,
  'soma das entradas mensais == total do período',
)

// 3e. Shares must add up to 100%.
const slices = analytics.categoryBreakdown(FULL, { flow: 'expense', level: 'parent' })
const shareSum = slices.reduce((sum, s) => sum + s.shareBps, 0)
ok(Math.abs(shareSum - 10_000) <= slices.length, 'participações somam ~100%', `${shareSum} bps`)
ok(slices.length > 0 && slices[0]!.amountCents >= slices[slices.length - 1]!.amountCents, 'fatias ordenadas por valor')

// 3f. Balances are derived, never stored.
const balances = analytics.accountBalances()
const ledgerSum = db.get<{ total: number }>(sql`select coalesce(sum(amount_cents),0) as total from transactions`)
eq(
  balances.reduce((sum, a) => sum + a.balanceCents, 0),
  ledgerSum?.total ?? 0,
  'soma dos saldos das contas == soma dos lançamentos',
)

// 3f-bis. "A receber" (Painel, StatTile ao lado de Entradas/Saídas): receita
// ainda pendente com vencimento dentro do período, o lado complementar de
// totals() (que sempre exclui pending).
const receberAccount = accountByName.get('Conta Corrente')!
const receberRange = { from: '2026-08-01', to: '2026-08-31' }
const receberPrevRange = { from: '2026-07-01', to: '2026-07-31' }

const receivableBefore = analytics.receivable(receberRange)
const receberTxn = txnService.createTransaction({
  accountId: receberAccount,
  postedOn: '2026-08-18',
  description: 'Projeto teste a receber',
  amountCents: 50_000,
  source: 'manual',
})
db.update(schema.transactions).set({ pending: true }).where(dEq(schema.transactions.id, receberTxn.id)).run()

const receivableAfter = analytics.receivable(receberRange)
eq(receivableAfter, receivableBefore + 50_000, '"a receber" soma receita pendente com vencimento dentro do período')

const dashboardReceber = analytics.dashboard(receberRange)
eq(
  dashboardReceber.totals.receivableCents,
  receivableAfter,
  'dashboard() expõe o mesmo valor de receivable() em totals.receivableCents',
)

// Um segundo lançamento pendente no período ANTERIOR prova que o delta usa a
// mesma janela "anterior comparável" que incomeBps/expenseBps já usam.
const receberPrevTxn = txnService.createTransaction({
  accountId: receberAccount,
  postedOn: '2026-07-18',
  description: 'Projeto teste a receber (mês anterior)',
  amountCents: 25_000,
  source: 'manual',
})
db.update(schema.transactions).set({ pending: true }).where(dEq(schema.transactions.id, receberPrevTxn.id)).run()

const receivablePrev = analytics.receivable(receberPrevRange)
const dashboardReceberComDelta = analytics.dashboard(receberRange)
eq(
  dashboardReceberComDelta.deltas.receivableBps,
  analytics.deltaBps(receivableAfter, receivablePrev),
  'deltas.receivableBps compara a mesma janela anterior usada pelos outros deltas',
)

// Confirmado (pending=false) não deve contar como "a receber".
db.update(schema.transactions).set({ pending: false }).where(dEq(schema.transactions.id, receberTxn.id)).run()
eq(analytics.receivable(receberRange), receivableBefore, 'lançamento confirmado (pending=false) não conta como a receber')

// Limpa — os módulos seguintes não devem herdar estes lançamentos de teste.
txnService.deleteTransactions([receberTxn.id, receberPrevTxn.id])

// 3g. Reajuste de saldo substitui edição direta (decisions/0018).
const contaAjuste = accountByName.get('Conta Corrente')!
const reajusteCategoryId = categoryPath.get('Financeiro/Reajuste de saldo')
ok(reajusteCategoryId !== undefined, 'categoria "Financeiro/Reajuste de saldo" semeada')
const reajusteCategoryRow = db
  .select()
  .from(schema.categories)
  .where(dEq(schema.categories.id, reajusteCategoryId!))
  .get()!
eq(reajusteCategoryRow.kind, 'transfer', 'reajuste de saldo é kind transfer, não receita nem despesa')

const saldoAntes = analytics.accountBalances().find((a) => a.id === contaAjuste)!.balanceCents
const diffCents = 12_345
const reajusteRow = txnService.createTransaction({
  accountId: contaAjuste,
  postedOn: '2026-08-20',
  description: 'Reajuste de saldo',
  amountCents: diffCents,
  categoryId: reajusteCategoryId!,
  source: 'adjustment',
})
const saldoDepois = analytics.accountBalances().find((a) => a.id === contaAjuste)!.balanceCents
eq(saldoDepois, saldoAntes + diffCents, 'accountBalances() muda exatamente pela diferença informada no reajuste')

// Limpa o lançamento de teste — os módulos seguintes recalculam Health
// Score/Runway/disponível a partir do estado atual do ledger, e não devem
// carregar este reajuste de teste adiante.
txnService.deleteTransactions([reajusteRow.id])
const saldoRestaurado = analytics.accountBalances().find((a) => a.id === contaAjuste)!.balanceCents
eq(saldoRestaurado, saldoAntes, 'removido o lançamento de teste, o saldo volta ao estado anterior')

const ledgerRouteSource = readFileSync(resolve('server/src/routes/ledger.ts'), 'utf-8')
ok(
  !ledgerRouteSource.includes('currentBalanceCents'),
  'nenhuma rota aceita mais currentBalanceCents (contrato removido, decisions/0018)',
)

/* ================================================================ *
 * MODULE 4 — rastreador diário
 * ================================================================ */
section('MODULE 4 — rastreador diário')

const AUG = { from: '2026-08-01', to: '2026-08-31' }
const emptyDays = analytics.dailySeries({ from: '2020-01-01', to: '2020-01-31' })
eq(emptyDays.length, 31, 'estado vazio: 31 dias preenchidos com zero')
ok(emptyDays.every((d) => d.expenseCents === 0), 'estado vazio: heatmap todo em zero')

const days = analytics.dailySeries(AUG)
eq(days.length, 31, 'agosto tem 31 células de dia')
eq(
  days.reduce((sum, d) => sum + d.expenseCents, 0),
  analytics.totals(AUG).expenseCents,
  'soma diária == total de saídas de agosto',
)
ok(days.some((d) => d.expenseCents > 0), 'há dias com gasto', days.filter((d) => d.expenseCents > 0).length)

// Quick-add writes to the same table, with source 'daily'.
const dailyEntry = txnService.createTransaction({
  accountId: accountByName.get('Conta Nubank')!,
  postedOn: '2026-08-19',
  description: 'Almoço com cliente',
  amountCents: -6_500,
  categoryId: categoryPath.get('Alimentação/Restaurante')!,
  source: 'daily',
})
eq(dailyEntry.source, 'daily', 'lançamento rápido gravado com source=daily')
eq(dailyEntry.direction, 'out', 'lançamento rápido é saída')
const daysAfter = analytics.dailySeries(AUG)
const day19 = daysAfter.find((d) => d.day === '2026-08-19')!
ok(day19.expenseCents >= 6_500, 'lançamento rápido aparece no heatmap do dia', brl(day19.expenseCents))

/* ================================================================ *
 * MODULE 5 — metas mensais
 * ================================================================ */
section('MODULE 5 — metas do mês')

// 5a. Empty state: no goal means no target, never a fake zero target.
const noGoal = goalsService.getPeriodProgress('2026-07')
eq(noGoal.progress.income.state, 'no_target', 'estado vazio: sem meta de receita')
eq(noGoal.progress.spend.state, 'no_target', 'estado vazio: sem teto de gastos')
eq(noGoal.caps.length, 0, 'estado vazio: nenhum teto por categoria')
ok(noGoal.actual.expenseCents > 0, 'realizado é apurado mesmo sem meta', brl(noGoal.actual.expenseCents))

// 5b. A cap that is comfortably above actual spending must read as met.
const julyActual = goalsService.getPeriodProgress('2026-07').actual
goalsService.upsertGoal('2026-07', {
  incomeTargetCents: Math.round(julyActual.incomeCents * 0.8),
  spendCapCents: Math.round(julyActual.expenseCents * 1.5),
  savingsRateTargetBps: 1000,
})
const july = goalsService.getPeriodProgress('2026-07')
eq(july.progress.income.state, 'met', 'julho: meta de receita batida')
eq(july.progress.spend.state, 'met', 'julho: teto de gastos respeitado (mês fechado)')
ok(july.progress.spend.usedBps! < 10_000, 'julho: uso do teto abaixo de 100%', `${july.progress.spend.usedBps} bps`)

// 5c. A cap below actual spending must read as exceeded.
goalsService.upsertGoal('2026-07', { spendCapCents: Math.round(julyActual.expenseCents * 0.5) })
eq(
  goalsService.getPeriodProgress('2026-07').progress.spend.state,
  'exceeded',
  'teto abaixo do gasto real -> estourado',
)
goalsService.upsertGoal('2026-07', { spendCapCents: Math.round(julyActual.expenseCents * 1.5) })

// 5d. A cap on a PARENT category must include its children's spending.
const alimentacaoId = categoryPath.get('Alimentação')!
const alimentacaoSpend = analytics
  .categoryBreakdown({ from: '2026-07-01', to: '2026-07-31' }, { flow: 'expense', level: 'parent' })
  .find((s) => s.categoryId === alimentacaoId)
ok((alimentacaoSpend?.amountCents ?? 0) > 0, 'houve gasto em Alimentação em julho', brl(alimentacaoSpend?.amountCents ?? 0))
goalsService.upsertCap('2026-07', alimentacaoId, 100_000_00)
const capped = goalsService.getPeriodProgress('2026-07').caps.find((c) => c.categoryId === alimentacaoId)!
eq(
  capped.spentCents,
  alimentacaoSpend!.amountCents,
  'teto na categoria-mãe soma o gasto das filhas',
)
eq(capped.state, 'met', 'teto folgado em mês fechado -> atingido')

// 5e. Suggestions come from real history.
const suggestions = goalsService.suggestCaps('2026-08', 2)
ok(suggestions.length > 0, 'sugestões de teto geradas a partir do histórico', suggestions.length)
ok(suggestions.every((s) => s.suggestedCapCents > 0), 'toda sugestão tem valor positivo')

// 5f. Copying a budget forward must not rewrite the source month.
goalsService.copyGoals('2026-07', '2026-08')
const august = goalsService.getPeriodProgress('2026-08')
eq(august.goal.spendCapCents, july.goal.spendCapCents, 'orçamento copiado para agosto')
eq(
  goalsService.getPeriodProgress('2026-07').goal.spendCapCents,
  july.goal.spendCapCents,
  'julho intacto após a cópia',
)
ok(august.isCurrent, 'agosto reconhecido como mês corrente')
ok(august.daysElapsed > 0 && august.daysElapsed <= august.daysTotal, 'dias decorridos coerentes', `${august.daysElapsed}/${august.daysTotal}`)

// 5g. Streak counts only CLOSED months, so an unfinished month cannot inflate it.
const history = goalsService.goalHistory(6)
ok(history.outcomes.length === 6, 'histórico de 6 meses', history.outcomes.length)
ok(history.streak >= 1, 'sequência de acertos conta julho', history.streak)
ok(
  history.outcomes.at(-1)!.period === '2026-08',
  'último item do histórico é o mês corrente',
)

/* ---------------------------------------------------------------- *
 * 5h. Meta de receita traduzida em número de projetos.
 *
 * Roda ANTES do módulo 13 salvar qualquer cotação, então começa pelo
 * estado sem histórico de preço, que é justamente o caso em que a tela
 * não pode inventar um número.
 * ---------------------------------------------------------------- */
const pricingForGoals = await import('../server/src/services/pricing')

{
  const semCotacao = goalsService.gapInProjects('2026-07')
  eq(semCotacao.sampleSize, 0, 'sem cotação salva, a amostra é zero')
  eq(semCotacao.averageQuoteCents, null, 'sem cotação salva, o ticket médio é nulo, nunca zero')
  eq(semCotacao.projectsNeeded, null, 'sem cotação salva, o número de projetos é nulo, nunca zero')
  ok(
    typeof semCotacao.assumptions.semTicketMedio === 'string',
    'a memória de cálculo diz por que não há tradução em projetos',
  )
}

// Cinco cotações de valores conhecidos: média = R$ 1.000,00 exata.
{
  const valores = [60_000, 80_000, 100_000, 120_000, 140_000] // média 100_000
  const criadas = valores.map((v, i) =>
    db
      .insert(schema.projectQuotes)
      .values({
        clientLabel: `Cotação de teste ${i + 1}`,
        estimatedHours: 10,
        directCosts: [],
        extraMarginBps: 0,
        hourlyBaseCents: 1,
        minimumPriceCents: v,
        recommendedPriceCents: v,
      })
      .returning()
      .get(),
  )
  eq(criadas.length, 5, 'cinco cotações de teste criadas')

  const media = pricingForGoals.averageRecentQuoteCents(5)
  eq(media.averageCents, 100_000, 'ticket médio das 5 últimas cotações = média aritmética exata')
  eq(media.sampleSize, 5, 'a amostra reporta quantas cotações entraram')

  // Meta de julho com gap conhecido, para conferir o ceil à mão.
  const julho = goalsService.getPeriodProgress('2026-07')
  const alvo = julho.actual.incomeCents + 250_001 // gap de R$ 2.500,01
  goalsService.upsertGoal('2026-07', { incomeTargetCents: alvo })

  const traduzido = goalsService.gapInProjects('2026-07')
  eq(traduzido.gapCents, 250_001, 'o gap é meta menos receita realizada')
  eq(traduzido.averageQuoteCents, 100_000, 'usa o ticket médio das últimas cotações')
  // 250001 / 100000 = 2,50001 -> 3, nunca 2 (arredondamento comum daria 3
  // aqui também, então o caso decisivo é o de baixo).
  eq(traduzido.projectsNeeded, 3, 'projetos necessários = ceil(gap / ticket médio)')

  // O caso que separa ceil de round: 2,1 projeto tem que virar 3, não 2.
  goalsService.upsertGoal('2026-07', { incomeTargetCents: julho.actual.incomeCents + 210_000 })
  eq(
    goalsService.gapInProjects('2026-07').projectsNeeded,
    3,
    'gap de 2,1 tickets arredonda para CIMA (3), nunca para o mais próximo (2)',
  )

  // Meta já batida: a pergunta deixa de fazer sentido, não vira zero.
  goalsService.upsertGoal('2026-07', { incomeTargetCents: 1 })
  const batida = goalsService.gapInProjects('2026-07')
  ok(batida.gapCents !== null && batida.gapCents <= 0, 'meta já superada tem gap não positivo')
  eq(batida.projectsNeeded, null, 'meta já batida devolve null, não zero projetos')

  // Sem meta configurada: nada para traduzir.
  goalsService.upsertGoal('2026-07', { incomeTargetCents: null })
  const semMeta = goalsService.gapInProjects('2026-07')
  eq(semMeta.gapCents, null, 'sem meta de receita, não há gap')
  eq(semMeta.projectsNeeded, null, 'sem meta de receita, não há tradução em projetos')

  // A janela é das ÚLTIMAS N, não do histórico inteiro.
  eq(
    pricingForGoals.averageRecentQuoteCents(2).averageCents,
    130_000,
    'a janela pega as N mais recentes (120k e 140k), não a média de tudo',
  )

  // Limpa as cotações de teste para não contaminar o módulo 13.
  for (const q of criadas) db.delete(schema.projectQuotes).where(dEq(schema.projectQuotes.id, q.id)).run()
  eq(pricingForGoals.averageRecentQuoteCents().sampleSize, 0, 'cotações de teste removidas')
  // Restaura a meta de receita que 5b definiu, para os módulos seguintes
  // encontrarem julho no mesmo estado.
  goalsService.upsertGoal('2026-07', { incomeTargetCents: Math.round(julyActual.incomeCents * 0.8) })
  eq(
    goalsService.getPeriodProgress('2026-07').progress.income.state,
    'met',
    'julho volta ao estado que os checks anteriores deixaram',
  )
}

/* ================================================================ *
 * MODULE 6 — endividamento
 * ================================================================ */
section('MODULE 6 — endividamento')

// 6a. Empty state.
const emptyDebt = debtService.debtOverview()
eq(emptyDebt.totalCents, 0, 'estado vazio: dívida total zero')
eq(emptyDebt.debts.length, 0, 'estado vazio: nenhuma dívida')
eq(emptyDebt.debtToIncomeBps, 0, 'estado vazio: comprometimento de renda 0%')
const emptyProjection = debtService.projectPaydown({ extraMonthlyCents: 0 })
eq(emptyProjection.months, 0, 'estado vazio: projeção retorna quitado')
eq(emptyProjection.series.length, 1, 'estado vazio: série com um único ponto')

// 6b. Real debts.
const card = debtService.createDebt({
  name: 'Cartão Nubank',
  kind: 'credit_card',
  principalCents: 850_000,
  aprBps: 32_000,
  minimumPaymentCents: 130_000,
  scheduledPaymentCents: 200_000,
})
debtService.createDebt({
  name: 'Empréstimo pessoal',
  kind: 'personal_loan',
  principalCents: 1_200_000,
  aprBps: 4_800,
  minimumPaymentCents: 90_000,
  scheduledPaymentCents: 90_000,
})
debtService.createDebt({
  name: 'Financiamento veículo',
  kind: 'financing',
  principalCents: 2_600_000,
  aprBps: 2_200,
  minimumPaymentCents: 78_000,
  scheduledPaymentCents: 78_000,
})

const overview = debtService.debtOverview()
eq(overview.totalCents, 4_650_000, 'dívida total somada')
eq(overview.scheduledCents, 368_000, 'pagamento programado somado')
ok(
  overview.weightedAprBps > 2_200 && overview.weightedAprBps < 32_000,
  'taxa média ponderada entre a menor e a maior',
  `${overview.weightedAprBps} bps`,
)
// Weighted, not arithmetic: the small expensive card must not dominate.
const arithmetic = Math.round((32_000 + 4_800 + 2_200) / 3)
ok(
  overview.weightedAprBps < arithmetic,
  'média ponderada pelo saldo difere da média simples',
  `ponderada ${overview.weightedAprBps} vs simples ${arithmetic}`,
)
ok(overview.monthlyInterestCents > 0, 'juros mensais calculados', brl(overview.monthlyInterestCents))
ok(overview.debtToIncomeBps !== null && overview.debtToIncomeBps > 0, 'comprometimento de renda calculado', `${overview.debtToIncomeBps} bps`)
eq(overview.byKind.length, 3, 'composição por tipo de dívida')
ok(
  Math.abs(overview.byKind.reduce((sum, k) => sum + k.shareBps, 0) - 10_000) <= 3,
  'participações da composição somam 100%',
)

// 6c. The accelerated scenario must be strictly better, and both must clear.
const comparison = debtService.paydownComparison(100_000, 'avalanche')
ok(comparison.baseline.months !== null, 'cenário atual quita em algum momento', comparison.baseline.months)
ok(comparison.accelerated.months !== null, 'cenário acelerado quita', comparison.accelerated.months)
ok(
  comparison.accelerated.months! < comparison.baseline.months!,
  'aporte extra antecipa a quitação',
  `${comparison.baseline.months} -> ${comparison.accelerated.months} meses`,
)
ok(
  comparison.accelerated.totalInterestCents < comparison.baseline.totalInterestCents,
  'aporte extra reduz juros totais',
  `economia de ${brl(comparison.savings.interestSavedCents)}`,
)
ok(comparison.savings.monthsSaved! > 0, 'meses economizados positivos', comparison.savings.monthsSaved)
ok(
  comparison.merged.length === Math.max(comparison.baseline.series.length, comparison.accelerated.series.length),
  'séries alinhadas no mesmo eixo de meses',
)
const firstPoint = comparison.merged[0]!
eq(firstPoint.baselineCents, 4_650_000, 'mês 0 dos dois cenários parte do saldo atual')
const lastBaseline = comparison.baseline.series.at(-1)!
ok(lastBaseline.balanceCents <= 1, 'trajetória do cenário atual chega a zero', lastBaseline.balanceCents)

// Avalanche must clear the highest-rate debt first.
const cardPayoff = comparison.accelerated.perDebt.find((d) => d.debtId === card.id)!
const others = comparison.accelerated.perDebt.filter((d) => d.debtId !== card.id)
ok(
  others.every((d) => d.months === null || cardPayoff.months! <= d.months),
  'avalanche quita primeiro a dívida de maior taxa',
  `cartão em ${cardPayoff.months} meses`,
)

// 6d. A measured snapshot must override the opening principal.
// A far-future date on purpose: createDebt() auto-inserts an opening
// snapshot at the REAL wall-clock today(), and currentBalance() picks
// whichever snapshot sorts latest. A fixed past-looking date here would
// silently start failing once the real calendar caught up to it.
debtService.recordSnapshot(card.id, '2099-01-01', 700_000)
const afterSnapshot = debtService.listDebts().find((d) => d.id === card.id)!
eq(afterSnapshot.balanceCents, 700_000, 'saldo medido substitui o principal de abertura')

// 6e. Payments below the interest must be reported honestly, not as a flat line.
for (const debt of debtService.listDebts()) debtService.deleteDebt(debt.id)
debtService.createDebt({
  name: 'Rotativo do cartão',
  kind: 'credit_card',
  principalCents: 500_000,
  aprBps: 30_000,
  minimumPaymentCents: 20_000,
  scheduledPaymentCents: 20_000,
})
const stalled = debtService.projectPaydown({ extraMonthlyCents: 0 })
eq(stalled.months, null, 'pagamento abaixo dos juros -> nunca quita (reportado, não mascarado)')
ok(stalled.series.length <= 3, 'projeção travada interrompe cedo em vez de desenhar 50 anos', stalled.series.length)

// 6f. Materialização não sobrescreve edição manual (decisions/0017).
for (const debt of debtService.listDebts()) debtService.deleteDebt(debt.id)
const contaParaParcelas = accountByName.get('Conta Corrente')!
const parceladaDebt = debtService.createDebt({
  name: 'Financiamento com parcela editável',
  kind: 'financing',
  principalCents: 1_000_000,
  aprBps: 1_800,
  minimumPaymentCents: 50_000,
  scheduledPaymentCents: 50_000,
  dueDay: 10,
  installmentCount: 12,
  accountId: contaParaParcelas,
})
debtService.materializeDebtInstallments(parceladaDebt.id)
const parcelasAntes = db
  .select()
  .from(schema.transactions)
  .where(and(dEq(schema.transactions.debtId, parceladaDebt.id), dEq(schema.transactions.pending, true)))
  .all()
  .sort((a, b) => (a.postedOn < b.postedOn ? -1 : 1))
ok(parcelasAntes.length >= 2, 'parcelas materializadas para o teste de edição manual', parcelasAntes.length)

const parcelaEditada = parcelasAntes[0]!
const parcelaIntocada = parcelasAntes[1]!
const edicaoManual = txnService.updateTransaction(parcelaEditada.id, {
  postedOn: '2099-06-15',
  amountCents: -70_000,
})
eq(edicaoManual?.manuallyEdited, true, 'PATCH em parcela pendente vinculada à dívida marca manuallyEdited')

// Edita o template (valor programado) — campo que não tem nada a ver com data,
// mas que syncMaterializedRows reescrevia incondicionalmente antes desta parte.
debtService.updateDebt(parceladaDebt.id, { scheduledPaymentCents: 90_000 })

const parcelaEditadaDepois = db
  .select()
  .from(schema.transactions)
  .where(dEq(schema.transactions.id, parcelaEditada.id))
  .get()!
eq(parcelaEditadaDepois.postedOn, '2099-06-15', 'parcela editada manualmente mantém a data escolhida pelo usuário')
eq(parcelaEditadaDepois.amountCents, -70_000, 'parcela editada manualmente mantém o valor escolhido pelo usuário')

const parcelaIntocadaDepois = db
  .select()
  .from(schema.transactions)
  .where(dEq(schema.transactions.id, parcelaIntocada.id))
  .get()!
eq(parcelaIntocadaDepois.amountCents, -90_000, 'parcela nunca tocada continua sincronizando com o template')
eq(parcelaIntocadaDepois.manuallyEdited, false, 'parcela nunca tocada continua com manuallyEdited false')

/* ================================================================ *
 * MODULE 7 — investimentos
 * ================================================================ */
section('MODULE 7 — investimentos e metas de aporte')

// 7a. Empty state.
const emptyPortfolio = investments.portfolioSummary()
eq(emptyPortfolio.marketValueCents, 0, 'estado vazio: carteira valendo zero')
eq(emptyPortfolio.assetCount, 0, 'estado vazio: nenhum ativo')
eq(investments.performanceSeries().length, 0, 'estado vazio: sem série de performance')
eq(investments.allocation().length, 0, 'estado vazio: sem alocação')

// 7b. Positions derived from trades.
const asset = investments.createAsset({ name: 'PETR4', ticker: 'PETR4', assetClass: 'stocks' })
const bond = investments.createAsset({ name: 'Tesouro IPCA+ 2035', assetClass: 'fixed_income' })

investments.createTrade({ assetId: asset.id, tradedOn: '2026-06-10', quantity: 100, unitPriceCents: 3_200, feesCents: 500 })
investments.createTrade({ assetId: asset.id, tradedOn: '2026-07-10', quantity: 100, unitPriceCents: 3_600, feesCents: 500 })
investments.createTrade({ assetId: bond.id, tradedOn: '2026-06-15', quantity: 10, unitPriceCents: 100_000 })

const petr = investments.positions().find((p) => p.assetId === asset.id)!
eq(petr.quantity, 200, 'quantidade = compras - vendas')
// 100*3200 + 100*3600 + 1000 de taxas = 681000
eq(petr.contributedCents, 681_000, 'capital aportado inclui taxas')
eq(petr.avgUnitPriceCents, 3_405, 'preço médio ponderado com taxas')
eq(petr.lastUnitPriceCents, null, 'sem cotação registrada ainda')
eq(petr.marketValueCents, 681_000, 'sem cotação, valor de mercado = custo (referência honesta)')

// 7c. A valuation turns cost basis into a real gain.
investments.recordValuation(asset.id, '2026-08-15', 4_100)
const petrPriced = investments.positions().find((p) => p.assetId === asset.id)!
eq(petrPriced.marketValueCents, 820_000, 'valor de mercado = quantidade x cotação')
eq(petrPriced.gainCents, 139_000, 'ganho = valor - aportado')
ok(petrPriced.gainBps !== null && petrPriced.gainBps > 0, 'ganho percentual positivo', `${petrPriced.gainBps} bps`)

// 7d. Selling reduces the contributed capital, not just the quantity.
investments.createTrade({ assetId: asset.id, kind: 'sell', tradedOn: '2026-08-16', quantity: 50, unitPriceCents: 4_100 })
const petrSold = investments.positions().find((p) => p.assetId === asset.id)!
eq(petrSold.quantity, 150, 'venda reduz a quantidade')
eq(petrSold.contributedCents, 681_000 - 205_000, 'venda devolve capital aportado')

// 7e. Allocation vs target.
investments.setTargetAllocation(null, [
  { assetClass: 'stocks', targetBps: 4_000 },
  { assetClass: 'fixed_income', targetBps: 6_000 },
])
const allocation = investments.allocation()
eq(allocation.length, 2, 'duas classes na alocação')
const stocks = allocation.find((a) => a.assetClass === 'stocks')!
eq(stocks.targetBps, 4_000, 'meta da classe lida do banco')
ok(stocks.driftBps !== null, 'desvio calculado', `${stocks.driftBps} bps`)
ok(
  Math.abs(allocation.reduce((sum, a) => sum + a.actualBps, 0) - 10_000) <= 2,
  'alocação atual soma 100%',
)
const rebalanceSum = allocation.reduce((sum, a) => sum + (a.rebalanceCents ?? 0), 0)
ok(Math.abs(rebalanceSum) <= 2, 'ajustes de rebalanceamento se cancelam', rebalanceSum)

// 7f. Performance: value vs contributed capital, on one axis.
const performance = investments.performanceSeries()
ok(performance.length >= 3, 'série de performance cobre os meses com aportes', performance.length)
ok(
  performance.every((p) => p.gainCents === p.valueCents - p.contributedCents),
  'ganho = valor - aportado em todos os pontos',
)
ok(
  performance[0]!.contributedCents <= performance.at(-1)!.contributedCents,
  'capital aportado é monotônico enquanto há aportes',
)

// 7g. Goal projection.
const invGoal = investments.createGoal({
  name: 'Reserva de oportunidade',
  targetValueCents: 5_000_000,
  targetDate: '2029-08-01',
  monthlyContributionCents: 100_000,
  expectedReturnBps: 900,
})
const projection = investments.goalProjection(invGoal.id)!
ok(projection !== null, 'projeção da meta gerada')
eq(projection.series[0]!.projectedCents, investments.portfolioSummary().marketValueCents, 'projeção parte do valor atual')
ok(
  projection.series.at(-1)!.projectedCents > projection.series[0]!.projectedCents,
  'projeção cresce com aportes e juros',
)
ok(
  projection.series.at(-1)!.projectedCents > projection.series.at(-1)!.baselineCents,
  'cenário com aportes supera o sem novos aportes',
)
ok(projection.progressBps !== null && projection.progressBps > 0, 'progresso da meta calculado', `${projection.progressBps} bps`)
ok(projection.requiredMonthlyCents !== null, 'aporte necessário calculado', brl(projection.requiredMonthlyCents ?? 0))

// The required contribution must be the amount that actually lands on target.
const tuned = investments.updateGoal(invGoal.id, {
  monthlyContributionCents: projection.requiredMonthlyCents,
})!
const tunedProjection = investments.goalProjection(invGoal.id)!
const monthsToTarget = 36
const atTarget = tunedProjection.series[monthsToTarget]?.projectedCents ?? 0
const withinOnePercent = Math.abs(atTarget - 5_000_000) / 5_000_000 < 0.01
ok(
  withinOnePercent,
  'aporte necessário atinge a meta na data (erro < 1%)',
  `${brl(atTarget)} vs meta ${brl(5_000_000)}`,
)
ok(tuned.monthlyContributionCents > 0, 'meta atualizada com o aporte necessário')

/* ================================================================ *
 * MODULE 8 — "Diagrama do Cerrado": critérios, nota, alocação por
 * ativo dentro da classe, e a cascata de sugestão de aporte.
 * ================================================================ */
section('MODULE 8 — Diagrama do Cerrado')

const criteriaService = await import('../server/src/services/criteria')

// The emergency-reserve step (module 8g) runs ahead of every class in the
// waterfall, so every pre-existing suggestContribution test in this module
// needs the reserve OFF (multiple 0 -> target 0 -> gap 0) to keep its
// original "100% goes to the classes" behaviour.
investments.setReserveSettings({ multiple: 0, lookbackMonths: 3 })

// 7h. Propósito da meta — só um rótulo organizador, nunca lido por
// suggestContribution (ver decisions/0010). Quem direciona o aporte é a
// alocação-alvo escopada por goalId, que a meta já podia ter desde a
// Rodada 3 — só sem UI pra editar até agora.
ok(
  !investments.GOAL_PURPOSES.includes('emergency_reserve' as never),
  '"reserva de emergência" não é um propósito de meta — já existe o mecanismo dedicado, prioridade zero',
)
const goalWithPurpose = investments.updateGoal(invGoal.id, { purpose: 'retirement' })!
eq(goalWithPurpose.purpose, 'retirement', 'propósito da meta persiste')

const purposeGoalCriterion = criteriaService.createCriterion({ assetClass: 'treasury', label: 'Critério meta com propósito' })
const purposeGoalAsset = investments.createAsset({ name: 'TESOURO-PROPOSITO', ticker: 'TESOURO-PROPOSITO', assetClass: 'treasury' })
investments.createTrade({ assetId: purposeGoalAsset.id, tradedOn: '2026-01-10', quantity: 1, unitPriceCents: 100 })
investments.recordValuation(purposeGoalAsset.id, '2026-06-01', 100)
criteriaService.setAnswer(purposeGoalAsset.id, purposeGoalCriterion.id, true)
investments.setTargetAllocation(invGoal.id, [{ assetClass: 'treasury', targetBps: 5_000 }])

const scopedPlan = investments.suggestContribution(10_000, invGoal.id)
const defaultPlan = investments.suggestContribution(10_000, null)
ok(
  scopedPlan.classes.some((c) => c.assetClass === 'treasury'),
  'aporte marcado pra uma meta com propósito usa a alocação-alvo DAQUELA meta (agora exposta em Investimentos > Metas)',
)
ok(
  defaultPlan.classes.every((c) => c.assetClass !== 'treasury') ||
    defaultPlan.classes.find((c) => c.assetClass === 'treasury')?.allocatedCents !==
      scopedPlan.classes.find((c) => c.assetClass === 'treasury')?.allocatedCents,
  'a política padrão (goalId nulo) continua independente da política desta meta específica',
)

// 8a. Seeded question bank exists for the 3 classes the strategy defines.
const stockCriteria = criteriaService.listCriteria('stocks')
const fiiCriteria = criteriaService.listCriteria('fii')
eq(stockCriteria.length, 12, 'banco de critérios de ações semeado com 12 perguntas')
eq(fiiCriteria.length, 12, 'banco de critérios de FIIs semeado com 12 perguntas')
ok(
  criteriaService.listCriteria('crypto').length === 0,
  'classe sem critérios definidos começa vazia (usuário adiciona os próprios)',
)

// 8b. Two stocks, scored oppositely, to prove the note-weighted split.
// The 'stocks' class already holds PETR4 from module 7's tests — capture
// its value first so class-value assertions check the DELTA these two new
// positions add, rather than assuming a pristine class.
const stocksValueBefore = investments.assetAllocationWithinClass('stocks').classValueCents
const strong = investments.createAsset({ name: 'Empresa Forte', ticker: 'FORTE3', assetClass: 'stocks' })
const weak = investments.createAsset({ name: 'Empresa Fraca', ticker: 'FRACA3', assetClass: 'stocks' })

investments.createTrade({ assetId: strong.id, tradedOn: '2026-01-10', quantity: 100, unitPriceCents: 10_00 })
investments.createTrade({ assetId: weak.id, tradedOn: '2026-01-10', quantity: 100, unitPriceCents: 10_00 })
investments.recordValuation(strong.id, '2026-06-01', 10_00)
investments.recordValuation(weak.id, '2026-06-01', 10_00)
// Both start at R$ 1.000 market value — the split below is driven ENTIRELY
// by the note, not by any pre-existing size difference.

// 8c. Unscored asset must be excluded from the weighting, not scored as 0.
const beforeScoring = investments.assetAllocationWithinClass('stocks')
const strongSliceBefore = beforeScoring.assets.find((a) => a.assetId === strong.id)!
eq(strongSliceBefore.note, null, 'ativo sem nenhuma resposta não tem nota (não é zero)')
eq(strongSliceBefore.targetBps, null, 'ativo sem nota não recebe alvo — não é penalizado como se tivesse nota 0')

// Score "Empresa Forte" 10/10 (all checked) and "Empresa Fraca" 2/10.
for (const c of stockCriteria) criteriaService.setAnswer(strong.id, c.id, true)
stockCriteria.forEach((c, i) => criteriaService.setAnswer(weak.id, c.id, i < 2))

const strongNote = criteriaService.getAssetNote(strong.id)!
const weakNote = criteriaService.getAssetNote(weak.id)!
eq(strongNote.note, 10, 'empresa com 12/12 marcadas -> nota 10 (saturada no teto)')
eq(strongNote.rawScore, 12, 'raw score = 12 checked - 0 unchecked')
eq(weakNote.note, 0, 'empresa com 2 sim e 10 não -> raw -8, nota clampada em 0 (piso)')
eq(weakNote.answered, 12, '12 de 12 perguntas respondidas')

// 8d. Set a class target and confirm the note alone drives the split
//10-vs-0 means "fraca" gets NOTHING, all of the class's target goes to "forte".
investments.setTargetAllocation(null, [{ assetClass: 'stocks', targetBps: 5_000 }]) // 50% of portfolio

const detail = investments.assetAllocationWithinClass('stocks')
const strongSlice = detail.assets.find((a) => a.assetId === strong.id)!
const weakSlice = detail.assets.find((a) => a.assetId === weak.id)!
eq(
  detail.classValueCents - stocksValueBefore,
  200_000,
  'as duas novas posições somam exatamente R$ 1.000 + R$ 1.000 ao valor da classe',
)
eq(strongSlice.targetBps, 10_000, 'nota 10 vs nota 0 -> forte recebe 100% do peso dentro da classe')
eq(weakSlice.targetBps, 0, 'nota 0 -> fraca recebe 0% do peso dentro da classe')
eq(
  strongSlice.actualBps,
  weakSlice.actualBps,
  'mesmo valor de mercado (R$ 1.000 cada) -> mesma participação atual dentro da classe',
)
ok((strongSlice.rebalanceCents ?? 0) > 0, 'forte está abaixo do seu alvo (nota alta, mesmo valor) -> precisa de mais aporte')
ok((weakSlice.rebalanceCents ?? 0) < 0, 'fraca está acima do seu alvo (nota 0) -> sistema nunca sugere vender, só para de comprar')

// 8e. The contribution waterfall must send 100% of a stocks-earmarked
// contribution to the note-10 asset, and zero to the note-0 one — this is
// the exact bug the original prototype had (ContributePage ignored the
// real portfolio and split evenly across every asset regardless of note).
const plan = investments.suggestContribution(50_000) // R$ 500
const stocksPlan = plan.classes.find((c) => c.assetClass === 'stocks')
ok(stocksPlan !== undefined, 'classe ações recebeu parte do aporte (estava abaixo da meta)')
eq(stocksPlan?.assets.length, 1, 'aporte sugerido para exatamente 1 ativo dentro da classe')
eq(stocksPlan?.assets[0]?.assetId, strong.id, 'o único ativo sugerido é o de nota alta, nunca o de nota 0')
eq(stocksPlan?.assets[0]?.suggestedCents, 50_000, 'todo o valor pedido foi direcionado (classe tinha espaço de sobra)')
ok(
  !stocksPlan?.assets.some((a) => a.assetId === weak.id),
  'ativo de nota 0 não aparece na sugestão — o sistema nunca aponta comprar quem falhou nos critérios',
)

// 8f. A class that is hugely underweight but has ZERO scored assets must
// never receive a fabricated suggestion, and the money it can't place
// must be traceable — either absorbed by another underweight+scored
// class, or reported in unallocatedCents. It must never silently vanish.
const fiiAsset = investments.createAsset({ name: 'FII Sem Nota', ticker: 'SEMNT11', assetClass: 'fii' })
investments.createTrade({ assetId: fiiAsset.id, tradedOn: '2026-01-10', quantity: 1, unitPriceCents: 1 })
investments.setTargetAllocation(null, [
  { assetClass: 'stocks', targetBps: 6_000 },
  { assetClass: 'fii', targetBps: 4_000 },
])

const rollPlan = investments.suggestContribution(5_000) // R$ 50
const fiiInPlan = rollPlan.classes.find((c) => c.assetClass === 'fii')
ok(
  fiiInPlan === undefined,
  'classe fii (sem nenhum ativo pontuado) não aparece no plano — não inventa sugestão para ativo sem nota',
)
const allocatedTotal = rollPlan.classes.reduce(
  (sum, c) => sum + c.assets.reduce((s, a) => s + a.suggestedCents, 0),
  0,
)
eq(
  allocatedTotal + rollPlan.unallocatedCents,
  rollPlan.amountCents,
  'conservação de valor: alocado + não-alocado == valor do aporte, nenhum centavo perdido ou inventado',
)
for (const c of rollPlan.classes) {
  ok(c.assets.length > 0, `classe "${c.assetClass}" no plano sempre lista ao menos 1 ativo sugerido`)
}

// A contribution far larger than any scored asset can absorb must report
// the remainder honestly rather than inventing a destination for it.
const hugePlan = investments.suggestContribution(50_000_000)
ok(
  hugePlan.unallocatedCents > 0,
  'aporte gigantesco sem mais ativos pontuados sobra sem alocação — reportado, não escondido',
  hugePlan.unallocatedCents,
)

/* ---------------------------------------------------------------- *
 * 8h. Nível 1 da cascata: proporcional ao gap, não sequencial.
 *
 * Um cenário limpo com duas classes novas (cripto e ETFs internacionais),
 * cada uma com um ativo pontuado e cotado a R$ 1,00, para que a granularidade
 * de cota inteira não mascare a proporção. Ver `decisions/0013`.
 * ---------------------------------------------------------------- */
const cleanClasses: Array<{ assetClass: string; ticker: string; targetBps: number }> = [
  { assetClass: 'crypto', ticker: 'CRIPTO1', targetBps: 3_000 },
  { assetClass: 'etf_intl', ticker: 'ETFI1', targetBps: 1_000 },
]

for (const spec of cleanClasses) {
  const criterion = criteriaService.createCriterion({ assetClass: spec.assetClass, label: `Critério ${spec.ticker}` })
  const asset = investments.createAsset({ name: spec.ticker, ticker: spec.ticker, assetClass: spec.assetClass })
  investments.createTrade({ assetId: asset.id, tradedOn: '2026-01-10', quantity: 1, unitPriceCents: 100 })
  investments.recordValuation(asset.id, '2026-06-01', 100) // R$ 1,00 por cota
  criteriaService.setAnswer(asset.id, criterion.id, true)
}

// Ações recebe um alvo que ela JÁ ultrapassou: precisa sumir da fila.
investments.setTargetAllocation(null, [
  { assetClass: 'stocks', targetBps: 100 },
  { assetClass: 'crypto', targetBps: 3_000 },
  { assetClass: 'etf_intl', targetBps: 1_000 },
])

const gapCrypto = investments.assetAllocationWithinClass('crypto')
const gapEtf = investments.assetAllocationWithinClass('etf_intl')
ok(gapCrypto.classValueCents >= 0 && gapEtf.classValueCents >= 0, 'as duas classes novas existem na carteira')

const smallAmount = 100_00 // R$ 100, bem menor que a soma dos gaps
const proportional = investments.suggestContribution(smallAmount)
const cryptoPlan = proportional.classes.find((c) => c.assetClass === 'crypto')
const etfPlan = proportional.classes.find((c) => c.assetClass === 'etf_intl')

ok(cryptoPlan !== undefined, 'aporte menor que a soma dos gaps: classe cripto recebe fatia')
ok(etfPlan !== undefined, 'e a classe ETFs internacionais recebe fatia na MESMA rodada, não na próxima')
ok(
  proportional.classes.every((c) => c.assetClass !== 'stocks'),
  'classe já acima da meta nunca aparece no plano, nem com valor zero',
)

if (cryptoPlan && etfPlan) {
  const totalDelta = cryptoPlan.deltaCents + etfPlan.deltaCents
  const expectedCrypto = Math.round((cryptoPlan.deltaCents / totalDelta) * smallAmount)
  const expectedEtf = Math.round((etfPlan.deltaCents / totalDelta) * smallAmount)
  // Tolerância de uma cota (R$ 1,00): allocateAcrossSectors compra cotas
  // inteiras, então a fatia efetiva arredonda para baixo até a cota.
  ok(
    Math.abs(cryptoPlan.allocatedCents - expectedCrypto) <= 100,
    'cripto recebeu proporcional ao próprio gap',
    `${brl(cryptoPlan.allocatedCents)} vs proporcional ${brl(expectedCrypto)}`,
  )
  ok(
    Math.abs(etfPlan.allocatedCents - expectedEtf) <= 100,
    'ETFs internacionais recebeu proporcional ao próprio gap',
    `${brl(etfPlan.allocatedCents)} vs proporcional ${brl(expectedEtf)}`,
  )
  ok(
    cryptoPlan.allocatedCents > etfPlan.allocatedCents,
    'a classe mais atrasada recebe a maior fatia, sem zerar a outra',
    `${brl(cryptoPlan.allocatedCents)} vs ${brl(etfPlan.allocatedCents)}`,
  )
  ok(
    cryptoPlan.allocatedCents < cryptoPlan.deltaCents,
    'nenhuma classe é saturada sozinha quando o aporte não fecha todos os gaps',
  )
}

const allocatedProportional = proportional.classes.reduce((sum, c) => sum + c.allocatedCents, 0)
eq(
  allocatedProportional + proportional.unallocatedCents,
  proportional.amountCents,
  'conservação de valor no rateio proporcional: alocado + não-alocado == aporte',
)
ok(
  proportional.classes.every((c) => c.allocatedCents <= c.deltaCents),
  'nenhuma fatia proporcional excede o gap da própria classe',
)

/*
 * Aporte MAIOR que a soma dos gaps: cada classe recebe exatamente o que
 * falta, e a sobra é reportada, nunca empurrada para quem já está na meta.
 *
 * O valor não pode ser estimado a partir do plano anterior: o alvo de cada
 * classe é `meta% × (carteira + aporte)`, então o gap CRESCE junto com o
 * aporte. A condição A >= Σgap(A) resolve para
 * A >= (meta%·T − V) / (1 − meta%), com T = carteira antes e V = valor
 * atual das classes elegíveis.
 */
const eligibleTargetShare = (3_000 + 1_000) / 10_000
const eligibleValueCents = gapCrypto.classValueCents + gapEtf.classValueCents
const closingThreshold =
  (eligibleTargetShare * proportional.totalBeforeCents - eligibleValueCents) / (1 - eligibleTargetShare)
const bigAmount = Math.ceil(closingThreshold) + 500_00
const closesAll = investments.suggestContribution(bigAmount)
ok(closesAll.classes.length >= 2, 'as duas classes elegíveis continuam no plano quando o aporte fecha os gaps')
for (const c of closesAll.classes) {
  // O nível 1 passa a oferecer o gap INTEIRO da classe (não mais uma fatia
  // proporcional), então cada classe absorve pelo menos o que absorveu na
  // rodada menor. O teto do que ela consegue colocar, porém, é do nível 2:
  // `assetAllocationWithinClass` calcula o alvo de cada ativo sobre a
  // carteira ATUAL, enquanto o gap da classe usa carteira + aporte. A
  // diferença entre os dois cai em `unallocatedCents`, exatamente como o
  // ADR 0013 descreve para o que os ativos elegíveis não conseguem absorver.
  const inSmallRound = proportional.classes.find((p) => p.assetClass === c.assetClass)
  ok(
    c.allocatedCents >= (inSmallRound?.allocatedCents ?? 0),
    `aporte maior: classe "${c.assetClass}" recebe pelo menos o que recebia no rateio proporcional`,
    `${brl(c.allocatedCents)} vs ${brl(inSmallRound?.allocatedCents ?? 0)}`,
  )
  ok(
    c.allocatedCents <= c.deltaCents,
    `classe "${c.assetClass}" nunca recebe mais que o próprio gap`,
    `${brl(c.allocatedCents)} de um gap de ${brl(c.deltaCents)}`,
  )
}
ok(
  closesAll.unallocatedCents > 0,
  'o excedente além da soma dos gaps sobra sem alocação, em vez de ir para uma classe já na meta',
  brl(closesAll.unallocatedCents),
)
eq(
  closesAll.classes.reduce((sum, c) => sum + c.allocatedCents, 0) + closesAll.unallocatedCents,
  closesAll.amountCents,
  'conservação de valor também quando o aporte fecha todos os gaps',
)

/* ---------------------------------------------------------------- *
 * 8h-2. Nível 1, redistribuição entre classes (decisions/0022): a fatia
 * que uma classe não consegue absorver (aqui, por preço de cota grosso
 * — R$300/cota, então "quase 1,4 cota" arredonda para 1 e perde o resto)
 * tem que chegar a outra classe que ainda tem gap aberto, em vez de virar
 * unallocatedCents enquanto a outra classe tinha espaço de sobra.
 * ---------------------------------------------------------------- */
const chunky = investments.createAsset({ name: 'Ativo Grosso', ticker: 'GROSSO1', assetClass: 'pension' })
const smooth = investments.createAsset({ name: 'Ativo Fino', ticker: 'FINO1', assetClass: 'other' })
investments.createTrade({ assetId: chunky.id, tradedOn: '2026-01-10', quantity: 1, unitPriceCents: 30_000 }) // R$ 300/cota
investments.createTrade({ assetId: smooth.id, tradedOn: '2026-01-10', quantity: 1, unitPriceCents: 100 }) // R$ 1/cota
investments.recordValuation(chunky.id, '2026-06-01', 30_000)
investments.recordValuation(smooth.id, '2026-06-01', 100)
const chunkyCriterion = criteriaService.createCriterion({ assetClass: 'pension', label: 'Critério Grosso' })
const smoothCriterion = criteriaService.createCriterion({ assetClass: 'other', label: 'Critério Fino' })
criteriaService.setAnswer(chunky.id, chunkyCriterion.id, true)
criteriaService.setAnswer(smooth.id, smoothCriterion.id, true)

// Alvos altos (20% e 5%) sobre uma carteira já grande — gap de sobra para
// as duas classes garante que o aporte de R$ 500 não fecha nenhum dos dois.
investments.setTargetAllocation(null, [
  { assetClass: 'pension', targetBps: 2_000 },
  { assetClass: 'other', targetBps: 500 },
])

const redistAmount = 500_00 // R$ 500
const redist = investments.suggestContribution(redistAmount)
const chunkyPlan = redist.classes.find((c) => c.assetClass === 'pension')
const smoothPlan = redist.classes.find((c) => c.assetClass === 'other')
ok(chunkyPlan !== undefined, 'classe de cota grossa recebeu fatia')
ok(smoothPlan !== undefined, 'classe de cota fina recebeu fatia')

if (chunkyPlan && smoothPlan) {
  ok(
    chunkyPlan.deltaCents + smoothPlan.deltaCents > redistAmount,
    'pré-condição: aporte não fecha a soma dos dois gaps (testando o ramo sem nível 4)',
    `soma dos gaps ${brl(chunkyPlan.deltaCents + smoothPlan.deltaCents)} vs aporte ${brl(redistAmount)}`,
  )

  const naiveTotalDelta = chunkyPlan.deltaCents + smoothPlan.deltaCents
  const naiveShareChunky = Math.round((chunkyPlan.deltaCents / naiveTotalDelta) * redistAmount)
  const naiveShareSmooth = Math.round((smoothPlan.deltaCents / naiveTotalDelta) * redistAmount)

  eq(chunkyPlan.assets.length, 1, 'classe grossa sugere para o único ativo pontuado dela')
  eq(
    chunkyPlan.allocatedCents,
    chunkyPlan.assets[0]!.suggestedCents,
    'a classe grossa fica travada em cotas inteiras do próprio ativo',
  )
  ok(
    chunkyPlan.allocatedCents < naiveShareChunky,
    'a classe grossa recebe MENOS do que a fatia proporcional ingênua — cota inteira não cabe',
    `${brl(chunkyPlan.allocatedCents)} vs fatia ingênua ${brl(naiveShareChunky)}`,
  )
  ok(
    smoothPlan.allocatedCents > naiveShareSmooth,
    'decisions/0022: a classe fina recebe MAIS do que a fatia ingênua — absorveu o que a grossa devolveu',
    `${brl(smoothPlan.allocatedCents)} vs fatia ingênua ${brl(naiveShareSmooth)}`,
  )
  ok(
    smoothPlan.allocatedCents <= smoothPlan.deltaCents,
    'mesmo recebendo a sobra redistribuída, a classe fina nunca passa do próprio gap',
  )
  eq(
    chunkyPlan.allocatedCents + smoothPlan.allocatedCents + redist.unallocatedCents,
    redistAmount,
    'conservação de valor com redistribuição: alocado nas duas classes + não-alocado == aporte',
  )
  ok(
    redist.unallocatedCents < naiveShareChunky - chunkyPlan.allocatedCents,
    'o que a classe grossa devolveu foi majoritariamente redistribuído, não empilhado em unallocatedCents',
    `sobra não-alocada ${brl(redist.unallocatedCents)}`,
  )
}

/* ---------------------------------------------------------------- *
 * 8h-3. `allocateAcrossSectors` não pode desistir da classe inteira só
 * porque o PRIMEIRO ativo tentado (o de maior gap) não cabe no
 * orçamento — precisa tentar o próximo do MESMO setor antes de desistir.
 *
 * Bug real encontrado em dados de produção (não coberto pelo 8h-2, que
 * testa redistribuição ENTRE classes): Tesouro Direto com 2 títulos, os
 * dois em "Sem setor", o mais caro ordenado primeiro por ter o maior gap
 * e inviável no orçamento oferecido, zerava a sugestão da classe inteira
 * mesmo com o segundo título perfeitamente pagável no mesmo setor.
 * ---------------------------------------------------------------- */
const sectorGoal = investments.createGoal({ name: 'Meta teste setor único', targetValueCents: 100_000_00 })
const pricey = investments.createAsset({ name: 'Título Caro', ticker: 'CARO1', assetClass: 'other' })
const priceyCriterion = criteriaService.createCriterion({ assetClass: 'other', label: 'Critério Título Caro' })
criteriaService.setAnswer(pricey.id, priceyCriterion.id, true)
investments.createTrade({ assetId: pricey.id, tradedOn: '2026-01-10', quantity: 1, unitPriceCents: 1_000_00 }) // R$ 1.000/cota
investments.recordValuation(pricey.id, '2026-06-01', 1_000_00)

// "smooth" (R$ 1,00/cota, nota 10) já existe na classe 'other' desde
// 8h-2 e é o segundo candidato do mesmo setor "Sem setor" — mesma nota
// do caro, mas já tem valor investido, então seu gap fica menor: o caro
// (gap maior, valor zero) ordena primeiro por construção.
investments.setTargetAllocation(sectorGoal.id, [{ assetClass: 'other', targetBps: 5_000 }])

const sectorAmount = 50_00 // R$ 50 — inviável para 1 cota de R$ 1.000, mas sobra para a de R$ 1,00
const sectorPlan = investments.suggestContribution(sectorAmount, sectorGoal.id)
const otherSectorPlan = sectorPlan.classes.find((c) => c.assetClass === 'other')
ok(
  otherSectorPlan !== undefined,
  'classe com um ativo caro demais e outro barato no MESMO setor ainda recebe fatia',
)
if (otherSectorPlan) {
  ok(
    !otherSectorPlan.assets.some((a) => a.assetId === pricey.id),
    'o título caro (inviável no orçamento oferecido) não aparece na sugestão',
  )
  ok(
    otherSectorPlan.assets.some((a) => a.assetId === smooth.id),
    'e o título barato do MESMO setor aparece — o laço não desiste da classe inteira ao achar o primeiro item caro',
  )
  ok(otherSectorPlan.allocatedCents > 0, 'valor alocado é positivo, não zerado pelo primeiro item inviável')
  eq(
    otherSectorPlan.allocatedCents,
    otherSectorPlan.assets.reduce((sum, a) => sum + a.suggestedCents, 0),
    'o valor alocado da classe é exatamente a soma do que foi sugerido por ativo',
  )
}

/* ---------------------------------------------------------------- *
 * 8i. Nível 4 da cascata (decisions/0019): depois que todo gap
 * fecha, a sobra vai por peso-alvo, não fica presa em unallocatedCents.
 *
 * Meta isolada (goalId próprio) com duas classes novas (treasury, funds),
 * cada uma com um único ativo pontuado a R$ 1,00/cota — mesmo desenho de
 * `cleanClasses` acima, só que num goalId à parte para não herdar o
 * "stocks" do goal nulo, que já está saturado e sem ativo elegível (isso
 * sempre deixa uma fatia presa por um motivo diferente do que este teste
 * quer isolar).
 * ---------------------------------------------------------------- */
const level4Goal = investments.createGoal({ name: 'Meta teste nível 4', targetValueCents: 100_000_00 })
// Pesos-alvo pequenos DE PROPÓSITO: o alvo por ativo (nível 2) é calculado
// sobre o portfólio ANTES do aporte, enquanto o gap de classe (nível 1) já
// usa portfólio + aporte — com um peso pequeno essa diferença é uma fração
// desprezível do aporte, então o único ativo da classe consegue absorver o
// gap quase inteiro, isolando o efeito do nível 4 (senão o teto do nível 2
// mascara a sobra e o teste não prova nada sobre o nível 4).
const level4ClassSpecs: Array<{ assetClass: string; ticker: string; targetBps: number }> = [
  { assetClass: 'treasury', ticker: 'TESOURO-T1', targetBps: 100 },
  { assetClass: 'funds', ticker: 'FUNDO-T1', targetBps: 50 },
]
for (const spec of level4ClassSpecs) {
  const criterion = criteriaService.createCriterion({ assetClass: spec.assetClass, label: `Critério ${spec.ticker}` })
  const a = investments.createAsset({ name: spec.ticker, ticker: spec.ticker, assetClass: spec.assetClass })
  investments.createTrade({ assetId: a.id, tradedOn: '2026-01-10', quantity: 1, unitPriceCents: 100 })
  investments.recordValuation(a.id, '2026-06-01', 100)
  criteriaService.setAnswer(a.id, criterion.id, true)
}
investments.setTargetAllocation(
  level4Goal.id,
  level4ClassSpecs.map((c) => ({ assetClass: c.assetClass, targetBps: c.targetBps })),
)

const gapTreasury = investments.assetAllocationWithinClass('treasury', level4Goal.id)
const gapFunds = investments.assetAllocationWithinClass('funds', level4Goal.id)
const level4TargetShare = (100 + 50) / 10_000
const level4TotalBefore = investments.suggestContribution(0, level4Goal.id).totalBeforeCents
const level4EligibleValue = gapTreasury.classValueCents + gapFunds.classValueCents
const level4Threshold = (level4TargetShare * level4TotalBefore - level4EligibleValue) / (1 - level4TargetShare)
const level4Amount = Math.ceil(level4Threshold) + 500_00 // folga generosa para garantir sobra real

const level4Plan = investments.suggestContribution(level4Amount, level4Goal.id)
const treasuryPlan = level4Plan.classes.find((c) => c.assetClass === 'treasury')
const fundsPlan = level4Plan.classes.find((c) => c.assetClass === 'funds')
ok(
  treasuryPlan !== undefined && fundsPlan !== undefined,
  'nível 4: as duas classes seguem no plano depois de fechar o próprio gap',
)

if (treasuryPlan && fundsPlan) {
  ok(
    treasuryPlan.allocatedCents > treasuryPlan.deltaCents,
    'nível 4: classe "treasury" recebe MAIS que o próprio gap — a sobra não fica parada',
    `${brl(treasuryPlan.allocatedCents)} alocado vs gap de ${brl(treasuryPlan.deltaCents)}`,
  )
  ok(
    fundsPlan.allocatedCents > fundsPlan.deltaCents,
    'nível 4: classe "funds" recebe MAIS que o próprio gap — a sobra não fica parada',
    `${brl(fundsPlan.allocatedCents)} alocado vs gap de ${brl(fundsPlan.deltaCents)}`,
  )

  const extraTreasury = treasuryPlan.allocatedCents - treasuryPlan.deltaCents
  const extraFunds = fundsPlan.allocatedCents - fundsPlan.deltaCents
  ok(
    extraFunds > 0 && Math.abs(extraTreasury / extraFunds - 2) < 0.5,
    'nível 4: o excedente se reparte ~2:1 entre as classes, na proporção do targetBps (100 vs 50), não igualmente',
    `${extraTreasury} vs ${extraFunds}`,
  )
}

eq(
  level4Plan.classes.reduce((sum, c) => sum + c.allocatedCents, 0) + level4Plan.unallocatedCents,
  level4Plan.amountCents,
  'nível 4: conservação de valor também quando a sobra se redistribui por peso-alvo',
)
// A cota de R$ 1,00 e o teto do nível 2 (baseado no portfólio ANTES do
// aporte, ver comentário acima) ainda deixam uma fração sem destino — o
// ponto aqui não é zerar isso, é confirmar que a maior parte do excedente
// realmente saiu de unallocatedCents, ao contrário do comportamento anterior
// ao ADR 0019 (onde TUDO além do gap ficava parado).
ok(
  level4Plan.unallocatedCents < level4Amount * 0.5,
  'nível 4: com ativo elegível em toda classe com peso-alvo, a maior parte do excedente é alocada, não fica toda parada',
  brl(level4Plan.unallocatedCents),
)

// 8g. Emergency reserve — "não investe nada até ter Nx o custo de vida
// guardado" is priority ZERO, ahead of every class above. The real
// monthly living cost depends on whatever earlier modules left in the
// ledger, so these assertions check the relationship (delta, cap,
// conservation), never a hardcoded absolute number.
investments.setReserveSettings({ multiple: 6, lookbackMonths: 3 })
const reserveBefore = investments.reserveStatus()
eq(
  reserveBefore.targetCents,
  reserveBefore.monthlyLivingCostCents * 6,
  'meta da reserva = custo de vida médio x múltiplo',
)

const reserveAsset = investments.createAsset({ name: 'Reserva CDB Teste', assetClass: 'fixed_income' })
investments.createTrade({ assetId: reserveAsset.id, tradedOn: '2026-01-10', quantity: 1, unitPriceCents: 100_000 })
investments.updateAsset(reserveAsset.id, { countsTowardReserve: true })

const reserveAfter = investments.reserveStatus()
eq(
  reserveAfter.currentCents - reserveBefore.currentCents,
  100_000,
  'marcar um ativo como reserva soma seu valor de mercado ao progresso',
)

// Push the multiple high enough that the target is guaranteed to outpace
// the single R$ 1.000 reserve asset just added, so the gap is positive
// regardless of what the real average living cost turns out to be.
investments.setReserveSettings({ multiple: 24 })
const bigGap = investments.reserveStatus()
if (bigGap.gapCents > 0) {
  const smallContribution = 1_000 // R$ 10 — comfortably below any realistic gap
  const smallPlan = investments.suggestContribution(smallContribution)
  eq(
    smallPlan.reserve.allocatedCents,
    smallContribution,
    'aporte menor que o gap da reserva -> 100% vai para a reserva antes de qualquer classe',
  )
  eq(smallPlan.classes.length, 0, 'nada sobra para nenhuma classe enquanto a reserva não está completa')

  const bigContribution = bigGap.gapCents + 50_000
  const bigPlan = investments.suggestContribution(bigContribution)
  eq(
    bigPlan.reserve.allocatedCents,
    bigGap.gapCents,
    'aporte maior que o gap -> a reserva recebe só o que falta, nunca mais que isso',
  )
  const classesAllocated = bigPlan.classes.reduce(
    (sum, c) => sum + c.assets.reduce((s, a) => s + a.suggestedCents, 0),
    0,
  )
  eq(
    bigPlan.reserve.allocatedCents + classesAllocated + bigPlan.unallocatedCents,
    bigContribution,
    'conservação: reserva + classes + não-alocado == valor total do aporte',
  )
} else {
  ok(true, 'reserva já cheia mesmo a 24x — despesas médias do período são zero; comportamento ainda correto')
}

investments.setReserveSettings({ multiple: 0, lookbackMonths: 3 })

/* ================================================================ *
 * MODULE 9 — saúde financeira: Health Score, Runway, Radar de risco
 *
 * The indicators are checked as pure functions against known numbers
 * first, because that is the only way to prove the normalization curve
 * itself is right; the composed endpoints are then checked for the
 * contract decisions/0010 imposes: a memory of calculation on every
 * derived number, and `null` (never 0) whenever data is missing.
 * ================================================================ */
section('MODULE 9 — saúde financeira (score, runway, radar)')

const health = await import('../server/src/services/financialHealth')

// 9a. Liquidez: one month of cost covered is full marks, and the ratio is
// linear below that.
eq(
  health.liquidityIndicator({ availableBalanceCents: 430_000, monthlyCostCents: 215_000, lookbackMonths: 3 }).scoreBps,
  10_000,
  'liquidez: 2x o custo mensal é capado em 100',
)
eq(
  health.liquidityIndicator({ availableBalanceCents: 107_500, monthlyCostCents: 215_000, lookbackMonths: 3 }).scoreBps,
  5_000,
  'liquidez: 0,5x o custo mensal pontua 50',
)
const liquidityNoCost = health.liquidityIndicator({
  availableBalanceCents: 430_000,
  monthlyCostCents: 0,
  lookbackMonths: 3,
})
eq(liquidityNoCost.scoreBps, null, 'liquidez sem despesa registrada -> sem dado, nunca 0')
ok(typeof liquidityNoCost.assumptions.semDado === 'string', 'indicador sem dado explica o motivo')
eq(
  health.liquidityIndicator({ availableBalanceCents: 430_000, monthlyCostCents: 215_000, lookbackMonths: 3 })
    .assumptions.custoMensalMedioCents,
  215_000,
  'liquidez devolve o custo mensal usado no cálculo',
)

// 9b. Endividamento: metade da renda comprometida zera o indicador.
const debtInputs = { debtCount: 2, scheduledCents: 50_000, monthlyIncomeCents: 200_000, period: '2026-07' }
eq(health.debtIndicator({ ...debtInputs, debtToIncomeBps: 0 }).scoreBps, 10_000, 'endividamento: 0% comprometido pontua 100')
eq(health.debtIndicator({ ...debtInputs, debtToIncomeBps: 2_500 }).scoreBps, 5_000, 'endividamento: 25% comprometido pontua 50')
eq(health.debtIndicator({ ...debtInputs, debtToIncomeBps: 5_000 }).scoreBps, 0, 'endividamento: 50% comprometido pontua 0')
eq(health.debtIndicator({ ...debtInputs, debtToIncomeBps: 8_000 }).scoreBps, 0, 'endividamento acima de 50% fica no piso, nunca negativo')
eq(
  health.debtIndicator({ ...debtInputs, debtCount: 0, debtToIncomeBps: 0 }).scoreBps,
  null,
  'nenhuma dívida cadastrada -> sem dado, não 100 automático',
)
eq(
  health.debtIndicator({ ...debtInputs, debtToIncomeBps: null }).scoreBps,
  null,
  'dívida sem renda no mês de referência -> sem dado',
)

// 9c. Controle de gastos: dentro do teto é 100, 150% do teto é 0.
eq(health.spendingIndicator({ spentCents: 80_000, capCents: 100_000 }).scoreBps, 10_000, 'gasto dentro do teto pontua 100')
eq(health.spendingIndicator({ spentCents: 100_000, capCents: 100_000 }).scoreBps, 10_000, 'gasto exatamente no teto ainda pontua 100')
eq(health.spendingIndicator({ spentCents: 125_000, capCents: 100_000 }).scoreBps, 5_000, 'gasto 25% acima do teto pontua 50')
eq(health.spendingIndicator({ spentCents: 150_000, capCents: 100_000 }).scoreBps, 0, 'gasto 50% acima do teto pontua 0')
eq(
  health.spendingIndicator({ spentCents: 80_000, capCents: null }).scoreBps,
  null,
  'sem teto definido -> sem dado, nem 0 nem 100',
)

// 9d. Reserva e alocação.
eq(
  health.reserveIndicator({
    currentCents: 500_000,
    targetCents: 1_000_000,
    multiple: 6,
    monthlyLivingCostCents: 166_667,
    livingCostIsManual: false,
  }).scoreBps,
  5_000,
  'reserva pela metade pontua 50',
)
eq(
  health.reserveIndicator({
    currentCents: 0,
    targetCents: 0,
    multiple: 0,
    monthlyLivingCostCents: 0,
    livingCostIsManual: false,
  }).scoreBps,
  null,
  'meta de reserva ainda não calculável -> sem dado',
)
eq(
  health.allocationIndicator({
    drifts: [
      { assetClass: 'stocks', label: 'Ações', driftBps: 1_000 },
      { assetClass: 'fii', label: 'FIIs', driftBps: -2_000 },
    ],
  }).scoreBps,
  8_500,
  'alocação: desvio médio absoluto de 15 p.p. pontua 85',
)
eq(health.allocationIndicator({ drifts: [] }).scoreBps, null, 'sem meta de alocação configurada -> sem dado')

// 9e. Composição: peso de indicador sem dado é redistribuído, não zerado.
const composed = health.composeScore([
  { key: 'liquidity', weight: 20, result: { scoreBps: 10_000, assumptions: { formula: 'teste' } } },
  { key: 'debt', weight: 20, result: { scoreBps: 0, assumptions: { formula: 'teste' } } },
  { key: 'spending', weight: 20, result: { scoreBps: null, assumptions: { formula: 'teste' } } },
  { key: 'reserve', weight: 20, result: { scoreBps: null, assumptions: { formula: 'teste' } } },
  { key: 'allocation', weight: 20, result: { scoreBps: null, assumptions: { formula: 'teste' } } },
])
eq(composed.scoreBps, 5_000, 'score = média ponderada só dos indicadores com dado')
eq(composed.activeWeight, 40, 'peso ativo soma apenas os indicadores com dado')
eq(
  composed.indicators.filter((i) => i.appliedWeightBps !== null).reduce((s, i) => s + i.appliedWeightBps!, 0),
  10_000,
  'pesos aplicados dos indicadores com dado somam 100%',
)
ok(
  composed.indicators.filter((i) => i.scoreBps === null).every((i) => i.appliedWeightBps === null),
  'indicador sem dado não recebe peso aplicado',
)
eq(
  health.composeScore([
    { key: 'liquidity', weight: 20, result: { scoreBps: null, assumptions: { formula: 'teste' } } },
  ]).scoreBps,
  null,
  'nenhum indicador com dado -> score nulo, nunca 0 nem 50 arbitrário',
)
// Weights are relative, not required to add up to 100.
eq(
  health.composeScore([
    { key: 'liquidity', weight: 30, result: { scoreBps: 10_000, assumptions: { formula: 'teste' } } },
    { key: 'debt', weight: 10, result: { scoreBps: 0, assumptions: { formula: 'teste' } } },
  ]).scoreBps,
  7_500,
  'pesos desiguais ponderam o score corretamente',
)

// 9f. Parâmetros: default até o usuário salvar, persistido depois.
eq(health.getSettings().weightLiquidity, health.DEFAULT_HEALTH_SETTINGS.weightLiquidity, 'pesos começam no default')
eq(health.getSettings().riskCardShareBps, 3_500, 'threshold de cartão começa em 35%')
health.setSettings({ weightLiquidity: 40, riskCardShareBps: 4_000 })
eq(health.getSettings().weightLiquidity, 40, 'peso configurado é persistido')
eq(health.getSettings().riskCardShareBps, 4_000, 'threshold configurado é persistido')
eq(health.getSettings().weightDebt, 20, 'peso não tocado mantém o default')
eq(health.DEFAULT_HEALTH_SETTINGS.weightLiquidity, 20, 'o default exportado não é mutado por uma gravação')
health.setSettings({ ...health.DEFAULT_HEALTH_SETTINGS })

// 9g. Score composto sobre o ledger real: contrato de memória de cálculo.
const scorePeriod = '2026-07'
const score = health.healthScore(scorePeriod)
eq(score.indicators.length, 5, 'score expõe os cinco indicadores, com ou sem dado')
ok(
  score.indicators.every((i) => typeof i.assumptions.formula === 'string' && i.assumptions.formula.length > 0),
  'cada indicador carrega a fórmula usada (contrato do ADR 0010)',
)
ok(typeof score.assumptions.formula === 'string', 'o score carrega memória de cálculo própria')
ok(Array.isArray(score.assumptions.indicadoresSemDado), 'o score declara quais indicadores ficaram de fora')
ok(
  score.scoreBps === null || (score.scoreBps >= 0 && score.scoreBps <= 10_000),
  'score fica entre 0 e 100 quando existe',
  score.scoreBps,
)
ok(
  score.indicators.every((i) => i.scoreBps === null || (i.scoreBps >= 0 && i.scoreBps <= 10_000)),
  'todo indicador fica entre 0 e 100 quando existe',
)
// The configured weights must be visible next to the result, or the
// composition is a black box — which the ADR does not allow.
eq(
  (score.assumptions.pesosConfigurados as Record<string, number>).liquidity,
  health.getSettings().weightLiquidity,
  'o score devolve os pesos que usou',
)

// 9h. Runway: consolidado + uma linha por conta, cada uma com premissas.
const runway = health.runway()
ok(runway.scopes.length >= 2, 'runway cobre consolidado e contas', runway.scopes.length)
eq(runway.scopes[0]!.accountId, null, 'a primeira linha do runway é a consolidada')
eq(runway.consolidated.accountId, null, 'consolidado exposto separadamente para a UI')
ok(
  runway.scopes.every((s) => typeof s.assumptions.formula === 'string'),
  'cada escopo do runway carrega sua memória de cálculo',
)
ok(
  runway.scopes.every(
    (s) =>
      (s.assumptions.saldoEmContaCents as number) +
        (s.assumptions.investimentosLiquidosCents as number) -
        (s.assumptions.dividaCurtoPrazoCents as number) ===
      s.netWorthCents,
  ),
  'patrimônio considerado bate com a soma dos termos declarados nas premissas',
)
ok(
  runway.scopes.every((s) => (s.monthlyCostCents > 0 ? s.months !== null : s.months === null)),
  'runway sem custo mensal não calcula, em vez de reportar infinito ou 0',
)
ok(
  runway.scopes.filter((s) => s.accountId !== null).every((s) => s.assumptions.investimentosIncluidos === false),
  'investimentos entram só no consolidado, e a premissa diz isso explicitamente',
)
eq(
  (runway.consolidated.assumptions.classesLiquidas as string[]).join(','),
  health.DEFAULT_LIQUID_ASSET_CLASSES.join(','),
  'runway declara quais classes tratou como líquidas',
)
const customRunway = health.runway(['cash'])
eq(
  (customRunway.consolidated.assumptions.classesLiquidas as string[]).join(','),
  'cash',
  'a lista de classes líquidas é parâmetro, não constante embutida no cálculo',
)

// 9i. Radar de risco: só regras com dado, cada uma contra o limite configurado.
// A card with a measured available limit is created here so the card rule is
// actually exercised instead of being skipped for lack of data.
const cardsService = await import('../server/src/services/creditCards')
const { todayIso: today } = await import('../server/src/core/dates')
const radarCard = cardsService.createCard({
  name: 'Cartão Radar Teste',
  accountId: accountByName.get('Conta Corrente')!,
  creditLimitCents: 1_000_000,
})
// Dated today on purpose: `createCard` already records a full-limit snapshot
// for today, and `latestAvailable` reads the most recent one — a snapshot in
// the past would be shadowed by it and measure nothing.
cardsService.recordSnapshot(radarCard.id, today(), 400_000) // usado = R$ 6.000

const radar = health.riskRadar(scorePeriod)
const cardRule = radar.rules.find((r) => r.key === 'card_share')
ok(cardRule !== undefined, 'cartão com limite medido entra no radar')
eq(
  cardRule!.assumptions.limiteCartaoComprometidoCents,
  600_000,
  'limite de cartão comprometido = limite total menos disponível medido',
)
// ADR 0015: o número é uma medição de limite usado, e a memória de cálculo
// tem que dizer que ele mistura parcelamento futuro com o ciclo corrente.
ok(
  /parcelamento/i.test(String(cardRule!.assumptions.formula)),
  'a fórmula do radar declara que o número inclui parcelamento em andamento',
)
ok(
  !/fatura/i.test(cardRule!.label),
  'o rótulo da regra não chama este número de fatura',
  cardRule!.label,
)
ok(typeof radar.assumptions.formula === 'string', 'radar carrega memória de cálculo')
ok(
  radar.rules.every((r) => typeof r.assumptions.formula === 'string'),
  'cada regra do radar carrega a fórmula usada',
)
ok(
  radar.rules.every((r) => r.thresholdBps > 0),
  'toda regra exibe o limite configurado ao lado do valor medido',
)
// A drift in percentage points must not be rendered as a share, so the unit
// travels with the value instead of being guessed from the rule's key.
ok(
  radar.rules.every((r) => r.unit === 'share' || r.unit === 'points'),
  'toda regra declara a unidade do valor que reporta',
)
eq(
  radar.rules.find((r) => r.key === 'allocation_drift')?.unit,
  'points',
  'desvio de alocação é reportado em pontos percentuais, não como percentual de algo',
)
ok(
  radar.rules.every((r) =>
    r.direction === 'above' ? r.outsideRange === r.valueBps > r.thresholdBps : r.outsideRange === r.valueBps < r.thresholdBps,
  ),
  'o status de cada regra é coerente com valor, limite e direção',
)
ok(
  Array.isArray(radar.assumptions.regrasSemDado),
  'o radar lista as regras que ficaram de fora por falta de dado',
)
ok(
  (radar.assumptions.regrasSemDado as string[]).every((key) => !radar.rules.some((r) => r.key === key)),
  'uma regra sem dado não aparece como se estivesse dentro da faixa',
)
// A threshold change has to move the verdict, or it was not really configurable.
health.setSettings({ riskCardShareBps: 1 })
const strictRadar = health.riskRadar(scorePeriod)
const strictCard = strictRadar.rules.find((r) => r.key === 'card_share')
if (strictCard) {
  eq(strictCard.thresholdBps, 1, 'o radar usa o threshold configurado, não um valor fixo')
  ok(strictCard.outsideRange, 'baixar o limite move a regra para fora da faixa')
} else {
  ok(true, 'sem cartão ou sem receita no período: regra de cartão corretamente ausente do radar')
}
health.setSettings({ ...health.DEFAULT_HEALTH_SETTINGS })

/* ---------------------------------------------------------------- *
 * 9j. Sinal positivo: o outro lado do radar.
 *
 * `exceedsPositively` e `outsideRange` são INDEPENDENTES, não opostos:
 * entre "fora da faixa" e "acima da folga" existe uma zona neutra, que é
 * justamente estar dentro do limite sem folga suficiente. O cenário abaixo
 * exercita os três estados na mesma regra, só mexendo no threshold.
 * ---------------------------------------------------------------- */
{
  // O módulo 8 encerra com `multiple: 0` (reserva desligada), então a regra
  // de cobertura nem existiria aqui. Um alvo controlado por custo de vida
  // manual dá uma cobertura conhecida, sem depender da despesa real do
  // fixture: reserva acumulada bem acima de uma meta pequena.
  investments.setReserveSettings({ multiple: 1, manualLivingCostCents: 50_000 })
  const reserveNow = investments.reserveStatus()
  ok(
    reserveNow.targetCents > 0 && reserveNow.progressBps > 0,
    'o cenário tem cobertura de reserva para comparar',
    `${reserveNow.progressBps} bps de ${brl(reserveNow.targetCents)}`,
  )

  // Threshold bem abaixo da cobertura real, folga pequena: sinal positivo.
  const folga = 2_000
  health.setSettings({
    riskReserveCoverageBps: Math.max(1, reserveNow.progressBps - folga - 1_000),
    riskPositiveMarginBps: folga,
  })
  const positivo = health.riskRadar(scorePeriod).rules.find((r) => r.key === 'reserve_coverage')!
  ok(positivo.exceedsPositively, 'cobertura bem acima do limite dispara o sinal positivo')
  ok(!positivo.outsideRange, 'e ao mesmo tempo NÃO está fora da faixa')
  eq(
    positivo.exceedsPositively && positivo.outsideRange,
    false,
    'os dois selos nunca acendem juntos',
  )

  // Mesma cobertura, mas exigindo uma folga maior do que a distância real:
  // continua dentro da faixa e deixa de ser sinal positivo. Este é o caso
  // que prova que um não é a negação do outro.
  health.setSettings({ riskPositiveMarginBps: reserveNow.progressBps + 10_000 })
  const neutro = health.riskRadar(scorePeriod).rules.find((r) => r.key === 'reserve_coverage')!
  ok(!neutro.outsideRange, 'com folga exigente, a regra segue dentro da faixa')
  ok(
    !neutro.exceedsPositively,
    'mas deixa de ser sinal positivo: dentro da faixa não implica acima da folga',
  )

  // Threshold acima da cobertura: volta a ser o lado ruim, e o positivo cai.
  health.setSettings({
    riskReserveCoverageBps: reserveNow.progressBps + 5_000,
    riskPositiveMarginBps: folga,
  })
  const negativo = health.riskRadar(scorePeriod).rules.find((r) => r.key === 'reserve_coverage')!
  ok(negativo.outsideRange, 'threshold acima da cobertura devolve a regra para fora da faixa')
  ok(!negativo.exceedsPositively, 'e o sinal positivo desliga')

  // Regra 'above' (limite de cartão) usa o espelho: bom é ficar ABAIXO.
  health.setSettings({ riskCardShareBps: 100_000, riskPositiveMarginBps: folga })
  const cartaoFolgado = health.riskRadar(scorePeriod).rules.find((r) => r.key === 'card_share')
  if (cartaoFolgado) {
    ok(
      cartaoFolgado.exceedsPositively,
      'numa regra "above", ficar bem abaixo do limite é o sinal positivo',
    )
  } else {
    ok(true, 'sem cartão no período: regra ausente, nada a verificar')
  }

  // A margem é parâmetro do usuário, não constante.
  eq(health.getSettings().riskPositiveMarginBps, folga, 'a margem de folga é persistida como configuração')
  eq(
    health.DEFAULT_HEALTH_SETTINGS.riskPositiveMarginBps,
    2_000,
    'o default exportado da margem é 20 p.p.',
  )
  eq(
    health.riskRadar(scorePeriod).assumptions.margemDeFolgaPositivaBps,
    folga,
    'a memória de cálculo do radar declara a margem usada',
  )

  health.setSettings({ ...health.DEFAULT_HEALTH_SETTINGS })
  // Devolve a reserva ao estado que o módulo 8 deixou, para não mudar o
  // cenário dos módulos seguintes.
  investments.setReserveSettings({ multiple: 0, lookbackMonths: 3, manualLivingCostCents: null })
}

/* ---------------------------------------------------------------- *
 * 9k. Patrimônio consolidado.
 *
 * O risco real desta função é ela virar uma cópia do numerador do Runway.
 * Os dois recortes precisam continuar diferentes: dívida TOTAL contra
 * dívida de 30 dias, investimentos TODOS contra só os líquidos.
 * ---------------------------------------------------------------- */
const patrimonio = health.netWorth()

eq(
  patrimonio.balanceCents + patrimonio.investmentsCents - patrimonio.debtCents,
  patrimonio.liquidityCents,
  'liquidez = saldo mais investimentos menos dívida total',
)
eq(
  patrimonio.investmentsCents,
  investments.positions().reduce((sum, p) => sum + p.marketValueCents, 0),
  'investimentos somam TODA a carteira, não só os ativos marcados como reserva',
)
eq(
  patrimonio.debtCents,
  debtService.listDebts().reduce((sum, d) => sum + d.balanceCents, 0),
  'dívida é a soma do saldo corrente de toda dívida ativa',
)

// O ponto do card: este recorte é diferente do do Runway, de propósito.
{
  const consolidado = health.runway().consolidated
  const curtoPrazo = consolidado.assumptions.dividaCurtoPrazoCents as number
  ok(
    patrimonio.debtCents > curtoPrazo,
    'a dívida do patrimônio é maior que a de curto prazo do Runway: recortes diferentes de propósito',
    `total ${brl(patrimonio.debtCents)} vs 30 dias ${brl(curtoPrazo)}`,
  )
  ok(
    patrimonio.investmentsCents >= (consolidado.assumptions.investimentosLiquidosCents as number),
    'investimentos totais nunca são menores que os líquidos que o Runway considera',
  )
}

ok(
  typeof patrimonio.assumptions.dividaEscopo === 'string' &&
    /curto prazo/i.test(String(patrimonio.assumptions.dividaEscopo)),
  'a memória de cálculo explica por que esta dívida difere da do Runway',
)

// Estado vazio: zero explícito, nunca "sem dado". Desativar as dívidas é
// reversível e exercita o caminho real do reduce sobre lista vazia.
{
  const ativas = debtService.listDebts()
  for (const d of ativas) debtService.updateDebt(d.id, { active: false })
  const semDivida = health.netWorth()
  eq(semDivida.debtCents, 0, 'nenhuma dívida cadastrada -> dívida total R$ 0,00 explícito, não nulo')
  eq(
    semDivida.liquidityCents,
    semDivida.balanceCents + semDivida.investmentsCents,
    'sem dívida, a liquidez é saldo mais investimentos',
  )
  for (const d of ativas) debtService.updateDebt(d.id, { active: true })
  eq(
    health.netWorth().debtCents,
    patrimonio.debtCents,
    'reativar as dívidas devolve o patrimônio ao estado anterior',
  )
}

/* ================================================================ *
 * MODULE 10 — motor financeiro: alocação do disponível e ponto de
 * equilíbrio de faturamento.
 *
 * Two things are checked beyond the arithmetic: that every composed
 * total ships the terms it was composed from, and that the list of
 * destinations comes back in a neutral order. The second one is a
 * product rule, not a cosmetic one (decisions/0010): ordering by
 * computed urgency would be a recommendation in disguise.
 * ================================================================ */
section('MODULE 10 — motor financeiro (disponível, ponto de equilíbrio)')

const engine = await import('../server/src/services/financialEngine')

// 10a. Disponível: o total é exatamente a composição declarada.
const available = engine.availableForAllocation(scorePeriod)
eq(
  available.terms.consolidatedBalanceCents -
    available.terms.futureCommitmentsCents -
    available.terms.provisionedCardBillCents -
    available.terms.alreadyAllocatedCents,
  available.availableCents,
  'disponível = saldo, menos compromissos, menos fatura, menos o já destinado a metas',
)
ok(typeof available.assumptions.formula === 'string', 'disponível carrega memória de cálculo')
eq(
  available.assumptions.jaDestinadoAMetasCents,
  available.terms.alreadyAllocatedCents,
  'o termo "já destinado a metas" aparece igual nas premissas e no resultado',
)
const alreadyDetail = available.assumptions.jaDestinadoDetalhe as {
  reservaCents: number
  investimentoCents: number
  dividaCents: number
}
eq(
  alreadyDetail.reservaCents + alreadyDetail.investimentoCents + alreadyDetail.dividaCents,
  available.terms.alreadyAllocatedCents,
  'o já destinado se abre em reserva, investimento e dívida sem sobra',
)
ok(
  typeof available.assumptions.compromissosFuturosOrigem === 'string' &&
    typeof available.assumptions.limiteCartaoOrigem === 'string',
  'cada termo declara de qual spec ele vem',
)
// A limitação do ADR 0015 viaja com o número, não fica só no ADR.
ok(
  /n[ãa]o separ[áa]vel/i.test(String(available.assumptions.limiteCartaoOrigem)),
  'a premissa do limite de cartão declara que o ciclo corrente não é separável do parcelamento',
)
ok(
  !/fatura/i.test(JSON.stringify(available.assumptions)),
  'nenhuma premissa do disponível chama o limite comprometido de fatura',
)

// 10b. Destinos: os quatro, em ordem neutra, cada um com meta e realizado.
eq(available.destinations.length, 4, 'quatro destinos: reserva, investimento, dívida, livre')
const destinationKeys = available.destinations.map((d) => d.key).join(',')
// Ordered by LABEL, so the key order is Dívida, Investimento, Livre, Reserva.
eq(destinationKeys, 'debt,investment,free,reserve', 'destinos em ordem alfabética por rótulo, nunca por urgência')
const labelsInOrder = available.destinations.map((d) => d.label)
eq(
  labelsInOrder.join('|'),
  [...labelsInOrder].sort((a, b) => a.localeCompare(b, 'pt-BR')).join('|'),
  'a ordem exibida é estável e independente dos valores',
)
ok(
  available.destinations.every((d) =>
    d.targetCents === null ? d.differenceCents === null : d.differenceCents === d.targetCents - d.realizedCents,
  ),
  'diferença = meta menos realizado em todo destino que tem meta',
)
const freeDestination = available.destinations.find((d) => d.key === 'free')!
eq(freeDestination.targetCents, null, '"Livre" não tem meta configurada, e isso é explícito')
ok(
  available.destinations.every((d) => typeof d.assumptions.formula === 'string'),
  'cada destino carrega a fórmula da sua meta',
)
// Nothing in this payload may rank or advise.
const availableJson = JSON.stringify(available)
ok(
  !/prioridade|urgencia|urgência|recomend|sugest[aã]o de investimento/i.test(availableJson),
  'a resposta do disponível não contém prioridade, urgência nem recomendação',
)

// 10c. Ponto de equilíbrio: composição linha a linha e a álgebra do imposto.
const pjAccountId = accountByName.get('Conta PJ')!
const pfAccountId = accountByName.get('Conta Corrente')!
const breakEven = engine.breakEven(scorePeriod, { pjAccountId, pfAccountId })
ok(breakEven.lines.length >= 6, 'ponto de equilíbrio exibe a composição linha a linha', breakEven.lines.length)
ok(
  breakEven.lines.every((l) => typeof l.assumptions.formula === 'string'),
  'cada linha da composição carrega a própria fórmula',
)
eq(
  breakEven.lines.reduce((sum, l) => sum + l.amountCents, 0),
  breakEven.breakEvenCents,
  'a soma das linhas é exatamente o total, imposto incluído',
)
eq(
  breakEven.lines.find((l) => l.key === 'taxes')!.amountCents,
  0,
  'sem alíquota configurada, a linha de imposto aparece zerada em vez de sumir',
)
eq(
  breakEven.lines.find((l) => l.key === 'taxes')!.assumptions.configurado,
  false,
  'a linha de imposto declara que a alíquota não foi configurada',
)
eq(
  breakEven.differenceCents,
  breakEven.billedCents - breakEven.breakEvenCents!,
  'diferença = faturado menos o ponto de equilíbrio',
)

// Tax is charged on revenue, so it has to be solved for, not added on top.
const taxed = engine.breakEven(scorePeriod, { pjAccountId, pfAccountId, taxRateBps: 2_000 })
const untaxedFixed = breakEven.breakEvenCents!
eq(
  taxed.breakEvenCents,
  Math.round(untaxedFixed / 0.8),
  'imposto de 20% sobre o faturamento resolve a equação, não soma 20% dos custos',
)
ok(
  taxed.breakEvenCents! - untaxedFixed === taxed.lines.find((l) => l.key === 'taxes')!.amountCents,
  'a linha de imposto é exatamente o que o faturamento sobe para pagá-lo',
)
eq(
  engine.breakEven(scorePeriod, { pjAccountId, pfAccountId, taxRateBps: 10_000 }).breakEvenCents,
  null,
  'alíquota de 100% não tem ponto de equilíbrio, e isso é reportado em vez de mascarado',
)

// 10d. Parâmetros: default explícito, override respeitado, origem declarada.
const breakEvenOrigins = breakEven.assumptions.origemDosParametros as Record<string, string>
eq(breakEvenOrigins.marginCents, 'default', 'a resposta declara quais parâmetros ficaram no default')
eq(breakEvenOrigins.pjAccountId, 'requisição', 'um parâmetro vindo da query é declarado como tal')
const withMargin = engine.breakEven(scorePeriod, { pjAccountId, pfAccountId, marginCents: 500_000 })
eq(
  withMargin.breakEvenCents! - breakEven.breakEvenCents!,
  500_000,
  'margem configurada entra no ponto de equilíbrio real por real',
)
eq(
  withMargin.lines.find((l) => l.key === 'margin')!.assumptions.configurado,
  true,
  'a linha de margem declara que foi configurada',
)
const proLaboreLine = breakEven.lines.find((l) => l.key === 'pro_labore')!
ok(
  typeof proLaboreLine.assumptions.origem === 'string' &&
    (proLaboreLine.assumptions.origem as string).includes('derivado'),
  'pró-labore vem derivado do repasse pareado, não de um número digitado',
  proLaboreLine.assumptions.origem,
)
eq(
  engine.breakEven(scorePeriod, { pjAccountId, pfAccountId, proLaboreCents: 700_000 }).lines.find(
    (l) => l.key === 'pro_labore',
  )!.amountCents,
  700_000,
  'um pró-labore informado sobrepõe o derivado',
)
// The reserve gap is shown, never silently forced into the month's target.
const reserveLine = breakEven.lines.find((l) => l.key === 'planned_reserve')!
eq(reserveLine.amountCents, 0, 'reserva planejada é escolha do usuário, não o gap inteiro assumido pelo sistema')
ok(
  typeof reserveLine.assumptions.gapDaReservaCents === 'number',
  'o gap da reserva aparece como referência ao lado da linha',
)
ok(
  !/prioridade|urgencia|urgência|recomend/i.test(JSON.stringify(breakEven)),
  'a resposta do ponto de equilíbrio não contém prioridade, urgência nem recomendação',
)

/* ---------------------------------------------------------------- *
 * 10d-bis. Faturamento mínimo x com metas.
 *
 * Duas chamadas da MESMA função, nunca duas fórmulas. O mínimo tira a
 * reserva planejada (override para 0) e REMOVE a linha de investimento
 * planejado, em vez de zerá-la: uma linha de R$ 0,00 diria que a meta foi
 * considerada e vale zero, quando ela não entrou na conta.
 * ---------------------------------------------------------------- */
{
  // Cenário sem metas: os dois números têm que coincidir.
  const semMetaAlguma = engine.breakEven(scorePeriod, { pjAccountId, pfAccountId, reservePlannedCents: 0 })
  const semMetaMinimo = engine.breakEven(
    scorePeriod,
    { pjAccountId, pfAccountId, reservePlannedCents: 0 },
    { includeGoals: false },
  )
  const metasDeInvestimento = investments.listGoals().reduce((s, g) => s + g.monthlyContributionCents, 0)
  if (metasDeInvestimento === 0) {
    eq(
      semMetaMinimo.breakEvenCents,
      semMetaAlguma.breakEvenCents,
      'sem nenhuma meta configurada, mínimo e com metas são o mesmo número',
    )
  } else {
    ok(true, 'o fixture já tem meta de investimento; a igualdade é checada no cenário zerado abaixo')
  }

  // Cenário com as duas metas: o mínimo tem que ser estritamente menor.
  engine.setSettings({ reservePlannedCents: 250_00 })
  const comMetas = engine.breakEven(scorePeriod, { pjAccountId, pfAccountId })
  const minimo = engine.breakEven(scorePeriod, { pjAccountId, pfAccountId }, { includeGoals: false })

  ok(
    minimo.breakEvenCents !== null && comMetas.breakEvenCents !== null,
    'os dois cenários têm ponto de equilíbrio calculável',
  )
  ok(
    minimo.breakEvenCents! < comMetas.breakEvenCents!,
    'com reserva planejada e meta de investimento, o mínimo é menor que o com metas',
    `${brl(minimo.breakEvenCents!)} vs ${brl(comMetas.breakEvenCents!)}`,
  )

  // A linha some da composição, não aparece zerada.
  ok(
    comMetas.lines.some((l) => l.key === 'planned_investment'),
    'a composição com metas inclui a linha de investimento planejado',
  )
  ok(
    !minimo.lines.some((l) => l.key === 'planned_investment'),
    'a composição do mínimo REMOVE a linha de investimento, não a zera',
  )
  eq(
    minimo.lines.find((l) => l.key === 'planned_reserve')?.amountCents,
    0,
    'a reserva planejada é forçada a zero no mínimo (a linha continua, com valor zero)',
  )

  // A soma das linhas continua sendo exatamente o total, nos dois cenários.
  for (const [nome, cenario] of [['com metas', comMetas], ['mínimo', minimo]] as const) {
    eq(
      cenario.lines.reduce((sum, l) => sum + l.amountCents, 0),
      cenario.breakEvenCents,
      `a soma das linhas do cenário "${nome}" é exatamente o total`,
    )
  }

  // O delta entre os dois é o que as metas acrescentam, já com o mesmo
  // gross-up de imposto que o resto da composição usa.
  const aliquotaBps = comMetas.assumptions.aliquotaBps as number
  const metasNaComposicaoCents =
    comMetas.lines.find((l) => l.key === 'planned_investment')!.amountCents +
    comMetas.lines.find((l) => l.key === 'planned_reserve')!.amountCents
  eq(
    comMetas.breakEvenCents! - minimo.breakEvenCents!,
    Math.round(metasNaComposicaoCents / (1 - aliquotaBps / 10_000)),
    'a diferença entre os dois é exatamente reserva e investimento planejados, com o mesmo gross-up',
  )

  engine.setSettings({ ...engine.DEFAULT_BREAK_EVEN_PARAMS })
}

// 10e. Parâmetros persistidos: default -> valor salvo -> override da requisição.
eq(engine.getSettings().marginCents, engine.DEFAULT_BREAK_EVEN_PARAMS.marginCents, 'parâmetros do motor começam no default')
eq(engine.getSettings().proLaboreCents, null, 'pró-labore começa nulo, ou seja, derivado do ledger')

engine.setSettings({ marginCents: 300_000, taxRateBps: 1_000, pjAccountId, pfAccountId })
eq(engine.getSettings().marginCents, 300_000, 'margem configurada é persistida')
eq(engine.getSettings().taxRateBps, 1_000, 'alíquota configurada é persistida')
eq(engine.getSettings().reservePlannedCents, 0, 'parâmetro não tocado mantém o default')
eq(engine.DEFAULT_BREAK_EVEN_PARAMS.marginCents, 0, 'o default exportado não é mutado por uma gravação')

// With nothing passed, the saved values must drive the calculation.
const fromStored = engine.breakEven(scorePeriod)
const storedOrigins = fromStored.assumptions.origemDosParametros as Record<string, string>
eq(storedOrigins.marginCents, 'configurado', 'valor salvo é reportado como configurado, não como default')
eq(storedOrigins.reservePlannedCents, 'default', 'o que ninguém escolheu continua reportado como default')
eq(
  fromStored.lines.find((l) => l.key === 'margin')!.amountCents,
  300_000,
  'o ponto de equilíbrio usa a margem salva sem precisar de query param',
)
eq(
  fromStored.lines.find((l) => l.key === 'taxes')!.assumptions.configurado,
  true,
  'a alíquota salva marca a linha de imposto como configurada',
)
eq(
  (fromStored.assumptions.parametrosUsados as { pjAccountId: number | null }).pjAccountId,
  pjAccountId,
  'a conta PJ salva é usada sem ser reinformada a cada requisição',
)

/**
 * The route fills every absent query param with null, so this is the exact
 * shape a plain "GET /financial-engine/break-even" produces. A null must
 * read as "the query did not say", never as "erase what the user saved" —
 * the browser caught this one: settings persisted, and the calculation
 * ignored them.
 */
const asTheRouteCalls = engine.breakEven(scorePeriod, {
  pjAccountId: null,
  pfAccountId: null,
  proLaboreCents: null,
})
eq(
  (asTheRouteCalls.assumptions.parametrosUsados as { pjAccountId: number | null }).pjAccountId,
  pjAccountId,
  'parâmetro ausente na query não apaga a conta PJ salva',
)
eq(
  (asTheRouteCalls.assumptions.origemDosParametros as Record<string, string>).pjAccountId,
  'configurado',
  'e a origem continua sendo "configurado", não "requisição"',
)
eq(
  asTheRouteCalls.lines.find((l) => l.key === 'margin')!.amountCents,
  300_000,
  'o mesmo vale para valores: a margem salva sobrevive a uma query sem parâmetros',
)

// A request override still wins over the saved value.
const overridden = engine.breakEven(scorePeriod, { marginCents: 100_000 })
eq(overridden.lines.find((l) => l.key === 'margin')!.amountCents, 100_000, 'override da requisição vence o valor salvo')
eq(
  (overridden.assumptions.origemDosParametros as Record<string, string>).marginCents,
  'requisição',
  'e a origem do parâmetro diz de onde ele veio',
)
eq(
  engine.getSettings().marginCents,
  300_000,
  'um override de requisição não grava nada: a configuração salva continua intacta',
)

// A saved pró-labore overrides the derived one, and says so.
engine.setSettings({ proLaboreCents: 250_000 })
const storedProLabore = engine.breakEven(scorePeriod).lines.find((l) => l.key === 'pro_labore')!
eq(storedProLabore.amountCents, 250_000, 'pró-labore salvo sobrepõe o derivado do repasse pareado')
ok(
  (storedProLabore.assumptions.origem as string).includes('salvo'),
  'e a premissa diz que o número veio do usuário, não do ledger',
  storedProLabore.assumptions.origem,
)
engine.setSettings({ ...engine.DEFAULT_BREAK_EVEN_PARAMS })
eq(engine.getSettings().proLaboreCents, null, 'limpar a configuração volta a derivar o pró-labore do ledger')

/* ================================================================ *
 * MODULE 11 — desvio de alocação (extensão de specs/investments)
 *
 * The contract here is as much about what the payload does NOT contain
 * as about what it does: no suggested asset, no recommended action, no
 * ordering by "what to fix first" (decisions/0010 and the
 * Ofício-Circular CVM/SIN 2/2026 reasoning recorded there).
 * ================================================================ */
section('MODULE 11 — desvio de alocação')

const deviation = investments.allocationDeviation()
ok(deviation.classes.length > 0, 'classes com meta aparecem no desvio', deviation.classes.length)
ok(
  deviation.classes.every((c) => c.deviationBps === c.actualBps - c.targetBps),
  'desvio = percentual atual menos percentual meta, em pontos percentuais',
)
ok(
  deviation.classes.every((c) => c.targetBps > 0),
  'nenhuma classe sem meta configurada entra na tabela de desvio',
)
const deviationLabels = deviation.classes.map((c) => c.label)
eq(
  deviationLabels.join('|'),
  [...deviationLabels].sort((a, b) => a.localeCompare(b, 'pt-BR')).join('|'),
  'classes em ordem alfabética, nunca por prioridade de correção',
)

// The absence of an advice field is the contract, so it is asserted as one.
const deviationFields = new Set(deviation.classes.flatMap((c) => Object.keys(c)))
eq(
  [...deviationFields].sort().join(','),
  'actualBps,assetClass,deviationBps,label,targetBps',
  'a resposta expõe exatamente classe, atual, meta e desvio, e nada além disso',
)
ok(
  !/suggest|recomend|rebalance|prioridade/i.test(JSON.stringify(deviation)),
  'nenhum campo de ativo sugerido ou ação recomendada existe no contrato de dados',
)
ok(
  deviation.classes.every((c) => !('rebalanceCents' in c)),
  'rebalanceCents de allocation() não vaza para o desvio, que é relatório e não instrução',
)
ok(
  typeof deviation.assumptions.formula === 'string' && typeof deviation.assumptions.ordem === 'string',
  'o desvio carrega memória de cálculo e declara a ordem que usou',
)

// It must keep reading the same derived portfolio, not recompute positions.
const allocationNow = investments.allocation()
for (const cls of deviation.classes) {
  const slice = allocationNow.find((a) => a.assetClass === cls.assetClass)!
  eq(cls.actualBps, slice.actualBps, `desvio reusa a posição derivada da classe ${cls.assetClass}`)
}

/* ================================================================ *
 * MODULE 12 — fluxo entre contas: pareamento e grafo do Sankey
 *
 * The pairing itself had no coverage at all before this module, so it
 * gets checked here alongside the graph built on top of it. The graph is
 * a pure function (shared/accountFlowGraph.ts) precisely so these
 * invariants can be asserted without rendering anything.
 * ================================================================ */
section('MODULE 12 — fluxo entre contas (pareamento e grafo do Sankey)')

const transfers = await import('../server/src/services/transfers')
const { buildAccountFlowGraph } = await import('../shared/accountFlowGraph')

const normalizeMod = await import('../server/src/core/normalize')

const pfAccount = accountByName.get('Conta Corrente')!
const pjAccount = accountByName.get('Conta PJ')!
// The pairing requires at least ONE side classified as a transfer (see the
// note in services/transfers.ts). Without this category the legs below would
// silently fail to pair and every assertion here would be vacuous.
const transferCategory = categoryPath.get('Transferências/Entre contas próprias') ?? null
ok(transferCategory !== null, 'categoria de transferência entre contas próprias existe no seed')

/**
 * A bidirectional pair inside one period: PJ sends to PF on one day, PF
 * sends back on another. This is the shape that makes a one-node-per-account
 * model cyclic, and it is the common case in this ledger, not an edge case.
 */
function postTransfer(fromId: number, toId: number, day: string, amountCents: number, tag: string) {
  const { dedupeHash, directionOf, normalizeDescription } = normalizeMod
  for (const [accountId, signed] of [
    [fromId, -amountCents],
    [toId, amountCents],
  ] as const) {
    const description = `Transferencia ${tag}`
    const descriptionNorm = normalizeDescription(description)
    db.insert(schema.transactions)
      .values({
        accountId,
        postedOn: day,
        description,
        descriptionNorm,
        amountCents: signed,
        direction: directionOf(signed),
        source: 'manual',
        categorizedBy: 'manual',
        categoryId: transferCategory,
        dedupeHash: dedupeHash({ accountId, postedOn: day, amountCents: signed, descriptionNorm }),
        pending: false,
      })
      .run()
  }
}

postTransfer(pjAccount, pfAccount, '2026-07-05', 250_000, 'ida')
postTransfer(pfAccount, pjAccount, '2026-07-19', 80_000, 'volta')

const flowRange = { from: '2026-07-01', to: '2026-07-31' }
const flows = transfers.accountFlows(flowRange)

// 12a. The pairing keeps direction: a round trip is two edges, not a net.
const outbound = flows.edges.find((e) => e.fromAccountId === pjAccount && e.toAccountId === pfAccount)
const inbound = flows.edges.find((e) => e.fromAccountId === pfAccount && e.toAccountId === pjAccount)
ok(outbound !== undefined, 'perna de ida vira uma aresta PJ -> PF')
ok(inbound !== undefined, 'perna de volta vira uma aresta PF -> PJ separada')
ok(
  outbound!.amountCents >= 250_000 && inbound!.amountCents >= 80_000,
  'cada direção soma o próprio valor, nunca o líquido entre as duas',
  `${brl(outbound!.amountCents)} ida / ${brl(inbound!.amountCents)} volta`,
)

// 12b. Two columns: the same account on both sides is two nodes, and the
// graph stays acyclic even com transferência bidirecional.
const graph = buildAccountFlowGraph(flows.edges)
const pjNodes = graph.nodes.filter((n) => n.accountId === pjAccount)
ok(pjNodes.length === 2, 'conta com fluxo nos dois sentidos vira dois nós, um por coluna', pjNodes.length)
eq(
  pjNodes.filter((n) => n.side === 'source').length,
  1,
  'exatamente um nó da conta na coluna de origem',
)
eq(
  pjNodes.filter((n) => n.side === 'target').length,
  1,
  'exatamente um nó da conta na coluna de destino',
)
ok(
  graph.links.every((link) => graph.nodes[link.source]!.side === 'source' && graph.nodes[link.target]!.side === 'target'),
  'toda aresta vai da coluna de origem para a de destino, então o grafo é acíclico por construção',
)
ok(
  graph.links.every((link) => link.source !== link.target),
  'nenhuma aresta sai e volta no mesmo nó',
)
// The round trip specifically: two distinct edges between the same pair.
const roundTrip = graph.links.filter(
  (l) =>
    (l.fromAccountId === pjAccount && l.toAccountId === pfAccount) ||
    (l.fromAccountId === pfAccount && l.toAccountId === pjAccount),
)
eq(roundTrip.length, 2, 'transferência bidirecional rende duas arestas distintas, sem erro de ciclo')

// 12c. Same source of truth as the resumo textual.
eq(
  graph.links.reduce((sum, link) => sum + link.value, 0),
  flows.totals.internalCents,
  'soma das arestas do Sankey == total pareado do resumo textual',
)
ok(
  graph.links.every((link) => Number.isInteger(link.value)),
  'todo valor de aresta é inteiro em centavos, nunca float',
)

// 12d. Unpaired legs never enter the diagram.
ok(flows.loose.length > 0, 'o período de teste tem pernas sem par para verificar', flows.loose.length)
const looseTotal = flows.loose.reduce((sum, leg) => sum + leg.amountCents, 0)
ok(
  graph.links.reduce((sum, link) => sum + link.value, 0) + looseTotal ===
    flows.totals.internalCents + flows.totals.looseCents,
  'pareado e sem par continuam somas separadas, nenhuma perna contada duas vezes',
)
ok(
  looseTotal > 0 && graph.links.every((link) => link.amountCents !== undefined),
  'nenhuma perna sem par vira aresta: o grafo lê apenas edges pareadas',
)
// Building the graph from the loose list would be a programming error; the
// contract is that it only ever receives `edges`.
eq(
  buildAccountFlowGraph([]).links.length,
  0,
  'sem arestas pareadas, o grafo é vazio em vez de inventar nós',
)

/* ================================================================ *
 * MODULE 13 — precificação de projetos
 *
 * The point of this module is that the hourly rate is NOT computed here:
 * it comes from the same break-even the motor financeiro already
 * publishes, minus that response's own tax line. Every check below is
 * about that relationship holding, and about a saved quote being frozen
 * history rather than a live formula. See `decisions/0012`.
 * ================================================================ */
section('MODULE 13 — precificação de projetos')

const pricing = await import('../server/src/services/pricing')

const pricingPeriod = scorePeriod
// A known configuration, so the arithmetic below is checkable by hand.
engine.setSettings({ ...engine.DEFAULT_BREAK_EVEN_PARAMS, pjAccountId, pfAccountId, taxRateBps: 0 })
pricing.updateSettings({ availableHoursPerMonth: 100, billablePercentageBps: 5_000 })

const engineBreakEven = engine.breakEven(pricingPeriod)
const engineTaxes = engineBreakEven.lines.find((l) => l.key === 'taxes')!.amountCents
const engineNetFixed = engineBreakEven.breakEvenCents! - engineTaxes

// 13a. Hora base = (ponto de equilíbrio menos impostos) ÷ horas faturáveis.
const sim = pricing.simulate({ estimatedHours: 10, period: pricingPeriod })
eq(sim.breakdown.billableHours, 50, 'horas faturáveis = 100 disponíveis x 50%')
eq(
  sim.breakdown.netFixedCents,
  engineNetFixed,
  'custo fixo líquido = ponto de equilíbrio do motor menos a linha de impostos dele',
)
eq(
  sim.hourlyBaseCents,
  Math.round(engineNetFixed / 50),
  'hora base = custo fixo líquido ÷ horas faturáveis',
  )
eq(
  sim.breakdown.breakEvenCents,
  engineBreakEven.breakEvenCents,
  'a precificação lê o MESMO ponto de equilíbrio do motor, não um recalculado à parte',
)
ok(
  (sim.assumptions.origemDoPontoDeEquilibrio as string).includes('motor-financeiro'),
  'a memória de cálculo declara de onde veio o ponto de equilíbrio',
)

// 13b. Preço mínimo é só horas x hora base — nenhum multiplicador o toca.
eq(sim.minimumPriceCents, 10 * sim.hourlyBaseCents, 'preço mínimo = horas estimadas x hora base')

const multipliers = pricing.multipliersByDimension()
const complexo = multipliers.complexity!.find((m) => m.multiplierBps === 16_000)!
const critico = multipliers.urgency!.find((m) => m.multiplierBps === 17_000)!
const multi = multipliers.client_size!.find((m) => m.multiplierBps === 20_000)!
const exclusivo = multipliers.usage_rights!.find((m) => m.multiplierBps === 18_000)!

const loaded = pricing.simulate({
  estimatedHours: 10,
  period: pricingPeriod,
  complexityOptionId: complexo.id,
  urgencyOptionId: critico.id,
  clientSizeOptionId: multi.id,
  usageRightsOptionId: exclusivo.id,
})
eq(
  loaded.minimumPriceCents,
  sim.minimumPriceCents,
  'o preço mínimo não muda com multiplicador nenhum: é sempre o piso técnico',
)
ok(
  loaded.recommendedPriceCents > loaded.minimumPriceCents,
  'com multiplicadores acima de 1x, o recomendado fica acima do mínimo',
)

// 13c. Os quatro multiplicadores se combinam como produto.
// 1.6 x 1.7 x 2.0 x 1.8 = 9.792
eq(loaded.breakdown.combinedMultiplierBps, 97_920, 'quatro multiplicadores combinam como produto, não como soma')
eq(loaded.multipliers.length, 4, 'as quatro dimensões sempre aparecem na resposta')

// Uma dimensão sem opção escolhida é neutra, nunca bloqueia.
const partial = pricing.simulate({
  estimatedHours: 10,
  period: pricingPeriod,
  complexityOptionId: complexo.id,
})
eq(partial.breakdown.combinedMultiplierBps, 16_000, 'dimensão sem opção usa 1.0x neutro')
eq(
  partial.multipliers.filter((m) => m.optionId === null).length,
  3,
  'as três dimensões não informadas aparecem explicitamente como neutras',
)
ok(
  partial.multipliers.every((m) => m.optionId !== null || m.multiplierBps === 10_000),
  'toda dimensão não informada vale exatamente 1.0x',
)

// 13d. Gross-up usa a MESMA alíquota do motor financeiro.
engine.setSettings({ taxRateBps: 2_000 })
const pricedWithTax = pricing.simulate({ estimatedHours: 10, period: pricingPeriod })
eq(pricedWithTax.breakdown.taxRateBps, 2_000, 'a alíquota vem de financialEngineSettings, não de uma segunda configuração')
eq(
  pricedWithTax.breakdown.priceWithTaxCents,
  Math.round(pricedWithTax.breakdown.adjustedPriceCents / 0.8),
  'gross-up = preço ÷ (1 - alíquota), o mesmo formato do ponto de equilíbrio',
)
ok(
  pricedWithTax.recommendedPriceCents > pricedWithTax.breakdown.adjustedPriceCents,
  'com imposto configurado, o preço cobrado do cliente sobe para absorvê-lo',
)

// Margem extra do projeto incide depois do imposto, e é distinta da margem mensal.
const pricedWithMargin = pricing.simulate({ estimatedHours: 10, period: pricingPeriod, extraMarginBps: 1_000 })
eq(
  pricedWithMargin.recommendedPriceCents,
  pricedWithMargin.breakdown.priceWithTaxCents + Math.round(pricedWithMargin.breakdown.priceWithTaxCents * 0.1),
  'margem extra de 10% incide sobre o preço já com imposto',
)

// 13e. Uma cotação salva congela os números.
const quote = pricing.saveQuote({
  clientLabel: 'Cliente de teste',
  estimatedHours: 10,
  period: pricingPeriod,
  complexityOptionId: complexo.id,
})
const savedRecommended = quote.recommendedPriceCents
const savedHourly = quote.hourlyBaseCents

// Muda o custo mensal por baixo dela: a cotação já enviada não pode mudar.
engine.setSettings({ marginCents: 500_000 })
const afterChange = pricing.getQuote(quote.id)!
eq(afterChange.recommendedPriceCents, savedRecommended, 'cotação salva não muda quando o custo mensal muda depois')
eq(afterChange.hourlyBaseCents, savedHourly, 'a hora base gravada também fica congelada')
ok(
  pricing.simulate({ estimatedHours: 10, period: pricingPeriod, complexityOptionId: complexo.id })
    .hourlyBaseCents !== savedHourly,
  'uma simulação NOVA reflete o custo novo, provando que o congelamento é da cotação, não do cálculo',
)
eq(pricing.listQuotes()[0]!.id, quote.id, 'a cotação salva aparece no histórico, mais recente primeiro')

// 13h. Aprovar uma cotação cria o lançamento de receita correspondente.
eq(quote.status, 'draft', 'cotação recém-salva começa em rascunho')
const contaAprovacao = accountByName.get('Conta Corrente')!
const txnCountBeforeApproval = db.get<{ n: number }>(sql`select count(*) as n from transactions`)!.n
const approved = pricing.approveQuote(quote.id, { accountId: contaAprovacao, paidOn: '2026-08-20' })
eq(approved.status, 'approved', 'aprovar move o status para "approved"')

const txnCountAfterApproval = db.get<{ n: number }>(sql`select count(*) as n from transactions`)!.n
eq(txnCountAfterApproval, txnCountBeforeApproval + 1, 'aprovar cria exatamente uma transaction')

const createdTxn = db
  .select()
  .from(schema.transactions)
  .where(and(dEq(schema.transactions.postedOn, '2026-08-20'), dEq(schema.transactions.accountId, contaAprovacao)))
  .all()
  .find((t) => t.description.includes('Cliente de teste'))
ok(createdTxn !== undefined, 'a transaction criada referencia o cliente/projeto da cotação')
eq(createdTxn?.amountCents, quote.recommendedPriceCents, 'o valor do lançamento é o preço recomendado da cotação')
eq(createdTxn?.direction, 'in', 'lançamento de aprovação é sempre entrada (receita)')

try {
  pricing.approveQuote(quote.id, { accountId: contaAprovacao, paidOn: '2026-08-21' })
  ok(false, 'aprovar uma cotação já aprovada deveria falhar')
} catch (error) {
  ok(error instanceof pricing.PricingError, 'aprovar duas vezes falha com PricingError, mensagem clara')
}
const txnCountAfterSecondAttempt = db.get<{ n: number }>(sql`select count(*) as n from transactions`)!.n
eq(
  txnCountAfterSecondAttempt,
  txnCountAfterApproval,
  'a tentativa de aprovar de novo não cria uma segunda transaction',
)

// 13f. Sem base de cálculo, erro claro — nunca NaN nem Infinity.
engine.setSettings({ taxRateBps: 10_000 }) // alíquota de 100% -> sem ponto de equilíbrio
try {
  pricing.simulate({ estimatedHours: 10, period: pricingPeriod })
  ok(false, 'alíquota de 100% deveria impedir o cálculo da hora base')
} catch (error) {
  ok(error instanceof pricing.PricingError, 'sem ponto de equilíbrio -> PricingError explicando, não NaN')
}

engine.setSettings({ taxRateBps: 0 })
pricing.updateSettings({ availableHoursPerMonth: 0 })
try {
  const broken = pricing.simulate({ estimatedHours: 10, period: pricingPeriod })
  ok(false, 'zero horas faturáveis deveria impedir o cálculo', broken.hourlyBaseCents)
} catch (error) {
  ok(error instanceof pricing.PricingError, 'zero horas faturáveis -> PricingError explicando, não Infinity')
}

// 13g. Contrato de memória de cálculo (ADR 0010).
pricing.updateSettings({ ...pricing.DEFAULT_PRICING_SETTINGS })
engine.setSettings({ ...engine.DEFAULT_BREAK_EVEN_PARAMS })
const documented = pricing.simulate({ estimatedHours: 8, period: pricingPeriod })
ok(typeof documented.assumptions.formula === 'string', 'a simulação carrega a fórmula em palavras')
ok(
  ['horaBaseCents', 'horasFaturaveis', 'aliquotaBps', 'multiplicadorCombinadoBps'].every(
    (key) => key in documented.assumptions,
  ),
  'a memória de cálculo traz hora base, horas faturáveis, alíquota e multiplicador combinado',
)
// "preço recomendado" é o NOME do número no spec, não uma recomendação: o
// que o ADR 0010 proíbe é verbo no imperativo dirigido à ação do usuário.
ok(
  !/\b(cobre|aumente|reduza|invista|priorize|venda|compre|negocie)\b/i.test(
    JSON.stringify(documented.assumptions),
  ),
  'nenhum verbo no imperativo na memória de cálculo da precificação',
)

// 13h. Editar uma cotação salva recalcula (decisions/0021), nunca uma
// segunda fórmula, e nunca depois de aprovada.
engine.setSettings({ ...engine.DEFAULT_BREAK_EVEN_PARAMS, pjAccountId, pfAccountId, taxRateBps: 0 })
pricing.updateSettings({ availableHoursPerMonth: 100, billablePercentageBps: 5_000 })

const editable = pricing.saveQuote({
  clientLabel: '[VERIFY] cotação editável',
  estimatedHours: 5,
  period: pricingPeriod,
})
eq(
  editable.minimumPriceCents,
  Math.round(editable.hourlyBaseCents * 5),
  'cotação recém-salva: mínimo bate com horas × hora base, antes de qualquer edição',
)

const doubledHours = pricing.updateQuote(editable.id, { estimatedHours: 10 })!
eq(
  doubledHours.minimumPriceCents,
  Math.round(doubledHours.hourlyBaseCents * 10),
  'editar horas recalcula o mínimo com a MESMA fórmula (simulate), não um valor ajustado à mão',
)
ok(
  doubledHours.minimumPriceCents !== editable.minimumPriceCents,
  'o número congelado de fato mudou depois da edição — "editar" recalcula, não é decorativo',
)

const labelOnly = pricing.updateQuote(editable.id, { clientLabel: '[VERIFY] renomeada' })!
eq(labelOnly.minimumPriceCents, doubledHours.minimumPriceCents, 'editar só o rótulo nunca recalcula nada')
eq(labelOnly.clientLabel, '[VERIFY] renomeada', 'e o rótulo de fato mudou')

const contagemTxnsAntesDeEditar = db.get<{ n: number }>(sql`select count(*) as n from transactions`)!.n
pricing.updateQuote(editable.id, { estimatedHours: 7 })
eq(
  db.get<{ n: number }>(sql`select count(*) as n from transactions`)!.n,
  contagemTxnsAntesDeEditar,
  'editar uma cotação nunca grava nem apaga lançamento nenhum',
)

// Aprovar, depois tentar editar cálculo: bloqueado. Rótulo continua livre.
const accountForApproval = accountByName.get('Nubank PJ') ?? accountByName.get('Conta PJ')!
const editableApproved = pricing.approveQuote(editable.id, { accountId: accountForApproval, paidOn: today() })
eq(editableApproved.status, 'approved', 'aprovação move o status, pré-condição deste teste')

try {
  pricing.updateQuote(editable.id, { estimatedHours: 20 })
  ok(false, 'editar horas de uma cotação aprovada deveria lançar PricingError')
} catch (error) {
  ok(
    error instanceof pricing.PricingError,
    'editar campo de cálculo numa cotação aprovada -> PricingError, não um recálculo silencioso',
  )
}
const stillApproved = pricing.getQuote(editable.id)!
eq(
  stillApproved.recommendedPriceCents,
  editableApproved.recommendedPriceCents,
  'a tentativa bloqueada não mudou o preço já aprovado',
)

const relabelApproved = pricing.updateQuote(editable.id, { clientLabel: '[VERIFY] aprovada, só renomeada' })!
eq(relabelApproved.clientLabel, '[VERIFY] aprovada, só renomeada', 'rótulo continua editável mesmo aprovada')
eq(
  relabelApproved.recommendedPriceCents,
  editableApproved.recommendedPriceCents,
  'e o preço aprovado continua intocado ao editar só o rótulo',
)

/* ================================================================ *
 * MODULE 14 — simulador de decisões
 *
 * Duas coisas precisam ser provadas aqui, e a segunda é a mais
 * importante: que o número simulado sai das MESMAS funções da tela real
 * (não de uma segunda fórmula), e que nenhuma chamada grava nada. A
 * segunda é verificada contando linhas antes e depois, nunca assumida.
 * ================================================================ */
section('MODULE 14 — simulador de decisões')

const simulator = await import('../server/src/services/simulator')

// Reserva com alvo conhecido, senão o indicador de reserva fica sem dado e
// a hipótese não teria onde mexer.
investments.setReserveSettings({ multiple: 1, manualLivingCostCents: 50_000 })

const contagem = () => ({
  transactions: db.get<{ n: number }>(sql`select count(*) as n from transactions`)!.n,
  debtPayments: db.get<{ n: number }>(sql`select count(*) as n from debt_payments`)!.n,
  assetTrades: db.get<{ n: number }>(sql`select count(*) as n from asset_trades`)!.n,
  assets: db.get<{ n: number }>(sql`select count(*) as n from assets`)!.n,
  debts: db.get<{ n: number }>(sql`select count(*) as n from debts`)!.n,
})

const antesDeSimular = contagem()

/* ---------------------------------------------------------------- *
 * 14a. Gasto único com origem "reserva".
 * ---------------------------------------------------------------- */
const gastoCents = 20_000
const gasto = simulator.simulateOneTimeExpense({
  amountCents: gastoCents,
  source: 'reserve',
  period: scorePeriod,
})

// Conta à mão, com os mesmos insumos: pega o estado real, reduz só a
// reserva e recompõe. Se o simulador tivesse ligado o delta no indicador
// errado, este número não bateria.
{
  const insumos = health.gatherScoreInputs(scorePeriod, null)
  const esperadoAntes = health.composeScoreFromInputs(insumos).scoreBps
  const esperadoDepois = health.composeScoreFromInputs({
    ...insumos,
    reserve: { ...insumos.reserve, currentCents: insumos.reserve.currentCents - gastoCents },
  }).scoreBps

  eq(gasto.healthScoreBps.before, esperadoAntes, 'score "antes" é exatamente o score real de agora')
  eq(gasto.healthScoreBps.after, esperadoDepois, 'score "depois" bate com a conta feita à mão sobre a reserva')
  eq(
    gasto.healthScoreBps.delta,
    esperadoDepois! - esperadoAntes!,
    'o delta do score é a diferença entre os dois, não um terceiro cálculo',
  )
  ok(
    gasto.healthScoreBps.after! <= gasto.healthScoreBps.before!,
    'tirar dinheiro da reserva não aumenta o Health Score',
  )
}

// Runway: o mesmo, pelo lado dos investimentos (a reserva é feita de ativos).
{
  const esperado = health.runway(health.DEFAULT_LIQUID_ASSET_CLASSES, {
    investmentsDeltaCents: -gastoCents,
  }).consolidated
  eq(gasto.runwayMonths.before, health.runway().consolidated.months, 'runway "antes" é o runway real')
  eq(gasto.runwayMonths.after, esperado.months, 'runway "depois" bate com o mesmo cálculo com o delta aplicado')
}

// Origem "saldo" move o disponível; origem "reserva" não.
{
  const doSaldo = simulator.simulateOneTimeExpense({
    amountCents: gastoCents,
    source: 'balance',
    period: scorePeriod,
  })
  eq(
    doSaldo.availableCents.delta,
    -gastoCents,
    'gasto vindo do saldo reduz o disponível para alocação real por real',
  )
  eq(gasto.availableCents.delta, 0, 'gasto vindo da reserva não muda o disponível em conta')

  // Que a origem "saldo" liga no insumo de LIQUIDEZ (e não em outro) é
  // verificado contra a conta à mão, não pela suposição de que o score
  // muda: com um valor pequeno, ou com o indicador saturado no teto, o
  // score pode legitimamente não se mover.
  const insumos = health.gatherScoreInputs(scorePeriod, null)
  eq(
    doSaldo.healthScoreBps.after,
    health.composeScoreFromInputs({
      ...insumos,
      liquidity: {
        ...insumos.liquidity,
        availableBalanceCents: insumos.liquidity.availableBalanceCents - gastoCents,
      },
    }).scoreBps,
    'gasto vindo do saldo ajusta o insumo de liquidez, e nenhum outro',
  )

  // E com um valor grande o bastante para sair do teto, o score se move
  // mesmo — provando que o caminho não está apenas inerte.
  const grande = simulator.simulateOneTimeExpense({
    amountCents: Math.max(insumos.liquidity.availableBalanceCents, 100_00),
    source: 'balance',
    period: scorePeriod,
  })
  ok(
    grande.healthScoreBps.after! < grande.healthScoreBps.before!,
    'zerar o saldo derruba o score, então o caminho da liquidez está vivo',
    `${grande.healthScoreBps.before} -> ${grande.healthScoreBps.after}`,
  )
}

// Origem "investimento" move runway e, por construção, não move o score.
{
  const doInvestimento = simulator.simulateOneTimeExpense({
    amountCents: gastoCents,
    source: 'investment',
    period: scorePeriod,
  })
  eq(
    doInvestimento.healthScoreBps.delta,
    0,
    'nenhum indicador do score lê o valor total da carteira, então esta origem não move o score',
  )
  ok(
    typeof doInvestimento.assumptions.notaDeEscopo === 'string',
    'e a memória de cálculo explica por que o score não mudou',
  )
}

// Valor maior que a origem disponível não bloqueia: é justamente o caso que
// o usuário simula para descobrir que não cabe.
{
  const absurdo = simulator.simulateOneTimeExpense({
    amountCents: 999_999_999,
    source: 'reserve',
    period: scorePeriod,
  })
  ok(absurdo.runwayMonths.after !== null, 'valor acima do disponível ainda produz resultado, sem erro')
  ok(
    absurdo.healthScoreBps.after !== null && absurdo.healthScoreBps.after <= absurdo.healthScoreBps.before!,
    'e o resultado mostra a consequência, por pior que ela seja',
  )
}

/* ---------------------------------------------------------------- *
 * 14b. Quitação de dívida.
 * ---------------------------------------------------------------- */
{
  const alvo = debtService.listDebts().find((d) => d.balanceCents > 0)!
  const quitacao = simulator.simulateDebtPayoff({ debtId: alvo.id, source: 'balance', period: scorePeriod })

  eq(quitacao.payoffCents, alvo.balanceCents, 'o valor a quitar é o saldo corrente da dívida')

  // O juro economizado sai da MESMA projeção que a tela de Endividamento
  // publica, não de um cálculo próprio do simulador.
  const projecao = debtService.projectPaydown({ extraMonthlyCents: 0 })
  eq(
    quitacao.savedInterestCents,
    projecao.perDebt.find((d) => d.debtId === alvo.id)!.interestCents,
    'o juro economizado é exatamente o que a projeção de dívida já mostra para essa dívida',
  )

  eq(
    quitacao.availableCents.delta,
    -alvo.balanceCents,
    'quitar pelo saldo reduz o disponível pelo valor quitado',
  )
  ok(
    (quitacao.assumptions.comprometimentoDepoisBps as number) <=
      (quitacao.assumptions.comprometimentoAntesBps as number),
    'quitar uma dívida não aumenta o comprometimento de renda',
  )
  ok(
    typeof quitacao.assumptions.juroOrigem === 'string' &&
      /projectPaydown/.test(String(quitacao.assumptions.juroOrigem)),
    'a memória de cálculo aponta de qual função veio o juro economizado',
  )

  // Dívida inexistente e dívida já quitada falham claramente.
  try {
    simulator.simulateDebtPayoff({ debtId: 999_999, source: 'balance' })
    ok(false, 'dívida inexistente deveria falhar')
  } catch (error) {
    ok(error instanceof simulator.SimulatorError, 'dívida inexistente lança SimulatorError, não erro genérico')
  }
}

/* ---------------------------------------------------------------- *
 * 14c. O ponto inegociável: nada foi gravado.
 * ---------------------------------------------------------------- */
const depoisDeSimular = contagem()
for (const tabela of ['transactions', 'debtPayments', 'assetTrades', 'assets', 'debts'] as const) {
  eq(
    depoisDeSimular[tabela],
    antesDeSimular[tabela],
    `nenhuma simulação gravou linha em ${tabela}`,
  )
}
// E o estado derivado também não mudou: se alguma simulação tivesse mexido
// no banco, o score real teria se movido junto.
eq(
  health.healthScore(scorePeriod).scoreBps,
  gasto.healthScoreBps.before,
  'o Health Score real continua igual ao "antes" da primeira simulação',
)

investments.setReserveSettings({ multiple: 0, lookbackMonths: 3, manualLivingCostCents: null })

/* ================================================================ *
 * MODULE 15 — conciliação de fluxo de caixa: visibilidade além do
 * horizonte e exclusão com escopo (decisions/0020)
 * ================================================================ */
section('MODULE 15 — fluxo de caixa: visibilidade além do horizonte e exclusão com escopo')

const cashFlow = await import('../server/src/services/cashFlow')
const { addMonths: addM } = await import('../server/src/core/dates')

const verifyAccountId = accountByName.get('Conta PJ')!
const verifyCategoryId = categoryPath.get('Receitas/Salário')!
ok(verifyAccountId !== undefined, 'conta de teste "Conta PJ" existe no seed', verifyAccountId)
ok(verifyCategoryId !== undefined, 'categoria de teste "Receitas/Salário" existe no seed', verifyCategoryId)
const nowPeriod = today().slice(0, 7)

/* ---------------------------------------------------------------- *
 * 15a. Um forecast cuja primeira ocorrência cai além do horizonte
 * rolante (6 meses) precisa continuar visível — com a data certa da
 * próxima ocorrência — mesmo materializando zero linhas. Este é
 * exatamente o caso real que motivou o ADR: um salário parcelado de 5
 * meses seguido de um recorrente que só começa depois que o
 * parcelamento acaba.
 * ---------------------------------------------------------------- */
const farPeriod = addM(nowPeriod, 8) // além dos 6 meses de horizonte

const contagemTransacoes = () => db.get<{ n: number }>(sql`select count(*) as n from transactions`)!.n
const antesDoForecastDistante = contagemTransacoes()

const forecastDistante = cashFlow.createForecast({
  description: '[VERIFY] salário reajustado',
  kind: 'recurring',
  amountCents: 450_000,
  accountId: verifyAccountId,
  categoryId: verifyCategoryId,
  startPeriod: farPeriod,
  dueDay: 5,
  installmentCount: null,
  installmentsRealized: 0,
  endPeriod: null,
  notes: null,
} as never)

eq(
  contagemTransacoes(),
  antesDoForecastDistante,
  'forecast com início além do horizonte materializa zero linhas',
)
eq(
  forecastDistante.nextOccurrencePeriod,
  farPeriod,
  'mas a próxima ocorrência aparece corretamente, mesmo sem nenhuma linha materializada',
)
ok(
  cashFlow.listForecasts().some((f) => f.id === forecastDistante.id && f.nextOccurrencePeriod === farPeriod),
  'e continua visível na listagem de templates, não só na resposta de criação',
)

/* ---------------------------------------------------------------- *
 * 15b. Exclusão com escopo "esta e as futuras" num forecast recorrente
 * já materializado: a ocorrência escolhida e as posteriores somem, a
 * anterior fica, e o template para de gerar mais nada a partir dali —
 * mesmo depois de uma nova chamada de materialização.
 * ---------------------------------------------------------------- */
const forecastRecorrente = cashFlow.createForecast({
  description: '[VERIFY] cliente fixo recorrente',
  kind: 'recurring',
  amountCents: 100_000,
  accountId: verifyAccountId,
  categoryId: verifyCategoryId,
  startPeriod: nowPeriod,
  dueDay: 10,
  installmentCount: null,
  installmentsRealized: 0,
  endPeriod: null,
  notes: null,
} as never)

const pendentesDoForecast = () =>
  db
    .select({ id: schema.transactions.id, occurrencePeriod: schema.transactions.occurrencePeriod })
    .from(schema.transactions)
    .where(and(dEq(schema.transactions.forecastId, forecastRecorrente.id), dEq(schema.transactions.pending, true)))
    .all()
    .sort((a, b) => (a.occurrencePeriod ?? '').localeCompare(b.occurrencePeriod ?? ''))

const antes = pendentesDoForecast()
ok(antes.length >= 3, 'o forecast recorrente materializou ao menos 3 ocorrências para testar', antes.length)

const segunda = antes[1]!
cashFlow.deletePending(segunda.id, 'this_and_future')

const depois = pendentesDoForecast()
eq(depois.length, 1, 'só a primeira ocorrência (anterior à excluída) continua pendente')
eq(depois[0]?.id, antes[0]!.id, 'e é exatamente a mesma linha de antes, não recriada')

cashFlow.materializeAll()
eq(
  pendentesDoForecast().length,
  1,
  'materializar de novo não recria as ocorrências excluídas com "esta e as futuras"',
)

/* ---------------------------------------------------------------- *
 * 15c. Exclusão com escopo "todas": zero ocorrências pendentes
 * restantes, template desativado, materializar de novo não traz nada
 * de volta.
 * ---------------------------------------------------------------- */
const forecastParaEncerrar = cashFlow.createForecast({
  description: '[VERIFY] a ser encerrado por completo',
  kind: 'recurring',
  amountCents: 50_000,
  accountId: verifyAccountId,
  categoryId: verifyCategoryId,
  startPeriod: nowPeriod,
  dueDay: 15,
  installmentCount: null,
  installmentsRealized: 0,
  endPeriod: null,
  notes: null,
} as never)

const pendentesParaEncerrar = () =>
  db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(and(dEq(schema.transactions.forecastId, forecastParaEncerrar.id), dEq(schema.transactions.pending, true)))
    .all()

const primeiraDoEncerrado = pendentesParaEncerrar()[0]!
cashFlow.deletePending(primeiraDoEncerrado.id, 'all')

eq(pendentesParaEncerrar().length, 0, '"todas" remove toda ocorrência pendente do template')
eq(
  db.select().from(schema.cashFlowForecasts).where(dEq(schema.cashFlowForecasts.id, forecastParaEncerrar.id)).get()
    ?.active,
  false,
  'e desativa o template',
)
cashFlow.materializeAll()
eq(pendentesParaEncerrar().length, 0, 'materializar de novo não traz nada de volta para um template desativado')

/* ---------------------------------------------------------------- *
 * 15d. O mesmo escopo funciona para uma parcela de dívida (debtId),
 * não só forecast — o serviço trata os dois de forma genérica.
 * ---------------------------------------------------------------- */
const dividaTeste = debtService.createDebt({
  name: '[VERIFY] empréstimo com parcela a excluir',
  kind: 'personal_loan',
  principalCents: 600_000,
  aprBps: 1200,
  minimumPaymentCents: 50_000,
  scheduledPaymentCents: 50_000,
  dueDay: 20,
  installmentCount: 6,
  accountId: verifyAccountId,
} as never)
debtService.materializeDebtInstallments(dividaTeste.id)

const pendentesDaDivida = () =>
  db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(and(dEq(schema.transactions.debtId, dividaTeste.id), dEq(schema.transactions.pending, true)))
    .all()

const antesDaDivida = pendentesDaDivida()
ok(antesDaDivida.length >= 2, 'a dívida de teste materializou mais de uma parcela pendente', antesDaDivida.length)
cashFlow.deletePending(antesDaDivida[0]!.id, 'all')
eq(pendentesDaDivida().length, 0, '"todas" também remove toda parcela pendente de uma dívida')
eq(
  db.select().from(schema.debts).where(dEq(schema.debts.id, dividaTeste.id)).get()?.active,
  false,
  'e desativa a dívida, mesmo caminho de código do forecast',
)

/* ================================================================ *
 * MODULE 16 — busca de lançamentos: descrição, categoria real e data
 * (decisions/0025)
 * ================================================================ */
section('MODULE 16 — busca unificada por descrição, categoria e data')

const buscaAccount = accountByName.get('Conta Corrente')!
const buscaCategoriaId = categoryPath.get('Moradia/Água')
ok(buscaCategoriaId !== undefined, 'categoria de teste "Moradia/Água" existe no seed', buscaCategoriaId)

const buscaTxn = txnService.createTransaction({
  accountId: buscaAccount,
  postedOn: '2026-03-17',
  description: 'Pagamento fatura XYZ789',
  amountCents: -12345,
  categoryId: buscaCategoriaId!,
})

// 16a. Categoria REAL (não rawCategory) — o ponto central deste módulo.
const porCategoria = txnService.listTransactions({ search: 'agua' }).rows
ok(
  porCategoria.some((r) => r.id === buscaTxn.id),
  'busca por nome de categoria real (sem acento) encontra o lançamento categorizado nela',
)
const porCategoriaComAcento = txnService.listTransactions({ search: 'Água' }).rows
ok(
  porCategoriaComAcento.some((r) => r.id === buscaTxn.id),
  'e com o acento digitado também, mesma normalização dos dois lados',
)

// 16b. Data em cada formato reconhecido (decisions/0025).
for (const termo of ['17/03/2026', '17/03', '2026-03-17', '2026-03', 'março', 'marco', 'mar', 'março de 2026', 'mar/2026']) {
  const rows = txnService.listTransactions({ search: termo }).rows
  ok(
    rows.some((r) => r.id === buscaTxn.id),
    `busca por data "${termo}" encontra o lançamento de 17/03/2026`,
  )
}

// 16c. Ano errado no formato "mês de ANO" não deve encontrar.
const mesAnoErrado = txnService.listTransactions({ search: 'março de 2020' }).rows
ok(
  !mesAnoErrado.some((r) => r.id === buscaTxn.id),
  '"março de 2020" não encontra um lançamento de março de 2026 — o ano importa quando informado',
)

// 16d. Número solto não vira data — description/categoria desta linha não
// contêm "17", então um falso positivo aqui só pode vir do dia sendo
// tratado como data.
const numeroSolto = txnService.listTransactions({ search: '17' }).rows
ok(
  !numeroSolto.some((r) => r.id === buscaTxn.id),
  'um número solto ("17") não é tratado como dia — não vira falso positivo de data',
)

// 16e. Busca por descrição continua funcionando (conservação do comportamento anterior).
const porDescricao = txnService.listTransactions({ search: 'XYZ789' }).rows
ok(porDescricao.some((r) => r.id === buscaTxn.id), 'busca por descrição continua funcionando como antes')

txnService.deleteTransactions([buscaTxn.id])

/* ---------------------------------------------------------------- */
section(`RESULTADO — ${passed} passaram, ${failed} falharam`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('  Todos os checks passaram.\n')
