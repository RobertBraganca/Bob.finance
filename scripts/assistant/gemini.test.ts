import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AssistantUnavailableError,
  DEFAULT_MODELS_BY_PROVIDER,
  createGeminiCaller,
  fromGeminiResponse,
  proposeFromText,
  providerOfKey,
  toGeminiBody,
  TOOL_DEFINITIONS,
  type AssistantTools,
  type ModelCaller,
  type ModelRequest,
  type ModelResponse,
} from '../../server/src/services/assistant/intent'
import { describeUnexpected, optionsFromEnv } from '../../server/src/services/assistant/service'
import type { AssistantCandidate, AssistantContext } from '../../shared/assistantTypes'

/**
 * Adaptador do Gemini (Google AI Studio). NENHUMA rede: o `fetch` é simulado.
 * A chave de teste é fictícia; vários testes garantem que ela nunca vira URL,
 * mensagem de erro nem diagnóstico.
 */
const KEY = 'AQ.chave-de-teste-nao-e-real'

const CTX: AssistantContext = {
  today: '2026-10-19',
  accounts: [{ id: 1, name: 'Nubank' }],
  categories: [],
  assets: [],
}

const CANDIDATE: AssistantCandidate = {
  kind: 'pending',
  id: 123,
  description: 'Coral Opus',
  amountCents: 75000,
  postedOn: '2026-10-12',
  accountName: 'Nubank',
  strength: 'exact',
}

const emptyTools = (over: Partial<AssistantTools> = {}): AssistantTools => ({
  searchPending: async () => [CANDIDATE],
  searchTransactions: async () => [],
  listAssets: async () => [],
  listAccounts: async () => CTX.accounts,
  ...over,
})

const REQ: ModelRequest = {
  model: 'gemini-3.8-flash',
  max_tokens: 1024,
  system: 'Você registra o que o usuário disse.',
  tools: TOOL_DEFINITIONS,
  messages: [{ role: 'user', content: 'Receita Coral Opus de R$ 750,00' }],
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/* ------------------------------------------------------------------ *
 * Pedido: formato interno → generateContent
 * ------------------------------------------------------------------ */
test('pedido: sistema, ferramentas com JSON Schema completo e modo AUTO por padrão', () => {
  const body = toGeminiBody(REQ) as {
    systemInstruction: { parts: Array<{ text: string }> }
    contents: Array<{ role: string; parts: Array<{ text?: string }> }>
    tools: Array<{ functionDeclarations: Array<{ name: string; parametersJsonSchema: unknown; parameters?: unknown }> }>
    toolConfig: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } }
    generationConfig: { maxOutputTokens: number; temperature: number; thinkingConfig?: { thinkingLevel: string } }
  }
  assert.equal(body.systemInstruction.parts[0]!.text, REQ.system)
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Receita Coral Opus de R$ 750,00' }] }])
  assert.equal(body.tools[0]!.functionDeclarations.length, TOOL_DEFINITIONS.length)
  for (const declaration of body.tools[0]!.functionDeclarations) {
    assert.ok(declaration.parametersJsonSchema, `${declaration.name} precisa do schema`)
    assert.equal(declaration.parameters, undefined, 'usa parametersJsonSchema, não o subconjunto OpenAPI')
  }
  assert.deepEqual(body.toolConfig.functionCallingConfig, { mode: 'AUTO' })
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 1024, temperature: 0, thinkingConfig: { thinkingLevel: 'low' } })
})

test('pedido: tool_choice de uma ferramenta vira modo ANY com a lista permitida', () => {
  const body = toGeminiBody({ ...REQ, tool_choice: { type: 'tool', name: 'submit_proposal' } }) as {
    toolConfig: { functionCallingConfig: unknown }
  }
  assert.deepEqual(body.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['submit_proposal'] })
})

test('pedido: tool_use vira functionCall (com a assinatura) e tool_result vira functionResponse com o nome certo', () => {
  const body = toGeminiBody({
    ...REQ,
    messages: [
      { role: 'user', content: 'frase' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'gemini_1', name: 'search_pending', input: { text: 'coral' }, signature: 'SIG123' }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'gemini_1', content: JSON.stringify([{ id: 123 }]) },
          { type: 'tool_result', tool_use_id: 'gemini_1', content: 'falhou', is_error: true },
        ],
      },
    ],
  }) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }
  assert.deepEqual(body.contents[1], {
    role: 'model',
    parts: [{ functionCall: { name: 'search_pending', args: { text: 'coral' } }, thoughtSignature: 'SIG123' }],
  })
  assert.equal(body.contents[2]!.role, 'user')
  assert.deepEqual(body.contents[2]!.parts[0], { functionResponse: { name: 'search_pending', response: { result: [{ id: 123 }] } } })
  assert.deepEqual(body.contents[2]!.parts[1], { functionResponse: { name: 'search_pending', response: { error: 'falhou' } } })
})

