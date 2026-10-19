import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { sql } from 'drizzle-orm'

/**
 * Banco, casamento, aplicar e desfazer do assistente (etapas 2 a 4 do plano).
 *
 *  - Casamento: só LEITURA contra o banco real.
 *  - Escrita: sempre DENTRO de uma `db.transaction` que termina em rollback
 *    (erro sentinela), depois de rodar o SQL da migração na própria transação
 *    (DDL é transacional no Postgres). Dados rotulados `[teste]`.
 *  - O último teste confere que nada ficou: zero linhas `[teste]` e a tabela
 *    `assistant_actions` NÃO existe (a migração só se aplica com autorização).
 *
 * Credenciais: `.env` da pasta, ou o arquivo apontado por BOB_ENV_FILE.
 * Sem credenciais, a suíte inteira é pulada.
 */

try {
  process.loadEnvFile(process.env.BOB_ENV_FILE)
} catch {
  // sem .env: o db/client falha logo abaixo e a suíte é pulada
}

const hasDb = Boolean(process.env.SUPABASE_DB_HOST && process.env.SUPABASE_DB_PASSWORD)
const skip = hasDb ? false : 'sem credenciais do banco (.env ou BOB_ENV_FILE)'

// Import dinâmico: o db/client lê o ambiente ao ser carregado.
const loaded = hasDb
  ? {
      client: await import('../../server/src/db/client'),
      schema: await import('../../server/src/db/schema'),
      matcher: await import('../../server/src/services/assistant/matcher'),
      cards: await import('../../server/src/services/assistant/cards'),
      apply: await import('../../server/src/services/assistant/apply'),
      errors: await import('../../server/src/services/assistant/errors'),
      txns: await import('../../server/src/services/transactions'),
      dates: await import('../../server/src/core/dates'),
    }
  : null

const MIGRATION = readFileSync(new URL('../../supabase/migrations/20261019120000_assistant_actions.sql', import.meta.url), 'utf8')
const TAG = '[teste]'

class Rollback extends Error {}

type Tx = import('../../server/src/db/client').DbExecutor

/** Roda `fn` numa transação com a migração aplicada e SEMPRE desfaz no fim. */
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  const { db } = loaded!.client
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(MIGRATION))
      await fn(tx)
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
}

/** Espera a ação falhar com AssistantError do código dado. */
async function rejectsWith(code: string, run: () => Promise<unknown>): Promise<void> {
  const { AssistantError } = loaded!.errors
  await assert.rejects(run, (error: unknown) => error instanceof AssistantError && error.code === code, `esperava AssistantError(${code})`)
}

function day(offset: number): string {
  return loaded!.dates.addDays(loaded!.dates.todayIso(), offset)
}

/** Dados rotulados [teste]: uma conta, dois ativos, duas pendências e um lançamento pago. */
async function seed(tx: Tx) {
  const { accounts, assets, categories } = loaded!.schema
  const { createTransaction } = loaded!.txns
  const account = (await tx.insert(accounts).values({ name: `${TAG} Conta`, institution: TAG }).returning())[0]!
  const asset = (await tx.insert(assets).values({ name: `${TAG} Ativo`, ticker: 'TSTE3', assetClass: 'stocks' }).returning())[0]!
  const archivedAsset = (
    await tx.insert(assets).values({ name: `${TAG} Ativo arquivado`, assetClass: 'stocks', archived: true }).returning()
  )[0]!
  const income = await createTransaction(
    { accountId: account.id, postedOn: day(3), description: `${TAG} Coral Opus`, amountCents: 75_000, pending: true, notes: null },
    tx,
  )
  const expense = await createTransaction(
    { accountId: account.id, postedOn: day(5), description: `${TAG} Aluguel do estudio`, amountCents: -120_000, pending: true, notes: 'combinado' },
    tx,
  )
  const settled = await createTransaction(
    { accountId: account.id, postedOn: day(-2), description: `${TAG} Mercado pago`, amountCents: -8_990, pending: false, notes: null },
    tx,
  )
  const category = (await tx.select().from(categories).limit(1))[0]
  return { account, asset, archivedAsset, income, expense, settled, category }
}

