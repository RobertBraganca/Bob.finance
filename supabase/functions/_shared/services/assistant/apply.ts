import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '../../db/client.ts'
import { assetTrades, assets, assistantActions, transactions } from '../../db/schema.ts'
import {
  MAX_ACTIONS_PER_PROPOSAL,
  PROPOSAL_TTL_MINUTES,
  type AssistantActionType,
  type AssistantApplyResponse,
  type AssistantProposal,
  type AssistantUndoResponse,
  type ProposedAction,
} from '../../core/assistantTypes.ts'
import { createTransaction, updateTransaction } from '../transactions.ts'
import { RESERVE_ASSET_NAME, contributeToReserve, createTrade } from '../investments.ts'
import { describeAction, requirePending, requireTransaction } from './cards.ts'
import { AssistantError } from './errors.ts'
import { appendNote } from './format.ts'

/**
 * Guardar a proposta, aplicar o que o usuário confirmou e desfazer
 * (docs/specs/assistente, A passos 5 a 8, e B.1).
 *
 * Regras que este arquivo garante:
 *  - o `apply` só grava ações que o SERVIDOR guardou em `assistant_actions`; ids
 *    confirmados que não estão na proposta são ignorados;
 *  - cada ação é revalidada contra o banco (`describeAction`) antes de gravar;
 *  - tudo numa única transação: uma ação inválida desfaz as outras;
 *  - o antes/depois de cada registro fica em `applied`, e o `undo` só reverte
 *    enquanto o registro continuar igual ao "depois" gravado.
 *
 * Todas as funções aceitam um `executor` opcional (a transação do chamador), para
 * os testes rodarem dentro de uma transação que termina em rollback. Quando o
 * executor já é uma transação, o `db.transaction` interno vira um savepoint.
 *
 * Edge: tudo em sequência, nunca `Promise.all` de consultas.
 */

type TxnImage = {
  postedOn: string
  description: string
  amountCents: number
  direction: 'in' | 'out'
  accountId: number
  categoryId: number | null
  notes: string | null
  pending: boolean
  hidden: boolean
  ignored: boolean
  manuallyEdited: boolean
  needsReview: boolean
  dedupeHash: string
}

type TradeImage = {
  assetId: number
  kind: 'buy' | 'sell' | 'dividend'
  tradedOn: string
  quantity: number
  unitPriceCents: number
  feesCents: number
}

/** Uma ação aplicada, com o antes e o depois: a fonte do Desfazer. */
export type AppliedEntry =
  | {
      actionId: string
      type: AssistantActionType
      table: 'transactions'
      recordId: number
      op: 'create' | 'update'
      /** imagem anterior; nula quando a ação criou o registro */
      before: TxnImage | null
      after: TxnImage
    }
  | {
      actionId: string
      type: AssistantActionType
      table: 'asset_trades'
      recordId: number
      op: 'create'
      before: null
      after: TradeImage
      /** o ativo da reserva foi criado por esta ação (o Desfazer o remove se ficar vazio) */
      createdAssetId?: number
    }

export type StoredProposal = {
  proposalId: string
  conversationId: string | null
  phrase: string
  summary: string
  actions: ProposedAction[]
  questions: string[]
  /** `proposed` vencida aparece como `expired` aqui (a leitura não grava) */
  status: 'proposed' | 'applied' | 'undone' | 'expired'
  createdAt: string
  /** ISO com fuso */
  expiresAt: string
  undoToken: string | null
  applied: AppliedEntry[] | null
}

const isoOf = (column: unknown) =>
  sql<string>`to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const expiresAtSql = sql<string>`to_char((${assistantActions.createdAt} + ${PROPOSAL_TTL_MINUTES}::int * interval '1 minute') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
const expiredSql = sql<boolean>`${assistantActions.createdAt} + ${PROPOSAL_TTL_MINUTES}::int * interval '1 minute' < now()`

function imageOfTransaction(row: typeof transactions.$inferSelect): TxnImage {
  return {
    postedOn: row.postedOn,
    description: row.description,
    amountCents: row.amountCents,
    direction: row.direction,
    accountId: row.accountId,
    categoryId: row.categoryId,
    notes: row.notes,
    pending: row.pending,
    hidden: row.hidden,
    ignored: row.ignored,
    manuallyEdited: row.manuallyEdited,
    needsReview: row.needsReview,
    dedupeHash: row.dedupeHash,
  }
}

function imageOfTrade(row: typeof assetTrades.$inferSelect): TradeImage {
  return {
    assetId: row.assetId,
    kind: row.kind,
    tradedOn: row.tradedOn,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
    feesCents: row.feesCents,
  }
}

/** Igualdade campo a campo de duas imagens (as duas vêm do mesmo formato). */
function sameImage(a: object, b: object): boolean {
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) if (left[key] !== right[key]) return false
  return true
}

