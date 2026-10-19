import type { AssistantErrorCode } from '../../core/assistantTypes'

/** HTTP de cada erro esperado do assistente (a tela trata pelo `code`). */
const STATUS_BY_CODE: Record<AssistantErrorCode, number> = {
  unavailable: 503,
  rate_limited: 429,
  proposal_expired: 410,
  proposal_not_found: 404,
  already_applied: 409,
  invalid_action: 422,
  undo_refused: 409,
}

/**
 * Erro esperado do assistente: a mensagem é em português e segura de mostrar,
 * `code` é o do contrato (`AssistantErrorCode`) e `status` é o HTTP da rota.
 */
export class AssistantError extends Error {
  readonly code: AssistantErrorCode
  readonly status: number
  /** motivo técnico e seguro de mostrar (sem segredo), para o usuário saber o que consertar */
  readonly detail?: string

  constructor(code: AssistantErrorCode, message: string, status: number = STATUS_BY_CODE[code], detail?: string) {
    super(message)
    this.name = 'AssistantError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}