const proposalOf = (actions: unknown[], summary = `${TAG} proposta`) => ({ summary, actions, questions: [] }) as never

describe('assistente: casamento (só leitura, banco real)', { skip }, () => {
  test('listContext traz contas, TAGs e ativos, sem saldos nem cartões', async () => {
    const context = await loaded!.matcher.listContext('2026-10-19')
    assert.equal(context.today, '2026-10-19')
    assert.deepEqual(Object.keys(context).sort(), ['accounts', 'assets', 'categories', 'today'])
    assert.ok(context.accounts.length > 0)
    for (const account of context.accounts) assert.deepEqual(Object.keys(account).sort(), ['id', 'name'])
    for (const asset of context.assets) assert.deepEqual(Object.keys(asset).sort(), ['assetClass', 'id', 'name', 'ticker'])
    for (const category of context.categories) assert.deepEqual(Object.keys(category).sort(), ['id', 'kind', 'name'])
    const { db } = loaded!.client
    const { accounts } = loaded!.schema
    const cardAccounts = await db.select({ id: accounts.id }).from(accounts).where(sql`${accounts.kind} = 'credit_card'`)
    const ids = new Set(context.accounts.map((a) => a.id))
    for (const card of cardAccounts) assert.ok(!ids.has(card.id), 'conta de cartão de crédito não pode ir ao modelo')
  })

  test('searchPending acha a pendência pelo valor e pelo texto, ordenada por força, no máximo 5', async () => {
    const { listPending } = await import('../../server/src/services/cashFlow')
    const rows = [...(await listPending('income')), ...(await listPending('expense'))]
    if (rows.length === 0) return
    const target = rows[0]!
    const found = await loaded!.matcher.searchPending({ amountCents: Math.abs(target.amountCents), text: target.description })
    assert.ok(found.length >= 1 && found.length <= 5)
    assert.ok(found.some((c) => c.id === target.id && c.kind === 'pending'))
    const rank = { exact: 0, likely: 1, weak: 2 } as const
    for (let i = 1; i < found.length; i++) assert.ok(rank[found[i - 1]!.strength] <= rank[found[i]!.strength], 'ordem por força')
    assert.notEqual(found[0]!.strength, 'weak')
    // Valor com sinal: despesa negativa, receita positiva.
    const hit = found.find((c) => c.id === target.id)!
    assert.equal(hit.amountCents < 0, target.direction === 'out')
    const onlyFlow = await loaded!.matcher.searchPending({ flow: target.direction === 'in' ? 'income' : 'expense' })
    for (const c of onlyFlow) assert.equal(c.amountCents > 0, target.direction === 'in')
  })

  test('searchPending respeita a janela de datas', async () => {
    const found = await loaded!.matcher.searchPending({ from: '1999-01-01', to: '1999-01-31' })
    assert.deepEqual(found, [])
  })

  test('searchTransactions acha um lançamento real pelo valor e pelo texto', async () => {
    const { db } = loaded!.client
    const { transactions } = loaded!.schema
    const row = (
      await db
        .select({ id: transactions.id, description: transactions.description, amountCents: transactions.amountCents, postedOn: transactions.postedOn })
        .from(transactions)
        .where(sql`${transactions.pending} = false and ${transactions.hidden} = false and length(${transactions.descriptionNorm}) > 4`)
        .orderBy(sql`${transactions.postedOn} desc, ${transactions.id} desc`)
        .limit(1)
    )[0]
    if (!row) return
    // Janela de um dia: lançamentos recorrentes de mesmo valor e texto não empatam a busca.
    const found = await loaded!.matcher.searchTransactions({
      amountCents: Math.abs(row.amountCents),
      text: row.description,
      from: row.postedOn,
      to: row.postedOn,
    })
    assert.ok(found.length >= 1 && found.length <= 5)
    assert.ok(found.some((c) => c.id === row.id && c.kind === 'transaction'))
    const rank = { exact: 0, likely: 1, weak: 2 } as const
    for (let i = 1; i < found.length; i++) assert.ok(rank[found[i - 1]!.strength] <= rank[found[i]!.strength], 'ordem por força')
  })
})