/* ------------------------------------------------------------------ *
 * Resposta: generateContent → formato interno
 * ------------------------------------------------------------------ */
test('resposta: functionCall vira tool_use com id estável e assinatura; texto de raciocínio é ignorado', () => {
  const res = fromGeminiResponse({
    candidates: [
      {
        content: {
          parts: [
            { text: 'pensando…', thought: true },
            { functionCall: { name: 'search_pending', args: { text: 'coral' } }, thoughtSignature: 'S1' },
            { functionCall: { name: 'list_assets', args: {} } },
            { text: 'ok' },
          ],
        },
      },
    ],
  })
  assert.deepEqual(res, {
    content: [
      { type: 'tool_use', id: 'gemini_1', name: 'search_pending', input: { text: 'coral' }, signature: 'S1' },
      { type: 'tool_use', id: 'gemini_2', name: 'list_assets', input: {} },
      { type: 'text', text: 'ok' },
    ],
    stop_reason: 'tool_use',
  })
})

test('resposta: só texto termina o turno; sem candidato (bloqueio) vira null', () => {
  assert.equal(fromGeminiResponse({ candidates: [{ content: { parts: [{ text: 'oi' }] } }] })!.stop_reason, 'end_turn')
  assert.equal(fromGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }), null)
  assert.equal(fromGeminiResponse({ candidates: [{}] }), null)
})

/* ------------------------------------------------------------------ *
 * Cliente
 * ------------------------------------------------------------------ */
test('cliente: chave só no cabeçalho x-goog-api-key, modelo na URL, nunca a chave na URL', async () => {
  let seen: { url: string; headers: Record<string, string> } | null = null
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, headers: init.headers as Record<string, string> }
    return json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
  }) as unknown as typeof fetch
  const res = await createGeminiCaller({ apiKey: KEY, fetchImpl })(REQ)
  assert.equal(res.stop_reason, 'end_turn')
  assert.match(seen!.url, /\/v1beta\/models\/gemini-3\.8-flash:generateContent$/)
  assert.ok(!seen!.url.includes(KEY), 'a chave não pode ir na URL')
  assert.equal(seen!.headers['x-goog-api-key'], KEY)
})

test('cliente: erro HTTP do Google vira diagnóstico (status e mensagem) sem a chave', async () => {
  const body = { error: { code: 400, status: 'INVALID_ARGUMENT', message: `API key not valid (${KEY}). Please pass a valid API key.` } }
  const fetchImpl = (async () => json(body, 400)) as unknown as typeof fetch
  await assert.rejects(createGeminiCaller({ apiKey: KEY, fetchImpl })(REQ), (error: unknown) => {
    const e = error as AssistantUnavailableError
    assert.equal(e.reason, 'http')
    assert.equal(e.status, 400)
    assert.match(e.detail ?? '', /INVALID_ARGUMENT/)
    assert.ok(!(e.detail ?? '').includes(KEY), 'a chave não pode aparecer no diagnóstico')
    assert.ok(!e.message.includes(KEY))
    return true
  })
})

test('cliente: 429 (limite da camada gratuita), timeout e rede viram unavailable', async () => {
  const limited = (async () => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, 429)) as unknown as typeof fetch
  await assert.rejects(createGeminiCaller({ apiKey: KEY, fetchImpl: limited })(REQ), (e: unknown) => (e as AssistantUnavailableError).status === 429)
  const down = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  await assert.rejects(createGeminiCaller({ apiKey: KEY, fetchImpl: down })(REQ), (e: unknown) => (e as AssistantUnavailableError).reason === 'network')
})

test('cliente: resposta sem candidato (bloqueio) vira bad_response, sem a chave', async () => {
  const fetchImpl = (async () => json({ promptFeedback: { blockReason: 'SAFETY' } })) as unknown as typeof fetch
  await assert.rejects(createGeminiCaller({ apiKey: KEY, fetchImpl })(REQ), (error: unknown) => {
    assert.equal((error as AssistantUnavailableError).reason, 'bad_response')
    assert.ok(!(error as Error).message.includes(KEY))
    return true
  })
})

