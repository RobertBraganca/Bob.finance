/**
 * Mock do assistente SÓ para desenvolvimento da tela (etapa 7). Não é
 * importado em produção: `assistantApi.ts` o carrega por `import()` dentro de
 * `import.meta.env.DEV && isAssistantMockOn()`, que o build de produção
 * elimina por inteiro.
 *
 * Ligar: `localStorage.assistantMock = '1'` ou `?assistantMock=1` na URL, ou a
 * rota `/dev/assistente`. Nada aqui é dado real: nomes e valores são inventados.
 *
 * Frases de exemplo (ver `MOCK_EXAMPLES`, que a rota de desenvolvimento lista):
 *  - Coral Opus ............ uma proposta simples (data + comentário)
 *  - "luz" / ambígua ....... só perguntas, nenhuma ação
 *  - "diverge" / "lume" .... três cards com os três `flag`
 *  - "compre" + cotas ...... compra de ativo (o Desfazer é recusado)
 *  - "erro" ................ `unavailable`
 *  - "limite" .............. `rate_limited`
 *  - "offline" ............. sem conexão (TypeError, como o fetch)
 *  - "expira" .............. proposta que vence em 8 s
 */
import { ApiError } from './api'
import { date, money, quantity } from './format'
import type {
  AssistantApplyResponse,
  AssistantCard,
  AssistantMessageResponse,
  AssistantUndoResponse,
} from '@shared/assistantTypes'

export const MOCK_EXAMPLES: Array<{ label: string; text: string }> = [
  {
    label: 'Receita com data e comentário',
    text: 'Receita Coral Opus de R$ 750,00, 50% finais, pagamento previsto para segunda-feira dia 19.',
  },
  { label: 'Frase ambígua (só perguntas)', text: 'Atualiza a conta de luz para o dia 10.' },
  {
    label: 'Valor divergente e data distante',
    text: 'Projeto Lume de R$ 980,00 vai ser pago só em 15/03/2027, e lança um adiantamento de R$ 200,00 de hoje.',
  },
  { label: 'Compra de ativo', text: 'Comprei 10 cotas do Fundo Horizonte a R$ 12,50 hoje.' },
  { label: 'Erro do modelo (unavailable)', text: 'Simula erro do modelo.' },
  { label: 'Limite de mensagens', text: 'Simula o limite de mensagens.' },
  { label: 'Sem conexão', text: 'Simula ficar offline.' },
  { label: 'Proposta que expira em 8 s', text: 'Receita Atelier Cobre de R$ 300,00, quando expira esta proposta?' },
]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const DELAY_MS = 900

const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

const uuid = () => crypto.randomUUID()

type StoredProposal = {
  expiresAt: number
  cards: AssistantCard[]
  applied: Set<string>
}

type StoredUndo = { refuse: boolean; used: boolean; count: number }

const proposals = new Map<string, StoredProposal>()
const undos = new Map<string, StoredUndo>()

function fail(code: string, status: number, message: string): never {
  throw new ApiError(message, status, undefined, code)
}

function reply(
  conversationId: string | undefined,
  summary: string,
  cards: AssistantCard[],
  questions: string[],
  ttlMs = 15 * 60_000,
): AssistantMessageResponse {
  const base = { conversationId: conversationId ?? uuid(), summary, cards, questions }
  if (cards.length === 0) return base
  const proposalId = uuid()
  const expiresAt = Date.now() + ttlMs
  proposals.set(proposalId, { expiresAt, cards, applied: new Set() })
  return { ...base, proposalId, expiresAt: new Date(expiresAt).toISOString() }
}

