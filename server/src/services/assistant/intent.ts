import { z } from 'zod'
import {
  MAX_ACTIONS_PER_PROPOSAL,
  MAX_PHRASE_LENGTH,
  assistantProposalSchema,
  type AssistantAction,
  type AssistantCandidate,
  type AssistantContext,
  type AssistantProposal,
} from '../../core/assistantTypes'
import { SYSTEM_PROMPT, buildUserMessage } from './prompt'

/**
 * Cliente do modelo do assistente (docs/specs/assistente/spec.md, etapa 5):
 * transforma a frase do usuário em uma PROPOSTA (ações + perguntas) usando a
 * API de mensagens da Anthropic com ferramentas de LEITURA. O modelo nunca
 * grava: não existe ferramenta de escrita; quem aplica é o `apply`, depois do
 * Confirmar do usuário.
 *
 * Roda em Node (Fastify) e em Deno (Edge Function): só `fetch` e APIs web, sem
 * SDK e sem ler variável de ambiente aqui dentro. A chave e os modelos chegam
 * por parâmetro. A chave nunca vai para log nem para mensagem de erro.
 *
 * Regra do pooler (Edge): as ferramentas de leitura rodam uma por vez, nunca
 * `Promise.all`.
 */

/* ------------------------------------------------------------------ *
 * Formato da API de mensagens (o que o `ModelCaller` recebe e devolve)
 * ------------------------------------------------------------------ */
export type ModelTextBlock = { type: 'text'; text: string }
export type ModelToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  /** Gemini: assinatura de raciocínio da chamada; precisa voltar junto na rodada seguinte */
  signature?: string
}
export type ModelToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
export type ModelContentBlock = ModelTextBlock | ModelToolUseBlock | ModelToolResultBlock

export type ModelMessage = { role: 'user' | 'assistant'; content: string | ModelContentBlock[] }

export type ModelToolDefinition = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type ModelRequest = {
  model: string
  max_tokens: number
  system: string
  tools: ModelToolDefinition[]
  messages: ModelMessage[]
  tool_choice?: { type: 'auto' } | { type: 'tool'; name: string }
}

export type ModelResponse = {
  content: ModelContentBlock[]
  stop_reason?: string | null
}

/** Função injetável: nos testes é o modelo simulado; em produção, `createAnthropicCaller`. */
export type ModelCaller = (req: ModelRequest) => Promise<ModelResponse>

/* ------------------------------------------------------------------ *
 * Erro e constantes
 * ------------------------------------------------------------------ */
export type UnavailableReason = 'no_key' | 'timeout' | 'network' | 'http' | 'bad_response'

/** Chave ausente, API fora do ar, tempo esgotado ou resposta quebrada: nada foi gravado. */
export class AssistantUnavailableError extends Error {
  readonly code = 'unavailable' as const
  readonly reason: UnavailableReason
  /** status HTTP da API do modelo, quando houve resposta */
  readonly status?: number
  /** tipo e mensagem do erro que a API devolveu (já sem a chave); só diagnóstico */
  readonly detail?: string
  constructor(message: string, reason: UnavailableReason, status?: number, detail?: string) {
    super(message)
    this.name = 'AssistantUnavailableError'
    this.reason = reason
    this.status = status
    this.detail = detail
  }
}

export const DEFAULT_MODELS = { cheap: 'claude-haiku-5-5', strong: 'claude-sonnet-5-5' } as const

/** Provedores do modelo. O resto do serviço fala o formato da API de mensagens; o adaptador traduz. */
export type AssistantProvider = 'anthropic' | 'gemini'

export const DEFAULT_MODELS_BY_PROVIDER: Record<AssistantProvider, { cheap: string; strong: string }> = {
  anthropic: DEFAULT_MODELS,
  // O Google aposenta modelos para contas novas (o 2.5 já devolve 404 "no longer available"): se mudar de
  // novo, o painel mostra o motivo e `ASSISTANT_MODEL_CHEAP`/`ASSISTANT_MODEL_STRONG` trocam sem código.
  gemini: { cheap: 'gemini-3.8-flash', strong: 'gemini-3.8-pro' },
}

