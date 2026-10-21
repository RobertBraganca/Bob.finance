import { randomUUID } from 'node:crypto'
import { todayIso } from '../../core/dates.ts'
import {
  MAX_PHRASE_LENGTH,
  type AssistantCard,
  type AssistantMessageResponse,
} from '../../core/assistantTypes.ts'
import { createProposal } from './apply.ts'
import { describeAction } from './cards.ts'
import { AssistantError } from './errors.ts'
import { AssistantUnavailableError, proposeFromText, type AssistantProvider, type AssistantTools, type ModelCaller } from './intent.ts'
import { listContext, searchPending, searchTransactions } from './matcher.ts'

/**
 * Orquestra uma mensagem do usuário (docs/specs/assistente/spec.md, seção A):
 * contexto mínimo, modelo com ferramentas de LEITURA, proposta guardada e cartões
 * de confirmação. Nada aqui grava no extrato; só `createProposal` grava, na
 * própria tabela do assistente. Edge: tudo em sequência, sem `Promise.all`.
 */

/** Prazo da conversa inteira (vários turnos e a escalada); o de cada chamada ao modelo é do `intent`. */
export const MESSAGE_DEADLINE_MS = 60_000

/** Mensagens por minuto: o app tem um usuário só, o limite protege o custo da API. */
const MAX_MESSAGES_PER_MINUTE = 20
const recent: number[] = []

function takeRateLimitSlot(now = Date.now()): void {
  while (recent.length > 0 && now - recent[0]! > 60_000) recent.shift()
  if (recent.length >= MAX_MESSAGES_PER_MINUTE) {
    throw new AssistantError('rate_limited', 'Muitas mensagens em pouco tempo. Espere um minuto e tente de novo.')
  }
  recent.push(now)
}

/** Só para teste: zera a janela do limite. */
export function resetRateLimitForTests(): void {
  recent.length = 0
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AssistantUnavailableError('A conversa passou do tempo limite.', 'timeout')), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** O motivo, em português, de o modelo não ter respondido. */
function unavailableDetail(error: AssistantUnavailableError): string {
  switch (error.reason) {
    case 'no_key':
      return 'a chave do assistente (ASSISTANT_API_KEY) não chegou à função'
    case 'timeout':
      return 'o modelo demorou demais para responder'
    case 'network':
      return 'a função não conseguiu falar com a API do modelo'
    case 'bad_response':
      return 'a API do modelo devolveu uma resposta inesperada'
    case 'http':
      return `a API do modelo respondeu HTTP ${error.status ?? '?'}${error.detail ? ` (${error.detail})` : ''}`
  }
}

/**
 * Descrição segura de um erro inesperado para mostrar ao usuário (e ler no log): nome e mensagem,
 * cortados em 160 caracteres e sem nada que pareça chave (a configurada, `sk-ant-…`, `AIza…`, `AQ.…`).
 * É o que diz o que quebrou em vez de um "não foi possível concluir" mudo.
 */
export function describeUnexpected(error: unknown, secret?: string): string {
  const name = error instanceof Error ? error.name : 'Erro'
  let text = `${name}: ${error instanceof Error ? error.message : String(error)}`
  if (secret && secret.trim()) text = text.split(secret.trim()).join('[chave]')
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[chave]')
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, '[chave]')
    .replace(/\bAQ\.[A-Za-z0-9_-]{10,}/g, '[chave]')
    .replace(/\s+/g, ' ')
    .slice(0, 160)
}

export type HandleMessageOptions = {
  /** segredo da função (`ASSISTANT_API_KEY`); ausente vira `unavailable`, sem gravar nada */
  apiKey: string | undefined
  /** só para teste */
  callModel?: ModelCaller
  models?: { cheap: string; strong: string }
  provider?: AssistantProvider
  today?: string
}

/**
 * Opções do modelo a partir das variáveis da função (segredos): `ASSISTANT_API_KEY`
 * (obrigatória), `ASSISTANT_PROVIDER` (`anthropic` ou `gemini`; sem ela vale o formato da
 * chave) e `ASSISTANT_MODEL_CHEAP` / `ASSISTANT_MODEL_STRONG` (trocam os modelos padrão).
 * `get` é `process.env[k]` no Node e `Deno.env.get(k)` no Edge.
 */