describe('assistente: dados em transação com rollback', { skip }, () => {
  test('searchTransactions enxerga o dado novo pelo executor', () =>
    inRollback(async (tx) => {
      const { settled } = await seed(tx)
      const found = await loaded!.matcher.searchTransactions({ amountCents: 8_990, text: 'mercado pago teste' }, tx)
      const hit = found.find((c) => c.id === settled.id)
      assert.ok(hit, 'achou o lançamento pago [teste]')
      assert.equal(hit.amountCents, -8_990)
      assert.equal(hit.accountName, `${TAG} Conta`)
      // Pendência não entra em searchTransactions.
      const none = await loaded!.matcher.searchTransactions({ text: 'coral opus' }, tx)
      assert.ok(!none.some((c) => c.description.startsWith(TAG)))
    }))

  test('describeAction: antes/depois, destaques e rótulos em português', () =>
    inRollback(async (tx) => {
      const { income, expense } = await seed(tx)
      const { describeAction } = loaded!.cards
      const card = await describeAction(
        { id: 'a1', type: 'update_pending', pendingId: income.id, postedOn: day(60), amountCents: 70_000, notes: '50% finais' },
        tx,
      )
      assert.equal(card.actionId, 'a1')
      assert.equal(card.kind, 'update_pending')
      const byField = Object.fromEntries(card.changes.map((c) => [c.field, c]))
      assert.equal(byField.amountCents!.flag, 'divergent_amount')
      assert.equal(byField.amountCents!.before, 'R$ 750,00')
      assert.equal(byField.amountCents!.after, 'R$ 700,00')
      assert.equal(byField.postedOn!.flag, 'far_date')
      assert.equal(byField.postedOn!.label, 'Data prevista')
      assert.match(byField.postedOn!.before!, /^\d{2}\/\d{2}\/\d{4} \(/)
      assert.equal(byField.notes!.before, null)
      assert.equal(byField.notes!.after, '50% finais')
      assert.equal(card.warnings.length, 2)

      // Dentro de 31 dias não destaca; mesmo valor não vira mudança.
      const near = await describeAction({ id: 'a2', type: 'update_pending', pendingId: income.id, postedOn: day(10), amountCents: 75_000 }, tx)
      assert.equal(near.changes.length, 1)
      assert.equal(near.changes[0]!.flag, undefined)
      assert.deepEqual(near.warnings, [])

      // Notas existentes: o depois acrescenta.
      const withNote = await describeAction({ id: 'a3', type: 'add_note', transactionId: expense.id, note: 'pago no pix' }, tx)
      assert.equal(withNote.changes[0]!.before, 'combinado')
      assert.equal(withNote.changes[0]!.after, 'combinado · pago no pix')

      const created = await describeAction(
        { id: 'a4', type: 'create_transaction', flow: 'expense', description: 'Papel', amountCents: 3_500, postedOn: day(1), accountId: income.accountId, pending: false },
        tx,
      )
      assert.equal(created.changes[0]!.flag, 'new_record')
      assert.ok(created.changes.every((c) => c.before === null))
    }))

  test('describeAction recusa ação que não se sustenta no banco (invalid_action)', () =>
    inRollback(async (tx) => {
      const { income, settled, account, asset, archivedAsset } = await seed(tx)
      const { describeAction } = loaded!.cards
      const bad = (a: Record<string, unknown>) => rejectsWith('invalid_action', () => describeAction({ id: 'x', ...a } as never, tx))
      await bad({ type: 'update_pending', pendingId: 999_999_999, postedOn: day(1) })
      await bad({ type: 'update_pending', pendingId: settled.id, postedOn: day(1) }) // já pago
      await bad({ type: 'update_pending', pendingId: income.id }) // não muda nada
      await bad({ type: 'update_pending', pendingId: income.id, postedOn: '2026-02-31' })
      await bad({ type: 'add_note', transactionId: 999_999_999, note: 'oi' })
      await bad({ type: 'create_transaction', flow: 'income', description: 'x', amountCents: 100, postedOn: day(1), accountId: 999_999_999, pending: false })
      await bad({ type: 'diary_entry', flow: 'expense', description: 'x', amountCents: 100, postedOn: day(1), accountId: account.id, categoryId: 999_999_999 })
      await bad({ type: 'record_trade', assetId: archivedAsset.id, kind: 'buy', quantity: 1, unitPriceCents: 100, tradedOn: day(0) })
      await bad({ type: 'record_trade', assetId: 999_999_999, kind: 'buy', quantity: 1, unitPriceCents: 100, tradedOn: day(0) })
      await bad({ type: 'record_trade', assetId: asset.id, kind: 'buy', quantity: 0, unitPriceCents: 100, tradedOn: day(0) })
      await bad({ type: 'reserve_contribution', amountCents: 100, tradedOn: '2026-13-01' })
    }))

  test('venda maior que a posição vira aviso, não erro', () =>
    inRollback(async (tx) => {
      const { asset } = await seed(tx)
      const card = await loaded!.cards.describeAction(
        { id: 'a1', type: 'record_trade', assetId: asset.id, kind: 'sell', quantity: 10, unitPriceCents: 1_000, tradedOn: day(0), feesCents: 50 },
        tx,
      )
      assert.equal(card.warnings.length, 1)
      assert.ok(card.changes.some((c) => c.field === 'feesCents'))
      assert.equal(card.changes.find((c) => c.field === 'total')!.after, 'R$ 99,50')
    }))

  test('createProposal guarda no banco com ids do servidor e expiração em 15 minutos', () =>
    inRollback(async (tx) => {
      const { income } = await seed(tx)
      const { createProposal, getProposal } = loaded!.apply
      const created = await createProposal(
        `${TAG} frase`,
        randomUUID(),
        proposalOf([{ type: 'add_note', transactionId: income.id, note: 'oi' }, { type: 'add_note', transactionId: income.id, note: 'dois' }]),
        tx,
      )
      assert.deepEqual(created.actions.map((a) => a.id), ['a1', 'a2'])
      const stored = await getProposal(created.proposalId, tx)
      assert.equal(stored.status, 'proposed')
      assert.equal(stored.phrase, `${TAG} frase`)
      assert.equal(stored.actions.length, 2)
      const minutes = (Date.parse(stored.expiresAt) - Date.now()) / 60_000
      assert.ok(minutes > 14 && minutes <= 15.1, `expira em ~15 min (deu ${minutes.toFixed(2)})`)
      assert.equal(Date.parse(created.expiresAt), Date.parse(stored.expiresAt))
      await rejectsWith('proposal_not_found', () => getProposal(randomUUID(), tx))
    }))

  test('apply: grava só o que o servidor guardou e devolve o contrato com undoToken', () =>
    inRollback(async (tx) => {
      const { income, expense, account, category } = await seed(tx)
      const { createProposal, applyProposal, getProposal } = loaded!.apply
      const { transactions } = loaded!.schema
      const created = await createProposal(
        `${TAG} frase`,
        null,
        proposalOf([
          { type: 'update_pending', pendingId: income.id, postedOn: day(10), notes: '50% finais' },
          { type: 'update_pending', pendingId: expense.id, amountCents: 130_000 },
          { type: 'create_transaction', flow: 'expense', description: `${TAG} Papel`, amountCents: 3_500, postedOn: day(1), accountId: account.id, categoryId: category?.id ?? null, pending: false, notes: 'novo' },
          { type: 'diary_entry', flow: 'income', description: `${TAG} Diario`, amountCents: 2_000, postedOn: day(0), accountId: account.id },
        ]),
        tx,
      )
      const response = await applyProposal(created.proposalId, ['a1', 'a2', 'a3', 'a4'], tx)
      assert.equal(response.applied.length, 4)
      assert.match(response.undoToken, /^[0-9a-f-]{36}$/)
      assert.ok(!Number.isNaN(Date.parse(response.appliedAt)))
      assert.ok(response.applied.every((a) => a.table === 'transactions' && a.recordId > 0))

      const row = async (id: number) => (await tx.select().from(transactions).where(sql`${transactions.id} = ${id}`))[0]!
      const a = await row(income.id)
      assert.equal(a.postedOn, day(10))
      assert.equal(a.notes, '50% finais')
      assert.equal(a.amountCents, 75_000)
      const b = await row(expense.id)
      assert.equal(b.amountCents, -130_000, 'o valor positivo da ação mantém o sinal de despesa')
      assert.equal(b.direction, 'out')
      assert.equal(b.pending, true)
      const c = await row(response.applied[2]!.recordId)
      assert.equal(c.amountCents, -3_500)
      assert.equal(c.source, 'manual')
      assert.equal(c.pending, false)
      assert.equal(c.notes, 'novo')
      const d = await row(response.applied[3]!.recordId)
      assert.equal(d.amountCents, 2_000)
      assert.equal(d.source, 'daily')
      assert.equal(d.pending, false)

      const stored = await getProposal(created.proposalId, tx)
      assert.equal(stored.status, 'applied')
      assert.equal(stored.undoToken, response.undoToken)
      assert.equal(stored.applied!.length, 4)
      const first = stored.applied![0] as { before: { postedOn: string }; after: { postedOn: string } }
      assert.equal(first.before.postedOn, day(3), 'antes gravado')
      assert.equal(first.after.postedOn, day(10), 'depois gravado')

      await rejectsWith('already_applied', () => applyProposal(created.proposalId, ['a1'], tx))
    }))

  test('apply: compra, venda e aporte na reserva gravam a operação', () =>
    inRollback(async (tx) => {
      const { asset } = await seed(tx)
      const { createProposal, applyProposal } = loaded!.apply
      const { assetTrades } = loaded!.schema
      const created = await createProposal(
        `${TAG} frase`,
        null,
        proposalOf([
          { type: 'record_trade', assetId: asset.id, kind: 'buy', quantity: 10, unitPriceCents: 2_550, tradedOn: day(0), feesCents: 100 },
          { type: 'record_trade', assetId: asset.id, kind: 'sell', quantity: 4, unitPriceCents: 2_600, tradedOn: day(1) },
          { type: 'reserve_contribution', amountCents: 50_000, tradedOn: day(0) },
        ]),
        tx,
      )
      const response = await applyProposal(created.proposalId, ['a1', 'a2', 'a3'], tx)
      assert.deepEqual(response.applied.map((a) => a.table), ['asset_trades', 'asset_trades', 'asset_trades'])
      const trade = (await tx.select().from(assetTrades).where(sql`${assetTrades.id} = ${response.applied[0]!.recordId}`))[0]!
      assert.equal(trade.kind, 'buy')
      assert.equal(trade.quantity, 10)
      assert.equal(trade.unitPriceCents, 2_550)
      assert.equal(trade.feesCents, 100)
      const sell = (await tx.select().from(assetTrades).where(sql`${assetTrades.id} = ${response.applied[1]!.recordId}`))[0]!
      assert.equal(sell.kind, 'sell')
      const reserve = (await tx.select().from(assetTrades).where(sql`${assetTrades.id} = ${response.applied[2]!.recordId}`))[0]!
      assert.equal(reserve.quantity, 500)
      assert.equal(reserve.unitPriceCents, 100)
    }))

  test('apply: tudo ou nada, uma ação inválida desfaz as outras', () =>
    inRollback(async (tx) => {
      const { income, archivedAsset, account } = await seed(tx)
      const { createProposal, applyProposal, getProposal } = loaded!.apply
      const { transactions } = loaded!.schema
      const before = (await tx.select().from(transactions).where(sql`${transactions.description} like ${`${TAG}%`}`)).length
      const created = await createProposal(
        `${TAG} frase`,
        null,
        proposalOf([
          { type: 'update_pending', pendingId: income.id, postedOn: day(20), notes: 'nao pode ficar' },
          { type: 'create_transaction', flow: 'expense', description: `${TAG} Nao pode ficar`, amountCents: 100, postedOn: day(1), accountId: account.id, pending: false },
          { type: 'record_trade', assetId: archivedAsset.id, kind: 'buy', quantity: 1, unitPriceCents: 100, tradedOn: day(0) },
        ]),
        tx,
      )
      await rejectsWith('invalid_action', () => applyProposal(created.proposalId, ['a1', 'a2', 'a3'], tx))
      const row = (await tx.select().from(transactions).where(sql`${transactions.id} = ${income.id}`))[0]!
      assert.equal(row.postedOn, day(3), 'a primeira ação foi desfeita')
      assert.equal(row.notes, null)
      const after = (await tx.select().from(transactions).where(sql`${transactions.description} like ${`${TAG}%`}`)).length
      assert.equal(after, before, 'a criação foi desfeita')
      const stored = await getProposal(created.proposalId, tx)
      assert.equal(stored.status, 'proposed')
      assert.equal(stored.applied, null)
      assert.equal(stored.undoToken, null)
    }))

  test('apply: ignora ids que não estão na proposta guardada', () =>
    inRollback(async (tx) => {
      const { income, expense } = await seed(tx)
      const { createProposal, applyProposal } = loaded!.apply
      const { transactions } = loaded!.schema
      const created = await createProposal(
        `${TAG} frase`,
        null,
        proposalOf([
          { type: 'add_note', transactionId: income.id, note: 'confirmada' },
          { type: 'add_note', transactionId: expense.id, note: 'nao confirmada' },
        ]),
        tx,
      )
      const response = await applyProposal(created.proposalId, ['a1', 'a99', randomUUID()], tx)
      assert.deepEqual(response.applied.map((a) => a.actionId), ['a1'])
      const i = (await tx.select().from(transactions).where(sql`${transactions.id} = ${income.id}`))[0]!
      const e = (await tx.select().from(transactions).where(sql`${transactions.id} = ${expense.id}`))[0]!
      assert.equal(i.notes, 'confirmada')
      assert.equal(e.notes, 'combinado', 'a ação não confirmada não gravou')

      const other = await createProposal(`${TAG} frase`, null, proposalOf([{ type: 'add_note', transactionId: income.id, note: 'x' }]), tx)
      await rejectsWith('invalid_action', () => applyProposal(other.proposalId, ['a99'], tx))
      const again = (await tx.select().from(transactions).where(sql`${transactions.id} = ${income.id}`))[0]!
      assert.equal(again.notes, 'confirmada', 'nada novo gravado')
    }))

  test('apply: proposta expirada, inexistente e já aplicada', () =>
    inRollback(async (tx) => {
      const { income } = await seed(tx)
      const { createProposal, applyProposal, getProposal } = loaded!.apply
      const { assistantActions, transactions } = loaded!.schema
      const created = await createProposal(`${TAG} frase`, null, proposalOf([{ type: 'add_note', transactionId: income.id, note: 'tarde' }]), tx)
      await tx
        .update(assistantActions)
        .set({ createdAt: sql`now() - interval '20 minutes'` })
        .where(sql`${assistantActions.proposalId} = ${created.proposalId}`)
      assert.equal((await getProposal(created.proposalId, tx)).status, 'expired')
      await rejectsWith('proposal_expired', () => applyProposal(created.proposalId, ['a1'], tx))
      const row = (await tx.select().from(transactions).where(sql`${transactions.id} = ${income.id}`))[0]!
      assert.equal(row.notes, null, 'expirada não grava')
      const stored = (await tx.select().from(assistantActions).where(sql`${assistantActions.proposalId} = ${created.proposalId}`))[0]!
      assert.equal(stored.status, 'expired', 'o status foi marcado')

      await rejectsWith('proposal_not_found', () => applyProposal(randomUUID(), ['a1'], tx))
    }))

  test('notas: acrescentam ao comentário existente, nunca substituem', () =>
    inRollback(async (tx) => {
      const { income, expense } = await seed(tx)
      const { createProposal, applyProposal } = loaded!.apply
      const { transactions } = loaded!.schema
      const created = await createProposal(
        `${TAG} frase`,
        null,
        proposalOf([
          { type: 'add_note', transactionId: expense.id, note: 'segunda nota' },
          { type: 'update_pending', pendingId: expense.id, notes: 'terceira nota' },
          { type: 'add_note', transactionId: income.id, note: 'primeira nota' },
        ]),
        tx,
      )
      await applyProposal(created.proposalId, ['a1', 'a2', 'a3'], tx)
      const e = (await tx.select().from(transactions).where(sql`${transactions.id} = ${expense.id}`))[0]!
      assert.equal(e.notes, 'combinado · segunda nota · terceira nota')
      const i = (await tx.select().from(transactions).where(sql`${transactions.id} = ${income.id}`))[0]!
      assert.equal(i.notes, 'primeira nota')
    }))

  test('undo feliz: restaura campos, apaga o que foi criado, apaga as operações', () =>
    inRollback(async (tx) => {
      const { income, expense, account, asset } = await seed(tx)
      const { createProposal, applyProposal, undoApplied, getProposal } = loaded!.apply
      const { transactions, assetTrades, assets } = loaded!.schema
      // Pendência "conferida" de verdade antes: o undo precisa devolver needs_review.
      await tx.update(transactions).set({ needsReview: true }).where(sql`${transactions.id} = ${income.id}`)
      const snapshot = async (id: number) => (await tx.select().from(transactions).where(sql`${transactions.id} = ${id}`))[0]!
      const incomeBefore = await snapshot(income.id)
      const expenseBefore = await snapshot(expense.id)
      const reserveBefore = (await tx.select().from(assets).where(sql`${assets.name} = 'Reserva de emergência'`)).length

      const created = await createProposal(
        `${TAG} frase`,
        null,
        proposalOf([
          { type: 'update_pending', pendingId: income.id, postedOn: day(10), amountCents: 70_000, notes: '50% finais' },
          { type: 'add_note', transactionId: expense.id, note: 'pago' },
          { type: 'create_transaction', flow: 'income', description: `${TAG} Novo`, amountCents: 900, postedOn: day(0), accountId: account.id, pending: true },
          { type: 'record_trade', assetId: asset.id, kind: 'buy', quantity: 3, unitPriceCents: 1_000, tradedOn: day(0) },
          { type: 'reserve_contribution', amountCents: 10_000, tradedOn: day(0) },
        ]),
        tx,
      )
      const applied = await applyProposal(created.proposalId, ['a1', 'a2', 'a3', 'a4', 'a5'], tx)
      assert.equal((await snapshot(income.id)).needsReview, false)

      const result = await undoApplied(applied.undoToken, tx)
      assert.deepEqual(result, { undone: 5 })

      const incomeAfter = await snapshot(income.id)
      for (const key of ['postedOn', 'amountCents', 'direction', 'dedupeHash', 'notes', 'manuallyEdited', 'needsReview', 'description'] as const) {
        assert.equal(incomeAfter[key], incomeBefore[key], `income.${key} restaurado`)
      }
      const expenseAfter = await snapshot(expense.id)
      assert.equal(expenseAfter.notes, expenseBefore.notes)
      for (const entry of applied.applied) {
        if (entry.table === 'transactions') {
          const gone = await tx.select().from(transactions).where(sql`${transactions.id} = ${entry.recordId}`)
          if (entry.actionId === 'a3') assert.equal(gone.length, 0, 'lançamento criado foi apagado')
        } else {
          const gone = await tx.select().from(assetTrades).where(sql`${assetTrades.id} = ${entry.recordId}`)
          assert.equal(gone.length, 0, 'operação apagada')
        }
      }
      const reserveAfter = (await tx.select().from(assets).where(sql`${assets.name} = 'Reserva de emergência'`)).length
      assert.equal(reserveAfter, reserveBefore, 'ativo da reserva criado pelo aporte sai junto')

      const stored = await getProposal(created.proposalId, tx)
      assert.equal(stored.status, 'undone')
      await rejectsWith('undo_refused', () => undoApplied(applied.undoToken, tx))
    }))

  test('undo recusado: o registro mudou depois, e nada é desfeito pela metade', () =>
    inRollback(async (tx) => {
      const { income, expense, account } = await seed(tx)
      const { createProposal, applyProposal, undoApplied, getProposal } = loaded!.apply
      const { transactions } = loaded!.schema
      const { updateTransaction } = loaded!.txns
      const created = await createProposal(
        `${TAG} frase`,
        null,
        proposalOf([
          { type: 'update_pending', pendingId: income.id, postedOn: day(10) },
          { type: 'create_transaction', flow: 'expense', description: `${TAG} Novo`, amountCents: 900, postedOn: day(0), accountId: account.id, pending: false },
          { type: 'add_note', transactionId: expense.id, note: 'pago' },
        ]),
        tx,
      )
      const applied = await applyProposal(created.proposalId, ['a1', 'a2', 'a3'], tx)
      // O usuário muda a pendência da nota na tela depois de aplicado.
      await updateTransaction(expense.id, { notes: 'editado a mao' }, 'only', tx)

      await rejectsWith('undo_refused', () => undoApplied(applied.undoToken, tx))
      const e = (await tx.select().from(transactions).where(sql`${transactions.id} = ${expense.id}`))[0]!
      assert.equal(e.notes, 'editado a mao', 'a edição do usuário ficou')
      const i = (await tx.select().from(transactions).where(sql`${transactions.id} = ${income.id}`))[0]!
      assert.equal(i.postedOn, day(10), 'as outras ações também não foram desfeitas')
      const createdRow = (await tx.select().from(transactions).where(sql`${transactions.id} = ${applied.applied[1]!.recordId}`))[0]
      assert.ok(createdRow, 'o lançamento criado continua lá')
      const stored = await getProposal(created.proposalId, tx)
      assert.equal(stored.status, 'applied', 'segue aplicada')

      await rejectsWith('proposal_not_found', () => undoApplied(randomUUID(), tx))
    }))

  test('undo recusado quando o lançamento criado foi editado ou apagado', () =>
    inRollback(async (tx) => {
      const { account } = await seed(tx)
      const { createProposal, applyProposal, undoApplied } = loaded!.apply
      const { transactions } = loaded!.schema
      const { updateTransaction } = loaded!.txns
      const one = await createProposal(
        `${TAG} frase`,
        null,
        proposalOf([{ type: 'diary_entry', flow: 'expense', description: `${TAG} Cafe`, amountCents: 700, postedOn: day(0), accountId: account.id }]),
        tx,
      )
      const applied = await applyProposal(one.proposalId, ['a1'], tx)
      await updateTransaction(applied.applied[0]!.recordId, { amountCents: -900 }, 'only', tx)
      await rejectsWith('undo_refused', () => undoApplied(applied.undoToken, tx))

      const two = await createProposal(
        `${TAG} frase`,
        null,
        proposalOf([{ type: 'diary_entry', flow: 'expense', description: `${TAG} Cha`, amountCents: 500, postedOn: day(0), accountId: account.id }]),
        tx,
      )
      const appliedTwo = await applyProposal(two.proposalId, ['a1'], tx)
      await tx.delete(transactions).where(sql`${transactions.id} = ${appliedTwo.applied[0]!.recordId}`)
      await rejectsWith('undo_refused', () => undoApplied(appliedTwo.undoToken, tx))
    }))
})

describe('assistente: nada ficou no banco real', { skip }, () => {
  test('sem dados [teste] e sem a tabela assistant_actions (migração não aplicada)', async () => {
    const { db } = loaded!.client
    const count = async (table: string, column: string) =>
      Number(
        ((await db.execute(sql.raw(`select count(*)::int as n from ${table} where ${column} like '[teste]%'`))) as unknown as Array<{ n: number }>)[0]!.n,
      )
    assert.equal(await count('transactions', 'description'), 0)
    assert.equal(await count('assets', 'name'), 0)
    assert.equal(await count('accounts', 'name'), 0)
    const rows = (await db.execute(sql`select to_regclass('public.assistant_actions') as t`)) as unknown as Array<{ t: string | null }>
    assert.equal(rows[0]!.t, null, 'assistant_actions não pode existir: a migração só se aplica com autorização')
  })
})

after(async () => {
  if (loaded) await (loaded.client.db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
})