/** Chave da Anthropic começa com `sk-ant-`; qualquer outra é tratada como Gemini (Google AI Studio). */
export function providerOfKey(apiKey: string): AssistantProvider {
  return apiKey.trim().startsWith('sk-ant-') ? 'anthropic' : 'gemini'
}
export const DEFAULT_TIMEOUT_MS = 20_000
/** Chamadas ao modelo por conversa (ferramentas de leitura + a proposta). */
export const MAX_TOOL_TURNS = 4
const MAX_OUTPUT_TOKENS = 1024
const MAX_CANDIDATES = 5
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

const FALLBACK_QUESTION = 'Não consegui entender; pode reescrever?'

/* ------------------------------------------------------------------ *
 * Ferramentas: só leitura. A última (`submit_proposal`) não consulta nada:
 * é por ela que o modelo entrega a proposta.
 * ------------------------------------------------------------------ */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const searchPendingInput = z.object({
  amountCents: z.number().int().positive().optional().describe('Valor em centavos, positivo (R$ 750,00 = 75000)'),
  text: z.string().trim().max(120).optional().describe('Nome ou trecho da descrição (cliente, fornecedor)'),
  from: isoDate.optional().describe('Início da janela de data, AAAA-MM-DD'),
  to: isoDate.optional().describe('Fim da janela de data, AAAA-MM-DD'),
  flow: z.enum(['income', 'expense']).optional().describe('income = a receber, expense = a pagar'),
})
export type SearchPendingInput = z.infer<typeof searchPendingInput>

export const searchTransactionsInput = z.object({
  amountCents: z.number().int().positive().optional().describe('Valor em centavos, positivo'),
  text: z.string().trim().max(120).optional().describe('Nome ou trecho da descrição'),
  from: isoDate.optional().describe('Início da janela de data, AAAA-MM-DD'),
  to: isoDate.optional().describe('Fim da janela de data, AAAA-MM-DD'),
})
export type SearchTransactionsInput = z.infer<typeof searchTransactionsInput>

/** O que o serviço precisa do banco; as rotas ligam estas funções ao `matcher`. */
export type AssistantTools = {
  searchPending(input: SearchPendingInput): Promise<AssistantCandidate[]>
  searchTransactions(input: SearchTransactionsInput): Promise<AssistantCandidate[]>
  listAssets(): Promise<AssistantContext['assets']>
  listAccounts(): Promise<AssistantContext['accounts']>
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

export const TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    name: 'search_pending',
    description:
      'Busca PENDÊNCIAS (receitas a receber e despesas a pagar ainda não realizadas) por valor, texto e janela de data. Devolve até 5 candidatos já ordenados pela força do casamento (exact, likely, weak). Só leitura.',
    input_schema: jsonSchemaOf(searchPendingInput),
  },
  {
    name: 'search_transactions',
    description:
      'Busca LANÇAMENTOS JÁ REALIZADOS por valor, texto e janela de data. Devolve até 5 candidatos já ordenados pela força do casamento. Use para comentar algo que já aconteceu. Só leitura.',
    input_schema: jsonSchemaOf(searchTransactionsInput),
  },
  {
    name: 'list_assets',
    description: 'Lista os ativos de investimento que existem (id, nome, ticker, classe). Só leitura. Ativos não são criados pelo assistente.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_accounts',
    description: 'Lista as contas do usuário (id e nome). Só leitura.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'submit_proposal',
    description:
      'Entrega a proposta final: um resumo, até 5 ações e até 3 perguntas. Chame uma única vez, no fim. Nada é gravado: o usuário confirma na tela. Sem ação segura, devolva só perguntas.',
    input_schema: jsonSchemaOf(assistantProposalSchema),
  },
]

/* ------------------------------------------------------------------ *
 * Cliente padrão: fetch + AbortController
 * ------------------------------------------------------------------ */
export type AnthropicCallerOptions = {
  apiKey: string
  timeoutMs?: number
  /** só para teste: o padrão é o `fetch` global */
  fetchImpl?: typeof fetch
}

/**
 * Do corpo de erro da API só sai `error.type` e `error.message` (ex.:
 * "authentication_error: invalid x-api-key"), cortados em 160 caracteres e SEM
 * nada que pareça a chave. É o que diz ao usuário por que o modelo falhou
 * (chave recusada, modelo inexistente, saldo) em vez de um "indisponível" mudo.
 */
