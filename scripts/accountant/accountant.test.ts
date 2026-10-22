import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { sql } from 'drizzle-orm'

/**
 * O recorte do contador (docs/specs/tarefas-comercial-contador, fases 4 e 5) não
 * pode vazar nada pessoal. Lê os dados reais numa transação que sempre desfaz
 * (a migração das tarefas só existe dentro dela).
 */

try {
  process.loadEnvFile(process.env.BOB_ENV_FILE)
} catch {
  // sem .env: pulado
}
const hasDb = Boolean(process.env.SUPABASE_DB_HOST && process.env.SUPABASE_DB_PASSWORD)
const skip = hasDb ? false : 'sem credenciais do banco (.env ou BOB_ENV_FILE)'
const loaded = hasDb
  ? {
      client: await import('../../server/src/db/client'),
      schema: await import('../../server/src/db/schema'),
      view: await import('../../server/src/services/accountantView'),
      access: await import('../../server/src/services/accountantAccess'),
      scope: await import('../../server/src/services/withdrawals'),
      dates: await import('../../server/src/core/dates'),
    }
  : null

const MIGRATION = ['../../supabase/migrations/20261022120000_tasks.sql', '../../supabase/migrations/20261022140000_accountant_access.sql']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')
class Rollback extends Error {}
type Tx = import('../../server/src/db/client').DbExecutor

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  const { db } = loaded!.client
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`)
      await tx.execute(sql.raw(MIGRATION))
      await fn(tx)
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
}

const ALLOWED = {
  root: ['period', 'pjAccount', 'summary', 'ceiling', 'revenueSeries', 'transactions', 'invoices', 'totals'],
  summary: ['revenueCents', 'dasCents', 'costsCents', 'profitCents', 'withdrawalsCents', 'dasMonthlyCents', 'dasPending'],
  ceiling: ['yearRevenueCents', 'limitCents', 'usedBps', 'projectedYearCents', 'state'],
  series: ['period', 'revenueCents'],
  transaction: ['id', 'postedOn', 'description', 'amountCents', 'categoryName', 'pending', 'clientName'],
}

describe('recorte do contador (rollback)', { skip }, () => {
  test('só as chaves permitidas, e todo lançamento é da conta PJ', async () => {
    await inRollback(async (tx) => {
      const period = loaded!.dates.addMonths(loaded!.dates.todayIso().slice(0, 7), -1)
      const month = await loaded!.view.accountantMonth(period, tx)
      assert.deepEqual(Object.keys(month).sort(), [...ALLOWED.root].sort())
      if (!month.pjAccount) return
      if (month.summary) assert.deepEqual(Object.keys(month.summary).sort(), [...ALLOWED.summary].sort())
      if (month.ceiling) assert.deepEqual(Object.keys(month.ceiling).sort(), [...ALLOWED.ceiling].sort())
      for (const p of month.revenueSeries) assert.deepEqual(Object.keys(p).sort(), [...ALLOWED.series].sort())
      const text = JSON.stringify(month)
      for (const leak of ['personalSpent', 'coverage', 'withdrawable', 'livingCost']) assert.ok(!text.includes(leak), `nada de ${leak}`)

      const { transactions } = loaded!.schema
      const scope = await loaded!.scope.accountScope()
      assert.equal(month.pjAccount.id, scope.pjAccountId)
      for (const t of month.transactions) {
        assert.deepEqual(Object.keys(t).sort(), [...ALLOWED.transaction].sort())
        assert.ok(t.postedOn.startsWith(period), 'só o mês pedido')
      }
      if (month.transactions.length > 0) {
        const ids = month.transactions.map((t) => t.id)
        const accountsOf = await tx.execute(sql`select distinct account_id from ${transactions} where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
        assert.deepEqual(
          (accountsOf as unknown as Array<{ account_id: number }>).map((r) => Number(r.account_id)),
          [scope.pjAccountId],
          'só a conta PJ',
        )
      }
      const sum = month.transactions.reduce((s, t) => s + t.amountCents, 0)
      assert.equal(sum, month.totals.inCents + month.totals.outCents)
    })
  })

  test('acesso: convidado entra, revogado não, e o e-mail é conferido', async () => {
    await inRollback(async (tx) => {
      const svc = loaded!.access
      const id = '00000000-0000-4000-8000-000000000001'
      assert.equal(await svc.isActiveAccountant(id, tx), false)
      await svc.recordAccountant(id, 'Contador@Exemplo.test', tx)
      assert.equal(await svc.isActiveAccountant(id, tx), true)
      assert.equal(await svc.accountantEmail(id, tx), 'contador@exemplo.test')
      await svc.revokeAccountant(id, tx)
      assert.equal(await svc.isActiveAccountant(id, tx), false)
      await svc.recordAccountant(id, 'contador@exemplo.test', tx)
      assert.equal(await svc.isActiveAccountant(id, tx), true, 'reconvidar reativa')
      assert.throws(() => svc.assertEmail('sem-arroba'), /e-mail/)
    })
  })
})

after(async () => {
  if (loaded) await (loaded.client.db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
})
