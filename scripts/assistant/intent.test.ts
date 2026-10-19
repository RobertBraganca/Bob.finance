import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AssistantUnavailableError,
  DEFAULT_MODELS,
  TOOL_DEFINITIONS,
  createAnthropicCaller,
  isAdviceRequest,
  proposeFromText,
  type AssistantTools,
  type IntentDeps,
  type ModelCaller,
  type ModelContentBlock,
  type ModelRequest,
  type ModelResponse,
  type ModelToolResultBlock,
  type ProposeResult,
} from '../../server/src/services/assistant/intent'
import { SYSTEM_PROMPT } from '../../server/src/services/assistant/prompt'
import {
  MAX_ACTIONS_PER_PROPOSAL,
  MAX_PHRASE_LENGTH,
  assistantProposalSchema,
  type AssistantCandidate,
  type AssistantContext,
} from '../../shared/assistantTypes'

/**
 * Testes do cliente do modelo (etapa 5). NENHUMA rede: o modelo é simulado e
 * roteirizado (`scripted`), o `fetch` do cliente padrão também (`fetchImpl`).
 * Nada aqui depende de `resolveDate`/`parseMoney`: o roteiro já traz as datas e
 * os centavos que o modelo "resolveria".
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */
const CTX: AssistantContext = {
  today: '2026-10-19', // segunda-feira
  accounts: [
    { id: 1, name: 'Nubank PJ' },
    { id: 2, name: 'Itaú' },
  ],
  categories: [
    { id: 10, name: 'Alimentação', kind: 'expense' },
    { id: 11, name: 'Serviços', kind: 'income' },
    { id: 12, name: 'Moradia', kind: 'expense' },
  ],
  assets: [
    { id: 5, name: 'Petrobras PN', ticker: 'PETR4', assetClass: 'acoes' },
    { id: 6, name: 'Itaúsa PN', ticker: 'ITSA4', assetClass: 'acoes' },
    { id: 7, name: 'Reserva de emergência', ticker: null, assetClass: 'reserva' },
  ],
}

const PENDING: AssistantCandidate[] = [
  { kind: 'pending', id: 101, description: 'Coral Opus', amountCents: 75000, postedOn: '2026-10-12', accountName: 'Nubank PJ', strength: 'exact' },
  { kind: 'pending', id: 102, description: 'Aluguel da sala', amountCents: 250000, postedOn: '2026-11-05', accountName: 'Itaú', strength: 'exact' },
  { kind: 'pending', id: 103, description: 'Studio Lume', amountCents: 120000, postedOn: '2026-10-15', accountName: 'Nubank PJ', strength: 'likely' },
  { kind: 'pending', id: 104, description: 'Studio Lume', amountCents: 120000, postedOn: '2026-11-15', accountName: 'Nubank PJ', strength: 'likely' },
]

const TRANSACTIONS: AssistantCandidate[] = [
  { kind: 'transaction', id: 201, description: 'Mercado Zona Sul', amountCents: 18990, postedOn: '2026-10-17', accountName: 'Itaú', strength: 'exact' },
  { kind: 'transaction', id: 202, description: 'Uber', amountCents: 2300, postedOn: '2026-10-18', accountName: 'Itaú', strength: 'likely' },
]