/* ------------------------------------------------------------------ *
 * Propostas
 * ------------------------------------------------------------------ */

/**
 * Guarda a proposta (status `proposed`) e dá a cada ação o id pelo qual o usuário
 * confirma. Expira em `PROPOSAL_TTL_MINUTES`. Não valida contra o banco: quem monta
 * a resposta chama `describeAction` antes (o `apply` revalida de qualquer jeito).
 */
export async function createProposal(
  phrase: string,
  conversationId: string | null | undefined,
  proposal: AssistantProposal,
  executor: DbExecutor = db,
): Promise<{ proposalId: string; actions: ProposedAction[]; expiresAt: string }> {
  if (proposal.actions.length > MAX_ACTIONS_PER_PROPOSAL) {
    throw new AssistantError('invalid_action', `Uma proposta tem no máximo ${MAX_ACTIONS_PER_PROPOSAL} ações.`)
  }
  const proposalId = randomUUID()
  const actions: ProposedAction[] = proposal.actions.map((action, index) => ({ ...action, id: `a${index + 1}` }))
  const stored = { summary: proposal.summary, actions, questions: proposal.questions }

  const inserted = (
    await executor
      .insert(assistantActions)
      .values({ proposalId, conversationId: conversationId ?? null, phrase, proposal: stored })
      .returning({ expiresAt: expiresAtSql })
  )[0]!
  return { proposalId, actions, expiresAt: inserted.expiresAt }
}

function toStored(
  row: typeof assistantActions.$inferSelect,
  expiresAt: string,
  expired: boolean,
): StoredProposal {
  const proposal = row.proposal as { summary: string; actions: ProposedAction[]; questions: string[] }
  return {
    proposalId: row.proposalId,
    conversationId: row.conversationId,
    phrase: row.phrase,
    summary: proposal.summary,
    actions: proposal.actions,
    questions: proposal.questions,
    status: row.status === 'proposed' && expired ? 'expired' : row.status,
    createdAt: row.createdAt,
    expiresAt,
    undoToken: row.undoToken,
    applied: (row.applied as AppliedEntry[] | null) ?? null,
  }
}

/** Lê a proposta guardada; `proposal_not_found` se o id não existe. */
export async function getProposal(proposalId: string, executor: DbExecutor = db): Promise<StoredProposal> {
  const found = (
    await executor
      .select({ row: assistantActions, expiresAt: expiresAtSql, expired: expiredSql })
      .from(assistantActions)
      .where(eq(assistantActions.proposalId, proposalId))
  )[0]
  if (!found) throw new AssistantError('proposal_not_found', 'Proposta não encontrada. Envie a frase de novo.')
  return toStored(found.row, found.expiresAt, found.expired)
}

/* ------------------------------------------------------------------ *
 * Aplicar uma ação
 * ------------------------------------------------------------------ */

