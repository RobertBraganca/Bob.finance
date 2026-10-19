import type { MatchStrength } from './assistantTypes.ts'

/**
 * Funções puras do assistente (sem banco e sem rede), compartilhadas entre o
 * servidor Node e as Edge Functions. ESQUELETO: as assinaturas abaixo são o
 * contrato; os corpos são implementados na etapa 1 do plano
 * (docs/specs/assistente/plan.md) e cobertos por scripts/assistant/core.test.ts.
 */

export type ResolvedDate = {
  /** AAAA-MM-DD, ou null quando não deu para resolver com segurança */
  date: string | null
  /** pergunta em português quando a frase é ambígua ou o dia da semana não bate */
  question?: string
}

/**
 * "segunda dia 19", "dia 19", "amanhã", "sexta", "19/10", "2026-10-19".
 * `today` é a data de hoje em America/Sao_Paulo. Se a frase cita dia da semana E
 * dia do mês e os dois não coincidem em nenhuma data próxima, devolve pergunta.
 */
export function resolveDate(_text: string, _today: string): ResolvedDate {
  throw new Error('resolveDate: não implementado')
}

/** "R$ 750,00", "750", "1.250,50", "750.00", "R$750": centavos, ou null. */
export function parseMoney(_text: string): number | null {
  throw new Error('parseMoney: não implementado')
}

/**
 * Força do casamento entre o que a frase diz e uma linha do banco: valor igual
 * (peso maior), texto normalizado (`normalizeDescription`) e distância de data.
 * Campos ausentes na busca não pesam.
 */
export function scoreCandidate(
  _query: { amountCents?: number; text?: string; date?: string },
  _row: { amountCents: number; description: string; postedOn: string },
): MatchStrength {
  throw new Error('scoreCandidate: não implementado')
}
