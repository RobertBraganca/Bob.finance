import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '../../db/client.ts'
import { assetTrades, assets, assistantActions, transactions } from '../../db/schema.ts'
import {
  MAX_ACTIONS_PER_PROPOSAL,
  PROPOSAL_TTL_MINUTES,
  assistantActionSchema,
  type AssistantActionType,
  type AssistantEdit,
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
 *    confirmados que não estão na proposta são ignorados; as edições do usuário
 *    valem só sobre a ação guardada e só nos campos permitidos;
 *  - cada ação é revalidada contra o banco (`describeAction`) antes de gravar;
 *  - tudo numa única transação: uma ação inválida desfaz as outras;
 *  - uma proposta aceita vários apply (um por card), cada um um lote com o seu
 *    `undoToken`; o antes/depois de cada registro fica em `applied`, e o `undo`
 *    só reverte um lote enquanto os registros continuarem iguais ao "depois".
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

/** O que `applyAction` devolve de uma ação gravada: o registro e o antes/depois. */
type AppliedCore =
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

/**
 * Uma ação aplicada, com o antes e o depois: a fonte do Desfazer. `batch` é o
 * undoToken do apply que a gravou (um apply = um lote); `undone` marca o que o
 * Desfazer do lote já reverteu; `action` é a ação como foi gravada (a EDITADA,
 * quando houve edição, com `edited: true`).
 */
export type AppliedEntry = AppliedCore & {
  batch: string
  undone: boolean
  edited?: true
  action: ProposedAction
}

export type StoredProposal = {
  proposalId: string
  conversationId: string | null
  phrase: string
  summary: string
  actions: ProposedAction[]
  questions: string[]
  /**
   * `proposed` enquanto restar ação sem aplicar; `applied` quando todas as ações
   * estão aplicadas (e não desfeitas); `undone` quando todas as entradas foram
   * desfeitas. `proposed` vencida sem nada aplicado aparece como `expired`
   * (a leitura não grava).
   */
  status: 'proposed' | 'applied' | 'undone' | 'expired'
  /** passou de PROPOSAL_TTL_MINUTES: não aceita ação nova, mas o Desfazer segue valendo */
  expired: boolean
  createdAt: string
  /** ISO com fuso */
  expiresAt: string
  /** uma entrada por ação aplicada, de todos os lotes; nulo antes do primeiro apply */
  applied: AppliedEntry[] | null
}

/** Estado da proposta a partir das entradas (a expiração é à parte). */
function statusOf(actions: ProposedAction[], entries: AppliedEntry[]): 'proposed' | 'applied' | 'undone' {
  const active = new Set(entries.filter((e) => !e.undone).map((e) => e.actionId))
  if (actions.length > 0 && actions.every((a) => active.has(a.id))) return 'applied'
  if (entries.length > 0 && active.size === 0) return 'undone'
  return 'proposed'
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
    // Vencida sem nenhuma ação aplicada: `expired`. Com algo aplicado, o estado das entradas vale.
    status:
      row.status === 'proposed' && expired && !((row.applied as AppliedEntry[] | null) ?? []).some((e) => !e.undone)
        ? 'expired'
        : row.status,
    expired,
    createdAt: row.createdAt,
    expiresAt,
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
async function applyAction(action: ProposedAction, tx: DbExecutor): Promise<AppliedCore> {
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
 * Campos que o usuário pode corrigir no card, por tipo de ação. O que não está
 * aqui a ação não tem (ou não aceita edição) e a edição é recusada.
 */
const EDITABLE_FIELDS: Record<AssistantActionType, ReadonlyArray<keyof AssistantEdit>> = {
  update_pending: ['postedOn', 'amountCents', 'notes'],
  add_note: ['note'],
  create_transaction: ['postedOn', 'amountCents', 'notes'],
  diary_entry: ['postedOn', 'amountCents'],
  record_trade: ['tradedOn'],
  reserve_contribution: ['tradedOn', 'amountCents'],
}

/**
 * Aplica a edição SOBRE A AÇÃO GUARDADA (nunca uma ação mandada pelo navegador),
 * só nos campos permitidos do tipo; campo que a ação não tem é `invalid_action`.
 * O resultado passa pelo schema do contrato antes de seguir (e o `apply` ainda
 * o revalida contra o banco).
 */
function applyEdit(action: ProposedAction, edit: AssistantEdit): { action: ProposedAction; edited: boolean } {
  const allowed = EDITABLE_FIELDS[action.type]
  const fields = (Object.keys(edit) as Array<keyof AssistantEdit>).filter((key) => edit[key] !== undefined)
  for (const field of fields) {
    if (!allowed.includes(field)) {
      throw new AssistantError('invalid_action', `A ação ${action.id} (${action.type}) não tem o campo "${field}" para editar.`)
    }
  }
  if (fields.length === 0) return { action, edited: false }
  const parsed = assistantActionSchema.safeParse({ ...action, ...edit })
  if (!parsed.success) {
    throw new AssistantError('invalid_action', `A edição da ação ${action.id} não é válida: ${parsed.error.issues[0]?.message ?? 'valor inválido'}.`)
  }
  return { action: { ...parsed.data, id: action.id }, edited: true }
}

/**
 * Aplica as ações CONFIRMADAS da proposta guardada, numa transação só (tudo ou
 * nada). Pode haver VÁRIOS apply por proposta, cada um com ações diferentes: cada
 * aplicação é um lote com o próprio `undoToken`, e uma ação já aplicada (e não
 * desfeita) não se aplica de novo (`already_applied`).
 *
 *  - Ids confirmados que não estão na proposta são ignorados; se nenhum está, a
 *    chamada é recusada (`invalid_action`).
 *  - `edits` (por id de ação) corrige campos permitidos sobre a ação guardada; id
 *    de edição fora das ações confirmadas, ou campo que a ação não tem, é
 *    `invalid_action`. Fica gravada a ação editada, com `edited: true`.
 *  - A expiração só bloqueia aplicar ação nova; o Desfazer de um lote já aplicado
 *    segue valendo.
 *  - Recusa também `proposal_not_found` e `proposal_expired`.
 */
export async function applyProposal(
  proposalId: string,
  confirmedActionIds: string[],
  edits?: Record<string, AssistantEdit>,
  executor: DbExecutor = db,
): Promise<AssistantApplyResponse> {
  const first = await getProposal(proposalId, executor)
  const confirmed = new Set(confirmedActionIds)
  const selected = first.actions.filter((action) => confirmed.has(action.id))
  if (selected.length === 0) {
    throw new AssistantError('invalid_action', 'Nenhuma das ações confirmadas faz parte desta proposta.')
  }
  const selectedIds = new Set(selected.map((a) => a.id))
  for (const editedId of Object.keys(edits ?? {})) {
    if (!selectedIds.has(editedId)) {
      throw new AssistantError('invalid_action', `A edição da ação ${editedId} não vale: ela não está entre as ações confirmadas desta proposta.`)
    }
  }
  // Edita e valida o formato antes de abrir a transação.
  const ready = selected.map((action) => ({ original: action, ...applyEdit(action, edits?.[action.id] ?? {}) }))

  const firstActive = new Set((first.applied ?? []).filter((e) => !e.undone).map((e) => e.actionId))
  if (ready.some((r) => firstActive.has(r.original.id))) {
    throw new AssistantError('already_applied', 'Esta ação já foi aplicada. Desfaça antes, ou envie a frase de novo.')
  }
  if (first.expired) {
    // Marca fora da transação de aplicar (o rollback de um erro a desfaria). Sem nada
    // aplicado a proposta vira `expired`; o que já foi aplicado continua desfazível.
    if (firstActive.size === 0) {
      await executor
        .update(assistantActions)
        .set({ status: 'expired' })
        .where(and(eq(assistantActions.proposalId, proposalId), eq(assistantActions.status, 'proposed')))
    }
    throw new AssistantError('proposal_expired', 'A proposta expirou. Envie a frase de novo.')
  }

  return executor.transaction(async (tx) => {
    // Trava a linha: dois "Confirmar" ao mesmo tempo não aplicam a mesma ação duas vezes.
    const locked = (
      await tx
        .select({ row: assistantActions, expired: expiredSql })
        .from(assistantActions)
        .where(eq(assistantActions.proposalId, proposalId))
        .for('update')
    )[0]
    if (!locked) throw new AssistantError('proposal_not_found', 'Proposta não encontrada. Envie a frase de novo.')
    const previous = (locked.row.applied as AppliedEntry[] | null) ?? []
    const active = new Set(previous.filter((e) => !e.undone).map((e) => e.actionId))
    if (ready.some((r) => active.has(r.original.id))) {
      throw new AssistantError('already_applied', 'Esta ação já foi aplicada. Desfaça antes, ou envie a frase de novo.')
    }
    if (locked.expired) throw new AssistantError('proposal_expired', 'A proposta expirou. Envie a frase de novo.')

    const batch = randomUUID()
    const entries: AppliedEntry[] = []
    for (const { action, edited } of ready) {
      // Revalida a ação (editada, se houve) contra o estado de agora, inclusive o que as anteriores gravaram.
      await describeAction(action, tx)
      const core = await applyAction(action, tx)
      entries.push({ ...core, batch, undone: false, action, ...(edited ? { edited: true as const } : {}) })
    }

    const all = [...previous, ...entries]
    const updated = (
      await tx
        .update(assistantActions)
        .set({ status: statusOf(first.actions, all), applied: all, appliedAt: sql`now()` })
        .where(eq(assistantActions.id, locked.row.id))
        .returning({ appliedAt: isoOf(assistantActions.appliedAt) })
    )[0]!

    return {
      applied: entries.map((e) => ({ actionId: e.actionId, table: e.table, recordId: e.recordId })),
      undoToken: batch,
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
 * Desfaz UM lote (um apply) pela imagem "antes": só as entradas daquele `undoToken`,
 * marcadas `undone: true` no fim. Criação de lançamento desfaz apagando; compra,
 * venda e aporte desfazem apagando a operação; atualização de pendência e
 * comentário restauram os campos. Recusa (`undo_refused`) se o lote já foi desfeito
 * ou se qualquer registro mudou depois, e nada é desfeito pela metade. Token
 * inexistente: `proposal_not_found`. A expiração da proposta não bloqueia o Desfazer.
 */
export async function undoApplied(undoToken: string, executor: DbExecutor = db): Promise<AssistantUndoResponse> {
  return executor.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(assistantActions)
        .where(sql`${assistantActions.applied} @> ${JSON.stringify([{ batch: undoToken }])}::jsonb`)
        .for('update')
    )[0]
    if (!row) throw new AssistantError('proposal_not_found', 'Não achei nada para desfazer com esse código.')

    const all = (row.applied as AppliedEntry[] | null) ?? []
    const batch = all.filter((e) => e.batch === undoToken)
    if (batch.length === 0 || batch.every((e) => e.undone)) refuse('Esta aplicação já foi desfeita.')

    // Do último para o primeiro: o que uma ação gravou em cima da outra sai na ordem certa.
    for (const entry of [...batch].reverse()) {
      if (!entry.undone) await undoEntry(entry, tx)
    }

    const next = all.map((e) => (e.batch === undoToken ? { ...e, undone: true } : e))
    const actions = (row.proposal as { actions: ProposedAction[] }).actions
    await tx
      .update(assistantActions)
      .set({ status: statusOf(actions, next), applied: next, undoneAt: sql`now()` })
      .where(eq(assistantActions.id, row.id))
    return { undone: batch.length }
  })
}
