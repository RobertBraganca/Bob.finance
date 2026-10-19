/**
 * Cliente do assistente em linguagem natural (docs/specs/assistente/spec.md).
 *
 * Só tipos do contrato (`shared/assistantTypes.ts`) entram aqui, nunca o zod:
 * a validação roda no servidor, e o navegador não paga o peso dela.
 *
 * O mock (`assistantMock.ts`) só existe em desenvolvimento: a condição
 * `import.meta.env.DEV` abaixo é constante no build de produção, então o
 * `import()` dele some do pacote (conferido em `dist/` na etapa 7).
 */
import { api, ApiError } from './api'
import type {
  AssistantApplyResponse,
  AssistantErrorCode,
  AssistantMessageResponse,
  AssistantUndoResponse,
} from '@shared/assistantTypes'

/* ------------------------------------------------------------------ *
 * Mock de desenvolvimento
 * ------------------------------------------------------------------ */
const MOCK_KEY = 'assistantMock'
let mockForced = false

/** A rota `/dev/assistente` liga o mock sem depender de localStorage. */
export function forceAssistantMock() {
  if (import.meta.env.DEV) mockForced = true
}

/**
 * Ligado só em desenvolvimento, com `localStorage.assistantMock = '1'` ou
 * `?assistantMock=1` na URL (o parâmetro é guardado no localStorage para
 * sobreviver à navegação interna; `?assistantMock=0` desliga).
 */
export function isAssistantMockOn(): boolean {
  if (!import.meta.env.DEV) return false
  if (mockForced) return true
  try {
    const param = new URLSearchParams(window.location.search).get(MOCK_KEY)
    if (param === '1') localStorage.setItem(MOCK_KEY, '1')
    if (param === '0') localStorage.removeItem(MOCK_KEY)
    return localStorage.getItem(MOCK_KEY) === '1'
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Erros em português, por `code`
 * ------------------------------------------------------------------ */
export type AssistantFailureCode = AssistantErrorCode | 'offline' | 'unknown'

export type AssistantFailure = {
  code: AssistantFailureCode
  message: string
  /** Vale a pena oferecer "Tentar de novo" com a mesma frase. */
  retryable: boolean
}

const FAILURE_MESSAGE: Record<AssistantFailureCode, string> = {
  unavailable: 'O assistente está indisponível agora. Nada foi gravado. Tente de novo em instantes.',
  rate_limited: 'Muitas mensagens em pouco tempo. Espere um minuto e tente de novo. Nada foi gravado.',
  proposal_expired: 'Esta proposta expirou. Nada foi gravado. Envie a frase de novo para gerar outra.',
  proposal_not_found: 'Não encontrei esta proposta. Nada foi gravado. Envie a frase de novo.',
  already_applied: 'Esta proposta já foi aplicada. Envie a frase de novo se quiser registrar outra coisa.',
  invalid_action: 'Uma das ações não passou na conferência com os seus dados. Nada foi gravado.',
  undo_refused: 'Não dá para desfazer: um dos registros mudou depois de ser gravado.',
  offline: 'Sem conexão com a internet. Nada foi gravado. Confira a rede e tente de novo.',
  unknown: 'Não foi possível concluir agora. Nada foi gravado. Tente de novo em instantes.',
}

const KNOWN_CODES = new Set<string>([
  'unavailable',
  'rate_limited',
  'proposal_expired',
  'proposal_not_found',
  'already_applied',
  'invalid_action',
  'undo_refused',
])

const RETRYABLE: ReadonlySet<AssistantFailureCode> = new Set(['unavailable', 'rate_limited', 'offline', 'unknown'])

export function failureOf(code: AssistantFailureCode): AssistantFailure {
  return { code, message: FAILURE_MESSAGE[code], retryable: RETRYABLE.has(code) }
}

/** Transforma qualquer falha de rede ou de API na mensagem em português da tela. */
export function toAssistantFailure(error: unknown): AssistantFailure {
  if (error instanceof ApiError) {
    if (error.code && KNOWN_CODES.has(error.code)) return failureOf(error.code as AssistantErrorCode)
    // Função ainda não publicada ou fora do ar: o servidor não deu um `code`.
    if ([404, 502, 503, 504].includes(error.status)) return failureOf('unavailable')
    if (error.status === 429) return failureOf('rate_limited')
    return failureOf('unknown')
  }
  // `fetch` rejeita com TypeError quando não há rede.
  if (error instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return failureOf('offline')
  }
  return failureOf('unknown')
}

/* ------------------------------------------------------------------ *
 * Chamadas
 * ------------------------------------------------------------------ */

/**
 * Ajustes que o usuário fez no card antes de confirmar (Editar).
 *
 * ATENÇÃO (contrato): `AssistantApplyRequest` hoje só tem `proposalId` e
 * `confirmedActionIds`. Para o Editar valer, o servidor precisa aceitar
 * `edits` e conferi-los como confere uma ação (ver relatório da etapa 7).
 * Enquanto não aceitar, o zod do servidor descartaria o campo em silêncio:
 * por isso `APPLY_ACCEPTS_EDITS` existe, para a tela poder ser desligada num
 * ponto só (os botões Editar somem) se a rota ainda não entender `edits`.
 */
export type CardEdit = { postedOn?: string; tradedOn?: string; amountCents?: number; notes?: string; note?: string }
export type CardEdits = Record<string, CardEdit>
export const APPLY_ACCEPTS_EDITS = true

export async function sendMessage(text: string, conversationId?: string): Promise<AssistantMessageResponse> {
  if (import.meta.env.DEV && isAssistantMockOn()) {
    const mock = await import('./assistantMock')
    return mock.mockSendMessage(text, conversationId)
  }
  return api.post<AssistantMessageResponse>('/assistant/message', { text, conversationId })
}

export async function applyProposal(
  proposalId: string,
  confirmedActionIds: string[],
  edits?: CardEdits,
): Promise<AssistantApplyResponse> {
  const hasEdits = edits !== undefined && Object.keys(edits).length > 0
  if (import.meta.env.DEV && isAssistantMockOn()) {
    const mock = await import('./assistantMock')
    return mock.mockApplyProposal(proposalId, confirmedActionIds, hasEdits ? edits : undefined)
  }
  return api.post<AssistantApplyResponse>('/assistant/apply', {
    proposalId,
    confirmedActionIds,
    ...(hasEdits ? { edits } : {}),
  })
}

export async function undoApplied(undoToken: string): Promise<AssistantUndoResponse> {
  if (import.meta.env.DEV && isAssistantMockOn()) {
    const mock = await import('./assistantMock')
    return mock.mockUndoApplied(undoToken)
  }
  return api.post<AssistantUndoResponse>('/assistant/undo', { undoToken })
}