export async function describeApiError(res: Response, apiKey: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = (await res.text()).slice(0, 4000)
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const error = (parsed as { error?: { type?: unknown; status?: unknown; message?: unknown } } | null)?.error
  // Anthropic manda `error.type`; o Gemini manda `error.status` (ex.: INVALID_ARGUMENT).
  const type = typeof error?.type === 'string' ? error.type : typeof error?.status === 'string' ? error.status : null
  const message = typeof error?.message === 'string' ? error.message : null
  if (!type && !message) return undefined
  let text = [type, message].filter(Boolean).join(': ')
  if (apiKey) text = text.split(apiKey).join('[chave]')
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[chave]').replace(/\s+/g, ' ').slice(0, 160)
}

export function createAnthropicCaller(opts: AnthropicCallerOptions): ModelCaller {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = opts.fetchImpl ?? fetch
  return async (req) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let res: Response
      let body: unknown
      try {
        res = await doFetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'x-api-key': opts.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify(req),
          signal: controller.signal,
        })
        if (!res.ok) {
          // O corpo do erro só entra como diagnóstico (tipo e mensagem, sem a chave).
          throw new AssistantUnavailableError(
            `O modelo respondeu com erro (HTTP ${res.status}).`,
            'http',
            res.status,
            await describeApiError(res, opts.apiKey),
          )
        }
        body = await res.json()
      } catch (error) {
        if (error instanceof AssistantUnavailableError) throw error
        if (controller.signal.aborted) {
          throw new AssistantUnavailableError('O modelo demorou demais para responder.', 'timeout')
        }
        if (error instanceof SyntaxError) {
          throw new AssistantUnavailableError('O modelo devolveu uma resposta ilegível.', 'bad_response')
        }
        throw new AssistantUnavailableError('Não consegui falar com o modelo.', 'network')
      }
      if (!body || typeof body !== 'object' || !Array.isArray((body as { content?: unknown }).content)) {
        throw new AssistantUnavailableError('O modelo devolveu uma resposta inesperada.', 'bad_response')
      }
      return body as ModelResponse
    } finally {
      clearTimeout(timer)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Gemini (Google AI Studio): traduz o formato interno (API de mensagens) para
 * `generateContent` e de volta. Só `fetch`, sem SDK. A chave vai no cabeçalho
 * `x-goog-api-key`, nunca na URL (URL vira log).
 * ------------------------------------------------------------------ */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

type GeminiPart = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args?: unknown }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

function parseToolResult(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

/** Corpo do `generateContent` a partir do pedido no formato da API de mensagens. */
export function toGeminiBody(req: ModelRequest): Record<string, unknown> {
  const namesById = new Map<string, string>()
  const contents = req.messages.map((message) => {
    const parts: GeminiPart[] =
      typeof message.content === 'string'
        ? [{ text: message.content }]
        : message.content.map((block): GeminiPart => {
            if (block.type === 'text') return { text: block.text }
            if (block.type === 'tool_use') {
              namesById.set(block.id, block.name)
              return {
                functionCall: { name: block.name, args: block.input ?? {} },
                ...(block.signature ? { thoughtSignature: block.signature } : {}),
              }
            }
            const result = parseToolResult(block.content)
            return {
              functionResponse: {
                name: namesById.get(block.tool_use_id) ?? 'ferramenta',
                response: block.is_error ? { error: result } : { result },
              },
            }
          })
    return { role: message.role === 'assistant' ? 'model' : 'user', parts }
  })

  const forced = req.tool_choice?.type === 'tool' ? req.tool_choice.name : null
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents,
    tools: [
      {
        functionDeclarations: req.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          // JSON Schema completo (o zod gera anyOf/const), não o subconjunto OpenAPI de `parameters`.
          parametersJsonSchema: tool.input_schema,
        })),
      },
    ],
    toolConfig: {
      functionCallingConfig: forced ? { mode: 'ANY', allowedFunctionNames: [forced] } : { mode: 'AUTO' },
    },
    generationConfig: { maxOutputTokens: req.max_tokens, temperature: 0 },
  }
}

