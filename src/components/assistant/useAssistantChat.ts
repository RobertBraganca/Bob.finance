import { useCallback, useRef, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { AssistantActionType, AssistantCard } from '@shared/assistantTypes'
import {
  applyProposal,
  sendMessage,
  toAssistantFailure,
  undoApplied,
  type AssistantFailure,
  type CardEdit,
  type CardEdits,
} from '../../lib/assistantApi'
import { invalidateInvestmentData } from '../../lib/invalidate'

/**
 * Conversa da SESSÃO: vive no estado do painel e se perde ao recarregar a
 * página (spec H: memória de longo prazo fica fora desta versão). Nada daqui
 * grava no banco; quem grava é o servidor, depois do Confirmar.
 */

export type CardStatus = 'pending' | 'applying' | 'applied' | 'undone' | 'cancelled'
export type UndoState = 'available' | 'undoing' | 'undone' | 'refused'
/** Por que a proposta inteira deixou de poder ser confirmada. */
export type ProposalBlock = 'expired' | 'not_found' | 'already_applied'

export type ProposalState = {
  proposalId: string
  expiresAt: string | null
  cards: AssistantCard[]
  status: Record<string, CardStatus>
  edits: CardEdits
  block: ProposalBlock | null
}

export type ChatItem =
  | { id: string; type: 'user'; text: string }
  | {
      id: string
      type: 'reply'
      /** a frase que originou a resposta, para "Reenviar" quando expira */
      sourceText: string
      summary: string
      questions: string[]
      proposal: ProposalState | null
    }
  | {
      id: string
      type: 'result'
      proposalItemId: string
      actionIds: string[]
      titles: string[]
      kinds: AssistantActionType[]
      appliedAt: string
      undoToken: string
      undo: UndoState
    }
  | { id: string; type: 'error'; failure: AssistantFailure; retryText: string | null }

/** Gravações de investimento nunca escrevem em `transactions` (lib/invalidate.ts). */
const INVESTMENT_KINDS: ReadonlySet<AssistantActionType> = new Set(['record_trade', 'reserve_contribution'])

/**
 * Recarrega o que a aplicação (ou o desfazer) pode ter mexido. Reaproveita o
 * que o app já faz: gravação de extrato recarrega tudo (`invalidateQueries()`,
 * como Diário e Painel), gravação só de investimento usa
 * `invalidateInvestmentData`, que poupa as telas do extrato.
 */
function invalidateAfter(queryClient: QueryClient, kinds: AssistantActionType[]) {
  if (kinds.length > 0 && kinds.every((kind) => INVESTMENT_KINDS.has(kind))) {
    return invalidateInvestmentData(queryClient)
  }
  return queryClient.invalidateQueries()
}

const newId = () => crypto.randomUUID()

export function useAssistantChat() {
  const queryClient = useQueryClient()
  const [items, setItems] = useState<ChatItem[]>([])
  const [thinking, setThinking] = useState(false)
  /** Texto curto para a região viva escondida (mudanças dentro de itens que já existem). */
  const [announcement, setAnnouncement] = useState('')
  const conversationId = useRef<string | undefined>(undefined)
  // Evita duas chamadas ao modelo ao mesmo tempo (duplo Enter, Reenviar + Enviar).
  const sending = useRef(false)

  const announce = useCallback((message: string) => {
    // Alternar o espaço no fim força a região a anunciar a mesma frase de novo.
    setAnnouncement((previous) => (previous === message ? `${message} ` : message))
  }, [])

  const patch = useCallback((id: string, update: (item: ChatItem) => ChatItem) => {
    setItems((current) => current.map((item) => (item.id === id ? update(item) : item)))
  }, [])

  const patchProposal = useCallback(
    (itemId: string, update: (proposal: ProposalState) => ProposalState) => {
      patch(itemId, (item) =>
        item.type === 'reply' && item.proposal ? { ...item, proposal: update(item.proposal) } : item,
      )
    },
    [patch],
  )

  const send = useCallback(
    async (text: string, options: { echo?: boolean } = {}) => {
      const phrase = text.trim()
      if (!phrase || sending.current) return false
      sending.current = true
      if (options.echo !== false) setItems((current) => [...current, { id: newId(), type: 'user', text: phrase }])
      setThinking(true)
      try {
        const response = await sendMessage(phrase, conversationId.current)
        conversationId.current = response.conversationId
        const proposal: ProposalState | null =
          response.proposalId && response.cards.length > 0
            ? {
                proposalId: response.proposalId,
                expiresAt: response.expiresAt ?? null,
                cards: response.cards,
                status: Object.fromEntries(response.cards.map((card) => [card.actionId, 'pending' as const])),
                edits: {},
                block: null,
              }
            : null
        setItems((current) => [
          ...current,
          {
            id: newId(),
            type: 'reply',
            sourceText: phrase,
            summary: response.summary,
            questions: response.questions,
            proposal,
          },
        ])
      } catch (error) {
        const failure = toAssistantFailure(error)
        setItems((current) => [
          ...current,
          { id: newId(), type: 'error', failure, retryText: failure.retryable ? phrase : null },
        ])
      } finally {
        sending.current = false
        setThinking(false)
      }
      return true
    },
    [],
  )

  /** Tentar de novo depois de um erro: a mensagem do usuário já está no histórico. */
  const retry = useCallback(
    (errorItemId: string, phrase: string) => {
      setItems((current) => current.filter((item) => item.id !== errorItemId))
      void send(phrase, { echo: false })
    },
    [send],
  )

  /** Proposta expirada: manda a mesma frase de novo para gerar outra. */
  const resend = useCallback(
    (phrase: string) => {
      void send(phrase)
    },
    [send],
  )

  const confirm = useCallback(
    async (itemId: string, actionIds: string[]) => {
      const item = items.find((candidate) => candidate.id === itemId)
      if (!item || item.type !== 'reply' || !item.proposal || actionIds.length === 0) return
      const { proposal } = item
      const ids = actionIds.filter((id) => proposal.status[id] === 'pending')
      if (ids.length === 0) return

      patchProposal(itemId, (current) => ({
        ...current,
        status: { ...current.status, ...Object.fromEntries(ids.map((id) => [id, 'applying' as const])) },
      }))
      const edits: CardEdits = Object.fromEntries(ids.filter((id) => proposal.edits[id]).map((id) => [id, proposal.edits[id]!]))

      try {
        const response = await applyProposal(proposal.proposalId, ids, edits)
        const appliedIds = response.applied.map((entry) => entry.actionId)
        const doneIds = appliedIds.length > 0 ? appliedIds : ids
        const cards = proposal.cards.filter((card) => doneIds.includes(card.actionId))
        patchProposal(itemId, (current) => ({
          ...current,
          status: { ...current.status, ...Object.fromEntries(doneIds.map((id) => [id, 'applied' as const])) },
        }))
        setItems((current) => [
          ...current,
          {
            id: newId(),
            type: 'result',
            proposalItemId: itemId,
            actionIds: doneIds,
            titles: cards.map((card) => card.title),
            kinds: cards.map((card) => card.kind),
            appliedAt: response.appliedAt,
            undoToken: response.undoToken,
            undo: 'available',
          },
        ])
        void invalidateAfter(
          queryClient,
          cards.map((card) => card.kind),
        )
      } catch (error) {
        const failure = toAssistantFailure(error)
        const block: ProposalBlock | null =
          failure.code === 'proposal_expired'
            ? 'expired'
            : failure.code === 'proposal_not_found'
              ? 'not_found'
              : failure.code === 'already_applied'
                ? 'already_applied'
                : null
        // Nada foi gravado: os cards voltam a pedir confirmação (ou bloqueiam a proposta).
        patchProposal(itemId, (current) => ({
          ...current,
          block: block ?? current.block,
          status: { ...current.status, ...Object.fromEntries(ids.map((id) => [id, 'pending' as const])) },
        }))
        setItems((current) => [...current, { id: newId(), type: 'error', failure, retryText: null }])
      }
    },
    [items, patchProposal, queryClient],
  )

  const cancelCard = useCallback(
    (itemId: string, actionId: string) => {
      patchProposal(itemId, (current) => ({ ...current, status: { ...current.status, [actionId]: 'cancelled' } }))
      announce('Ação cancelada. Nada foi gravado.')
    },
    [announce, patchProposal],
  )

  const saveEdit = useCallback(
    (itemId: string, actionId: string, edit: CardEdit | null) => {
      patchProposal(itemId, (current) => {
        const { [actionId]: _removed, ...rest } = current.edits
        return { ...current, edits: edit ? { ...rest, [actionId]: edit } : rest }
      })
      announce(edit ? 'Edição guardada. Ela vale quando você confirmar.' : 'Sem alterações em relação à proposta.')
    },
    [announce, patchProposal],
  )

  const undo = useCallback(
    async (resultId: string) => {
      const item = items.find((candidate) => candidate.id === resultId)
      if (!item || item.type !== 'result' || item.undo !== 'available') return
      patch(resultId, (current) => (current.type === 'result' ? { ...current, undo: 'undoing' } : current))
      try {
        await undoApplied(item.undoToken)
        patch(resultId, (current) => (current.type === 'result' ? { ...current, undo: 'undone' } : current))
        patchProposal(item.proposalItemId, (current) => ({
          ...current,
          status: { ...current.status, ...Object.fromEntries(item.actionIds.map((id) => [id, 'undone' as const])) },
        }))
        announce('Desfeito. Os registros voltaram ao que eram.')
        void invalidateAfter(queryClient, item.kinds)
      } catch (error) {
        const failure = toAssistantFailure(error)
        if (failure.code === 'undo_refused') {
          patch(resultId, (current) => (current.type === 'result' ? { ...current, undo: 'refused' } : current))
          announce(failure.message)
        } else {
          // Falha de rede ou do servidor: o Desfazer continua disponível.
          patch(resultId, (current) => (current.type === 'result' ? { ...current, undo: 'available' } : current))
          setItems((current) => [...current, { id: newId(), type: 'error', failure, retryText: null }])
        }
      }
    },
    [announce, items, patch, patchProposal, queryClient],
  )

  return { items, thinking, announcement, send, retry, resend, confirm, cancelCard, saveEdit, undo }
}
