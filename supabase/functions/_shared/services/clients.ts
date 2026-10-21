import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '../db/client.ts'
import {
  accounts,
  categories,
  clientContacts,
  clientPayerAliases,
  clientTransactionLinks,
  clients,
  projectQuotes,
  serviceProposalItems,
  serviceProposals,
  transactions,
} from '../db/schema.ts'
import { todayIso } from '../core/dates.ts'
import { normalizeDescription } from '../core/normalize.ts'
import { proposalTotals } from '../core/proposals.ts'
import {
  computeClientMetrics,
  matchPayer,
  quoteStatusToStage,
  summarizeClients,
  type ClientMetrics,
  type DealStage,
  type QuoteStatus,
} from '../core/deals.ts'
import { PricingError } from './pricing.ts'

/**
 * Clientes (docs/specs/clientes-e-negocios, fases 2 e 3): cadastro de lead,
 * empresa ou pessoa, com contatos, e as métricas lidas do DINHEIRO REAL.
 *
 * Uma receita é do cliente quando (1) o usuário escolheu o lançamento para ele
 * (`client_transaction_links`), (2) nasceu da aprovação de um orçamento ou de
 * uma cotação dele (`source_proposal_id` / `source_quote_id`) ou (3) o nome de
 * quem pagou, na descrição do extrato, é um dos "nomes no extrato" do cliente
 * (`client_payer_aliases`). Nessa ordem: a escolha vence o documento, que vence o nome.
 *
 * Só observa (decisions/0010): nada aqui diz em qual cliente focar. Edge: tudo
 * em sequência, nunca `Promise.all` (project-memory, 18/10/2026).
 */

export const CLIENT_KINDS = ['lead', 'company', 'person'] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]
export const CLIENT_STATUSES = ['active', 'inactive', 'archived'] as const
export type ClientStatus = (typeof CLIENT_STATUSES)[number]

export type ClientInput = {
  name: string
  kind?: ClientKind
  status?: ClientStatus
  segment?: string | null
  email?: string | null
  phone?: string | null
  document?: string | null
  website?: string | null
  source?: string | null
  description?: string | null
  isRecurring?: boolean
}

export type ContactInput = {
  name: string
  role?: string | null
  email?: string | null
  phone?: string | null
  isPrimary?: boolean
}

type ClientRecord = typeof clients.$inferSelect

const blankToNull = (value: string | null | undefined) => {
  if (value === undefined) return undefined
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code
  return code === '23505'
}

/* ------------------------------------------------------------------ *
 * Receita ligada ao cliente (o dinheiro real)
 * ------------------------------------------------------------------ */

export type LinkedRevenue = {
  id: number
  clientId: number
  postedOn: string
  description: string
  amountCents: number
  pending: boolean
  /** como o lançamento foi ligado ao cliente */
  via: 'manual' | 'proposal' | 'quote' | 'payer'
}

/**
 * Todas as receitas (entradas, não ignoradas) ligadas a algum cliente. Uma
 * leitura por fonte, em sequência; o casamento pelo nome do pagador roda em
 * memória (`matchPayer`), e só em receita de TAG de receita ou sem TAG, para uma
 * transferência entre contas próprias nunca virar receita de cliente.
 */
