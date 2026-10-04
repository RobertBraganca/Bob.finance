import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { accounts, bankConnections, categories, importBatches, stagedTransactions, transactions } from '../db/schema'
import { dedupeHash, merchantSignature, normalizeDescription } from '../core/normalize'
import * as pluggy from './pluggy'
import { stageRows, type StageRow } from './imports'

/**
 * Open Finance via Meu Pluggy (docs/specs/open-finance-sync, decisions/0038).
 * Fase 1: só contas correntes. Cada sincronização vira um lote de
 * importação revisável, como um CSV; nada entra direto no ledger.
 */

/** Data no fuso do Brasil: a Pluggy manda horário real em UTC, e um gasto às 22h não pode cair no dia seguinte. */
function saoPauloDate(iso: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(iso))
}

function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** "Nu Pagamentos S.A. - Instituição de Pagamento (Conta Pré-paga)" vira "Nubank". */
function bankName(raw: string): string {
  const cleaned = raw
    .replace(/\(.*?\)/g, '')
    .replace(/\s*-?\s*institui[cç][aã]o de pagamento.*$/i, '')
    .replace(/\bS\.?\s?A\.?(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^nu pagamentos/i.test(cleaned)) return 'Nubank'
  if (/^banco inter/i.test(cleaned)) return 'Inter'
  if (/^picpay/i.test(cleaned)) return 'PicPay'
  return cleaned
}

function labelOf(account: pluggy.PluggyAccount): string {
  const ending = (account.number ?? '').replace(/\D/g, '').slice(-4)
  if (account.type === 'CREDIT') return `Cartão ${account.name}${ending ? ` · final ${ending}` : ''}`
  // CNPJ tem 14 dígitos, CPF 11: o mesmo banco aparece duas vezes quando há conta PF e PJ.
  const digits = (account.taxNumber ?? '').replace(/\D/g, '').length
  const holder = digits === 14 ? ' PJ' : digits === 11 ? ' PF' : ''
  return `${bankName(account.name)}${holder} · conta corrente${ending ? ` · final ${ending}` : ''}`
}

export async function listConnections() {
  return db
    .select({
      id: bankConnections.id,
      accountId: bankConnections.accountId,
      accountName: accounts.name,
      provider: bankConnections.provider,
      providerItemId: bankConnections.providerItemId,
      providerAccountId: bankConnections.providerAccountId,
      providerAccountLabel: bankConnections.providerAccountLabel,
      syncFrom: bankConnections.syncFrom,
      lastSyncedAt: bankConnections.lastSyncedAt,
      lastSyncCount: bankConnections.lastSyncCount,
      lastError: bankConnections.lastError,
    })
    .from(bankConnections)
    .innerJoin(accounts, eq(accounts.id, bankConnections.accountId))
    .orderBy(accounts.name)
}

/** As contas que uma conexão da Pluggy enxerga, marcando as já ligadas a uma conta do app. */
export async function discover(itemId: string) {
  const found = await pluggy.listAccounts(itemId)
  const linked = await db
    .select({ providerAccountId: bankConnections.providerAccountId, accountId: bankConnections.accountId })
    .from(bankConnections)
  const linkedBy = new Map(linked.map((l) => [l.providerAccountId, l.accountId]))
  return found.map((account) => ({
    providerAccountId: account.id,
    label: labelOf(account),
    kind: account.type === 'CREDIT' ? ('credit_card' as const) : ('checking' as const),
    linkedAccountId: linkedBy.get(account.id) ?? null,
  }))
}

/**
 * Liga uma conta da Pluggy a uma conta do app. O corte (`syncFrom`) é o dia
 * do último extrato CSV da conta: o histórico que veio por CSV fica como
 * está, e o próprio dia de corte passa pela checagem de duplicado por data
 * e valor. Sem CSV nenhum, começa 12 meses atrás (o que a Pluggy guarda).
 */
export async function createConnection(input: { accountId: number; providerItemId: string; providerAccountId: string }) {
  const account = (await db.select().from(accounts).where(eq(accounts.id, input.accountId)))[0]
  if (!account) throw new Error('conta do app não encontrada')

  const providerAccount = (await pluggy.listAccounts(input.providerItemId)).find((a) => a.id === input.providerAccountId)
  if (!providerAccount) throw new Error('essa conta não pertence à conexão informada na Pluggy')
  if (providerAccount.type === 'CREDIT') {
    throw new Error('cartões de crédito entram numa fase seguinte; por enquanto, só contas correntes')
  }

  const lastCsv = (
    await db
      .select({ last: sql<string | null>`max(${transactions.postedOn})` })
      .from(transactions)
      .where(and(eq(transactions.accountId, input.accountId), eq(transactions.source, 'csv'), eq(transactions.pending, false)))
  )[0]?.last
  const syncFrom = lastCsv ?? shiftDays(saoPauloDate(new Date()), -365)

  const row = (
    await db
      .insert(bankConnections)
      .values({
        accountId: input.accountId,
        provider: 'pluggy',
        providerItemId: input.providerItemId,
        providerAccountId: input.providerAccountId,
        providerAccountLabel: labelOf(providerAccount),
        syncFrom,
      })
      .returning()
  )[0]!
  return row
}

export async function deleteConnection(id: number) {
  await db.delete(bankConnections).where(eq(bankConnections.id, id))
  return { deleted: true }
}

/** TAGs das caixinhas (aplicação e resgate automáticos): achadas pelo nome, nunca por id fixo. */
async function investmentCategories() {
  const rows = await db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
    .from(categories)
    .where(and(eq(categories.kind, 'investment'), eq(categories.archived, false)))
  const parent = rows.find((r) => r.parentId === null && r.name === 'Investimentos')
  const child = (name: string) => rows.find((r) => r.parentId === parent?.id && r.name === name)?.id ?? null
  return { aporte: child('Aportes'), resgate: child('Resgates') }
}

function isAutomaticInvestment(t: pluggy.PluggyTransaction): boolean {
  return (t.category ?? '').startsWith('Investment') || /\b(rdb|caixinha)\b/i.test(t.description)
}

/**
 * Busca as transações confirmadas desde o corte e manda as que ainda não
 * existem para um lote de revisão. "Ainda não existe" = o id da Pluggy não
 * está no ledger nem num lote em revisão ou já gravado; um lote descartado
 * libera as linhas dele para a próxima sincronização.
 */
export async function syncConnection(id: number) {
  const conn = (await db.select().from(bankConnections).where(eq(bankConnections.id, id)))[0]
  if (!conn) throw new Error('conexão não encontrada')

  try {
    const today = saoPauloDate(new Date())
    const fetched = await pluggy.listTransactions(conn.providerAccountId, conn.syncFrom, today)
    const posted = fetched
      .filter((t) => t.status === 'POSTED')
      .map((t) => ({ t, postedOn: saoPauloDate(t.date) }))
      .filter(({ postedOn }) => postedOn >= conn.syncFrom)

    const ids = posted.map(({ t }) => t.id)
    const known = new Set<string>()
    if (ids.length > 0) {
      for (const r of await db
        .select({ externalId: transactions.externalId })
        .from(transactions)
        .where(inArray(transactions.externalId, ids))) {
        if (r.externalId) known.add(r.externalId)
      }
      for (const r of await db
        .select({ externalId: stagedTransactions.externalId })
        .from(stagedTransactions)
        .innerJoin(importBatches, eq(importBatches.id, stagedTransactions.batchId))
        .where(and(inArray(stagedTransactions.externalId, ids), inArray(importBatches.status, ['staged', 'committed'])))) {
        if (r.externalId) known.add(r.externalId)
      }
    }

    const fresh = posted.filter(({ t }) => !known.has(t.id)).sort((a, b) => a.postedOn.localeCompare(b.postedOn))

    let batchId: number | null = null
    if (fresh.length > 0) {
      const invest = await investmentCategories()
      const rows: StageRow[] = fresh.map(({ t, postedOn }, index) => {
        const amountCents = Math.round(t.amount * 100) * (t.type === 'DEBIT' && t.amount > 0 ? -1 : 1)
        const descriptionNorm = normalizeDescription(t.description)
        const investmentCategory = isAutomaticInvestment(t) ? (amountCents < 0 ? invest.aporte : invest.resgate) : null
        return {
          rowIndex: index,
          postedOn,
          description: t.description.trim(),
          descriptionNorm,
          signature: merchantSignature(t.description),
          amountCents,
          rawCategory: t.category,
          dedupeHash: dedupeHash({ accountId: conn.accountId, postedOn, amountCents, descriptionNorm }),
          parseError: null,
          rawLine: JSON.stringify({ id: t.id, date: t.date, category: t.category, operationType: t.operationType }),
          externalId: t.id,
          presetCategory:
            investmentCategory !== null
              ? { categoryId: investmentCategory, detail: 'Open Finance: aplicação ou resgate automático (caixinha)' }
              : null,
        }
      })
      const fmt = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
      const staged = await stageRows({
        accountId: conn.accountId,
        profileId: null,
        filename: `Open Finance · ${conn.providerAccountLabel} · ${fmt(rows[0]!.postedOn!)} a ${fmt(rows[rows.length - 1]!.postedOn!)}`,
        rowCount: rows.length,
        parsedCount: rows.length,
        errorCount: 0,
        rows,
        matchByDateAndAmount: true,
      })
      batchId = staged.batchId
    }

    await db
      .update(bankConnections)
      .set({ lastSyncedAt: new Date().toISOString(), lastSyncCount: fresh.length, lastError: null })
      .where(eq(bankConnections.id, id))

    return { batchId, staged: fresh.length, alreadyKnown: posted.length - fresh.length, pendingSkipped: fetched.length - posted.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.update(bankConnections).set({ lastError: message }).where(eq(bankConnections.id, id))
    throw error
  }
}

/** Lotes de Open Finance ainda esperando revisão, para a tela de Contas e bancos apontar para eles. */
export async function pendingBatches() {
  return db
    .select({ id: importBatches.id, accountId: importBatches.accountId, filename: importBatches.filename, rowCount: importBatches.rowCount })
    .from(importBatches)
    .where(and(eq(importBatches.status, 'staged'), sql`${importBatches.filename} like 'Open Finance%'`))
    .orderBy(desc(importBatches.id))
}