/** Resposta do `generateContent` no formato interno; `null` quando não veio candidato (bloqueio, vazio). */
export function fromGeminiResponse(body: unknown): ModelResponse | null {
  const parts = (body as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> } | null)?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return null
  const content: ModelContentBlock[] = []
  let n = 0
  for (const part of parts) {
    if (part.functionCall) {
      n += 1
      content.push({
        type: 'tool_use',
        id: `gemini_${n}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
      })
    } else if (typeof part.text === 'string' && !part.thought) {
      content.push({ type: 'text', text: part.text })
    }
  }
  return { content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }
}

export function createGeminiCaller(opts: AnthropicCallerOptions): ModelCaller {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = opts.fetchImpl ?? fetch
  return async (req) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let res: Response
      let body: unknown
      try {
        res = await doFetch(`${GEMINI_BASE}/${encodeURIComponent(req.model)}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': opts.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify(toGeminiBody(req)),
          signal: controller.signal,
        })
        if (!res.ok) {
          throw new AssistantUnavailableError(
            `O modelo respondeu com erro (HTTP ${res.status}).`,
            'http',
            res.status,
            await describeApiError(res, opts.apiKey),
          )
        }
        body = await res.json()
      } catch (error) {
        if (error instanceof AssistantUnavailableError) throw error
        if (controller.signal.aborted) throw new AssistantUnavailableError('O modelo demorou demais para responder.', 'timeout')
        if (error instanceof SyntaxError) throw new AssistantUnavailableError('O modelo devolveu uma resposta ilegível.', 'bad_response')
        throw new AssistantUnavailableError('Não consegui falar com o modelo.', 'network')
      }
      const parsed = fromGeminiResponse(body)
      if (!parsed) throw new AssistantUnavailableError('O modelo não devolveu resposta (possível bloqueio de conteúdo).', 'bad_response')
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }
}

/** O cliente certo para o provedor (pela chave, ou o `provider` pedido). */
export function createModelCaller(opts: AnthropicCallerOptions & { provider?: AssistantProvider }): ModelCaller {
  const provider = opts.provider ?? providerOfKey(opts.apiKey)
  return provider === 'gemini' ? createGeminiCaller(opts) : createAnthropicCaller(opts)
}

/* ------------------------------------------------------------------ *
 * Filtro de conselho (decisions/0010): antes da chamada e na saída
 * ------------------------------------------------------------------ */