export async function linkedRevenue(executor: DbExecutor = db, onlyClientId?: number): Promise<LinkedRevenue[]> {
  const out: LinkedRevenue[] = []
  const seen = new Set<number>()

  const chosen = await executor
    .select({
      id: transactions.id,
      clientId: clientTransactionLinks.clientId,
      postedOn: transactions.postedOn,
      description: transactions.description,
      amountCents: transactions.amountCents,
      pending: transactions.pending,
    })
    .from(clientTransactionLinks)
    .innerJoin(transactions, eq(transactions.id, clientTransactionLinks.transactionId))
    .where(and(sql`${transactions.amountCents} > 0`, eq(transactions.ignored, false)))
  for (const r of chosen) {
    seen.add(r.id)
    out.push({ ...r, amountCents: Number(r.amountCents), via: 'manual' })
  }

  const fromProposals = await executor
    .select({
      id: transactions.id,
      clientId: serviceProposals.clientId,
      postedOn: transactions.postedOn,
      description: transactions.description,
      amountCents: transactions.amountCents,
      pending: transactions.pending,
    })
    .from(transactions)
    .innerJoin(serviceProposals, eq(serviceProposals.id, transactions.sourceProposalId))
    .where(and(sql`${transactions.amountCents} > 0`, eq(transactions.ignored, false), sql`${serviceProposals.clientId} is not null`))
  for (const r of fromProposals) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ ...r, clientId: r.clientId!, amountCents: Number(r.amountCents), via: 'proposal' })
  }

  const fromQuotes = await executor
    .select({
      id: transactions.id,
      clientId: projectQuotes.clientId,
      postedOn: transactions.postedOn,
      description: transactions.description,
      amountCents: transactions.amountCents,
      pending: transactions.pending,
    })
    .from(transactions)
    .innerJoin(projectQuotes, eq(projectQuotes.id, transactions.sourceQuoteId))
    .where(and(sql`${transactions.amountCents} > 0`, eq(transactions.ignored, false), sql`${projectQuotes.clientId} is not null`))
  for (const r of fromQuotes) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ ...r, clientId: r.clientId!, amountCents: Number(r.amountCents), via: 'quote' })
  }

  const aliases = await executor.select({ clientId: clientPayerAliases.clientId, alias: clientPayerAliases.alias }).from(clientPayerAliases)
  if (aliases.length > 0) {
    const candidates = await executor
      .select({
        id: transactions.id,
        postedOn: transactions.postedOn,
        description: transactions.description,
        descriptionNorm: transactions.descriptionNorm,
        amountCents: transactions.amountCents,
        pending: transactions.pending,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          sql`${transactions.amountCents} > 0`,
          eq(transactions.ignored, false),
          sql`(${categories.kind} = 'income' or ${transactions.categoryId} is null)`,
          sql`${transactions.sourceProposalId} is null and ${transactions.sourceQuoteId} is null`,
        ),
      )
    for (const r of candidates) {
      if (seen.has(r.id)) continue
      const clientId = matchPayer(r.descriptionNorm || normalizeDescription(r.description), aliases)
      if (clientId === null) continue
      seen.add(r.id)
      out.push({ id: r.id, clientId, postedOn: r.postedOn, description: r.description, amountCents: Number(r.amountCents), pending: r.pending, via: 'payer' })
    }
  }
  return onlyClientId === undefined ? out : out.filter((r) => r.clientId === onlyClientId)
}

/* ------------------------------------------------------------------ *
 * Negócios do cliente (cotações e orçamentos), já no estágio unificado
 * ------------------------------------------------------------------ */

export type ClientDeal = {
  kind: 'proposal' | 'quote'
  id: number
  title: string
  stage: DealStage
  valueCents: number
  updatedAt: string
}

async function dealsByClient(executor: DbExecutor, onlyClientId?: number): Promise<Map<number, ClientDeal[]>> {
  const map = new Map<number, ClientDeal[]>()
  const push = (clientId: number, deal: ClientDeal) => {
    const list = map.get(clientId)
    if (list) list.push(deal)
    else map.set(clientId, [deal])
  }
  const proposalRows = await executor
    .select()
    .from(serviceProposals)
    .where(onlyClientId === undefined ? sql`${serviceProposals.clientId} is not null` : eq(serviceProposals.clientId, onlyClientId))
  const ids = proposalRows.map((p) => p.id)
  const items = ids.length > 0 ? await executor.select().from(serviceProposalItems).where(inArray(serviceProposalItems.proposalId, ids)) : []
  const itemsBy = new Map<number, typeof items>()
  for (const item of items) {
    const list = itemsBy.get(item.proposalId)
    if (list) list.push(item)
    else itemsBy.set(item.proposalId, [item])
  }
  for (const p of proposalRows) {
    const { totalCents } = proposalTotals(itemsBy.get(p.id) ?? [], p.discountBps)
    push(p.clientId!, {
      kind: 'proposal',
      id: p.id,
      title: p.title,
      stage: p.status as DealStage,
      valueCents: p.status === 'approved' ? (p.approvedAmountCents ?? totalCents) : totalCents,
      updatedAt: p.updatedAt,
    })
  }
  const quoteRows = await executor
    .select()
    .from(projectQuotes)
    .where(onlyClientId === undefined ? sql`${projectQuotes.clientId} is not null` : eq(projectQuotes.clientId, onlyClientId))
  for (const q of quoteRows) {
    push(q.clientId!, {
      kind: 'quote',
      id: q.id,
      title: q.clientLabel,
      stage: quoteStatusToStage(q.status as QuoteStatus),
      valueCents: q.actualPriceCents ?? q.recommendedPriceCents,
      updatedAt: q.updatedAt,
    })
  }
  return map
}

