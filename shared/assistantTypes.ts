import { z } from 'zod'

/**
 * Contrato do assistente em linguagem natural (docs/specs/assistente/spec.md).
 * Só tipos e validação, sem lógica: é o que o servidor, o modelo, as rotas e a
 * tela combinam entre si. Espelho em supabase/functions/_shared/core.
 *
 * Valores em centavos (inteiros), datas em AAAA-MM-DD.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const positiveCents = z.number().int().positive()
const idOf = z.number().int().positive()

/* ------------------------------------------------------------------ *
 * Ações que o modelo PODE PROPOR. Quem grava é o `apply`, depois do Confirmar.
 * ------------------------------------------------------------------ */
export const updatePendingAction = z.object({
  type: z.literal('update_pending'),
  pendingId: idOf,
  postedOn: isoDate.optional(),
  amountCents: positiveCents.optional(),
  /** comentário em `transactions.notes`; acrescenta ao que já existe */
  notes: z.string().trim().min(1).max(500).optional(),
})

export const addNoteAction = z.object({
  type: z.literal('add_note'),
  transactionId: idOf,
  note: z.string().trim().min(1).max(500),
})

/** `amountCents` é sempre positivo; o sinal vem de `flow` (income +, expense -). */
export const createTransactionAction = z.object({
  type: z.literal('create_transaction'),
  flow: z.enum(['income', 'expense']),
  description: z.string().trim().min(1).max(160),
  amountCents: positiveCents,
  postedOn: isoDate,
  accountId: idOf,
  categoryId: idOf.nullable().optional(),
  pending: z.boolean(),
  notes: z.string().trim().max(500).nullable().optional(),
})

/** Entrada do Diário: um lançamento realizado (`source: 'daily'`). */
export const diaryEntryAction = z.object({
  type: z.literal('diary_entry'),
  flow: z.enum(['income', 'expense']),
  description: z.string().trim().min(1).max(160),
  amountCents: positiveCents,
  postedOn: isoDate,
  accountId: idOf,
  categoryId: idOf.nullable().optional(),
})

/** Compra ou venda de um ativo que já existe. Exige ativo, quantidade e preço. */
export const recordTradeAction = z.object({
  type: z.literal('record_trade'),
  assetId: idOf,
  kind: z.enum(['buy', 'sell']),
  quantity: z.number().positive(),
  unitPriceCents: positiveCents,
  tradedOn: isoDate,
  feesCents: z.number().int().min(0).optional(),
})

/** Aporte na reserva de emergência (`contributeToReserve`). */
export const reserveContributionAction = z.object({
  type: z.literal('reserve_contribution'),
  amountCents: positiveCents,
  tradedOn: isoDate,
  kind: z.enum(['buy', 'sell']).optional(),
})

export const assistantActionSchema = z.discriminatedUnion('type', [
  updatePendingAction,
  addNoteAction,
  createTransactionAction,
  diaryEntryAction,
  recordTradeAction,
  reserveContributionAction,
])
export type AssistantAction = z.infer<typeof assistantActionSchema>
export type AssistantActionType = AssistantAction['type']

export const MAX_ACTIONS_PER_PROPOSAL = 5
export const MAX_PHRASE_LENGTH = 600
export const PROPOSAL_TTL_MINUTES = 15

/** O que o modelo devolve no fim: ações e/ou perguntas, nunca as duas coisas vazias. */
export const assistantProposalSchema = z
  .object({
    summary: z.string().trim().min(1).max(400),
    actions: z.array(assistantActionSchema).max(MAX_ACTIONS_PER_PROPOSAL),
    questions: z.array(z.string().trim().min(1).max(300)).max(3),
  })
  .refine((p) => p.actions.length > 0 || p.questions.length > 0, { message: 'proposta sem ação e sem pergunta' })
export type AssistantProposal = z.infer<typeof assistantProposalSchema>

/** Ação com o id que o servidor lhe dá; é por ele que o usuário confirma. */
export type ProposedAction = AssistantAction & { id: string }

/* ------------------------------------------------------------------ *
 * Candidatos devolvidos pelas ferramentas de leitura do modelo
 * ------------------------------------------------------------------ */
