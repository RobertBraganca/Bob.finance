import { and, eq, lte, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '../../db/client.ts'
import { accounts, assetTrades, assets, categories, transactions } from '../../db/schema.ts'
import type { AssistantCard, CardFlag, ProposedAction } from '../../core/assistantTypes.ts'
import { RESERVE_ASSET_NAME } from '../investments.ts'
import { AssistantError } from './errors.ts'
import { appendNote, daysBetween, formatBRL, formatDate, formatQuantity, isRealDate } from './format.ts'

/**
 * Cartão de confirmação (antes e depois, campo a campo) e validação de cada ação
 * contra o banco (docs/specs/assistente, A.1). Só LÊ: quem grava é o `apply`,
 * que chama `describeAction` de novo dentro da transação antes de gravar.
 *
 * Edge: tudo em sequência, nunca `Promise.all` de consultas.
 */

/** A nova data a mais de tantos dias da antiga ganha o destaque `far_date`. */
export const FAR_DATE_DAYS = 31

type Change = AssistantCard['changes'][number]

function invalid(message: string): never {
  throw new AssistantError('invalid_action', message)
}

function requireRealDate(iso: string, label: string): void {
  if (!isRealDate(iso)) invalid(`${label} inválida: ${iso}.`)
}

/* ------------------------------------------------------------------ *
 * Leitura do estado atual (compartilhada com o apply)
 * ------------------------------------------------------------------ */
export async function loadTransactionRow(id: number, executor: DbExecutor = db) {
  return (await executor.select().from(transactions).where(eq(transactions.id, id)))[0] ?? null
}

/** A pendência existe e continua pendente; senão a ação é inválida. */
export async function requirePending(id: number, executor: DbExecutor = db) {
  const row = await loadTransactionRow(id, executor)
  if (!row) invalid(`A pendência ${id} não existe.`)
  if (!row.pending) invalid(`O lançamento ${id} (${row.description}) já não está pendente.`)
  return row
}

export async function requireTransaction(id: number, executor: DbExecutor = db) {
  const row = await loadTransactionRow(id, executor)
  if (!row) invalid(`O lançamento ${id} não existe.`)
  return row
}

async function requireAccount(id: number, executor: DbExecutor) {
  const row = (await executor.select().from(accounts).where(eq(accounts.id, id)))[0]
  if (!row || row.archived) invalid(`A conta ${id} não existe ou está arquivada.`)
  return row
}

async function requireCategory(id: number, executor: DbExecutor) {
  const row = (await executor.select().from(categories).where(eq(categories.id, id)))[0]
  if (!row || row.archived) invalid(`A TAG ${id} não existe ou está arquivada.`)
  return row
}

async function requireAsset(id: number, executor: DbExecutor) {
  const row = (await executor.select().from(assets).where(eq(assets.id, id)))[0]
  if (!row || row.archived) invalid(`O ativo ${id} não existe ou está arquivado.`)
  return row
}

/* ------------------------------------------------------------------ *
 * Cartões por tipo de ação
 * ------------------------------------------------------------------ */
async function describeUpdatePending(action: Extract<ProposedAction, { type: 'update_pending' }>, executor: DbExecutor): Promise<AssistantCard> {
  const row = await requirePending(action.pendingId, executor)
  if (action.postedOn === undefined && action.amountCents === undefined && action.notes === undefined) {
    invalid('A ação não muda nada: faltou a data, o valor ou o comentário.')
  }
  const changes: Change[] = []
  const warnings: string[] = []

  if (action.postedOn !== undefined && action.postedOn !== row.postedOn) {
    requireRealDate(action.postedOn, 'Data')
    const days = Math.abs(daysBetween(row.postedOn, action.postedOn))
    const far = days > FAR_DATE_DAYS
    changes.push({
      field: 'postedOn',
      label: 'Data prevista',
      before: formatDate(row.postedOn),
      after: formatDate(action.postedOn),
      ...(far ? { flag: 'far_date' as CardFlag } : {}),
    })
    if (far) warnings.push(`A nova data fica a ${days} dias da data cadastrada.`)
  } else if (action.postedOn !== undefined) {
    requireRealDate(action.postedOn, 'Data')
  }

  if (action.amountCents !== undefined && action.amountCents !== Math.abs(row.amountCents)) {
    changes.push({
      field: 'amountCents',
      label: 'Valor',
      before: formatBRL(row.amountCents),
      after: formatBRL(action.amountCents),
      flag: 'divergent_amount',
    })
    warnings.push(`O valor informado (${formatBRL(action.amountCents)}) é diferente do cadastrado (${formatBRL(row.amountCents)}).`)
  }

  if (action.notes !== undefined) {
    changes.push({ field: 'notes', label: 'Comentário', before: row.notes, after: appendNote(row.notes, action.notes) })
  }

  if (changes.length === 0) invalid(`A pendência ${row.id} (${row.description}) já está assim: nada a mudar.`)
  return { actionId: action.id, kind: action.type, title: `Atualizar pendência: ${row.description}`, changes, warnings }
}

async function describeAddNote(action: Extract<ProposedAction, { type: 'add_note' }>, executor: DbExecutor): Promise<AssistantCard> {
  const row = await requireTransaction(action.transactionId, executor)
  return {
    actionId: action.id,
    kind: action.type,
    title: `Comentar: ${row.description}`,
    changes: [{ field: 'notes', label: 'Comentário', before: row.notes, after: appendNote(row.notes, action.note) }],
    warnings: [],
  }
}

/** Cartão comum de `create_transaction` e `diary_entry`. */
async function describeNewLedgerRow(
  action: Extract<ProposedAction, { type: 'create_transaction' | 'diary_entry' }>,
  executor: DbExecutor,
): Promise<AssistantCard> {
  requireRealDate(action.postedOn, 'Data')
  const account = await requireAccount(action.accountId, executor)
  const category = action.categoryId ? await requireCategory(action.categoryId, executor) : null
  const warnings: string[] = []
  if (category && (category.kind === 'income' || category.kind === 'expense') && category.kind !== action.flow) {
    warnings.push(`A TAG ${category.name} é de ${category.kind === 'income' ? 'receita' : 'despesa'}, e o lançamento é ${action.flow === 'income' ? 'uma receita' : 'uma despesa'}.`)
  }

  const isDiary = action.type === 'diary_entry'
  const pending = action.type === 'create_transaction' ? action.pending : false
  const noun = action.flow === 'income' ? 'receita' : 'despesa'
  const notes = action.type === 'create_transaction' ? (action.notes ?? null) : null
  const changes: Change[] = [
    { field: 'record', label: 'Registro', before: null, after: `Novo lançamento (${noun}${pending ? ', pendente' : ''})`, flag: 'new_record' },
    { field: 'description', label: 'Descrição', before: null, after: action.description },
    { field: 'amountCents', label: 'Valor', before: null, after: formatBRL(action.amountCents) },
    { field: 'postedOn', label: pending ? 'Data prevista' : 'Data', before: null, after: formatDate(action.postedOn) },
    { field: 'accountId', label: 'Conta', before: null, after: account.name },
  ]
  if (category) changes.push({ field: 'categoryId', label: 'TAG', before: null, after: category.name })
  if (notes) changes.push({ field: 'notes', label: 'Comentário', before: null, after: notes })

  const title = isDiary ? `Diário: ${action.description}` : `Nova ${noun}${pending ? ' prevista' : ''}: ${action.description}`
  return { actionId: action.id, kind: action.type, title, changes, warnings }
}

async function describeRecordTrade(action: Extract<ProposedAction, { type: 'record_trade' }>, executor: DbExecutor): Promise<AssistantCard> {
  requireRealDate(action.tradedOn, 'Data')
  if (!Number.isFinite(action.quantity) || action.quantity <= 0) invalid('A quantidade precisa ser maior que zero.')
  const asset = await requireAsset(action.assetId, executor)
  const warnings: string[] = []

  if (action.kind === 'sell') {
    const held = (
      await executor
        .select({
          qty: sql<number>`coalesce(sum(case when ${assetTrades.kind} = 'buy' then ${assetTrades.quantity} when ${assetTrades.kind} = 'sell' then -${assetTrades.quantity} else 0 end), 0)`,
        })
        .from(assetTrades)
        .where(and(eq(assetTrades.assetId, asset.id), lte(assetTrades.tradedOn, action.tradedOn)))
    )[0]?.qty
    const position = Number(held ?? 0)
    if (action.quantity > position + 1e-9) {
      warnings.push(`A venda (${formatQuantity(action.quantity)}) é maior que a posição registrada até essa data (${formatQuantity(position)}).`)
    }
  }

  const fees = action.feesCents ?? 0
  const gross = Math.round(action.quantity * action.unitPriceCents)
  const total = action.kind === 'buy' ? gross + fees : gross - fees
  const assetLabel = asset.ticker ? `${asset.name} (${asset.ticker})` : asset.name
  const changes: Change[] = [
    { field: 'record', label: 'Registro', before: null, after: action.kind === 'buy' ? 'Nova compra' : 'Nova venda', flag: 'new_record' },
    { field: 'assetId', label: 'Ativo', before: null, after: assetLabel },
    { field: 'quantity', label: 'Quantidade', before: null, after: formatQuantity(action.quantity) },
    { field: 'unitPriceCents', label: 'Preço unitário', before: null, after: formatBRL(action.unitPriceCents) },
  ]
  if (fees > 0) changes.push({ field: 'feesCents', label: 'Taxas', before: null, after: formatBRL(fees) })
  changes.push({ field: 'tradedOn', label: 'Data', before: null, after: formatDate(action.tradedOn) })
  changes.push({ field: 'total', label: action.kind === 'buy' ? 'Total pago' : 'Total recebido', before: null, after: formatBRL(total) })

  return {
    actionId: action.id,
    kind: action.type,
    title: `${action.kind === 'buy' ? 'Compra' : 'Venda'} de ${asset.name}`,
    changes,
    warnings,
  }
}

async function describeReserveContribution(
  action: Extract<ProposedAction, { type: 'reserve_contribution' }>,
  executor: DbExecutor,
): Promise<AssistantCard> {
  requireRealDate(action.tradedOn, 'Data')
  const kind = action.kind ?? 'buy'
  const reserve = (await executor.select({ id: assets.id }).from(assets).where(eq(assets.name, RESERVE_ASSET_NAME)))[0]
  const warnings = reserve ? [] : [`O ativo "${RESERVE_ASSET_NAME}" ainda não existe e será criado junto com o lançamento.`]
  return {
    actionId: action.id,
    kind: action.type,
    title: kind === 'buy' ? 'Aporte na reserva de emergência' : 'Resgate da reserva de emergência',
    changes: [
      { field: 'record', label: 'Registro', before: null, after: kind === 'buy' ? 'Novo aporte' : 'Novo resgate', flag: 'new_record' },
      { field: 'amountCents', label: 'Valor', before: null, after: formatBRL(action.amountCents) },
      { field: 'tradedOn', label: 'Data', before: null, after: formatDate(action.tradedOn) },
      { field: 'asset', label: 'Destino', before: null, after: RESERVE_ASSET_NAME },
    ],
    warnings,
  }
}

/**
 * Lê o estado atual do banco, valida a ação e monta o cartão. Lança
 * `AssistantError('invalid_action')` quando a ação não se sustenta (pendência
 * inexistente ou já paga, ativo arquivado, conta inexistente, data impossível...).
 */
export async function describeAction(action: ProposedAction, executor: DbExecutor = db): Promise<AssistantCard> {
  switch (action.type) {
    case 'update_pending':
      return describeUpdatePending(action, executor)
    case 'add_note':
      return describeAddNote(action, executor)
    case 'create_transaction':
    case 'diary_entry':
      return describeNewLedgerRow(action, executor)
    case 'record_trade':
      return describeRecordTrade(action, executor)
    case 'reserve_contribution':
      return describeReserveContribution(action, executor)
  }
}

/** Os cartões de uma lista de ações, na ordem, validando cada uma (em sequência). */
export async function describeActions(actions: ProposedAction[], executor: DbExecutor = db): Promise<AssistantCard[]> {
  const cards: AssistantCard[] = []
  for (const action of actions) cards.push(await describeAction(action, executor))
  return cards
}