function metricsFor(client: ClientRecord, revenue: LinkedRevenue[], deals: ClientDeal[], currentPeriod: string): ClientMetrics {
  const realizedByPeriod = new Map<string, number>()
  let pendingCents = 0
  let lastRevenueOn: string | null = null
  for (const r of revenue) {
    if (r.pending) {
      pendingCents += r.amountCents
      continue
    }
    const period = r.postedOn.slice(0, 7)
    realizedByPeriod.set(period, (realizedByPeriod.get(period) ?? 0) + r.amountCents)
    if (!lastRevenueOn || r.postedOn > lastRevenueOn) lastRevenueOn = r.postedOn
  }
  return computeClientMetrics({
    currentPeriod,
    flaggedRecurring: client.isRecurring,
    realizedByPeriod,
    pendingCents,
    approvedDealCents: deals.filter((d) => d.stage === 'approved').map((d) => d.valueCents),
    rejectedDeals: deals.filter((d) => d.stage === 'rejected').length,
    openPipelineCents: deals
      .filter((d) => d.stage === 'sent' || d.stage === 'negotiating' || d.stage === 'paused')
      .reduce((s, d) => s + d.valueCents, 0),
    lastRevenueOn,
  })
}

/* ------------------------------------------------------------------ *
 * Leitura
 * ------------------------------------------------------------------ */

export type ClientSummary = ClientRecord & { metrics: ClientMetrics; dealCount: number; primaryContact: { name: string; email: string | null } | null }

/** Lista com as métricas de cada cliente e o resumo da carteira. */
export async function listClients(
  filter: { q?: string; kind?: ClientKind; status?: ClientStatus; recurring?: boolean } = {},
  executor: DbExecutor = db,
) {
  const rows = await executor.select().from(clients).orderBy(asc(clients.name))
  const revenue = await linkedRevenue(executor)
  const deals = await dealsByClient(executor)
  const contacts = await executor.select().from(clientContacts).orderBy(desc(clientContacts.isPrimary), asc(clientContacts.id))
  const period = todayIso().slice(0, 7)

  const revenueBy = new Map<number, LinkedRevenue[]>()
  for (const r of revenue) {
    const list = revenueBy.get(r.clientId)
    if (list) list.push(r)
    else revenueBy.set(r.clientId, [r])
  }
  const all: ClientSummary[] = rows.map((client) => {
    const primary = contacts.find((c) => c.clientId === client.id)
    return {
      ...client,
      metrics: metricsFor(client, revenueBy.get(client.id) ?? [], deals.get(client.id) ?? [], period),
      dealCount: deals.get(client.id)?.length ?? 0,
      primaryContact: primary ? { name: primary.name, email: primary.email } : null,
    }
  })
  const overview = summarizeClients(all)

  const q = filter.q ? normalizeDescription(filter.q) : ''
  const list = all.filter(
    (c) =>
      (!filter.kind || c.kind === filter.kind) &&
      (filter.status ? c.status === filter.status : c.status !== 'archived') &&
      (filter.recurring === undefined || c.metrics.isRecurring === filter.recurring) &&
      (!q ||
        normalizeDescription(`${c.name} ${c.email ?? ''} ${c.segment ?? ''} ${c.primaryContact?.name ?? ''}`).includes(q)),
  )
  return {
    clients: list,
    overview,
    assumptions: {
      ltv: 'receita que de fato entrou: os lançamentos escolhidos para o cliente, as receitas geradas pela aprovação dos orçamentos e cotações dele e as entradas em que o nome de quem pagou é um dos "nomes no extrato" dele',
      previsto: 'o realizado mais as receitas a receber ligadas ao cliente',
      recorrente: 'marcado como recorrente, ou com receita em 3 meses diferentes ou mais, ou com 2 negócios aprovados ou mais',
      mrr: 'para cada cliente recorrente, a média da receita dos 3 últimos meses fechados',
      concentracao: 'fatia do cliente com mais receita nos últimos 12 meses fechados',
    },
  }
}