export async function mockSendMessage(text: string, conversationId?: string): Promise<AssistantMessageResponse> {
  await sleep(DELAY_MS)
  const phrase = normalize(text)

  if (phrase.includes('offline')) throw new TypeError('Failed to fetch')
  if (phrase.includes('erro')) fail('unavailable', 503, 'modelo indisponível')
  if (phrase.includes('limite')) fail('rate_limited', 429, 'limite de mensagens')

  if (phrase.includes('coral opus')) {
    return reply(
      conversationId,
      'Achei a pendência "Coral Opus" de R$ 750,00. Vou mudar a data para segunda-feira, 19/10/2026, e anotar "50% finais".',
      [
        {
          actionId: 'a1',
          kind: 'update_pending',
          title: 'Coral Opus · pendência de receita',
          changes: [
            { field: 'postedOn', label: 'Data de pagamento', before: date('2026-10-12'), after: date('2026-10-19') },
            { field: 'notes', label: 'Comentário', before: null, after: '50% finais' },
          ],
          warnings: [],
        },
      ],
      [],
    )
  }

  if (phrase.includes('luz') || phrase.includes('ambigu')) {
    return reply(
      conversationId,
      'Encontrei mais de uma pendência parecida e não quero adivinhar.',
      [],
      [
        'Qual destas você quer ajustar: "Conta de luz · R$ 184,30 (dia 05)", "Luz da sala comercial · R$ 96,00 (dia 12)"?',
        'O dia 10 é a nova data de vencimento?',
      ],
    )
  }

  if (phrase.includes('diverg') || phrase.includes('lume')) {
    return reply(
      conversationId,
      'Montei 3 ações. Duas pedem atenção: o valor e a data não batem com o cadastro.',
      [
        {
          actionId: 'a1',
          kind: 'update_pending',
          title: 'Projeto Lume · pendência de receita',
          changes: [
            {
              field: 'amountCents',
              label: 'Valor',
              before: money(85_000),
              after: money(98_000),
              flag: 'divergent_amount',
            },
            { field: 'postedOn', label: 'Data de pagamento', before: date('2026-10-30'), after: date('2027-03-15'), flag: 'far_date' },
          ],
          warnings: ['O valor que você disse é diferente do cadastrado (R$ 850,00). Confira antes de confirmar.'],
        },
        {
          actionId: 'a2',
          kind: 'create_transaction',
          title: 'Adiantamento · novo lançamento',
          changes: [
            { field: 'description', label: 'Descrição', before: null, after: 'Adiantamento Projeto Lume', flag: 'new_record' },
            { field: 'amountCents', label: 'Valor', before: null, after: money(20_000) },
            { field: 'postedOn', label: 'Data', before: null, after: date('2026-10-19') },
            { field: 'account', label: 'Conta', before: null, after: 'Conta exemplo' },
          ],
          warnings: [],
        },
        {
          actionId: 'a3',
          kind: 'add_note',
          title: 'Comentário · Projeto Lume',
          changes: [{ field: 'notes', label: 'Comentário', before: 'Entrada paga', after: 'Entrada paga · saldo em março' }],
          warnings: [],
        },
      ],
      [],
    )
  }

  if (phrase.includes('compr') && (phrase.includes('cota') || phrase.includes('acoes') || phrase.includes('ativo'))) {
    return reply(
      conversationId,
      'Vou registrar a compra de 10 cotas do Fundo Horizonte. Não aconselho comprar nem vender: só registro o que você fez.',
      [
        {
          actionId: 'a1',
          kind: 'record_trade',
          title: 'Compra · Fundo Horizonte',
          changes: [
            { field: 'asset', label: 'Ativo', before: null, after: 'Fundo Horizonte (HRZN11)', flag: 'new_record' },
            { field: 'quantity', label: 'Quantidade', before: null, after: quantity(10) },
            { field: 'unitPriceCents', label: 'Preço unitário', before: null, after: money(1_250) },
            { field: 'total', label: 'Total', before: null, after: money(12_500) },
            { field: 'tradedOn', label: 'Data da operação', before: null, after: date('2026-10-19') },
          ],
          warnings: ['Taxas não informadas: serão gravadas como R$ 0,00.'],
        },
      ],
      [],
    )
  }

  if (phrase.includes('expira')) {
    return reply(
      conversationId,
      'Montei o lançamento. Esta proposta de teste vence em 8 segundos.',
      [
        {
          actionId: 'a1',
          kind: 'create_transaction',
          title: 'Atelier Cobre · nova receita',
          changes: [
            { field: 'description', label: 'Descrição', before: null, after: 'Atelier Cobre', flag: 'new_record' },
            { field: 'amountCents', label: 'Valor', before: null, after: money(30_000) },
            { field: 'postedOn', label: 'Data', before: null, after: date('2026-10-19') },
          ],
          warnings: [],
        },
      ],
      [],
      8_000,
    )
  }

  return reply(
    conversationId,
    'Não entendi bem o que você quer registrar.',
    [],
    ['Você quer atualizar uma pendência, lançar algo novo, registrar uma entrada do Diário ou um ativo?'],
  )
}

export async function mockApplyProposal(
  proposalId: string,
  confirmedActionIds: string[],
  edits?: Record<string, unknown>,
): Promise<AssistantApplyResponse> {
  await sleep(DELAY_MS)
  const proposal = proposals.get(proposalId)
  if (!proposal) fail('proposal_not_found', 404, 'proposta não encontrada')
  if (Date.now() > proposal.expiresAt) fail('proposal_expired', 410, 'proposta expirada')
  if (confirmedActionIds.some((id) => proposal.applied.has(id))) fail('already_applied', 409, 'já aplicada')
  const known = new Set(proposal.cards.map((card) => card.actionId))
  if (confirmedActionIds.some((id) => !known.has(id))) fail('invalid_action', 422, 'ação desconhecida')
  // Um edit sobre campo que o card não tem seria recusado de verdade.
  if (edits && Object.keys(edits).some((id) => !known.has(id))) fail('invalid_action', 422, 'edição inválida')

  confirmedActionIds.forEach((id) => proposal.applied.add(id))
  const undoToken = uuid()
  const trade = proposal.cards.some((card) => confirmedActionIds.includes(card.actionId) && card.kind === 'record_trade')
  undos.set(undoToken, { refuse: trade, used: false, count: confirmedActionIds.length })

  return {
    applied: confirmedActionIds.map((actionId, index) => ({
      actionId,
      table: proposal.cards.find((card) => card.actionId === actionId)?.kind === 'record_trade' ? 'asset_trades' : 'transactions',
      recordId: 9000 + index,
    })),
    undoToken,
    appliedAt: new Date().toISOString(),
  }
}

export async function mockUndoApplied(undoToken: string): Promise<AssistantUndoResponse> {
  await sleep(DELAY_MS / 2)
  const undo = undos.get(undoToken)
  if (!undo || undo.used) fail('proposal_not_found', 404, 'nada para desfazer')
  // Simula "o registro mudou depois": a compra do exemplo nunca pode ser desfeita.
  if (undo.refuse) fail('undo_refused', 409, 'o registro mudou depois da aplicação')
  undo.used = true
  return { undone: undo.count }
}