function plain(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

// Só INFINITIVOS e pedidos de opinião: "comprei", "vendi" e "aporte de" ficam de fora.
const OPERATION = '(?:comprar|vender|aportar|investir|resgatar|diversificar)'
const ADVICE_REQUEST = [
  new RegExp(`\\b(?:devo|devemos|deveria|deveriamos)\\b(?:\\s+\\S+){0,3}?\\s+${OPERATION}\\b`),
  new RegExp(`\\bvale\\s+(?:a\\s+)?pena\\b[^.?!]{0,50}?\\b(?:${OPERATION}|investimento|aporte|fundo|acao|acoes|ativo)\\b`),
  new RegExp(`\\b(?:e|seria)\\s+(?:bom|melhor|boa ideia)\\b[^.?!]{0,30}?\\b${OPERATION}\\b`),
  new RegExp(`\\bcompensa\\b[^.?!]{0,20}?\\b${OPERATION}\\b`),
  new RegExp(`\\bo\\s+que\\b(?:\\s+\\S+){0,3}?\\s+${OPERATION}\\b`),
  /\b(?:onde|em\s+que|em\s+qual)\b(?:\s+\S+){0,2}?\s+(?:investir|aportar|comprar)\b/,
  /\bqual\b[^.?!]{0,12}?\b(?:melhor|ideal)\b[^.?!]{0,30}?\b(?:investimento|ativo|acao|fundo|aporte|opcao)\b/,
  new RegExp(`\\bquanto\\b(?:\\s+\\S+){0,3}?\\s+${OPERATION}\\b`),
  /\b(?:recomend\w*|sugir\w*|sugere|indic\w*|aconselh\w*)\b[^.?!]{0,40}?\b(?:investimento|ativo|acao|acoes|fundo|aporte|comprar|vender|aportar|investir)\b/,
]

/** A frase pede conselho de compra, venda, aporte ou investimento? */
export function isAdviceRequest(text: string): boolean {
  const t = plain(text)
  return ADVICE_REQUEST.some((re) => re.test(t))
}

const ADVICE_OUTPUT = [
  new RegExp(`\\b(?:recomend\\w*|sugir\\w*|aconselh\\w*)\\b[^.?!]{0,40}?\\b${OPERATION}\\b`),
  new RegExp(`\\bvoce\\s+(?:deveria|deve|precisa)\\b[^.?!]{0,30}?\\b${OPERATION}\\b`),
  /\bmelhor\s+(?:investimento|opcao\s+de\s+investimento)\b/,
  new RegExp(`\\bvale\\s+(?:a\\s+)?pena\\b[^.?!]{0,50}?\\b${OPERATION}\\b`),
]

/** O resumo ou as perguntas do modelo soam como conselho? */
function outputLooksLikeAdvice(proposal: AssistantProposal): boolean {
  const t = plain([proposal.summary, ...proposal.questions].join(' . '))
  return ADVICE_OUTPUT.some((re) => re.test(t))
}

function adviceProposal(): AssistantProposal {
  return {
    summary: 'Eu registro e organizo o que você fez; não aconselho sobre comprar, vender ou aportar.',
    actions: [],
    questions: ['Quer registrar uma operação que você já fez? Diga o ativo, a quantidade e o preço.'],
  }
}

/* ------------------------------------------------------------------ *
 * Validação da proposta e dos ids
 * ------------------------------------------------------------------ */
type SeenIds = {
  pending: Set<number>
  transactions: Set<number>
  assets: Set<number>
  accounts: Set<number>
  categories: Set<number>
}

function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

function invalidDateIssues(actions: AssistantAction[]): string[] {
  const issues: string[] = []
  actions.forEach((action, index) => {
    const dates: string[] = []
    if ('postedOn' in action && action.postedOn) dates.push(action.postedOn)
    if ('tradedOn' in action && action.tradedOn) dates.push(action.tradedOn)
    for (const date of dates) {
      if (!isRealDate(date)) issues.push(`ação ${index + 1} (${action.type}): a data ${date} não existe no calendário`)
    }
  })
  return issues
}

function issuesOf(error: z.ZodError): string {
  const text = error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || 'proposta'}: ${issue.message}`)
    .join('; ')
  return text.slice(0, 600)
}

type Checked =
  | { ok: true; proposal: AssistantProposal; truncated: boolean }
  | { ok: false; issues: string }

/** Schema do contrato + datas reais. Mais de 5 ações não invalida: mantém as 5 primeiras. */
function checkSubmission(input: unknown): Checked {
  let raw = input
  let truncated = false
  const actions = input && typeof input === 'object' ? (input as { actions?: unknown }).actions : undefined
  if (Array.isArray(actions) && actions.length > MAX_ACTIONS_PER_PROPOSAL) {
    raw = { ...(input as object), actions: actions.slice(0, MAX_ACTIONS_PER_PROPOSAL) }
    truncated = true
  }
  const parsed = assistantProposalSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) }
  const dateIssues = invalidDateIssues(parsed.data.actions)
  if (dateIssues.length > 0) return { ok: false, issues: dateIssues.join('; ') }
  return { ok: true, proposal: parsed.data, truncated }
}

/** Acrescenta uma pergunta; com 3 já na lista, troca a última (o contrato aceita no máximo 3). */
function addQuestion(questions: string[], question: string): string[] {
  return questions.length < 3 ? [...questions, question] : [...questions.slice(0, 2), question]
}

/**
 * Descarta ação com id que nunca apareceu nas ferramentas (ou no contexto) desta
 * conversa: é id inventado. Categoria desconhecida não derruba a ação: sai a
 * categoria e o card mostra "sem TAG".
 */
function keepSeenIds(actions: AssistantAction[], seen: SeenIds): { kept: AssistantAction[]; dropped: number } {
  const kept: AssistantAction[] = []
  let dropped = 0
  for (const action of actions) {
    switch (action.type) {
      case 'update_pending':
        if (seen.pending.has(action.pendingId)) kept.push(action)
        else dropped += 1
        break
      case 'add_note':
        if (seen.transactions.has(action.transactionId)) kept.push(action)
        else dropped += 1
        break
      case 'record_trade':
        if (seen.assets.has(action.assetId)) kept.push(action)
        else dropped += 1
        break
      case 'create_transaction':
      case 'diary_entry': {
        if (!seen.accounts.has(action.accountId)) {
          dropped += 1
          break
        }
        const unknownCategory = action.categoryId != null && !seen.categories.has(action.categoryId)
        kept.push(unknownCategory ? { ...action, categoryId: null } : action)
        break
      }
      case 'reserve_contribution':
        kept.push(action)
        break
    }
  }
  return { kept, dropped }
}

type Finalized = { proposal: AssistantProposal; dropped: number } | null

function finalize(checked: { proposal: AssistantProposal; truncated: boolean }, seen: SeenIds): Finalized {
  const { kept, dropped } = keepSeenIds(checked.proposal.actions, seen)
  let summary = checked.proposal.summary
  let questions = checked.proposal.questions
  if (dropped > 0) {
    if (kept.length === 0) summary = 'Não consegui confirmar o registro citado; nada será alterado.'
    questions = addQuestion(
      questions,
      dropped === 1
        ? 'Ignorei uma ação porque não achei o registro certo. Pode dar mais detalhes (descrição, valor ou data)?'
        : `Ignorei ${dropped} ações porque não achei os registros certos. Pode dar mais detalhes?`,
    )
  }
  if (checked.truncated) {
    questions = addQuestion(
      questions,
      `Só dá para propor ${MAX_ACTIONS_PER_PROPOSAL} ações por vez; mantive as ${MAX_ACTIONS_PER_PROPOSAL} primeiras. Envie o resto em outra frase.`,
    )
  }
  const result = assistantProposalSchema.safeParse({ summary, actions: kept, questions })
  if (!result.success) return null
  return { proposal: result.data, dropped }
}

/* ------------------------------------------------------------------ *
 * Escalonamento: o modelo barato falhou numa frase que parecia clara?
 * ------------------------------------------------------------------ */
const CLEAR_AMOUNT = /(?:r\$\s*\d|\d[\d.]*,\d{2}\b|\b\d+\s*(?:reais|conto|contos|mil)\b)/
const CLEAR_VERB =
  /\b(?:receb\w*|pag\w*|compr\w*|vend\w*|aport\w*|gast\w*|lanc\w*|registr\w*|entrou|saiu|entrada|receita|despesa|deposit\w*|transfer\w*|resgat\w*|mud\w*|troc\w*|alter\w*|atualiz\w*|adiant\w*)\b/

/** A frase tem valor e verbo claros? Só então um "não entendi" do modelo barato merece o forte. */
export function looksClear(text: string): boolean {
  const t = plain(text)
  return CLEAR_AMOUNT.test(t) && CLEAR_VERB.test(t)
}

/* ------------------------------------------------------------------ *
 * Laço do modelo
 * ------------------------------------------------------------------ */
export type IntentDeps = {
  apiKey: string
  /** injetável; o padrão usa `fetch` com a chave e o tempo limite abaixo */
  callModel?: ModelCaller
  tools: AssistantTools
  models?: { cheap: string; strong: string }
  /** `anthropic` ou `gemini`; ausente = pelo formato da chave */
  provider?: AssistantProvider
  /** tempo limite de CADA chamada ao modelo (só no cliente padrão); padrão 20 s */
  timeoutMs?: number
}

export type ProposeResult = {
  proposal: AssistantProposal
  /** de onde veio a proposta */
  source: 'model' | 'advice_filter' | 'input_limit' | 'fallback'
  /** modelo que produziu a proposta; null quando não houve chamada ou ela falhou */
  model: string | null
  /** o modelo barato não bastou e o forte foi chamado (uma vez) */
  escalated: boolean
  /** ações descartadas por id nunca visto nas ferramentas */
  droppedActions: number
  /** chamadas feitas ao modelo, somando barato e forte */
  modelCalls: number
}

type Run = { model: string; result: Finalized }

function earlyResult(proposal: AssistantProposal, source: ProposeResult['source']): ProposeResult {
  return { proposal, source, model: null, escalated: false, droppedActions: 0, modelCalls: 0 }
}

function fallbackProposal(): AssistantProposal {
  return { summary: 'Não consegui entender o pedido.', actions: [], questions: [FALLBACK_QUESTION] }
}

async function callSafely(call: ModelCaller, req: ModelRequest): Promise<ModelResponse> {
  let res: ModelResponse
  try {
    res = await call(req)
  } catch (error) {
    if (error instanceof AssistantUnavailableError) throw error
    const name = error && typeof error === 'object' ? (error as { name?: string }).name : undefined
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new AssistantUnavailableError('O modelo demorou demais para responder.', 'timeout')
    }
    // A mensagem original pode conter detalhes da requisição; não é repassada.
    throw new AssistantUnavailableError('Não consegui falar com o modelo.', 'network')
  }
  if (!res || !Array.isArray(res.content)) {
    throw new AssistantUnavailableError('O modelo devolveu uma resposta inesperada.', 'bad_response')
  }
  return res
}

function isToolUse(block: unknown): block is ModelToolUseBlock {
  return !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use'
}

function describeCandidates(candidates: AssistantCandidate[]): string {
  const list = candidates.slice(0, MAX_CANDIDATES).map((c) => ({
    kind: c.kind,
    id: c.id,
    description: c.description,
    amountCents: c.amountCents,
    postedOn: c.postedOn,
    accountName: c.accountName,
    strength: c.strength,
  }))
  return JSON.stringify(list.length > 0 ? { candidatos: list } : { candidatos: [], aviso: 'nenhum candidato' })
}

/** Executa UMA ferramenta de leitura e registra os ids que ela devolveu. Erro de entrada volta ao modelo; erro de banco sobe. */
async function runReadTool(
  block: ModelToolUseBlock,
  tools: AssistantTools,
  seen: SeenIds,
): Promise<{ content: string; isError: boolean }> {
  switch (block.name) {
    case 'search_pending': {
      const input = searchPendingInput.safeParse(block.input ?? {})
      if (!input.success) return { content: `Entrada inválida: ${issuesOf(input.error)}`, isError: true }
      const found = (await tools.searchPending(input.data)).slice(0, MAX_CANDIDATES)
      for (const c of found) seen.pending.add(c.id)
      return { content: describeCandidates(found), isError: false }
    }
    case 'search_transactions': {
      const input = searchTransactionsInput.safeParse(block.input ?? {})
      if (!input.success) return { content: `Entrada inválida: ${issuesOf(input.error)}`, isError: true }
      const found = (await tools.searchTransactions(input.data)).slice(0, MAX_CANDIDATES)
      for (const c of found) seen.transactions.add(c.id)
      return { content: describeCandidates(found), isError: false }
    }
    case 'list_assets': {
      const assets = await tools.listAssets()
      for (const a of assets) seen.assets.add(a.id)
      return { content: JSON.stringify({ ativos: assets }), isError: false }
    }
    case 'list_accounts': {
      const accounts = await tools.listAccounts()
      for (const a of accounts) seen.accounts.add(a.id)
      return { content: JSON.stringify({ contas: accounts }), isError: false }
    }
    default:
      return { content: `Ferramenta desconhecida: ${block.name}`, isError: true }
  }
}

/**
 * Uma conversa com UM modelo: no máximo MAX_TOOL_TURNS chamadas, mais uma de
 * correção se a proposta vier inválida. `result` nulo = não entregou proposta
 * válida (inválida mesmo após a correção, ou o laço estourou).
 */
async function runModel(
  model: string,
  phrase: string,
  ctx: AssistantContext,
  tools: AssistantTools,
  call: ModelCaller,
  seen: SeenIds,
  counter: { calls: number },
): Promise<Run> {
  const messages: ModelMessage[] = [{ role: 'user', content: buildUserMessage(phrase, ctx) }]
  let corrected = false

  for (let turn = 0; turn < MAX_TOOL_TURNS + (corrected ? 1 : 0); turn += 1) {
    // Na última chamada (ou na de correção) o modelo é obrigado a entregar a proposta.
    const force = turn >= MAX_TOOL_TURNS - 1 || corrected
    const request: ModelRequest = {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages: [...messages], // cópia: a lista segue crescendo depois da chamada
      ...(force ? { tool_choice: { type: 'tool' as const, name: 'submit_proposal' } } : {}),
    }
    const response = await callSafely(call, request)
    counter.calls += 1

    const content = response.content.length > 0 ? response.content : [{ type: 'text' as const, text: '(sem resposta)' }]
    const toolUses = response.content.filter(isToolUse)
    const submit = toolUses.find((block) => block.name === 'submit_proposal')

    if (submit) {
      const checked = checkSubmission(submit.input)
      if (checked.ok) return { model, result: finalize(checked, seen) }
      if (corrected) return { model, result: null }
      corrected = true
      messages.push({ role: 'assistant', content })
      messages.push({
        role: 'user',
        content: toolUses.map((block) => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          is_error: true,
          content:
            block === submit
              ? `Proposta inválida: ${checked.issues}. Corrija e chame submit_proposal de novo; sem dados suficientes, devolva só perguntas.`
              : 'Ignorada: chame apenas submit_proposal.',
        })),
      })
      continue
    }

    // Na chamada obrigatória (última ou de correção) quem não entrega a proposta perde a vez.
    if (force) return { model, result: null }

    if (toolUses.length > 0) {
      messages.push({ role: 'assistant', content })
      const results: ModelToolResultBlock[] = []
      // Uma ferramenta por vez, nunca Promise.all (pooler do Edge).
      for (const block of toolUses) {
        const out = await runReadTool(block, tools, seen)
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out.content, ...(out.isError ? { is_error: true } : {}) })
      }
      messages.push({ role: 'user', content: results })
      continue
    }

    // Só texto, sem chamar nenhuma ferramenta: pede a proposta uma vez.
    corrected = true
    messages.push({ role: 'assistant', content })
    messages.push({ role: 'user', content: 'Responda chamando a ferramenta submit_proposal.' })
  }
  return { model, result: null }
}

/**
 * Frase -> proposta. Nunca grava e nunca aconselha.
 *
 * Ordem: limites da frase, filtro de conselho (sem chamar o modelo), chave,
 * modelo barato; se ele não entregar proposta válida, ou só perguntar para uma
 * frase com valor e verbo claros, UMA escalada para o modelo forte.
 * Lança `AssistantUnavailableError` (code `unavailable`) para chave ausente,
 * HTTP de erro, tempo esgotado ou resposta quebrada. Erros das ferramentas
 * (banco) sobem como vieram.
 */
export async function proposeFromText(text: string, ctx: AssistantContext, deps: IntentDeps): Promise<ProposeResult> {
  const phrase = text.trim()
  if (!phrase) {
    return earlyResult(
      { summary: 'Nada para registrar.', actions: [], questions: ['Escreva o que você quer registrar.'] },
      'input_limit',
    )
  }
  if (phrase.length > MAX_PHRASE_LENGTH) {
    return earlyResult(
      {
        summary: 'A frase ficou longa demais.',
        actions: [],
        questions: [`Use até ${MAX_PHRASE_LENGTH} caracteres; pode dividir em duas frases?`],
      },
      'input_limit',
    )
  }
  if (isAdviceRequest(phrase)) return earlyResult(adviceProposal(), 'advice_filter')

  if (!deps.apiKey || !deps.apiKey.trim()) {
    throw new AssistantUnavailableError('O assistente não está configurado (falta a chave do modelo).', 'no_key')
  }

  const provider = deps.provider ?? providerOfKey(deps.apiKey)
  const models = deps.models ?? DEFAULT_MODELS_BY_PROVIDER[provider]
  const call = deps.callModel ?? createModelCaller({ apiKey: deps.apiKey, timeoutMs: deps.timeoutMs, provider })
  const seen: SeenIds = {
    pending: new Set(),
    transactions: new Set(),
    assets: new Set(ctx.assets.map((a) => a.id)),
    accounts: new Set(ctx.accounts.map((a) => a.id)),
    categories: new Set(ctx.categories.map((c) => c.id)),
  }
  const counter = { calls: 0 }

  const cheap = await runModel(models.cheap, phrase, ctx, deps.tools, call, seen, counter)
  let chosen = cheap
  let escalated = false
  const cheapFailed = cheap.result === null
  const onlyQuestions = cheap.result !== null && cheap.result.proposal.actions.length === 0
  // Escalar para o MESMO modelo só gastaria cota; e um forte indisponível (modelo aposentado, limite da
  // camada gratuita) não pode derrubar o que o barato já entregou.
  if ((cheapFailed || (onlyQuestions && looksClear(phrase))) && models.strong !== models.cheap) {
    escalated = true
    let strong: Run | null
    try {
      strong = await runModel(models.strong, phrase, ctx, deps.tools, call, seen, counter)
    } catch (error) {
      if (cheap.result !== null && error instanceof AssistantUnavailableError) strong = null
      else throw error
    }
    // O forte vale se entregou algo; senão, fica o que o barato tinha (se tinha).
    if (strong && strong.result !== null) chosen = strong
  }

  if (chosen.result === null) {
    return { ...earlyResult(fallbackProposal(), 'fallback'), escalated, modelCalls: counter.calls }
  }
  if (outputLooksLikeAdvice(chosen.result.proposal)) {
    return { ...earlyResult(adviceProposal(), 'advice_filter'), model: chosen.model, escalated, modelCalls: counter.calls }
  }
  return {
    proposal: chosen.result.proposal,
    source: 'model',
    model: chosen.model,
    escalated,
    droppedActions: chosen.result.dropped,
    modelCalls: counter.calls,
  }
}