export async function getClient(id: number, executor: DbExecutor = db) {
  const client = (await executor.select().from(clients).where(eq(clients.id, id)))[0]
  if (!client) return null
  const contacts = await executor
    .select()
    .from(clientContacts)
    .where(eq(clientContacts.clientId, id))
    .orderBy(desc(clientContacts.isPrimary), asc(clientContacts.id))
  const aliases = await executor.select().from(clientPayerAliases).where(eq(clientPayerAliases.clientId, id)).orderBy(asc(clientPayerAliases.alias))
  const revenue = (await linkedRevenue(executor, id)).sort((a, b) => b.postedOn.localeCompare(a.postedOn))
  const deals = ((await dealsByClient(executor, id)).get(id) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const period = todayIso().slice(0, 7)

  const monthly = new Map<string, number>()
  for (const r of revenue) if (!r.pending) monthly.set(r.postedOn.slice(0, 7), (monthly.get(r.postedOn.slice(0, 7)) ?? 0) + r.amountCents)
  return {
    ...client,
    contacts,
    aliases,
    deals,
    revenue,
    monthlyRevenue: [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([p, cents]) => ({ period: p, cents })),
    metrics: metricsFor(client, revenue, deals, period),
  }
}

export type ClientDetail = NonNullable<Awaited<ReturnType<typeof getClient>>>

/**
 * Nomes de quem pagou que ainda não estão ligados a nenhum cliente, para o
 * usuário escolher quais são deste cliente. Ordenados por quanto pagaram; os
 * que parecem com o nome do cliente vêm primeiro.
 */
export async function payerSuggestions(id: number, executor: DbExecutor = db) {
  const client = (await executor.select().from(clients).where(eq(clients.id, id)))[0]
  if (!client) return null
  const linked = new Set((await linkedRevenue(executor)).map((r) => r.id))
  const rows = await executor
    .select({ id: transactions.id, description: transactions.description, amountCents: transactions.amountCents })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        sql`${transactions.amountCents} > 0`,
        eq(transactions.ignored, false),
        eq(transactions.pending, false),
        sql`(${categories.kind} = 'income' or ${transactions.categoryId} is null)`,
      ),
    )
  const nameTokens = normalizeDescription(client.name).split(' ').filter((t) => t.length >= 4)
  const byPayer = new Map<string, { alias: string; example: string; totalCents: number; count: number }>()
  for (const r of rows) {
    if (linked.has(r.id)) continue
    const payer = payerOf(r.description)
    if (!payer) continue
    const entry = byPayer.get(payer) ?? { alias: payer, example: r.description, totalCents: 0, count: 0 }
    entry.totalCents += Number(r.amountCents)
    entry.count += 1
    byPayer.set(payer, entry)
  }
  const looksLike = (alias: string) => nameTokens.some((t) => alias.includes(t))
  return [...byPayer.values()]
    .sort((a, b) => Number(looksLike(b.alias)) - Number(looksLike(a.alias)) || b.totalCents - a.totalCents)
    .slice(0, 12)
    .map((s) => ({ ...s, looksLikeClient: looksLike(s.alias) }))
}

/**
 * O nome de quem pagou numa descrição de Pix/TED ("Transferência Recebida|KLEBER
 * DE MELLO TRISTAO" vira "kleber de mello tristao"). No formato com traços
 * ("Transferência Recebida - NOME - CPF - BANCO - Agência ..."), o nome é só o
 * trecho logo depois do cabeçalho. Sem um separador conhecido, não há nome
 * confiável e devolve null.
 */
