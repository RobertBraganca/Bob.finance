import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { sql } from 'drizzle-orm'
import {
  computeClientMetrics,
  matchPayer,
  quoteStatusToStage,
  stageToQuoteStatus,
  summarizeClients,
  type ClientMetrics,
} from '../../shared/deals'

/**
 * Clientes, catálogo de serviços e negócios (docs/specs/clientes-e-negocios).
 *
 *  - Puros: estágios unificados, métricas, carteira e casamento pelo pagador.
 *  - Banco: SEMPRE dentro de uma `db.transaction` que termina em rollback, com
 *    a migração aplicada na própria transação (DDL é transacional). Dados `[teste]`.
 *  - O último teste confere que nada ficou: zero linhas `[teste]` e, enquanto a
 *    migração não for autorizada, a tabela `clients` não existe.
 *
 * Credenciais: `.env` da pasta ou BOB_ENV_FILE. Sem elas, a parte de banco é pulada.
 */

/* ------------------------------------------------------------------ *
 * Puros
 * ------------------------------------------------------------------ */
test('estágios: "em revisão" e "em ajuste" da cotação são "em negociação"; a volta vira "em revisão"', () => {
  assert.equal(quoteStatusToStage('in_review'), 'negotiating')
  assert.equal(quoteStatusToStage('needs_changes'), 'negotiating')
  assert.equal(quoteStatusToStage('paused'), 'paused')
  assert.equal(quoteStatusToStage('approved'), 'approved')
  assert.equal(stageToQuoteStatus('negotiating'), 'in_review')
  assert.equal(stageToQuoteStatus('sent'), 'sent')
})

const base = {
  currentPeriod: '2026-10',
  flaggedRecurring: false,
  realizedByPeriod: new Map<string, number>(),
  pendingCents: 0,
  approvedDealCents: [] as number[],
  rejectedDeals: 0,
  openPipelineCents: 0,
  lastRevenueOn: null,
}

test('métricas: LTV realizado e previsto, ticket e taxa de aprovação', () => {
  const m = computeClientMetrics({
    ...base,
    realizedByPeriod: new Map([['2026-08', 100_000], ['2026-09', 50_000]]),
    pendingCents: 25_000,
    approvedDealCents: [100_000, 50_000],
    rejectedDeals: 2,
    openPipelineCents: 30_000,
    lastRevenueOn: '2026-09-10',
  })
  assert.equal(m.ltvRealizedCents, 150_000)
  assert.equal(m.ltvForecastCents, 175_000)
  assert.equal(m.monthsWithRevenue, 2)
  assert.equal(m.avgTicketCents, 75_000)
  assert.equal(m.approvalRateBps, 5_000)
  assert.equal(m.openPipelineCents, 30_000)
})

test('recorrência: marcado, 3 meses com receita ou 2 negócios aprovados; senão não', () => {
  assert.equal(computeClientMetrics({ ...base, flaggedRecurring: true }).recurringReason, 'flag')
  const months = new Map([['2026-07', 1], ['2026-08', 1], ['2026-09', 1]])
  assert.equal(computeClientMetrics({ ...base, realizedByPeriod: months }).recurringReason, 'months')
  assert.equal(computeClientMetrics({ ...base, approvedDealCents: [1, 2] }).recurringReason, 'deals')
  const one = computeClientMetrics({ ...base, realizedByPeriod: new Map([['2026-09', 500]]), approvedDealCents: [500] })
  assert.equal(one.isRecurring, false)
  assert.equal(one.mrrCents, 0, 'quem não é recorrente não entra no MRR')
})

test('MRR: média dos 3 meses FECHADOS (o mês corrente fica fora)', () => {
  const m = computeClientMetrics({
    ...base,
    flaggedRecurring: true,
    realizedByPeriod: new Map([['2026-07', 90_000], ['2026-08', 60_000], ['2026-09', 30_000], ['2026-10', 999_999], ['2026-06', 999_999]]),
  })
  assert.equal(m.mrrCents, 60_000)
  assert.equal(m.last12Cents, 90_000 + 60_000 + 30_000 + 999_999)
})