export type MatchStrength = 'exact' | 'likely' | 'weak'

export type AssistantCandidate = {
  kind: 'pending' | 'transaction'
  id: number
  description: string
  amountCents: number
  postedOn: string
  accountName: string
  strength: MatchStrength
}

/** Contexto mínimo que vai ao modelo: sem extrato, saldos, cartões nem dados pessoais. */
export type AssistantContext = {
  /** data de hoje em America/Sao_Paulo, AAAA-MM-DD */
  today: string
  accounts: Array<{ id: number; name: string }>
  categories: Array<{ id: number; name: string; kind: 'income' | 'expense' | 'transfer' | 'investment' }>
  assets: Array<{ id: number; name: string; ticker: string | null; assetClass: string }>
}

/* ------------------------------------------------------------------ *
 * Cartão de confirmação mostrado na tela (antes e depois de cada campo)
 * ------------------------------------------------------------------ */
export type CardFlag = 'divergent_amount' | 'far_date' | 'new_record'

export type AssistantCard = {
  actionId: string
  kind: AssistantActionType
  title: string
  changes: Array<{ field: string; label: string; before: string | null; after: string; flag?: CardFlag }>
  warnings: string[]
}

/* ------------------------------------------------------------------ *
 * API: /assistant/message, /assistant/apply, /assistant/undo
 * ------------------------------------------------------------------ */
export const assistantMessageRequest = z.object({
  text: z.string().trim().min(1).max(MAX_PHRASE_LENGTH),
  conversationId: z.string().uuid().optional(),
})
export type AssistantMessageRequest = z.infer<typeof assistantMessageRequest>

export type AssistantMessageResponse = {
  conversationId: string
  /** ausente quando só há perguntas */
  proposalId?: string
  summary: string
  cards: AssistantCard[]
  questions: string[]
  /** quando a proposta expira (ISO com fuso) */
  expiresAt?: string
}

/**
 * O que o usuário pode corrigir num card antes de confirmar ("Editar"). Só estes
 * campos, e só valem se a ação os tem: o servidor aplica sobre a ação GUARDADA e a
 * revalida (nunca grava uma ação mandada pelo navegador).
 */
export const assistantEditSchema = z
  .object({
    postedOn: isoDate.optional(),
    tradedOn: isoDate.optional(),
    amountCents: positiveCents.optional(),
    /** `update_pending` e `create_transaction` */
    notes: z.string().trim().min(1).max(500).optional(),
    /** `add_note` */
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
export type AssistantEdit = z.infer<typeof assistantEditSchema>

/**
 * Pode haver VÁRIOS `apply` da mesma proposta, cada um com ações diferentes
 * (Confirmar por card): cada aplicação devolve o próprio `undoToken`, e uma ação
 * já aplicada não se aplica de novo. `.strict()`: campo desconhecido é erro, não
 * é ignorado em silêncio.
 */
export const assistantApplyRequest = z
  .object({
    proposalId: z.string().uuid(),
    confirmedActionIds: z.array(z.string().min(1)).min(1).max(MAX_ACTIONS_PER_PROPOSAL),
    edits: z.record(z.string().min(1), assistantEditSchema).optional(),
  })
  .strict()
export type AssistantApplyRequest = z.infer<typeof assistantApplyRequest>

export type AssistantApplyResponse = {
  applied: Array<{ actionId: string; table: string; recordId: number }>
  undoToken: string
  appliedAt: string
}

export const assistantUndoRequest = z.object({ undoToken: z.string().uuid() })
export type AssistantUndoRequest = z.infer<typeof assistantUndoRequest>

export type AssistantUndoResponse = { undone: number }

/** Erros esperados que a tela trata (HTTP 4xx com `error` e `code`). */
export type AssistantErrorCode =
  | 'unavailable' // chave ausente ou API do modelo fora do ar: nada foi gravado
  | 'rate_limited'
  | 'proposal_expired'
  | 'proposal_not_found'
  | 'already_applied'
  | 'invalid_action' // a ação não passou na validação contra o banco
  | 'undo_refused' // o registro mudou depois da aplicação