export function optionsFromEnv(get: (name: string) => string | undefined): HandleMessageOptions {
  const provider = get('ASSISTANT_PROVIDER')?.trim().toLowerCase()
  const cheap = get('ASSISTANT_MODEL_CHEAP')?.trim()
  const strong = get('ASSISTANT_MODEL_STRONG')?.trim()
  return {
    apiKey: get('ASSISTANT_API_KEY')?.trim(),
    ...(provider === 'anthropic' || provider === 'gemini' ? { provider } : {}),
    // Os dois ou nenhum: um modelo só trocado deixaria o outro de outro provedor.
    ...(cheap && strong ? { models: { cheap, strong } } : {}),
  }
}

/** Liga as ferramentas de leitura do modelo ao banco (via `matcher`). */
function databaseTools(ctx: Awaited<ReturnType<typeof listContext>>): AssistantTools {
  return {
    searchPending: (input) => searchPending(input),
    searchTransactions: (input) => searchTransactions(input),
    listAssets: async () => ctx.assets,
    listAccounts: async () => ctx.accounts,
  }
}

export async function handleMessage(
  request: { text: string; conversationId?: string },
  options: HandleMessageOptions,
): Promise<AssistantMessageResponse> {
  // Etapa em andamento: se algo inesperado quebrar, o usuário vê onde (e o log tem o erro inteiro).
  let stage = 'início'
  try {
    return await handleMessageSteps(request, options, (next) => {
      stage = next
    })
  } catch (error) {
    if (error instanceof AssistantError) throw error
    console.error('assistant: erro inesperado em', stage, error)
    throw new AssistantError(
      'unavailable',
      'O assistente está indisponível agora. Nada foi alterado.',
      undefined,
      `falha em ${stage}: ${describeUnexpected(error, options.apiKey)}`,
    )
  }
}

async function handleMessageSteps(
  request: { text: string; conversationId?: string },
  options: HandleMessageOptions,
  setStage: (stage: string) => void,
): Promise<AssistantMessageResponse> {
  const text = request.text.trim()
  if (text.length === 0 || text.length > MAX_PHRASE_LENGTH) {
    throw new AssistantError('invalid_action', `A frase precisa ter de 1 a ${MAX_PHRASE_LENGTH} caracteres.`, 400)
  }
  takeRateLimitSlot()

  const conversationId = request.conversationId ?? randomUUID()
  setStage('ler o contexto')
  const ctx = await listContext(options.today ?? todayIso())

  setStage('chamar o modelo e as ferramentas')
  let result
  try {
    result = await withDeadline(
      proposeFromText(text, ctx, {
        apiKey: options.apiKey ?? '',
        tools: databaseTools(ctx),
        callModel: options.callModel,
        models: options.models,
        provider: options.provider,
      }),
      MESSAGE_DEADLINE_MS,
    )
  } catch (error) {
    if (error instanceof AssistantUnavailableError) {
      const detail = unavailableDetail(error)
      // Sem a chave nem o corpo da resposta: só o motivo e o status.
      console.error('assistant: modelo indisponível', error.reason, error.status ?? '', error.detail ?? '')
      throw new AssistantError('unavailable', 'O assistente está indisponível agora. Nada foi alterado.', undefined, detail)
    }
    throw error
  }
  const proposal = result.proposal

  // Só perguntas (ou recusa de conselho): nada a guardar nem a confirmar.
  if (proposal.actions.length === 0) {
    return { conversationId, summary: proposal.summary, cards: [], questions: proposal.questions }
  }

  setStage('guardar a proposta')
  const saved = await createProposal(text, conversationId, proposal)
  setStage('montar os cartões')
  const cards: AssistantCard[] = []
  const questions = [...proposal.questions]
  for (const action of saved.actions) {
    try {
      cards.push(await describeAction(action))
    } catch (error) {
      // Uma ação que não passa na conferência com o banco não vira card: o usuário fica sabendo por quê.
      if (error instanceof AssistantError && error.code === 'invalid_action') questions.push(error.message)
      else throw error
    }
  }

  if (cards.length === 0) {
    return { conversationId, summary: proposal.summary, cards: [], questions }
  }
  return {
    conversationId,
    proposalId: saved.proposalId,
    summary: proposal.summary,
    cards,
    questions,
    expiresAt: saved.expiresAt,
  }
}

/** Corpo e status HTTP de um erro esperado do assistente; null quando não é um deles. */
export function assistantHttpError(error: unknown): { status: number; body: { error: string; code: string; detail?: string } } | null {
  if (error instanceof AssistantError) {
    return { status: error.status, body: { error: error.message, code: error.code, ...(error.detail ? { detail: error.detail } : {}) } }
  }
  if (error instanceof AssistantUnavailableError) {
    return {
      status: 503,
      body: { error: 'O assistente está indisponível agora. Nada foi alterado.', code: 'unavailable', detail: unavailableDetail(error) },
    }
  }
  return null
}