test('carteira: arquivado fora, lead não é cliente ativo, concentração pelo maior dos 12 meses', () => {
  const metrics = (last12: number, ltv: number, mrr = 0, recurring = false): ClientMetrics => ({
    ...computeClientMetrics(base),
    last12Cents: last12,
    ltvRealizedCents: ltv,
    mrrCents: mrr,
    isRecurring: recurring,
  })
  const o = summarizeClients([
    { id: 1, name: 'A', kind: 'company', status: 'active', metrics: metrics(75_000, 200_000, 20_000, true) },
    { id: 2, name: 'B', kind: 'company', status: 'inactive', metrics: metrics(25_000, 50_000) },
    { id: 3, name: 'Lead', kind: 'lead', status: 'active', metrics: metrics(0, 0) },
    { id: 4, name: 'Velho', kind: 'company', status: 'archived', metrics: metrics(500_000, 500_000, 9, true) },
  ])
  assert.equal(o.activeClients, 1)
  assert.equal(o.leads, 1)
  assert.equal(o.recurringClients, 1)
  assert.equal(o.mrrCents, 20_000)
  assert.equal(o.ltvRealizedCents, 250_000)
  assert.equal(o.avgLtvCents, 125_000)
  assert.deepEqual(o.concentration, { clientId: 1, name: 'A', shareBps: 7_500 })
})

test('pagador: o nome mais longo vence; nome curto demais não casa', () => {
  const aliases = [
    { clientId: 1, alias: 'kleber' },
    { clientId: 2, alias: 'kleber de mello tristao' },
    { clientId: 3, alias: 'ab' },
  ]
  assert.equal(matchPayer('transferencia recebida kleber de mello tristao', aliases), 2)
  assert.equal(matchPayer('pix kleber souza', aliases), 1)
  assert.equal(matchPayer('ab cd', aliases), null)
})

/* ------------------------------------------------------------------ *
 * Banco (em transação que sempre desfaz)
 * ------------------------------------------------------------------ */
try {
  process.loadEnvFile(process.env.BOB_ENV_FILE)
} catch {
  // sem .env: a parte de banco é pulada
}
const hasDb = Boolean(process.env.SUPABASE_DB_HOST && process.env.SUPABASE_DB_PASSWORD)
const skip = hasDb ? false : 'sem credenciais do banco (.env ou BOB_ENV_FILE)'
const loaded = hasDb
  ? {
      client: await import('../../server/src/db/client'),
      schema: await import('../../server/src/db/schema'),
      clients: await import('../../server/src/services/clients'),
      catalog: await import('../../server/src/services/serviceCatalog'),
      deals: await import('../../server/src/services/deals'),
      txns: await import('../../server/src/services/transactions'),
      pricing: await import('../../server/src/services/pricing'),
      dates: await import('../../server/src/core/dates'),
    }
  : null