/** Grava UMA ação (já validada) e devolve o antes/depois. Usa só o `tx` recebido. */
async function applyAction(action: ProposedAction, tx: DbExecutor): Promise<AppliedEntry> {
  switch (action.type) {
    case 'update_pending': {
      const current = await requirePending(action.pendingId, tx)
      const patch: { postedOn?: string; amountCents?: number; notes?: string } = {}
      if (action.postedOn !== undefined && action.postedOn !== current.postedOn) patch.postedOn = action.postedOn
      // O valor da ação é sempre positivo: o sinal (receita +, despesa -) é o do registro.
      if (action.amountCents !== undefined) {
        const signed = current.amountCents < 0 ? -action.amountCents : action.amountCents
        if (signed !== current.amountCents) patch.amountCents = signed
      }
      if (action.notes !== undefined) patch.notes = appendNote(current.notes, action.notes)
      const updated = await updateTransaction(current.id, patch, 'only', tx)
      if (!updated) throw new AssistantError('invalid_action', `A pendência ${current.id} não existe.`)
      return {
        actionId: action.id,
        type: action.type,
        table: 'transactions',
        recordId: current.id,
        op: 'update',
        before: imageOfTransaction(current),
        after: imageOfTransaction(updated),
      }
    }
    case 'add_note': {
      const current = await requireTransaction(action.transactionId, tx)
      const updated = await updateTransaction(current.id, { notes: appendNote(current.notes, action.note) }, 'only', tx)
      if (!updated) throw new AssistantError('invalid_action', `O lançamento ${current.id} não existe.`)
      return {
        actionId: action.id,
        type: action.type,
        table: 'transactions',
        recordId: current.id,
        op: 'update',
        before: imageOfTransaction(current),
        after: imageOfTransaction(updated),
      }
    }
    case 'create_transaction':
    case 'diary_entry': {
      const isDiary = action.type === 'diary_entry'
      const created = await createTransaction(
        {
          accountId: action.accountId,
          postedOn: action.postedOn,
          description: action.description,
          amountCents: action.flow === 'income' ? action.amountCents : -action.amountCents,
          categoryId: action.categoryId ?? null,
          notes: action.type === 'create_transaction' ? (action.notes ?? null) : null,
          source: isDiary ? 'daily' : 'manual',
          pending: action.type === 'create_transaction' ? action.pending : false,
        },
        tx,
      )
      return {
        actionId: action.id,
        type: action.type,
        table: 'transactions',
        recordId: created.id,
        op: 'create',
        before: null,
        after: imageOfTransaction(created),
      }
    }
    case 'record_trade': {
      const trade = await createTrade(
        {
          assetId: action.assetId,
          kind: action.kind,
          tradedOn: action.tradedOn,
          quantity: action.quantity,
          unitPriceCents: action.unitPriceCents,
          feesCents: action.feesCents ?? 0,
        },
        tx,
      )
      return {
        actionId: action.id,
        type: action.type,
        table: 'asset_trades',
        recordId: trade.id,
        op: 'create',
        before: null,
        after: imageOfTrade(trade),
      }
    }
    case 'reserve_contribution': {
      const existed = (await tx.select({ id: assets.id }).from(assets).where(eq(assets.name, RESERVE_ASSET_NAME)))[0]
      const trade = await contributeToReserve({ amountCents: action.amountCents, tradedOn: action.tradedOn, kind: action.kind }, tx)
      return {
        actionId: action.id,
        type: action.type,
        table: 'asset_trades',
        recordId: trade.id,
        op: 'create',
        before: null,
        after: imageOfTrade(trade),
        ...(existed ? {} : { createdAssetId: trade.assetId }),
      }
    }
  }
}

/**
 * Aplica as ações CONFIRMADAS da proposta guardada, numa transação só (tudo ou
 * nada). Ids confirmados que não estão na proposta são ignorados; se nenhum está,
 * a chamada é recusada. Recusa também `proposal_not_found`, `proposal_expired` e
 * `already_applied`.
 */