export function payerOf(description: string): string | null {
  const afterPipe = description.includes('|') ? description.split('|')[1] : null
  const afterDash =
    !afterPipe && /(pix recebido|transfer[eê]ncia recebida|ted recebida)[^-]*\s-\s/i.test(description)
      ? (description.split(/\s+-\s+/)[1] ?? null)
      : null
  const raw = afterPipe ?? afterDash
  if (!raw) return null
  // Tira o CPF/CNPJ e números soltos do fim ("ERICK ... 18364216724").
  const name = normalizeDescription(raw.replace(/[\d./-]{6,}/g, ' ')).trim()
  return name.length >= 3 ? name : null
}

/* ------------------------------------------------------------------ *
 * Lançamentos escolhidos à mão
 * ------------------------------------------------------------------ */

export type TransactionCandidate = {
  id: number
  postedOn: string
  description: string
  amountCents: number
  pending: boolean
  accountName: string | null
  categoryName: string | null
  /** a quem o lançamento já conta hoje, e por quê; null se não conta para ninguém */
  linkedTo: { clientId: number; clientName: string; via: LinkedRevenue['via'] } | null
}

/**
 * Entradas do extrato para escolher à mão na ficha do cliente: as mais recentes,
 * ou as que batem com a busca (descrição, sem acento nem maiúsculas). Cada uma diz
 * se já conta para algum cliente e por quê, para a tela mostrar antes de ligar.
 */
export async function transactionCandidates(
  clientId: number,
  filter: { q?: string; from?: string; to?: string; limit?: number } = {},
  executor: DbExecutor = db,
): Promise<TransactionCandidate[] | null> {
  const client = (await executor.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)))[0]
  if (!client) return null
  const q = filter.q ? normalizeDescription(filter.q) : ''
  const conditions = [sql`${transactions.amountCents} > 0`, eq(transactions.ignored, false)]
  if (q) conditions.push(sql`${transactions.descriptionNorm} like ${`%${q}%`}`)
  if (filter.from) conditions.push(sql`${transactions.postedOn} >= ${filter.from}`)
  if (filter.to) conditions.push(sql`${transactions.postedOn} <= ${filter.to}`)
  const rows = await executor
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      description: transactions.description,
      amountCents: transactions.amountCents,
      pending: transactions.pending,
      accountName: accounts.name,
      categoryName: categories.name,
    })
    .from(transactions)
    .leftJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(...conditions))
    .orderBy(desc(transactions.postedOn), desc(transactions.id))
    .limit(Math.min(100, Math.max(1, filter.limit ?? 40)))

  const linked = new Map((await linkedRevenue(executor)).map((r) => [r.id, r] as const))
  const names = new Map((await executor.select({ id: clients.id, name: clients.name }).from(clients)).map((c) => [c.id, c.name] as const))
  return rows.map((r) => {
    const hit = linked.get(r.id)
    return {
      ...r,
      amountCents: Number(r.amountCents),
      linkedTo: hit ? { clientId: hit.clientId, clientName: names.get(hit.clientId) ?? '', via: hit.via } : null,
    }
  })
}

/**
 * Liga lançamentos ao cliente. Recusa (sem gravar nada) se algum já foi escolhido
 * para OUTRO cliente: aí é preciso desligar lá antes. Só entradas não ignoradas.
 */