const MIGRATION = [
  '../../supabase/migrations/20261021120000_clients_and_deals.sql',
  '../../supabase/migrations/20261021180000_client_transaction_links.sql',
]
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')
const TAG = '[teste]'
class Rollback extends Error {}
type Tx = import('../../server/src/db/client').DbExecutor

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  const { db } = loaded!.client
  try {
    await db.transaction(async (tx) => {
      // A migração é idempotente: já aplicada, só refaz o passo de dados dentro da transação.
      await tx.execute(sql`set local client_min_messages = warning`)
      await tx.execute(sql.raw(MIGRATION))
      await fn(tx)
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
}

const rejectsPricing = (run: () => Promise<unknown>, pattern: RegExp) =>
  assert.rejects(run, (error: unknown) => error instanceof loaded!.pricing.PricingError && pattern.test((error as Error).message))

test('pagador: só o nome, sem CPF, banco, agência e conta', { skip }, () => {
  const { payerOf } = loaded!.clients
  assert.equal(
    payerOf('Transferência Recebida - Maria Teste de Souza - •••.111.222-•• - NU PAGAMENTOS - IP (0260) Agência: 1 Conta: 1234567-8'),
    'maria teste de souza',
  )
  assert.equal(
    payerOf('Transferência recebida pelo Pix - LOJA TESTE LTDA - 11.222.333/0001-44 - SICOOB Agência: 3001 Conta: 58100-3'),
    'loja teste ltda',
  )
  assert.equal(payerOf('Transferência Recebida - 11.222.333 JOAO TESTE - 11.222.333/0001-44 - NU PAGAMENTOS'), 'joao teste')
  assert.equal(payerOf('Transferência Recebida|KLEBER DE MELLO TRISTAO'), 'kleber de mello tristao')
  assert.equal(payerOf('Compra no débito - Mercado'), null)
})

describe('clientes no banco (rollback)', { skip }, () => {
  test('a migração cria um cliente por nome dos orçamentos e liga os documentos', async () => {
    await inRollback(async (tx) => {
      const { serviceProposals, clients } = loaded!.schema
      const labels = new Set(
        (await tx.select({ label: serviceProposals.clientLabel }).from(serviceProposals)).map((r) => r.label.trim().toLowerCase()).filter(Boolean),
      )
      const names = new Set((await tx.select().from(clients)).map((c) => c.name.trim().toLowerCase()))
      for (const label of labels) assert.ok(names.has(label), `cliente para "${label}"`)
      const unlinked = await tx.select().from(serviceProposals).where(sql`${serviceProposals.clientId} is null`)
      assert.equal(unlinked.length, 0, 'todo orçamento com nome fica ligado ao cliente')
    })
  })

  test('cadastro, nome repetido, contato principal único e nome no extrato', async () => {
    await inRollback(async (tx) => {
      const svc = loaded!.clients
      const a = await svc.createClient({ name: `${TAG} Estúdio Alfa`, kind: 'company', email: 'CONTATO@ALFA.COM' }, tx)
      assert.equal(a.email, 'contato@alfa.com')
      await rejectsPricing(() => svc.createClient({ name: `${TAG} estúdio alfa` }, tx), /já existe/)

      const c1 = await svc.addContact(a.id, { name: 'Ana', isPrimary: true }, tx)
      const c2 = await svc.addContact(a.id, { name: 'Bia', isPrimary: true }, tx)
      const { clientContacts } = loaded!.schema
      const rows = await tx.select().from(clientContacts).where(sql`${clientContacts.clientId} = ${a.id}`)
      assert.equal(rows.find((r) => r.id === c1.id)!.isPrimary, false)
      assert.equal(rows.find((r) => r.id === c2.id)!.isPrimary, true)

      const alias = await svc.addPayerAlias(a.id, 'KLÉBER  de Mello', tx)
      assert.equal(alias.alias, 'kleber de mello')
      const b = await svc.createClient({ name: `${TAG} Beta` }, tx)
      await rejectsPricing(() => svc.addPayerAlias(b.id, 'kleber de mello', tx), /já está ligado/)
      await rejectsPricing(() => svc.addPayerAlias(b.id, 'ab', tx), /3 letras/)
    })
  })

  test('lançamento escolhido à mão: vence o nome do pagador, trava para outro cliente e volta ao desligar', async () => {
    await inRollback(async (tx) => {
      const { accounts } = loaded!.schema
      const svc = loaded!.clients
      const { createTransaction } = loaded!.txns
      const account = (await tx.insert(accounts).values({ name: `${TAG} Conta`, institution: TAG }).returning())[0]!
      const alpha = await svc.createClient({ name: `${TAG} Cliente Delta` }, tx)
      const beta = await svc.createClient({ name: `${TAG} Cliente Épsilon` }, tx)
      await svc.addPayerAlias(alpha.id, 'delta servicos', tx)
      const pix = await createTransaction(
        { accountId: account.id, postedOn: '2026-09-12', description: `Transferência Recebida|${TAG} DELTA SERVIÇOS`, amountCents: 40_000, notes: null },
        tx,
      )
      const loose = await createTransaction(
        { accountId: account.id, postedOn: '2026-09-20', description: `${TAG} Projeto especial deltaepsilon`, amountCents: 25_000, notes: null },
        tx,
      )
      const out = await createTransaction(
        { accountId: account.id, postedOn: '2026-09-21', description: `${TAG} Pagamento deltaepsilon`, amountCents: -9_000, notes: null },
        tx,
      )

      // o candidato diz a quem conta hoje (Delta, pelo nome) antes de ligar
      const candidates = (await svc.transactionCandidates(beta.id, { q: 'delta' }, tx))!
      const pixCandidate = candidates.find((c) => c.id === pix.id)!
      assert.equal(pixCandidate.linkedTo?.clientId, alpha.id)
      assert.equal(pixCandidate.linkedTo?.via, 'payer')
      assert.ok(!candidates.some((c) => c.id === out.id), 'saída não é candidata')

      assert.deepEqual(await svc.linkTransactions(beta.id, [pix.id, loose.id], tx), { linked: 2, alreadyLinked: 0 })
      const mine = async (clientId: number) => (await svc.linkedRevenue(tx, clientId)).map((r) => [r.id, r.via]).sort()
      assert.deepEqual(await mine(beta.id), [[pix.id, 'manual'], [loose.id, 'manual']].sort())
      assert.deepEqual(await mine(alpha.id), [], 'a escolha vence o nome do pagador')

      // repetir é inofensivo; para outro cliente é recusado; saída também
      assert.deepEqual(await svc.linkTransactions(beta.id, [pix.id], tx), { linked: 0, alreadyLinked: 1 })
      await rejectsPricing(() => svc.linkTransactions(alpha.id, [pix.id], tx), /já foi escolhido/)
      await rejectsPricing(() => svc.linkTransactions(alpha.id, [out.id], tx), /só entradas/)

      // desligado, volta a contar pelo nome do pagador
      assert.deepEqual(await svc.unlinkTransaction(beta.id, pix.id, tx), { removed: 1 })
      assert.deepEqual(await mine(alpha.id), [[pix.id, 'payer']])
      assert.equal((await svc.getClient(beta.id, tx))!.metrics.ltvRealizedCents, 25_000)
    })
  })

  test('receita do cliente: pelo orçamento de origem e pelo nome do pagador, sem contar duas vezes', async () => {
    await inRollback(async (tx) => {
      const { accounts, serviceProposals } = loaded!.schema
      const svc = loaded!.clients
      const { createTransaction } = loaded!.txns
      const account = (await tx.insert(accounts).values({ name: `${TAG} Conta`, institution: TAG }).returning())[0]!
      const client = await svc.createClient({ name: `${TAG} Cliente Gama` }, tx)
      await svc.addPayerAlias(client.id, 'gama comunicacao', tx)
      const proposal = (
        await tx.insert(serviceProposals).values({ title: `${TAG} Site`, clientLabel: client.name, clientId: client.id, status: 'approved', approvedAmountCents: 100_000 }).returning()
      )[0]!
      // receita gerada pela aprovação (ligada ao orçamento), já recebida
      const fromProposal = await createTransaction(
        { accountId: account.id, postedOn: '2026-08-10', description: `${TAG} Projeto Site 1/2 GAMA COMUNICACAO`, amountCents: 50_000, notes: null },
        tx,
      )
      const { transactions } = loaded!.schema
      await tx.update(transactions).set({ sourceProposalId: proposal.id }).where(sql`${transactions.id} = ${fromProposal.id}`)
      // a segunda parcela, a receber
      const pending = await createTransaction(
        { accountId: account.id, postedOn: '2026-11-10', description: `${TAG} Projeto Site 2/2`, amountCents: 50_000, pending: true, notes: null },
        tx,
      )
      await tx.update(transactions).set({ sourceProposalId: proposal.id }).where(sql`${transactions.id} = ${pending.id}`)
      // um Pix do cliente fora de orçamento, casado pelo nome
      await createTransaction(
        { accountId: account.id, postedOn: '2026-09-05', description: `Transferência Recebida|${TAG} GAMA COMUNICAÇÃO LTDA`, amountCents: 30_000, notes: null },
        tx,
      )
      // saída com o mesmo nome não é receita
      await createTransaction(
        { accountId: account.id, postedOn: '2026-09-06', description: `Pix enviado|GAMA COMUNICACAO`, amountCents: -5_000, notes: null },
        tx,
      )

      const revenue = await svc.linkedRevenue(tx, client.id)
      assert.deepEqual(revenue.map((r) => [r.via, r.amountCents, r.pending]).sort(), [
        ['payer', 30_000, false],
        ['proposal', 50_000, false],
        ['proposal', 50_000, true],
      ])
      const detail = (await svc.getClient(client.id, tx))!
      assert.equal(detail.metrics.ltvRealizedCents, 80_000)
      assert.equal(detail.metrics.ltvForecastCents, 130_000)
      assert.equal(detail.metrics.monthsWithRevenue, 2)
      assert.equal(detail.deals.length, 1)
      assert.equal(detail.deals[0]!.stage, 'approved')

      const list = await svc.listClients({ q: 'gama' }, tx)
      assert.equal(list.clients.length, 1)
      assert.equal(list.clients[0]!.metrics.ltvRealizedCents, 80_000)
    })
  })

  test('catálogo: serviço vendido conta pela fatia do valor aprovado; item solto cai em "sem catálogo" e é adotado pelo título', async () => {
    await inRollback(async (tx) => {
      const { serviceProposals, serviceProposalItems } = loaded!.schema
      const catalog = loaded!.catalog
      const logo = await catalog.createService({ name: `${TAG} Logotipo`, defaultPriceCents: 80_000 }, tx)
      await rejectsPricing(() => catalog.createService({ name: `${TAG} logotipo` }, tx), /já existe/)
      // aprovado por 90.000 (10% de desconto sobre 100.000): logo 60.000 e manual 40.000 no subtotal
      const p = (
        await tx.insert(serviceProposals).values({ title: `${TAG} Marca`, clientLabel: `${TAG} Cliente`, status: 'approved', discountBps: 1_000, approvedAmountCents: 90_000 }).returning()
      )[0]!
      await tx.insert(serviceProposalItems).values([
        { proposalId: p.id, title: 'Logo', unitPriceCents: 60_000, quantity: 1, serviceId: logo.id },
        { proposalId: p.id, title: `${TAG} Manual da marca`, unitPriceCents: 40_000, quantity: 1 },
      ])
      const listed = await catalog.listServices(tx)
      const stats = listed.services.find((s) => s.id === logo.id)!.stats
      assert.equal(stats.timesSold, 1)
      assert.equal(stats.revenueCents, 54_000)
      const loose = listed.uncatalogued.find((u) => u.title === `${TAG} Manual da marca`)!
      assert.equal(loose.revenueCents, 36_000)

      const manual = await catalog.createService({ name: `${TAG} manual da MARCA` }, tx)
      assert.equal((await catalog.adoptItemsByTitle(manual.id, tx)).linked, 1)
    })
  })

  test('negócios: cotação e orçamento numa lista só, nos estágios unificados; aprovar por aqui é recusado', async () => {
    await inRollback(async (tx) => {
      const { serviceProposals, projectQuotes } = loaded!.schema
      const client = await loaded!.clients.createClient({ name: `${TAG} Delta` }, tx)
      await tx.insert(serviceProposals).values({ title: `${TAG} Proposta`, clientLabel: client.name, clientId: client.id, status: 'sent' })
      await tx.insert(projectQuotes).values({
        clientLabel: `${TAG} Projeto Delta`,
        clientId: client.id,
        estimatedHours: 10,
        hourlyBaseCents: 10_000,
        minimumPriceCents: 80_000,
        recommendedPriceCents: 100_000,
        premiumPriceCents: 130_000,
        status: 'in_review',
      })
      const deals = await loaded!.deals.listDeals({ clientId: client.id }, tx)
      assert.deepEqual(deals.map((d) => [d.kind, d.stage, d.clientName]).sort(), [
        ['proposal', 'sent', client.name],
        ['quote', 'negotiating', client.name],
      ])
      const onlyNegotiating = await loaded!.deals.listDeals({ clientId: client.id, stages: ['negotiating'] }, tx)
      assert.equal(onlyNegotiating.length, 1)
      const summary = await loaded!.deals.dealsSummary(tx)
      assert.ok(summary.byStage.negotiating.count >= 1)
    })
    await rejectsPricing(() => loaded!.deals.setDealStage('quote', 1, 'approved'), /use a aprovação/)
  })
})

describe('nada ficou no banco real', { skip }, () => {
  test('sem linhas [teste] em nenhuma tabela tocada', async () => {
    const { db } = loaded!.client
    const count = async (table: string, column: string) =>
      Number(((await db.execute(sql.raw(`select count(*)::int as n from ${table} where ${column} like '[teste]%'`))) as unknown as Array<{ n: number }>)[0]!.n)
    assert.equal(await count('transactions', 'description'), 0)
    assert.equal(await count('accounts', 'name'), 0)
    assert.equal(await count('service_proposals', 'title'), 0)
    assert.equal(await count('project_quotes', 'client_label'), 0)
    const exists = (await db.execute(sql`select to_regclass('public.clients') as t`)) as unknown as Array<{ t: string | null }>
    if (exists[0]!.t !== null) assert.equal(await count('clients', 'name'), 0)
  })
})

after(async () => {
  if (loaded) await (loaded.client.db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
})
