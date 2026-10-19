import { and, desc, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm'
import { db, type DbExecutor } from '../../db/client.ts'
import { accounts, assets, categories, transactions } from '../../db/schema.ts'
import { normalizeDescription } from '../../core/normalize.ts'
import { scoreCandidate } from '../../core/assistant.ts'
import type { AssistantCandidate, AssistantContext, MatchStrength } from '../../core/assistantTypes.ts'
import { listPending } from '../cashFlow.ts'

/**
 * Leitura e casamento para as ferramentas do modelo (docs/specs/assistente, A.3).
 * Só LÊ. O casamento (valor, texto normalizado, janela de data) é feito aqui, por
 * código, via `scoreCandidate`; o modelo só escolhe entre os candidatos ou pergunta.
 *
 * Valores dos candidatos vêm COM SINAL, como no banco (despesa negativa, receita
 * positiva): é assim que o modelo distingue um do outro. As ações de volta
 * (`update_pending.amountCents` etc.) continuam positivas; o sinal vem do registro.
 *
 * Edge: tudo em sequência, nunca `Promise.all` de consultas (project-memory, 18/10/2026).
 */

export const MAX_CANDIDATES = 5

export type MatchQuery = {
  /** valor em centavos, positivo (o sinal não entra na busca) */
  amountCents?: number
  text?: string
  /** janela de datas, AAAA-MM-DD, inclusive */
  from?: string
  to?: string
  flow?: 'income' | 'expense'
}

const STRENGTH_RANK: Record<MatchStrength, number> = { exact: 0, likely: 1, weak: 2 }

/** Palavras da busca com 3+ letras, já normalizadas, sem curinga de LIKE. */
function textTokens(text: string | undefined): string[] {
  if (!text) return []
  const tokens = normalizeDescription(text)
    .split(/\s+/)
    .map((t) => t.replace(/[%_\\]/g, ''))
    .filter((t) => t.length >= 3)
  return [...new Set(tokens)]
}

/** Meio da janela (ou a ponta que existir): a data que o `scoreCandidate` compara. */
function referenceDate(query: MatchQuery): string | undefined {
  if (query.from && query.to) {
    const mid = (Date.parse(`${query.from}T00:00:00Z`) + Date.parse(`${query.to}T00:00:00Z`)) / 2
    return new Date(Math.round(mid)).toISOString().slice(0, 10)
  }
  return query.from ?? query.to
}

function dayDistance(a: string, b: string | undefined): number {
  if (!b) return 0
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000
}

/**
 * Com valor ou texto na busca, só entra quem bate em um dos dois: sem isso toda
 * linha da janela viraria candidata "fraca" e afogaria o que importa.
 */
function isRelevant(query: MatchQuery, row: { amountCents: number; description: string }): boolean {
  const tokens = textTokens(query.text)
  if (query.amountCents === undefined && tokens.length === 0) return true
  if (query.amountCents !== undefined && Math.abs(row.amountCents) === query.amountCents) return true
  const norm = normalizeDescription(row.description)
  return tokens.some((t) => norm.includes(t))
}

type Row = { id: number; description: string; amountCents: number; postedOn: string; accountName: string }

function toCandidates(kind: AssistantCandidate['kind'], query: MatchQuery, rows: Row[]): AssistantCandidate[] {
  const date = referenceDate(query)
  return rows
    .filter((row) => isRelevant(query, row))
    .map((row) => {
      const strength = scoreCandidate(
        { amountCents: query.amountCents, text: query.text, date },
        // Valor sem sinal dos dois lados: a busca nunca carrega o sinal.
        { amountCents: Math.abs(row.amountCents), description: row.description, postedOn: row.postedOn },
      )
      const candidate: AssistantCandidate = {
        kind,
        id: row.id,
        description: row.description,
        amountCents: row.amountCents,
        postedOn: row.postedOn,
        accountName: row.accountName,
        strength,
      }
      return { candidate, distance: dayDistance(row.postedOn, date) }
    })
    .sort(
      (a, b) =>
        STRENGTH_RANK[a.candidate.strength] - STRENGTH_RANK[b.candidate.strength] ||
        a.distance - b.distance ||
        a.candidate.postedOn.localeCompare(b.candidate.postedOn) ||
        a.candidate.id - b.candidate.id,
    )
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.candidate)
}

/** Pendências (a receber/a pagar) que combinam com a frase, até 5, das mais fortes às mais fracas. */
export async function searchPending(query: MatchQuery): Promise<AssistantCandidate[]> {
  const flows: Array<'income' | 'expense'> = query.flow ? [query.flow] : ['income', 'expense']
  const rows: Row[] = []
  // Em sequência: nada de Promise.all no Edge.
  for (const flow of flows) {
    for (const p of await listPending(flow)) {
      if (query.from && p.postedOn < query.from) continue
      if (query.to && p.postedOn > query.to) continue
      rows.push({ id: p.id, description: p.description, amountCents: p.amountCents, postedOn: p.postedOn, accountName: p.accountName })
    }
  }
  return toCandidates('pending', query, rows)
}

/** Lançamentos já realizados (fora as pendências e os ocultos) que combinam com a frase, até 5. */
export async function searchTransactions(query: MatchQuery, executor: DbExecutor = db): Promise<AssistantCandidate[]> {
  const parts: SQL[] = [eq(transactions.pending, false), eq(transactions.hidden, false)]
  if (query.from) parts.push(gte(transactions.postedOn, query.from))
  if (query.to) parts.push(lte(transactions.postedOn, query.to))
  if (query.flow) parts.push(eq(transactions.direction, query.flow === 'income' ? 'in' : 'out'))

  const tokens = textTokens(query.text)
  const relevance: SQL[] = []
  if (query.amountCents !== undefined) relevance.push(sql`abs(${transactions.amountCents}) = ${query.amountCents}`)
  for (const t of tokens) relevance.push(sql`${transactions.descriptionNorm} like ${`%${t}%`}`)
  if (relevance.length > 0) parts.push(or(...relevance)!)

  const rows = await executor
    .select({
      id: transactions.id,
      description: transactions.description,
      amountCents: transactions.amountCents,
      postedOn: transactions.postedOn,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(...parts))
    .orderBy(desc(transactions.postedOn), desc(transactions.id))
    .limit(300)
  return toCandidates('transaction', query, rows)
}

/**
 * Contexto mínimo que vai ao modelo (spec B.5): contas, TAGs e ativos não
 * arquivados. SEM saldos, SEM cartões (nem as contas do tipo cartão de crédito)
 * e sem o extrato.
 */
export async function listContext(today: string, executor: DbExecutor = db): Promise<AssistantContext> {
  const accountRows = await executor
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.archived, false), inArray(accounts.kind, ['checking', 'savings', 'investment', 'cash', 'loan'])))
    .orderBy(accounts.name)
  const categoryRows = await executor
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(eq(categories.archived, false))
    .orderBy(categories.sortOrder, categories.name)
  const assetRows = await executor
    .select({ id: assets.id, name: assets.name, ticker: assets.ticker, assetClass: assets.assetClass })
    .from(assets)
    .where(eq(assets.archived, false))
    .orderBy(assets.name)
  return { today, accounts: accountRows, categories: categoryRows, assets: assetRows }
}