export async function linkTransactions(clientId: number, transactionIds: number[], executor: DbExecutor = db) {
  const ids = [...new Set(transactionIds)].filter((n) => Number.isInteger(n) && n > 0)
  if (ids.length === 0) throw new PricingError('escolha pelo menos um lançamento')
  const client = (await executor.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)))[0]
  if (!client) return null
  const found = await executor
    .select({ id: transactions.id, amountCents: transactions.amountCents, ignored: transactions.ignored })
    .from(transactions)
    .where(inArray(transactions.id, ids))
  if (found.length !== ids.length) throw new PricingError('algum lançamento escolhido não existe mais')
  if (found.some((t) => Number(t.amountCents) <= 0 || t.ignored)) throw new PricingError('só entradas (valor positivo e não ignoradas) contam como receita do cliente')

  const existing = await executor.select().from(clientTransactionLinks).where(inArray(clientTransactionLinks.transactionId, ids))
  const elsewhere = existing.filter((l) => l.clientId !== clientId)
  if (elsewhere.length > 0) {
    const other = (await executor.select({ name: clients.name }).from(clients).where(eq(clients.id, elsewhere[0]!.clientId)))[0]
    throw new PricingError(
      `${elsewhere.length === 1 ? 'um lançamento já foi escolhido' : `${elsewhere.length} lançamentos já foram escolhidos`} para ${other?.name ?? 'outro cliente'}: desligue lá antes`,
    )
  }
  const already = new Set(existing.map((l) => l.transactionId))
  const fresh = ids.filter((id) => !already.has(id))
  if (fresh.length > 0) await executor.insert(clientTransactionLinks).values(fresh.map((transactionId) => ({ clientId, transactionId })))
  return { linked: fresh.length, alreadyLinked: ids.length - fresh.length }
}

export async function unlinkTransaction(clientId: number, transactionId: number, executor: DbExecutor = db) {
  const result = await executor
    .delete(clientTransactionLinks)
    .where(and(eq(clientTransactionLinks.clientId, clientId), eq(clientTransactionLinks.transactionId, transactionId)))
  return { removed: result.count }
}

/* ------------------------------------------------------------------ *
 * Escrita
 * ------------------------------------------------------------------ */

function clientValues(input: Partial<ClientInput>) {
  return {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.segment !== undefined ? { segment: blankToNull(input.segment) } : {}),
    ...(input.email !== undefined ? { email: blankToNull(input.email)?.toLowerCase() ?? null } : {}),
    ...(input.phone !== undefined ? { phone: blankToNull(input.phone) } : {}),
    ...(input.document !== undefined ? { document: blankToNull(input.document) } : {}),
    ...(input.website !== undefined ? { website: blankToNull(input.website) } : {}),
    ...(input.source !== undefined ? { source: blankToNull(input.source) } : {}),
    ...(input.description !== undefined ? { description: blankToNull(input.description) } : {}),
    ...(input.isRecurring !== undefined ? { isRecurring: input.isRecurring } : {}),
  }
}

/**
 * Nome repetido (sem diferenciar maiúsculas) é conferido ANTES de gravar: no Postgres
 * um erro aborta a transação inteira, e a violação do índice único ficaria só como
 * última garantia (duas gravações ao mesmo tempo).
 */
async function assertNameFree(name: string, executor: DbExecutor, exceptId?: number) {
  const taken = (await executor.select({ id: clients.id }).from(clients).where(sql`lower(${clients.name}) = lower(${name.trim()})`))[0]
  if (taken && taken.id !== exceptId) throw new PricingError(`já existe um cliente chamado "${name.trim()}"`)
}

export async function createClient(input: ClientInput, executor: DbExecutor = db) {
  if (!input.name.trim()) throw new PricingError('informe o nome do cliente')
  await assertNameFree(input.name, executor)
  try {
    const row = (await executor.insert(clients).values({ name: input.name.trim(), ...clientValues(input) }).returning())[0]!
    return row
  } catch (error) {
    if (isUniqueViolation(error)) throw new PricingError(`já existe um cliente chamado "${input.name.trim()}"`)
    throw error
  }
}

export async function updateClient(id: number, patch: Partial<ClientInput>, executor: DbExecutor = db) {
  if (patch.name !== undefined && !patch.name.trim()) throw new PricingError('informe o nome do cliente')
  if (patch.name !== undefined) await assertNameFree(patch.name, executor, id)
  try {
    const row = (await executor.update(clients).set({ ...clientValues(patch), updatedAt: sql`now_iso()` }).where(eq(clients.id, id)).returning())[0]
    return row ?? null
  } catch (error) {
    if (isUniqueViolation(error)) throw new PricingError(`já existe um cliente chamado "${patch.name?.trim()}"`)
    throw error
  }
}