/* ------------------------------------------------------------------ *
 * Provedor e ambiente
 * ------------------------------------------------------------------ */
test('provedor pela chave: sk-ant- é Anthropic; AQ. e AIza são Gemini', () => {
  assert.equal(providerOfKey('sk-ant-api03-abc'), 'anthropic')
  assert.equal(providerOfKey(`  sk-ant-api03-abc  `), 'anthropic')
  assert.equal(providerOfKey('AQ.ExemploFicticio123'), 'gemini')
  assert.equal(providerOfKey('AIzaSyAbc'), 'gemini')
  assert.deepEqual(DEFAULT_MODELS_BY_PROVIDER.gemini, { cheap: 'gemini-3.8-flash', strong: 'gemini-3.8-pro' })
})

test('optionsFromEnv: chave sem espaços, provedor só se válido, modelos só se vierem os dois', () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name]
  assert.deepEqual(optionsFromEnv(env({ ASSISTANT_API_KEY: `  ${KEY} \n` })), { apiKey: KEY })
  assert.deepEqual(optionsFromEnv(env({ ASSISTANT_API_KEY: KEY, ASSISTANT_PROVIDER: ' Gemini ' })), { apiKey: KEY, provider: 'gemini' })
  assert.deepEqual(optionsFromEnv(env({ ASSISTANT_API_KEY: KEY, ASSISTANT_PROVIDER: 'openai' })), { apiKey: KEY })
  assert.deepEqual(optionsFromEnv(env({ ASSISTANT_API_KEY: KEY, ASSISTANT_MODEL_CHEAP: 'a' })), { apiKey: KEY })
  assert.deepEqual(optionsFromEnv(env({ ASSISTANT_API_KEY: KEY, ASSISTANT_MODEL_CHEAP: 'a', ASSISTANT_MODEL_STRONG: 'b' })), {
    apiKey: KEY,
    models: { cheap: 'a', strong: 'b' },
  })
  assert.deepEqual(optionsFromEnv(env({})), { apiKey: undefined })
})

/* ------------------------------------------------------------------ *
 * Conversa completa com o Gemini simulado (duas rodadas: busca e proposta)
 * ------------------------------------------------------------------ */
test('Coral Opus de ponta a ponta pelo Gemini: busca a pendência e propõe data e comentário', async () => {
  const urls: string[] = []
  const bodies: Array<{ contents: unknown[] }> = []
  const script = [
    { candidates: [{ content: { parts: [{ functionCall: { name: 'search_pending', args: { text: 'coral opus', amountCents: 75000 } }, thoughtSignature: 'SIG-A' }] } }] },
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'submit_proposal',
                  args: {
                    summary: 'Achei a pendência "Coral Opus" de R$ 750,00. Vou mudar a data para 19/10/2026 e anotar "50% finais".',
                    actions: [{ type: 'update_pending', pendingId: 123, postedOn: '2026-10-19', notes: '50% finais' }],
                    questions: [],
                  },
                },
              },
            ],
          },
        },
      ],
    },
  ]
  let turn = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url)
    bodies.push(JSON.parse(String(init.body)))
    return json(script[turn++])
  }) as unknown as typeof fetch

  const result = await proposeFromText('Receita Coral Opus de R$ 750,00, 50% finais, pagamento previsto para segunda-feira dia 19.', CTX, {
    apiKey: KEY,
    tools: emptyTools(),
    callModel: createGeminiCaller({ apiKey: KEY, fetchImpl }),
    provider: 'gemini',
  })

  assert.equal(result.source, 'model')
  assert.equal(result.model, 'gemini-3.8-flash')
  assert.equal(result.escalated, false)
  assert.equal(result.modelCalls, 2)
  assert.deepEqual(result.proposal.actions, [{ type: 'update_pending', pendingId: 123, postedOn: '2026-10-19', notes: '50% finais' }])
  assert.ok(urls.every((u) => u.includes('/models/gemini-3.8-flash:generateContent')))
  // a assinatura da 1ª resposta volta junto na 2ª rodada
  assert.match(JSON.stringify(bodies[1]!.contents), /"thoughtSignature":"SIG-A"/)
  assert.match(JSON.stringify(bodies[1]!.contents), /"functionResponse":\{"name":"search_pending"/)
})