export async function applyProposal(
  proposalId: string,
  confirmedActionIds: string[],
  executor: DbExecutor = db,
): Promise<AssistantApplyResponse> {
  const first = await getProposal(proposalId, executor)
  if (first.status === 'applied' || first.status === 'undone') {
    throw new AssistantError('already_applied', 'Esta proposta já foi aplicada. Envie a frase de novo se quiser repetir.')
  }
  if (first.status === 'expired') {
    // Marca fora da transação de aplicar (que não vai existir) e recusa.
    await executor
      .update(assistantActions)
      .set({ status: 'expired' })
      .where(and(eq(assistantActions.proposalId, proposalId), eq(assistantActions.status, 'proposed')))
    throw new AssistantError('proposal_expired', 'A proposta expirou. Envie a frase de novo.')
  }

  const confirmed = new Set(confirmedActionIds)
  const selected = first.actions.filter((action) => confirmed.has(action.id))
  if (selected.length === 0) {
    throw new AssistantError('invalid_action', 'Nenhuma das ações confirmadas faz parte desta proposta.')
  }

  return executor.transaction(async (tx) => {
    // Trava a linha: dois "Confirmar" ao mesmo tempo não aplicam duas vezes.
    const locked = (
      await tx
        .select({ status: assistantActions.status, expired: expiredSql })
        .from(assistantActions)
        .where(eq(assistantActions.proposalId, proposalId))
        .for('update')
    )[0]
    if (!locked) throw new AssistantError('proposal_not_found', 'Proposta não encontrada. Envie a frase de novo.')
    if (locked.status !== 'proposed') {
      throw new AssistantError('already_applied', 'Esta proposta já foi aplicada. Envie a frase de novo se quiser repetir.')
    }
    if (locked.expired) throw new AssistantError('proposal_expired', 'A proposta expirou. Envie a frase de novo.')

    const entries: AppliedEntry[] = []
    for (const action of selected) {
      // Revalida contra o estado de agora (inclusive o que as ações anteriores já gravaram).
      await describeAction(action, tx)
      entries.push(await applyAction(action, tx))
    }

    const undoToken = randomUUID()
    const updated = (
      await tx
        .update(assistantActions)
        .set({ status: 'applied', applied: entries, undoToken, appliedAt: sql`now()` })
        .where(and(eq(assistantActions.proposalId, proposalId), eq(assistantActions.status, 'proposed')))
        .returning({ appliedAt: isoOf(assistantActions.appliedAt) })
    )[0]
    if (!updated) throw new AssistantError('already_applied', 'Esta proposta já foi aplicada. Envie a frase de novo se quiser repetir.')

    return {
      applied: entries.map((e) => ({ actionId: e.actionId, table: e.table, recordId: e.recordId })),
      undoToken,
      appliedAt: updated.appliedAt,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Desfazer
 * ------------------------------------------------------------------ */

function refuse(message: string): never {
  throw new AssistantError('undo_refused', message)
}

/** Reverte UMA entrada, recusando se o registro mudou depois da aplicação. */
async function undoEntry(entry: AppliedEntry, tx: DbExecutor): Promise<void> {
  if (entry.table === 'asset_trades') {
    const current = (await tx.select().from(assetTrades).where(eq(assetTrades.id, entry.recordId)))[0]
    if (!current) refuse('A compra, venda ou aporte já não existe; não há o que desfazer.')
    if (!sameImage(imageOfTrade(current), entry.after)) refuse('A operação foi alterada depois de aplicada; desfaça pela tela de Investimentos.')
    await tx.delete(assetTrades).where(eq(assetTrades.id, entry.recordId))
    if (entry.createdAssetId !== undefined) {
      // O ativo da reserva nasceu com o aporte: sai junto, se não sobrou nenhuma operação nele.
      const left = (
        await tx.select({ n: sql<number>`count(*)` }).from(assetTrades).where(eq(assetTrades.assetId, entry.createdAssetId))
      )[0]
      if (Number(left?.n ?? 0) === 0) await tx.delete(assets).where(eq(assets.id, entry.createdAssetId))
    }
    return
  }

  const current = (await tx.select().from(transactions).where(eq(transactions.id, entry.recordId)))[0]
  if (!current) refuse('O lançamento já não existe; não há o que desfazer.')
  if (!sameImage(imageOfTransaction(current), entry.after)) {
    refuse('O lançamento foi alterado depois de aplicado; desfaça pela tela de Lançamentos.')
  }
  if (entry.op === 'create') {
    await tx.delete(transactions).where(eq(transactions.id, entry.recordId))
    return
  }
  const before = entry.before!
  await tx
    .update(transactions)
    .set({
      postedOn: before.postedOn,
      amountCents: before.amountCents,
      direction: before.direction,
      dedupeHash: before.dedupeHash,
      notes: before.notes,
      manuallyEdited: before.manuallyEdited,
      needsReview: before.needsReview,
    })
    .where(eq(transactions.id, entry.recordId))
}

/**
 * Desfaz uma aplicação pela imagem "antes". Criação de lançamento desfaz apagando;
 * compra, venda e aporte desfazem apagando a operação; atualização de pendência e
 * comentário restauram os campos. Recusa (`undo_refused`) se qualquer registro
 * mudou depois, e nada é desfeito pela metade.
 */
export async function undoApplied(undoToken: string, executor: DbExecutor = db): Promise<AssistantUndoResponse> {
  return executor.transaction(async (tx) => {
    const row = (
      await tx.select().from(assistantActions).where(eq(assistantActions.undoToken, undoToken)).for('update')
    )[0]
    if (!row) throw new AssistantError('proposal_not_found', 'Não achei nada para desfazer com esse código.')
    if (row.status === 'undone') refuse('Esta aplicação já foi desfeita.')
    if (row.status !== 'applied') refuse('Esta proposta não foi aplicada; não há o que desfazer.')

    const entries = (row.applied as AppliedEntry[] | null) ?? []
    // Do último para o primeiro: o que uma ação gravou em cima da outra sai na ordem certa.
    for (const entry of [...entries].reverse()) await undoEntry(entry, tx)

    await tx
      .update(assistantActions)
      .set({ status: 'undone', undoneAt: sql`now()` })
      .where(eq(assistantActions.id, row.id))
    return { undone: entries.length }
  })
}