/**
 * Apagar um cliente desliga os documentos (cotação e orçamento continuam, com o
 * nome escrito neles) e apaga contatos e nomes no extrato. Para guardar o
 * histórico sem a pessoa na lista, arquive em vez de apagar.
 */
export async function deleteClient(id: number, executor: DbExecutor = db) {
  return { removed: (await executor.delete(clients).where(eq(clients.id, id))).count }
}

async function requireClient(id: number, executor: DbExecutor) {
  const client = (await executor.select({ id: clients.id }).from(clients).where(eq(clients.id, id)))[0]
  if (!client) throw new PricingError('cliente não encontrado')
}

/** Um contato principal por cliente: marcar um desmarca os outros. */
export async function addContact(clientId: number, input: ContactInput, executor: DbExecutor = db) {
  if (!input.name.trim()) throw new PricingError('informe o nome do contato')
  await requireClient(clientId, executor)
  return executor.transaction(async (tx) => {
    if (input.isPrimary) await tx.update(clientContacts).set({ isPrimary: false }).where(eq(clientContacts.clientId, clientId))
    return (
      await tx
        .insert(clientContacts)
        .values({
          clientId,
          name: input.name.trim(),
          role: blankToNull(input.role) ?? null,
          email: blankToNull(input.email)?.toLowerCase() ?? null,
          phone: blankToNull(input.phone) ?? null,
          isPrimary: input.isPrimary ?? false,
        })
        .returning()
    )[0]!
  })
}

export async function updateContact(clientId: number, contactId: number, patch: Partial<ContactInput>, executor: DbExecutor = db) {
  if (patch.name !== undefined && !patch.name.trim()) throw new PricingError('informe o nome do contato')
  return executor.transaction(async (tx) => {
    if (patch.isPrimary) await tx.update(clientContacts).set({ isPrimary: false }).where(eq(clientContacts.clientId, clientId))
    const row = (
      await tx
        .update(clientContacts)
        .set({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.role !== undefined ? { role: blankToNull(patch.role) } : {}),
          ...(patch.email !== undefined ? { email: blankToNull(patch.email)?.toLowerCase() ?? null } : {}),
          ...(patch.phone !== undefined ? { phone: blankToNull(patch.phone) } : {}),
          ...(patch.isPrimary !== undefined ? { isPrimary: patch.isPrimary } : {}),
        })
        .where(and(eq(clientContacts.id, contactId), eq(clientContacts.clientId, clientId)))
        .returning()
    )[0]
    return row ?? null
  })
}

export async function deleteContact(clientId: number, contactId: number, executor: DbExecutor = db) {
  const result = await executor.delete(clientContacts).where(and(eq(clientContacts.id, contactId), eq(clientContacts.clientId, clientId)))
  return { removed: result.count }
}

/** O nome é guardado normalizado, como a descrição do extrato, para o casamento ser exato. */
export async function addPayerAlias(clientId: number, alias: string, executor: DbExecutor = db) {
  const normalized = normalizeDescription(alias).trim()
  if (normalized.length < 3) throw new PricingError('o nome no extrato precisa ter pelo menos 3 letras')
  await requireClient(clientId, executor)
  const taken = (
    await executor
      .select({ clientId: clientPayerAliases.clientId, name: clients.name })
      .from(clientPayerAliases)
      .innerJoin(clients, eq(clients.id, clientPayerAliases.clientId))
      .where(eq(clientPayerAliases.alias, normalized))
  ).find((r) => r.clientId !== clientId)
  if (taken) throw new PricingError(`esse nome já está ligado a ${taken.name}`)
  const row = (
    await executor.insert(clientPayerAliases).values({ clientId, alias: normalized }).onConflictDoNothing().returning()
  )[0]
  return row ?? (await executor.select().from(clientPayerAliases).where(and(eq(clientPayerAliases.clientId, clientId), eq(clientPayerAliases.alias, normalized))))[0]!
}

export async function deletePayerAlias(clientId: number, aliasId: number, executor: DbExecutor = db) {
  const result = await executor.delete(clientPayerAliases).where(and(eq(clientPayerAliases.id, aliasId), eq(clientPayerAliases.clientId, clientId)))
  return { removed: result.count }
}