test('chave recusada pelo Gemini: proposeFromText lança unavailable com o motivo, sem a chave', async () => {
  const fetchImpl = (async () =>
    json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: `API key not valid: ${KEY}` } }, 400)) as unknown as typeof fetch
  await assert.rejects(
    proposeFromText('Gastei R$ 16,00 hoje na padaria', CTX, {
      apiKey: KEY,
      tools: emptyTools(),
      callModel: createGeminiCaller({ apiKey: KEY, fetchImpl }),
      provider: 'gemini',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AssistantUnavailableError)
      assert.equal(error.status, 400)
      assert.ok(!String(error.detail).includes(KEY))
      assert.ok(!error.message.includes(KEY))
      return true
    },
  )
})

/* ------------------------------------------------------------------ *
 * Escalada tolerante: modelo forte aposentado ou no limite não derruba o barato
 * ------------------------------------------------------------------ */
const submit = (proposal: unknown): ModelResponse => ({
  content: [{ type: 'tool_use', id: 't1', name: 'submit_proposal', input: proposal }],
  stop_reason: 'tool_use',
})

test('forte indisponível (404) depois de o barato só perguntar: vale a pergunta do barato, sem erro', async () => {
  const seenModels: string[] = []
  const callModel: ModelCaller = async (req) => {
    seenModels.push(req.model)
    if (req.model === 'modelo-barato') {
      return submit({ summary: 'Preciso de mais um dado.', actions: [], questions: ['Em qual conta foi o pix?'] })
    }
    throw new AssistantUnavailableError('O modelo respondeu com erro (HTTP 404).', 'http', 404, 'NOT_FOUND: modelo aposentado')
  }
  const result = await proposeFromText('Gastei R$ 16,00 hoje na padaria', CTX, {
    apiKey: KEY,
    tools: emptyTools(),
    callModel,
    models: { cheap: 'modelo-barato', strong: 'modelo-forte' },
  })
  assert.deepEqual(seenModels, ['modelo-barato', 'modelo-forte'])
  assert.equal(result.source, 'model')
  assert.equal(result.model, 'modelo-barato')
  assert.deepEqual(result.proposal.questions, ['Em qual conta foi o pix?'])
})

test('barato indisponível e forte também: o erro sobe (nada a aproveitar)', async () => {
  const callModel: ModelCaller = async () => {
    throw new AssistantUnavailableError('O modelo respondeu com erro (HTTP 404).', 'http', 404, 'NOT_FOUND')
  }
  await assert.rejects(
    proposeFromText('Gastei R$ 16,00 hoje na padaria', CTX, { apiKey: KEY, tools: emptyTools(), callModel, models: { cheap: 'a', strong: 'b' } }),
    (error: unknown) => error instanceof AssistantUnavailableError && error.status === 404,
  )
})

test('cliente: 503 "high demand" passageiro, tenta de novo e segue com a resposta', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return calls === 1
      ? json({ error: { status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } }, 503)
      : json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
  }) as unknown as typeof fetch
  const res = await createGeminiCaller({ apiKey: KEY, fetchImpl })(REQ)
  assert.equal(calls, 2)
  assert.equal(res.stop_reason, 'end_turn')
})

test('cliente: 503 que não passa, desiste depois de duas novas tentativas com o status', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return json({ error: { status: 'UNAVAILABLE', message: 'high demand' } }, 503)
  }) as unknown as typeof fetch
  await assert.rejects(createGeminiCaller({ apiKey: KEY, fetchImpl })(REQ), (e: unknown) => (e as AssistantUnavailableError).status === 503)
  assert.equal(calls, 3)
})

test('cliente: erro de pedido (400 sem "thinking") não tenta de novo', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return json({ error: { status: 'INVALID_ARGUMENT', message: 'bad field' } }, 400)
  }) as unknown as typeof fetch
  await assert.rejects(createGeminiCaller({ apiKey: KEY, fetchImpl })(REQ))
  assert.equal(calls, 1)
})