function plain(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

function matching(rows: AssistantCandidate[], input: { amountCents?: number; text?: string }): AssistantCandidate[] {
  return rows
    .filter((row) => (input.amountCents === undefined ? true : row.amountCents === input.amountCents))
    .filter((row) => (input.text ? plain(row.description).includes(plain(input.text).split(' ')[0] ?? '') : true))
    .slice(0, 5)
}

/** Ferramentas falsas: devolvem as fixtures e anotam chamadas e concorrência. */
function fakeTools(over: Partial<AssistantTools> = {}) {
  const calls: string[] = []
  let inflight = 0
  let maxInflight = 0
  const track = async <T>(name: string, fn: () => T): Promise<T> => {
    calls.push(name)
    inflight += 1
    maxInflight = Math.max(maxInflight, inflight)
    await new Promise((resolve) => setTimeout(resolve, 2))
    inflight -= 1
    return fn()
  }
  const tools: AssistantTools = {
    searchPending: (input) => track('search_pending', () => matching(PENDING, input)),
    searchTransactions: (input) => track('search_transactions', () => matching(TRANSACTIONS, input)),
    listAssets: () => track('list_assets', () => CTX.assets),
    listAccounts: () => track('list_accounts', () => CTX.accounts),
    ...over,
  }
  return { tools, calls, maxInflight: () => maxInflight }
}

/* ------------------------------------------------------------------ *
 * Modelo simulado e roteirizado
 * ------------------------------------------------------------------ */
let seq = 0
const use = (name: string, input: unknown, id?: string): ModelContentBlock => ({
  type: 'tool_use',
  id: id ?? `tu_${(seq += 1)}`,
  name,
  input,
})
const reply = (...blocks: ModelContentBlock[]): ModelResponse => ({
  content: blocks,
  stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
})
const submit = (proposal: unknown): ModelResponse => reply(use('submit_proposal', proposal))
const read = (name: string, input: unknown = {}): ModelResponse => reply(use(name, input))
const onlyQuestions = (...questions: string[]): ModelResponse =>
  submit({ summary: 'Preciso de mais informação.', actions: [], questions })

function scripted(steps: ModelResponse[]) {
  const requests: ModelRequest[] = []
  const caller: ModelCaller = async (req) => {
    requests.push(req)
    const step = steps[requests.length - 1]
    if (!step) throw new Error(`roteiro acabou na chamada ${requests.length}`)
    return step
  }
  return { caller, requests }
}

type Harness = { result: ProposeResult; requests: ModelRequest[]; tools: ReturnType<typeof fakeTools> }

async function run(
  text: string,
  script: ModelResponse[],
  over: Partial<IntentDeps> = {},
  ctx: AssistantContext = CTX,
): Promise<Harness> {
  const model = scripted(script)
  const tools = fakeTools()
  const result = await proposeFromText(text, ctx, {
    apiKey: 'sk-ant-test-secret',
    callModel: model.caller,
    tools: tools.tools,
    ...over,
  })
  return { result, requests: model.requests, tools }
}

const unavailable = (reason?: string) => (error: unknown) => {
  assert.ok(error instanceof AssistantUnavailableError, 'deveria ser AssistantUnavailableError')
  assert.equal(error.code, 'unavailable')
  if (reason) assert.equal(error.reason, reason)
  assert.ok(!String(error.message).includes('sk-ant-test-secret'), 'a chave não pode aparecer no erro')
  return true
}

const toolResultsOf = (req: ModelRequest): ModelToolResultBlock[] => {
  const last = req.messages[req.messages.length - 1]
  assert.ok(last && Array.isArray(last.content))
  return last.content.filter((b): b is ModelToolResultBlock => b.type === 'tool_result')
}

/* ------------------------------------------------------------------ *
 * 1 a 17: o que o modelo propõe (frase, roteiro, resultado esperado)
 * ------------------------------------------------------------------ */
type Case = {
  name: string
  text: string
  script: ModelResponse[]
  expect: (h: Harness) => void
}

const CASES: Case[] = [
  {
    name: 'Coral Opus: acha a pendência, muda a data para segunda 19 e anota 50% finais',
    text: 'Receita Coral Opus de R$ 750,00, 50% finais, pagamento previsto para segunda-feira dia 19',
    script: [
      read('search_pending', { text: 'Coral Opus', amountCents: 75000 }),
      submit({
        summary: 'Muda o pagamento previsto de Coral Opus para 19/10 e anota 50% finais.',
        actions: [{ type: 'update_pending', pendingId: 101, postedOn: '2026-10-19', notes: '50% finais' }],
        questions: [],
      }),
    ],
    expect: ({ result, requests, tools }) => {
      assert.equal(result.source, 'model')
      assert.deepEqual(result.proposal.actions, [
        { type: 'update_pending', pendingId: 101, postedOn: '2026-10-19', notes: '50% finais' },
      ])
      assert.equal(result.model, DEFAULT_MODELS.cheap)
      assert.equal(result.escalated, false)
      assert.equal(result.modelCalls, 2)
      assert.deepEqual(tools.calls, ['search_pending'])
      // o candidato volta ao modelo como tool_result, com o id
      const results = toolResultsOf(requests[1]!)
      assert.equal(results.length, 1)
      assert.match(results[0]!.content, /"id":101/)
    },
  },
  {
    name: 'despesa pendente nova: aluguel que vence dia 5 de novembro',
    text: 'Aluguel da sala de R$ 2.500,00 vence dia 5 de novembro, pelo Itaú',
    script: [
      read('list_accounts'),
      submit({
        summary: 'Cria a despesa pendente Aluguel da sala de R$ 2.500,00 para 05/11.',
        actions: [
          { type: 'create_transaction', flow: 'expense', description: 'Aluguel da sala', amountCents: 250000, postedOn: '2026-11-05', accountId: 2, categoryId: 12, pending: true },
        ],
        questions: [],
      }),
    ],
    expect: ({ result, tools }) => {
      const [action] = result.proposal.actions
      assert.equal(action?.type, 'create_transaction')
      assert.ok(action?.type === 'create_transaction' && action.pending && action.flow === 'expense' && action.accountId === 2)
      assert.deepEqual(tools.calls, ['list_accounts'])
    },
  },
  {
    name: 'receita nova a receber: vai receber R$ 3.000,00 dia 30',
    text: 'Vou receber R$ 3.000,00 da Órbita dia 30 na conta Nubank PJ',
    script: [
      submit({
        summary: 'Cria a receita pendente Órbita de R$ 3.000,00 para 30/10.',
        actions: [
          { type: 'create_transaction', flow: 'income', description: 'Órbita', amountCents: 300000, postedOn: '2026-10-30', accountId: 1, pending: true },
        ],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      const [action] = result.proposal.actions
      assert.ok(action?.type === 'create_transaction' && action.flow === 'income' && action.amountCents === 300000)
    },
  },
  {
    name: 'entrada do Diário: gastei R$ 45,00 no almoço hoje',
    text: 'Gastei R$ 45,00 no almoço hoje, no Itaú',
    script: [
      submit({
        summary: 'Registra no Diário a despesa Almoço de R$ 45,00 em 19/10.',
        actions: [{ type: 'diary_entry', flow: 'expense', description: 'Almoço', amountCents: 4500, postedOn: '2026-10-19', accountId: 2, categoryId: 10 }],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      const [action] = result.proposal.actions
      assert.ok(action?.type === 'diary_entry' && action.categoryId === 10 && action.postedOn === '2026-10-19')
    },
  },
  {
    name: 'compra de ativo completa: 10 PETR4 a R$ 38,50 ontem',
    text: 'Comprei 10 PETR4 a R$ 38,50 ontem',
    script: [
      read('list_assets'),
      submit({
        summary: 'Registra a compra de 10 PETR4 a R$ 38,50 em 18/10.',
        actions: [{ type: 'record_trade', assetId: 5, kind: 'buy', quantity: 10, unitPriceCents: 3850, tradedOn: '2026-10-18' }],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      assert.deepEqual(result.proposal.actions, [
        { type: 'record_trade', assetId: 5, kind: 'buy', quantity: 10, unitPriceCents: 3850, tradedOn: '2026-10-18' },
      ])
    },
  },
  {
    name: 'compra incompleta (sem quantidade e preço) vira pergunta, sem ação',
    text: 'Comprei PETR4',
    script: [onlyQuestions('Quantas ações de PETR4 você comprou?', 'Qual foi o preço por ação?')],
    expect: ({ result }) => {
      assert.equal(result.proposal.actions.length, 0)
      assert.equal(result.proposal.questions.length, 2)
      // sem valor na frase: não escala para o modelo forte
      assert.equal(result.escalated, false)
      assert.equal(result.modelCalls, 1)
    },
  },
  {
    name: 'compra sem preço: "comprei 10 PETR4" pergunta o preço',
    text: 'Comprei 10 PETR4 hoje',
    script: [onlyQuestions('Qual foi o preço por ação?')],
    expect: ({ result }) => {
      assert.equal(result.proposal.actions.length, 0)
      assert.deepEqual(result.proposal.questions, ['Qual foi o preço por ação?'])
    },
  },
  {
    name: 'venda de ativo com taxa',
    text: 'Vendi 5 ITSA4 a R$ 10,20 hoje, taxa de R$ 1,50',
    script: [
      submit({
        summary: 'Registra a venda de 5 ITSA4 a R$ 10,20 em 19/10, com taxa de R$ 1,50.',
        actions: [{ type: 'record_trade', assetId: 6, kind: 'sell', quantity: 5, unitPriceCents: 1020, tradedOn: '2026-10-19', feesCents: 150 }],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      const [action] = result.proposal.actions
      assert.ok(action?.type === 'record_trade' && action.kind === 'sell' && action.feesCents === 150)
    },
  },
  {
    name: 'aporte na reserva de emergência',
    text: 'Aportei R$ 500,00 na reserva hoje',
    script: [
      submit({
        summary: 'Registra o aporte de R$ 500,00 na reserva de emergência em 19/10.',
        actions: [{ type: 'reserve_contribution', amountCents: 50000, tradedOn: '2026-10-19' }],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      assert.deepEqual(result.proposal.actions, [{ type: 'reserve_contribution', amountCents: 50000, tradedOn: '2026-10-19' }])
    },
  },
  {
    name: 'comentário em lançamento já realizado: add_note',
    text: 'No mercado de ontem, anota que foram as compras do mês',
    script: [
      read('search_transactions', { text: 'mercado', from: '2026-10-17', to: '2026-10-18' }),
      submit({
        summary: 'Anota "compras do mês" no lançamento Mercado Zona Sul.',
        actions: [{ type: 'add_note', transactionId: 201, note: 'compras do mês' }],
        questions: [],
      }),
    ],
    expect: ({ result, tools }) => {
      assert.deepEqual(result.proposal.actions, [{ type: 'add_note', transactionId: 201, note: 'compras do mês' }])
      assert.deepEqual(tools.calls, ['search_transactions'])
    },
  },
  {
    name: 'frase ambígua com 2 candidatos vira pergunta, sem ação (sem valor na frase, sem escalar)',
    text: 'Muda a data do pagamento do Studio Lume',
    script: [
      read('search_pending', { text: 'Studio Lume' }),
      onlyQuestions('Achei duas pendências de Studio Lume (15/10 e 15/11). Qual delas?'),
    ],
    expect: ({ result }) => {
      assert.equal(result.proposal.actions.length, 0)
      assert.match(result.proposal.questions[0]!, /Studio Lume/)
      assert.equal(result.escalated, false)
      assert.equal(result.modelCalls, 2)
    },
  },
  {
    name: 'frase ambígua com valor e verbo claros: escala UMA vez e aceita a pergunta do forte',
    text: 'Studio Lume de R$ 1.200,00 vai ser paga dia 20',
    script: [
      read('search_pending', { text: 'Studio Lume', amountCents: 120000 }),
      onlyQuestions('Qual das duas pendências de Studio Lume?'),
      read('search_pending', { text: 'Studio Lume', amountCents: 120000 }),
      onlyQuestions('Achei duas de Studio Lume (15/10 e 15/11). Qual delas muda para o dia 20?'),
    ],
    expect: ({ result, requests }) => {
      assert.equal(result.escalated, true)
      assert.equal(result.model, DEFAULT_MODELS.strong)
      assert.equal(result.proposal.actions.length, 0)
      assert.match(result.proposal.questions[0]!, /15\/10/)
      assert.equal(result.modelCalls, 4)
      assert.deepEqual(
        requests.map((r) => r.model),
        [DEFAULT_MODELS.cheap, DEFAULT_MODELS.cheap, DEFAULT_MODELS.strong, DEFAULT_MODELS.strong],
      )
    },
  },
  {
    name: 'escalonamento: o barato só pergunta, o forte entrega a ação',
    text: 'Recebi R$ 750,00 da Coral Opus, 50% finais, pagamento dia 19',
    script: [
      onlyQuestions('Qual pendência?'),
      read('search_pending', { text: 'Coral Opus', amountCents: 75000 }),
      submit({
        summary: 'Muda o pagamento de Coral Opus para 19/10 e anota 50% finais.',
        actions: [{ type: 'update_pending', pendingId: 101, postedOn: '2026-10-19', notes: '50% finais' }],
        questions: [],
      }),
    ],
    expect: ({ result, requests }) => {
      assert.equal(result.escalated, true)
      assert.equal(result.model, DEFAULT_MODELS.strong)
      assert.equal(result.proposal.actions.length, 1)
      assert.equal(requests[0]!.model, DEFAULT_MODELS.cheap)
      assert.equal(requests[1]!.model, DEFAULT_MODELS.strong)
      assert.equal(result.modelCalls, 3)
    },
  },
  {
    name: 'sem escalonamento quando o barato já entrega ação',
    text: 'Aportei R$ 200,00 na reserva hoje',
    script: [
      submit({
        summary: 'Registra o aporte de R$ 200,00 na reserva.',
        actions: [{ type: 'reserve_contribution', amountCents: 20000, tradedOn: '2026-10-19' }],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      assert.equal(result.escalated, false)
      assert.equal(result.modelCalls, 1)
    },
  },
  {
    name: 'o forte escala só uma vez, mesmo que também só pergunte',
    text: 'Paguei R$ 89,90 de internet ontem',
    script: [onlyQuestions('De qual conta saiu?'), onlyQuestions('De qual conta saiu o pagamento?')],
    expect: ({ result }) => {
      assert.equal(result.escalated, true)
      assert.equal(result.modelCalls, 2)
      assert.equal(result.proposal.actions.length, 0)
    },
  },
  {
    name: 'id de pendência inventado é descartado (o modelo nunca buscou o 999)',
    text: 'Atualiza a pendência do Coral Opus para o dia 19',
    script: [
      submit({
        summary: 'Muda o pagamento de Coral Opus para 19/10.',
        actions: [{ type: 'update_pending', pendingId: 999, postedOn: '2026-10-19' }],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      assert.equal(result.proposal.actions.length, 0)
      assert.equal(result.droppedActions, 1)
      assert.ok(result.proposal.questions.length >= 1)
      assert.match(result.proposal.summary, /nada será alterado/)
      assert.ok(assistantProposalSchema.safeParse(result.proposal).success)
    },
  },
  {
    name: 'ação com id válido fica e a com id inventado sai, com aviso',
    text: 'Coral Opus para o dia 19 e o aluguel para o dia 6',
    script: [
      read('search_pending', { text: 'Coral Opus' }),
      submit({
        summary: 'Muda duas datas de pagamento.',
        actions: [
          { type: 'update_pending', pendingId: 101, postedOn: '2026-10-19' },
          { type: 'update_pending', pendingId: 555, postedOn: '2026-11-06' },
        ],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      assert.deepEqual(result.proposal.actions, [{ type: 'update_pending', pendingId: 101, postedOn: '2026-10-19' }])
      assert.equal(result.droppedActions, 1)
      assert.match(result.proposal.questions.join(' '), /Ignorei uma ação/)
      assert.equal(result.proposal.summary, 'Muda duas datas de pagamento.')
    },
  },
  {
    name: 'id de transação inventado em add_note é descartado',
    text: 'Anota no mercado que foram as compras do mês',
    script: [
      read('search_transactions', { text: 'mercado' }),
      submit({ summary: 'Anota no mercado.', actions: [{ type: 'add_note', transactionId: 777, note: 'compras do mês' }], questions: [] }),
    ],
    expect: ({ result }) => {
      assert.equal(result.proposal.actions.length, 0)
      assert.equal(result.droppedActions, 1)
    },
  },
  {
    name: 'id de PENDÊNCIA usado como transactionId em add_note é descartado (tabelas diferentes)',
    text: 'Anota na pendência do aluguel que foi reajuste',
    script: [
      read('search_pending', { text: 'aluguel' }),
      submit({ summary: 'Anota reajuste.', actions: [{ type: 'add_note', transactionId: 102, note: 'reajuste' }], questions: [] }),
    ],
    expect: ({ result }) => {
      assert.equal(result.proposal.actions.length, 0)
      assert.equal(result.droppedActions, 1)
    },
  },
  {
    name: 'ativo inventado em record_trade é descartado',
    text: 'Comprei 3 ABCD3 por R$ 12,00 hoje',
    script: [
      submit({
        summary: 'Registra a compra de 3 ABCD3.',
        actions: [{ type: 'record_trade', assetId: 88, kind: 'buy', quantity: 3, unitPriceCents: 1200, tradedOn: '2026-10-19' }],
        questions: [],
      }),
      // o barato ficou só com perguntas e a frase é clara: o forte também é consultado e também inventa
      submit({
        summary: 'Registra a compra de 3 ABCD3.',
        actions: [{ type: 'record_trade', assetId: 88, kind: 'buy', quantity: 3, unitPriceCents: 1200, tradedOn: '2026-10-19' }],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      assert.equal(result.proposal.actions.length, 0)
      assert.ok(result.proposal.questions.length >= 1)
      assert.equal(result.escalated, true)
    },
  },
  {
    name: 'conta inventada em create_transaction é descartada',
    text: 'Aluguel de sala que vence dia 5, na conta Caixa',
    script: [
      submit({
        summary: 'Cria o aluguel.',
        actions: [{ type: 'create_transaction', flow: 'expense', description: 'Aluguel', amountCents: 250000, postedOn: '2026-11-05', accountId: 42, pending: true }],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      assert.equal(result.proposal.actions.length, 0)
      assert.equal(result.droppedActions, 1)
    },
  },
  {
    name: 'TAG desconhecida não derruba a ação: sai a TAG e a ação fica',
    text: 'Gastei R$ 30,00 de café hoje no Itaú',
    script: [
      submit({
        summary: 'Registra o café no Diário.',
        actions: [{ type: 'diary_entry', flow: 'expense', description: 'Café', amountCents: 3000, postedOn: '2026-10-19', accountId: 2, categoryId: 999 }],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      const [action] = result.proposal.actions
      assert.ok(action?.type === 'diary_entry' && action.categoryId === null)
      assert.equal(result.droppedActions, 0)
    },
  },
  {
    name: 'ativo do contexto é aceito sem chamar list_assets',
    text: 'Vendi 2 PETR4 a R$ 40,00 hoje',
    script: [
      submit({
        summary: 'Registra a venda de 2 PETR4.',
        actions: [{ type: 'record_trade', assetId: 5, kind: 'sell', quantity: 2, unitPriceCents: 4000, tradedOn: '2026-10-19' }],
        questions: [],
      }),
    ],
    expect: ({ result, tools }) => {
      assert.equal(result.proposal.actions.length, 1)
      assert.deepEqual(tools.calls, [])
    },
  },
  {
    name: 'proposta inválida (compra sem preço) recebe uma correção e depois passa',
    text: 'Comprei 10 PETR4 a R$ 38,50 ontem',
    script: [
      submit({
        summary: 'Registra a compra.',
        actions: [{ type: 'record_trade', assetId: 5, kind: 'buy', quantity: 10, tradedOn: '2026-10-18' }],
        questions: [],
      }),
      submit({
        summary: 'Registra a compra de 10 PETR4 a R$ 38,50.',
        actions: [{ type: 'record_trade', assetId: 5, kind: 'buy', quantity: 10, unitPriceCents: 3850, tradedOn: '2026-10-18' }],
        questions: [],
      }),
    ],
    expect: ({ result, requests }) => {
      assert.equal(result.proposal.actions.length, 1)
      assert.equal(result.modelCalls, 2)
      assert.equal(result.escalated, false)
      // a correção vai como tool_result com erro e cita o campo
      const [feedback] = toolResultsOf(requests[1]!)
      assert.equal(feedback?.is_error, true)
      assert.match(feedback!.content, /unitPriceCents/)
      // e a chamada de correção obriga a ferramenta final
      assert.deepEqual(requests[1]!.tool_choice, { type: 'tool', name: 'submit_proposal' })
    },
  },
  {
    name: 'proposta que não existe no calendário (30/02) recebe correção',
    text: 'Pagamento do Coral Opus fica para 30 de fevereiro',
    script: [
      read('search_pending', { text: 'Coral Opus' }),
      submit({ summary: 'Muda a data.', actions: [{ type: 'update_pending', pendingId: 101, postedOn: '2027-02-30' }], questions: [] }),
      onlyQuestions('Essa data não existe; qual é a data certa?'),
    ],
    expect: ({ result, requests }) => {
      assert.equal(result.proposal.actions.length, 0)
      assert.equal(result.proposal.questions.length, 1)
      const [feedback] = toolResultsOf(requests[2]!)
      assert.match(feedback!.content, /não existe no calendário/)
    },
  },
  {
    name: 'resposta só com texto (sem ferramenta) recebe um pedido e depois passa',
    text: 'Recebi R$ 100,00 de reembolso hoje',
    script: [
      reply({ type: 'text', text: 'Entendi, vou registrar.' }),
      submit({
        summary: 'Registra o reembolso de R$ 100,00 no Diário.',
        actions: [{ type: 'diary_entry', flow: 'income', description: 'Reembolso', amountCents: 10000, postedOn: '2026-10-19', accountId: 1 }],
        questions: [],
      }),
    ],
    expect: ({ result, requests }) => {
      assert.equal(result.proposal.actions.length, 1)
      assert.equal(requests[1]!.messages.at(-1)!.content, 'Responda chamando a ferramenta submit_proposal.')
    },
  },
  {
    name: 'inválida mesmo após a correção, no barato e no forte: pergunta de segurança, 4 chamadas',
    text: 'Mexe no negócio da Coral',
    script: [submit({ foo: 'bar' }), submit({ summary: '', actions: [], questions: [] }), submit({ nada: 3 }), submit({ nada: 4 })],
    expect: ({ result }) => {
      assert.equal(result.source, 'fallback')
      assert.deepEqual(result.proposal.questions, ['Não consegui entender; pode reescrever?'])
      assert.equal(result.proposal.actions.length, 0)
      assert.equal(result.modelCalls, 4)
      assert.equal(result.model, null)
      assert.equal(result.escalated, true) // falha do barato sempre dá uma chance ao forte, uma só
    },
  },
  {
    name: 'barato inválido, forte válido: vale o forte',
    text: 'Aportei R$ 300,00 na reserva ontem',
    script: [
      submit({ summary: 'x', actions: [{ type: 'reserve_contribution', amountCents: -5, tradedOn: '2026-10-18' }], questions: [] }),
      submit({ summary: 'x', actions: [{ type: 'reserve_contribution', amountCents: -5, tradedOn: '2026-10-18' }], questions: [] }),
      submit({ summary: 'Registra o aporte de R$ 300,00.', actions: [{ type: 'reserve_contribution', amountCents: 30000, tradedOn: '2026-10-18' }], questions: [] }),
    ],
    expect: ({ result }) => {
      assert.equal(result.model, DEFAULT_MODELS.strong)
      assert.deepEqual(result.proposal.actions, [{ type: 'reserve_contribution', amountCents: 30000, tradedOn: '2026-10-18' }])
    },
  },
  {
    name: 'laço excedendo 4 turnos: para na 4ª chamada (com a final obrigatória) e pergunta de segurança',
    text: 'Procura aquele pagamento',
    script: Array.from({ length: 10 }, () => read('search_pending', { text: 'Coral' })),
    expect: ({ result, requests }) => {
      // 4 do barato; o forte (barato falhou) também gasta 4: o teto vale por modelo
      assert.equal(result.source, 'fallback')
      assert.equal(result.modelCalls, 8)
      assert.equal(requests[0]!.tool_choice, undefined)
      assert.equal(requests[2]!.tool_choice, undefined)
      assert.deepEqual(requests[3]!.tool_choice, { type: 'tool', name: 'submit_proposal' })
      assert.equal(requests[4]!.model, DEFAULT_MODELS.strong)
      assert.deepEqual(requests[7]!.tool_choice, { type: 'tool', name: 'submit_proposal' })
    },
  },
  {
    name: 'mais de 5 ações: mantém as 5 primeiras e avisa',
    text: 'Gastei R$ 10,00 de café, R$ 20,00 de lanche, R$ 30,00 de pão, R$ 40,00 de leite, R$ 50,00 de fruta, R$ 60,00 de suco e R$ 70,00 de água hoje',
    script: [
      submit({
        summary: 'Registra 7 gastos no Diário.',
        actions: [10, 20, 30, 40, 50, 60, 70].map((reais, i) => ({
          type: 'diary_entry',
          flow: 'expense',
          description: `Gasto ${i + 1}`,
          amountCents: reais * 100,
          postedOn: '2026-10-19',
          accountId: 2,
        })),
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      assert.equal(result.proposal.actions.length, MAX_ACTIONS_PER_PROPOSAL)
      assert.match(result.proposal.questions.join(' '), /5 ações por vez/)
      assert.equal(result.modelCalls, 1)
      const last = result.proposal.actions.at(-1)
      assert.ok(last?.type === 'diary_entry' && last.amountCents === 5000)
    },
  },
  {
    name: 'resumo do modelo com cara de conselho é trocado pela recusa (filtro de saída)',
    text: 'Aportei R$ 400,00 hoje, e agora',
    script: [
      submit({
        summary: 'Recomendo comprar mais PETR4 com esse dinheiro.',
        actions: [{ type: 'reserve_contribution', amountCents: 40000, tradedOn: '2026-10-19' }],
        questions: [],
      }),
    ],
    expect: ({ result }) => {
      assert.equal(result.source, 'advice_filter')
      assert.equal(result.proposal.actions.length, 0)
      assert.match(result.proposal.summary, /não aconselho/)
    },
  },
]

for (const c of CASES) {
  test(c.name, async () => {
    c.expect(await run(c.text, c.script))
  })
}

/* ------------------------------------------------------------------ *
 * Filtro de conselho (antes da chamada) e o que NÃO pode ser bloqueado
 * ------------------------------------------------------------------ */
const ADVICE_PHRASES = [
  'Devo comprar PETR4?',
  'devo vender ITSA4 agora',
  'Vale a pena vender ITSA4 agora?',
  'Será que vale a pena investir em ações?',
  'O que comprar com R$ 1.000,00?',
  'O que eu devo aportar este mês',
  'Qual o melhor investimento hoje?',
  'Deveria aportar mais na reserva?',
  'É bom investir em ações agora?',
  'Seria melhor vender tudo?',
  'Onde investir esse dinheiro?',
  'Em que aportar R$ 500?',
  'Quanto devo aportar na reserva?',
  'Me recomende um fundo',
  'Você sugere comprar PETR4?',
]

for (const phrase of ADVICE_PHRASES) {
  test(`filtro de conselho recusa sem chamar o modelo: "${phrase}"`, async () => {
    const { result, requests } = await run(phrase, [])
    assert.equal(requests.length, 0)
    assert.equal(result.source, 'advice_filter')
    assert.equal(result.modelCalls, 0)
    assert.equal(result.proposal.actions.length, 0)
    assert.match(result.proposal.summary, /não aconselho/)
    assert.ok(result.proposal.questions.length >= 1)
    assert.ok(assistantProposalSchema.safeParse(result.proposal).success)
  })
}

const NOT_ADVICE = [
  'Comprei 10 PETR4 a R$ 38,50 ontem',
  'Vendi 5 ITSA4 a R$ 10,20 hoje',
  'Aporte de R$ 500,00 na reserva hoje',
  'Aportei R$ 500,00 na reserva',
  'Devo R$ 200,00 pro João, paguei hoje',
  'Paguei o que devia e investi R$ 300,00 ontem',
  'Receita Coral Opus de R$ 750,00, 50% finais, pagamento previsto para segunda-feira dia 19',
  'Resgatei R$ 1.000,00 da reserva hoje',
  'Vou comprar 10 PETR4 amanhã',
  'Gastei R$ 45,00 no almoço, o que foi bom',
]

test('"comprei", "vendi", "aporte de", "devo R$" e demais frases de registro NÃO são bloqueadas', () => {
  for (const phrase of NOT_ADVICE) {
    assert.equal(isAdviceRequest(phrase), false, `bloqueou por engano: "${phrase}"`)
  }
})

test('"comprei" e "vendi" chegam ao modelo (não passam pelo filtro de conselho)', async () => {
  for (const phrase of ['Comprei 10 PETR4 a R$ 38,50 ontem', 'Vendi 5 ITSA4 a R$ 10,20 hoje']) {
    const { requests, result } = await run(phrase, [onlyQuestions('Confirma?'), onlyQuestions('Confirma a operação?')])
    assert.ok(requests.length >= 1, `o modelo deveria ser chamado para "${phrase}"`)
    assert.notEqual(result.source, 'advice_filter')
  }
})

/* ------------------------------------------------------------------ *
 * Limites da frase
 * ------------------------------------------------------------------ */
test('frase acima do limite não chama o modelo e pede para dividir', async () => {
  const { result, requests } = await run('a'.repeat(MAX_PHRASE_LENGTH + 1), [])
  assert.equal(requests.length, 0)
  assert.equal(result.source, 'input_limit')
  assert.match(result.proposal.questions[0]!, /600/)
})

test('frase vazia ou só espaços não chama o modelo', async () => {
  const { result, requests } = await run('   ', [])
  assert.equal(requests.length, 0)
  assert.equal(result.proposal.actions.length, 0)
  assert.ok(result.proposal.questions.length >= 1)
})

test('frase no limite exato (600) ainda vai ao modelo', async () => {
  const { requests } = await run('x'.repeat(MAX_PHRASE_LENGTH), [onlyQuestions('O que você quer registrar?')])
  assert.equal(requests.length, 1)
})

/* ------------------------------------------------------------------ *
 * Erros: chave, tempo, HTTP, JSON
 * ------------------------------------------------------------------ */
test('chave ausente lança unavailable sem chamar o modelo', async () => {
  for (const apiKey of ['', '   ']) {
    const model = scripted([])
    await assert.rejects(
      proposeFromText('Comprei 10 PETR4 a R$ 38,50 ontem', CTX, { apiKey, callModel: model.caller, tools: fakeTools().tools }),
      unavailable('no_key'),
    )
    assert.equal(model.requests.length, 0)
  }
})

test('chave ausente: o filtro de conselho ainda responde (não precisa de modelo)', async () => {
  const result = await proposeFromText('Devo comprar PETR4?', CTX, { apiKey: '', tools: fakeTools().tools })
  assert.equal(result.source, 'advice_filter')
})

test('timeout do modelo (AbortError) vira unavailable', async () => {
  const caller: ModelCaller = async () => {
    throw new DOMException('tempo esgotado', 'AbortError')
  }
  await assert.rejects(
    proposeFromText('Comprei 10 PETR4 a R$ 38,50 ontem', CTX, { apiKey: 'sk-ant-test-secret', callModel: caller, tools: fakeTools().tools }),
    unavailable('timeout'),
  )
})

test('erro qualquer do chamador vira unavailable, sem repassar a mensagem original', async () => {
  const caller: ModelCaller = async () => {
    throw new Error('falha com x-api-key: sk-ant-test-secret')
  }
  await assert.rejects(
    proposeFromText('Comprei 10 PETR4 a R$ 38,50 ontem', CTX, { apiKey: 'sk-ant-test-secret', callModel: caller, tools: fakeTools().tools }),
    unavailable('network'),
  )
})

test('resposta do modelo sem lista de conteúdo (JSON quebrado) vira unavailable', async () => {
  const caller: ModelCaller = async () => ({ content: 'texto solto' }) as unknown as ModelResponse
  await assert.rejects(
    proposeFromText('Comprei 10 PETR4 a R$ 38,50 ontem', CTX, { apiKey: 'sk-ant-test-secret', callModel: caller, tools: fakeTools().tools }),
    unavailable('bad_response'),
  )
})

test('erro do modelo no meio do laço: sem retry, nada de proposta parcial', async () => {
  let calls = 0
  const caller: ModelCaller = async () => {
    calls += 1
    if (calls === 1) return read('search_pending', { text: 'Coral' })
    throw new AssistantUnavailableError('O modelo respondeu com erro (HTTP 503).', 'http', 503)
  }
  await assert.rejects(
    proposeFromText('Muda a data da Coral', CTX, { apiKey: 'sk-ant-test-secret', callModel: caller, tools: fakeTools().tools }),
    unavailable('http'),
  )
  assert.equal(calls, 2)
})

/* ---- cliente padrão (fetch simulado, sem rede) ---- */
const REQ: ModelRequest = { model: 'claude-haiku-5-5', max_tokens: 16, system: 's', tools: [], messages: [{ role: 'user', content: 'oi' }] }

test('cliente padrão: monta POST com x-api-key, anthropic-version e content-type', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 })
  }) as unknown as typeof fetch
  const res = await createAnthropicCaller({ apiKey: 'sk-ant-test-secret', fetchImpl })(REQ)
  assert.equal(res.stop_reason, 'end_turn')
  assert.equal(seen!.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(seen!.init.method, 'POST')
  const headers = seen!.init.headers as Record<string, string>
  assert.equal(headers['x-api-key'], 'sk-ant-test-secret')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['content-type'], 'application/json')
  const body = JSON.parse(String(seen!.init.body))
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'system', 'tools'])
  assert.ok(seen!.init.signal instanceof AbortSignal)
})

test('cliente padrão: HTTP 500 vira unavailable com o status, sem a chave nem o corpo', async () => {
  const fetchImpl = (async () => new Response('erro interno sk-ant-test-secret', { status: 500 })) as unknown as typeof fetch
  await assert.rejects(createAnthropicCaller({ apiKey: 'sk-ant-test-secret', fetchImpl })(REQ), (error: unknown) => {
    unavailable('http')(error)
    assert.equal((error as AssistantUnavailableError).status, 500)
    assert.match((error as Error).message, /HTTP 500/)
    assert.ok(!(error as Error).message.includes('erro interno'))
    return true
  })
})

test('cliente padrão: o corpo de erro da API vira diagnóstico (tipo e mensagem), sem a chave', async () => {
  const body = JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-test-secret' } })
  const fetchImpl = (async () => new Response(body, { status: 401 })) as unknown as typeof fetch
  await assert.rejects(createAnthropicCaller({ apiKey: 'sk-ant-test-secret', fetchImpl })(REQ), (error: unknown) => {
    const e = error as AssistantUnavailableError
    assert.equal(e.status, 401)
    assert.match(e.detail ?? '', /authentication_error/)
    assert.ok(!(e.detail ?? '').includes('sk-ant-test-secret'), 'a chave não pode aparecer no diagnóstico')
    assert.ok(!e.message.includes('sk-ant-test-secret'))
    return true
  })
})

test('cliente padrão: corpo de erro que não é JSON não vira diagnóstico', async () => {
  const fetchImpl = (async () => new Response('<html>erro sk-ant-test-secret</html>', { status: 502 })) as unknown as typeof fetch
  await assert.rejects(createAnthropicCaller({ apiKey: 'sk-ant-test-secret', fetchImpl })(REQ), (error: unknown) => {
    assert.equal((error as AssistantUnavailableError).detail, undefined)
    return true
  })
})

test('cliente padrão: 401 e 429 também viram unavailable (nada de retry)', async () => {
  for (const status of [401, 429, 529]) {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response('{}', { status })
    }) as unknown as typeof fetch
    await assert.rejects(createAnthropicCaller({ apiKey: 'sk-ant-test-secret', fetchImpl })(REQ), unavailable('http'))
    assert.equal(calls, 1)
  }
})

test('cliente padrão: timeout aborta o fetch e vira unavailable', async () => {
  let aborted = false
  const fetchImpl = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('abortado', 'AbortError'))
      })
    })) as unknown as typeof fetch
  await assert.rejects(createAnthropicCaller({ apiKey: 'sk-ant-test-secret', timeoutMs: 20, fetchImpl })(REQ), unavailable('timeout'))
  assert.equal(aborted, true)
})

test('cliente padrão: JSON quebrado e corpo sem "content" viram unavailable', async () => {
  const broken = (async () => new Response('{nao eh json', { status: 200 })) as unknown as typeof fetch
  await assert.rejects(createAnthropicCaller({ apiKey: 'sk-ant-test-secret', fetchImpl: broken })(REQ), unavailable('bad_response'))
  const noContent = (async () => new Response('{"type":"error"}', { status: 200 })) as unknown as typeof fetch
  await assert.rejects(createAnthropicCaller({ apiKey: 'sk-ant-test-secret', fetchImpl: noContent })(REQ), unavailable('bad_response'))
})

test('cliente padrão: falha de rede vira unavailable sem a mensagem original', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('fetch failed: sk-ant-test-secret')
  }) as unknown as typeof fetch
  await assert.rejects(createAnthropicCaller({ apiKey: 'sk-ant-test-secret', fetchImpl })(REQ), unavailable('network'))
})

/* ------------------------------------------------------------------ *
 * Ferramentas: só leitura, uma por vez, entrada validada
 * ------------------------------------------------------------------ */
test('as ferramentas são só de leitura mais submit_proposal: nenhuma de escrita', () => {
  assert.deepEqual(
    TOOL_DEFINITIONS.map((t) => t.name),
    ['search_pending', 'search_transactions', 'list_assets', 'list_accounts', 'submit_proposal'],
  )
  for (const tool of TOOL_DEFINITIONS) {
    assert.doesNotMatch(tool.name, /create|update|apply|write|delete|save|insert|undo/)
    assert.equal(tool.input_schema.type, 'object', `${tool.name} precisa de input_schema de objeto`)
    assert.equal('$schema' in tool.input_schema, false)
    assert.ok(tool.description.length > 20)
  }
  const search = TOOL_DEFINITIONS[0]!.input_schema.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(search).sort(), ['amountCents', 'flow', 'from', 'text', 'to'])
  const submitSchema = TOOL_DEFINITIONS[4]!.input_schema.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(submitSchema).sort(), ['actions', 'questions', 'summary'])
})

test('duas ferramentas pedidas no mesmo turno rodam uma por vez (nunca Promise.all)', async () => {
  const { tools, requests } = await run('Studio Lume e Coral Opus, qual a situação', [
    reply(use('search_pending', { text: 'Coral' }), use('search_pending', { text: 'Studio' }), use('list_accounts', {})),
    onlyQuestions('Quer mudar alguma data?'),
  ])
  assert.deepEqual(tools.calls, ['search_pending', 'search_pending', 'list_accounts'])
  assert.equal(tools.maxInflight(), 1)
  assert.equal(toolResultsOf(requests[1]!).length, 3)
})

test('entrada inválida de ferramenta volta ao modelo como erro e a consulta não roda', async () => {
  const { tools, requests, result } = await run('Procura a Coral de valor negativo', [
    read('search_pending', { amountCents: -10 }),
    onlyQuestions('Qual é o valor?'),
  ])
  assert.deepEqual(tools.calls, [])
  const [feedback] = toolResultsOf(requests[1]!)
  assert.equal(feedback?.is_error, true)
  assert.match(feedback!.content, /Entrada inválida/)
  assert.equal(result.proposal.actions.length, 0)
})

test('ferramenta desconhecida volta ao modelo como erro', async () => {
  const { requests } = await run('Apaga a Coral', [read('delete_transaction', { id: 1 }), onlyQuestions('Não apago nada; o que você quer registrar?')])
  const [feedback] = toolResultsOf(requests[1]!)
  assert.equal(feedback?.is_error, true)
  assert.match(feedback!.content, /desconhecida/)
})

test('erro de banco numa ferramenta sobe como veio (não vira unavailable)', async () => {
  const boom = new Error('conexão com o banco caiu')
  const tools = fakeTools({
    searchPending: async () => {
      throw boom
    },
  })
  const model = scripted([read('search_pending', { text: 'Coral' })])
  await assert.rejects(
    proposeFromText('Muda a data da Coral', CTX, { apiKey: 'sk-ant-test-secret', callModel: model.caller, tools: tools.tools }),
    (error) => error === boom,
  )
})

test('no máximo 5 candidatos voltam ao modelo, mesmo que a ferramenta devolva mais', async () => {
  const many: AssistantCandidate[] = Array.from({ length: 9 }, (_, i) => ({ ...PENDING[0]!, id: 300 + i }))
  const tools = fakeTools({ searchPending: async () => many })
  const model = scripted([read('search_pending', { text: 'Coral' }), onlyQuestions('Qual delas?')])
  await proposeFromText('Muda a Coral', CTX, { apiKey: 'sk-ant-test-secret', callModel: model.caller, tools: tools.tools })
  const [out] = toolResultsOf(model.requests[1]!)
  assert.equal(JSON.parse(out!.content).candidatos.length, 5)
})

test('id visto na ferramenta numa chamada vale no submit; id do 6º candidato cortado não vale', async () => {
  const many: AssistantCandidate[] = Array.from({ length: 6 }, (_, i) => ({ ...PENDING[0]!, id: 300 + i }))
  const tools = fakeTools({ searchPending: async () => many })
  const model = scripted([
    read('search_pending', { text: 'Coral' }),
    submit({
      summary: 'Muda duas.',
      actions: [
        { type: 'update_pending', pendingId: 300, postedOn: '2026-10-19' },
        { type: 'update_pending', pendingId: 305, postedOn: '2026-10-19' },
      ],
      questions: [],
    }),
  ])
  const result = await proposeFromText('Muda as da Coral', CTX, { apiKey: 'sk-ant-test-secret', callModel: model.caller, tools: tools.tools })
  assert.deepEqual(result.proposal.actions.map((a) => (a.type === 'update_pending' ? a.pendingId : 0)), [300])
  assert.equal(result.droppedActions, 1)
})

/* ------------------------------------------------------------------ *
 * Requisição ao modelo: prompt, contexto, modelos
 * ------------------------------------------------------------------ */
test('o primeiro pedido leva sistema, ferramentas e contexto com a data e o dia da semana', async () => {
  const { requests } = await run('Comprei PETR4', [onlyQuestions('Quantas?')])
  const req = requests[0]!
  assert.equal(req.system, SYSTEM_PROMPT)
  assert.equal(req.tools, TOOL_DEFINITIONS)
  assert.equal(req.model, 'claude-haiku-5-5')
  assert.ok(req.max_tokens > 0)
  const first = req.messages[0]!
  assert.equal(first.role, 'user')
  const text = String(first.content)
  assert.match(text, /"hoje":"2026-10-19"/)
  assert.match(text, /segunda-feira/)
  assert.match(text, /2026-10-23 sexta-feira/)
  assert.match(text, /<frase>\nComprei PETR4\n<\/frase>/)
  // o que vai ao modelo: contas, TAGs e ativos; nada de saldo ou extrato
  assert.match(text, /Nubank PJ/)
  assert.doesNotMatch(text, /saldo|balance|extrato/i)
  // a frase do usuário nunca entra no prompt do sistema
  assert.ok(!req.system.includes('Comprei PETR4'))
})

test('o prompt do sistema traz as regras e os 3 exemplos, sem travessão', () => {
  assert.match(SYSTEM_PROMPT, /nunca aconselha|Você nunca aconselha/)
  assert.match(SYSTEM_PROMPT, /Nunca invente ids/)
  assert.match(SYSTEM_PROMPT, /quantidade e preço/)
  assert.match(SYSTEM_PROMPT, /Coral Opus/)
  assert.match(SYSTEM_PROMPT, /"postedOn":"2026-10-19"/)
  assert.match(SYSTEM_PROMPT, /"notes":"50% finais"/)
  assert.equal((SYSTEM_PROMPT.match(/^Exemplo \d$/gm) ?? []).length, 3)
  assert.ok(!SYSTEM_PROMPT.includes('—'), 'decisions/0007: sem travessão')
})

test('modelos configuráveis: o barato e o forte vêm de deps.models', async () => {
  const models = { cheap: 'modelo-barato-x', strong: 'modelo-forte-y' }
  const { requests, result } = await run(
    'Paguei R$ 89,90 de internet ontem',
    [onlyQuestions('De qual conta?'), onlyQuestions('De qual conta saiu?')],
    { models },
  )
  assert.deepEqual(requests.map((r) => r.model), ['modelo-barato-x', 'modelo-forte-y'])
  assert.equal(result.model, 'modelo-forte-y')
})

test('o histórico cresce corretamente: assistant(tool_use) seguido de user(tool_result) com o mesmo id', async () => {
  const { requests } = await run('Muda a Coral Opus para o dia 19', [
    reply(use('search_pending', { text: 'Coral Opus' }, 'toolu_abc')),
    onlyQuestions('Confirma o dia 19?'),
  ])
  const msgs = requests[1]!.messages
  assert.equal(msgs.length, 3)
  assert.equal(msgs[1]!.role, 'assistant')
  assert.equal(msgs[2]!.role, 'user')
  const [out] = toolResultsOf(requests[1]!)
  assert.equal(out!.tool_use_id, 'toolu_abc')
  // a primeira requisição não foi alterada depois (cópia, não referência)
  assert.equal(requests[0]!.messages.length, 1)
})

test('a proposta final sempre passa no schema do contrato', async () => {
  for (const c of CASES) {
    const { result } = await run(c.text, c.script)
    assert.ok(assistantProposalSchema.safeParse(result.proposal).success, c.name)
  }
})