test('barato sobrecarregado (503): o forte responde e vale a proposta dele', async () => {
  const seenModels: string[] = []
  const callModel: ModelCaller = async (req) => {
    seenModels.push(req.model)
    if (req.model === 'modelo-barato') throw new AssistantUnavailableError('O modelo respondeu com erro (HTTP 503).', 'http', 503, 'UNAVAILABLE: high demand')
    return submit({ summary: 'Preciso de mais um dado.', actions: [], questions: ['Em qual conta foi o pix?'] })
  }
  const result = await proposeFromText('Gastei R$ 16,00 hoje na padaria', CTX, {
    apiKey: KEY,
    tools: emptyTools(),
    callModel,
    models: { cheap: 'modelo-barato', strong: 'modelo-forte' },
  })
  assert.deepEqual(seenModels, ['modelo-barato', 'modelo-forte'])
  assert.equal(result.model, 'modelo-forte')
  assert.equal(result.escalated, true)
  assert.deepEqual(result.proposal.questions, ['Em qual conta foi o pix?'])
})

test('barato e forte sobrecarregados: sobe o erro do primeiro, com o status 503', async () => {
  const callModel: ModelCaller = async (req) => {
    throw new AssistantUnavailableError('O modelo respondeu com erro (HTTP 503).', 'http', 503, `UNAVAILABLE: ${req.model}`)
  }
  await assert.rejects(
    proposeFromText('Gastei R$ 16,00 hoje na padaria', CTX, { apiKey: KEY, tools: emptyTools(), callModel, models: { cheap: 'a', strong: 'b' } }),
    (error: unknown) => error instanceof AssistantUnavailableError && error.status === 503 && /UNAVAILABLE: a/.test(error.detail ?? ''),
  )
})

test('modelo barato igual ao forte: não escala (gastaria cota à toa)', async () => {
  let calls = 0
  const callModel: ModelCaller = async () => {
    calls += 1
    return submit({ summary: 'Preciso de mais um dado.', actions: [], questions: ['Em qual conta?'] })
  }
  const result = await proposeFromText('Gastei R$ 16,00 hoje na padaria', CTX, {
    apiKey: KEY,
    tools: emptyTools(),
    callModel,
    models: { cheap: 'mesmo', strong: 'mesmo' },
  })
  assert.equal(calls, 1)
  assert.equal(result.escalated, false)
})

/* ------------------------------------------------------------------ *
 * Raciocínio baixo e nova tentativa quando o modelo não o aceita
 * ------------------------------------------------------------------ */
test('corpo sem raciocínio quando pedido (thinking: false)', () => {
  const body = toGeminiBody(REQ, { thinking: false }) as { generationConfig: Record<string, unknown> }
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 1024, temperature: 0 })
})

test('modelo que recusa thinkingLevel (400 sobre thinking): uma nova tentativa sem a opção', async () => {
  const bodies: Array<{ generationConfig: Record<string, unknown> }> = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    if (bodies.length === 1) {
      return json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Unknown name "thinkingLevel": Cannot find field.' } }, 400)
    }
    return json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
  }) as unknown as typeof fetch
  const res = await createGeminiCaller({ apiKey: KEY, fetchImpl })(REQ)
  assert.equal(res.stop_reason, 'end_turn')
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0]!.generationConfig.thinkingConfig, { thinkingLevel: 'low' })
  assert.equal(bodies[1]!.generationConfig.thinkingConfig, undefined)
})

test('400 que não é sobre thinking não repete a chamada', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid.' } }, 400)
  }) as unknown as typeof fetch
  await assert.rejects(createGeminiCaller({ apiKey: KEY, fetchImpl })(REQ), (e: unknown) => (e as AssistantUnavailableError).status === 400)
  assert.equal(calls, 1)
})

/* ------------------------------------------------------------------ *
 * Erro inesperado: o motivo aparece, sem segredo
 * ------------------------------------------------------------------ */
test('describeUnexpected: nome e mensagem, cortados em 160 e sem chave nenhuma', () => {
  const error = new TypeError(`falhou com x-goog-api-key ${KEY} e sk-ant-abc123_def e AIzaSyA1234567890123456789012 e AQ.OutraChaveDeTeste123`)
  const text = describeUnexpected(error, KEY)
  assert.match(text, /^TypeError: falhou/)
  for (const secret of [KEY, 'sk-ant-abc123_def', 'AIzaSyA1234567890123456789012', 'AQ.OutraChaveDeTeste123']) {
    assert.ok(!text.includes(secret), `não pode vazar ${secret}`)
  }
  assert.ok(text.includes('[chave]'))
  assert.ok(describeUnexpected(new Error('x'.repeat(500))).length <= 160)
  assert.equal(describeUnexpected('texto solto'), 'Erro: texto solto')
})
