import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { proposalIssuerSettings, projectQuotes, serviceProposalItems, serviceProposals, transactions } from '../db/schema.ts'
import { addMonthsToDate } from '../core/dates.ts'
import { formatProposalNumber, proposalTotals, proposalValidUntil, splitProposalInstallments } from '../core/proposals.ts'
import { createTransaction } from './transactions.ts'
import { PricingError } from './pricing.ts'

/**
 * Orçamentos de serviço (decisions/0040, specs/service-proposals).
 *
 * O documento que vai ao cliente: título, cliente, serviços com preço e
 * quantidade, desconto e condições. Separado da cotação (`project_quotes`),
 * que continua sendo a calculadora; um item pode nascer dela, mas não fica
 * preso a ela. Totais sempre derivados dos itens (`core/proposals`); só a
 * aprovação congela o valor, e é ele que vira as receitas a receber.
 */

export const PROPOSAL_STATUSES = ['draft', 'sent', 'approved', 'rejected'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]
/** O que dá para escolher direto; `approved` só pela aprovação, que pede conta e data. */
export const EDITABLE_STATUSES = ['draft', 'sent', 'rejected'] as const
export type EditableStatus = (typeof EDITABLE_STATUSES)[number]

export const PROPOSAL_SORTS = ['recent', 'oldest', 'value_desc', 'value_asc'] as const
export type ProposalSort = (typeof PROPOSAL_SORTS)[number]

export type ProposalItemInput = {
  title: string
  description?: string | null
  unitPriceCents: number
  quantity: number
  sourceQuoteId?: number | null
}

export type ProposalInput = {
  title: string
  clientLabel: string
  status?: EditableStatus
  discountBps?: number
  validityDays?: number
  installments?: number
  paymentTerms?: string | null
  deliveryTerms?: string | null
  notes?: string | null
  items: ProposalItemInput[]
}

export type ProposalPatch = Partial<ProposalInput>

type ProposalRecord = typeof serviceProposals.$inferSelect
type ItemRecord = typeof serviceProposalItems.$inferSelect

function summarize(proposal: ProposalRecord, items: ItemRecord[]) {
  const totals = proposalTotals(items, proposal.discountBps)
  return {
    id: proposal.id,
    number: proposal.number,
    numberLabel: formatProposalNumber(proposal.number),
    title: proposal.title,
    clientLabel: proposal.clientLabel,
    status: proposal.status as ProposalStatus,
    discountBps: proposal.discountBps,
    validityDays: proposal.validityDays,
    validUntil: proposalValidUntil(proposal.createdAt, proposal.validityDays),
    installments: proposal.installments,
    paymentTerms: proposal.paymentTerms,
    deliveryTerms: proposal.deliveryTerms,
    notes: proposal.notes,
    sentAt: proposal.sentAt,
    approvedAmountCents: proposal.approvedAmountCents,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    ...totals,
  }
}

export type ProposalSummary = ReturnType<typeof summarize>

async function itemsFor(ids: number[]): Promise<Map<number, ItemRecord[]>> {
  const map = new Map<number, ItemRecord[]>()
  if (ids.length === 0) return map
  for (const item of await db
    .select()
    .from(serviceProposalItems)
    .where(inArray(serviceProposalItems.proposalId, ids))
    .orderBy(asc(serviceProposalItems.sortOrder), asc(serviceProposalItems.id))) {
    map.set(item.proposalId, [...(map.get(item.proposalId) ?? []), item])
  }
  return map
}

/* ------------------------------------------------------------------ *
 * Leitura
 * ------------------------------------------------------------------ */
export async function listProposals(filter: { q?: string; statuses?: ProposalStatus[]; sort?: ProposalSort } = {}) {
  const parts = []
  if (filter.statuses && filter.statuses.length > 0) parts.push(inArray(serviceProposals.status, filter.statuses))
  const q = filter.q?.trim()
  if (q) {
    const like = `%${q}%`
    parts.push(sql`(${serviceProposals.title} ilike ${like} or ${serviceProposals.clientLabel} ilike ${like})`)
  }
  const rows = await db
    .select()
    .from(serviceProposals)
    .where(parts.length > 0 ? and(...parts) : undefined)
  const items = await itemsFor(rows.map((r) => r.id))
  const list = rows.map((r) => summarize(r, items.get(r.id) ?? []))

  const sort = filter.sort ?? 'recent'
  list.sort((a, b) =>
    sort === 'oldest'
      ? a.createdAt.localeCompare(b.createdAt)
      : sort === 'value_desc'
        ? b.totalCents - a.totalCents
        : sort === 'value_asc'
          ? a.totalCents - b.totalCents
          : b.updatedAt.localeCompare(a.updatedAt),
  )

  const [{ drafts } = { drafts: 0 }] = await db
    .select({ drafts: sql<number>`count(*)::int` })
    .from(serviceProposals)
    .where(eq(serviceProposals.status, 'draft'))
  return { proposals: list, draftCount: Number(drafts) }
}

/**
 * Os três números da lista: quanto está esperando resposta do cliente, quanto
 * foi aprovado entre os orçamentos criados no ano, e a taxa de aprovação
 * entre os que já tiveram resposta.
 */
export async function proposalsSummary() {
  const rows = await db.select().from(serviceProposals)
  const items = await itemsFor(rows.map((r) => r.id))
  const year = new Date().getFullYear().toString()
  let awaitingCents = 0
  let awaitingCount = 0
  let approvedYearCents = 0
  let approved = 0
  let rejected = 0
  for (const r of rows) {
    const { totalCents } = proposalTotals(items.get(r.id) ?? [], r.discountBps)
    if (r.status === 'sent') {
      awaitingCents += totalCents
      awaitingCount++
    }
    if (r.status === 'approved') {
      approved++
      if (r.createdAt.startsWith(year)) approvedYearCents += r.approvedAmountCents ?? totalCents
    }
    if (r.status === 'rejected') rejected++
  }
  return {
    awaitingCents,
    awaitingCount,
    approvedYearCents,
    year: Number(year),
    approvalRateBps: approved + rejected > 0 ? Math.round((approved / (approved + rejected)) * 10_000) : null,
    decidedCount: approved + rejected,
  }
}

export async function getProposal(id: number) {
  const proposal = (await db.select().from(serviceProposals).where(eq(serviceProposals.id, id)))[0]
  if (!proposal) return null
  const items = (await itemsFor([id])).get(id) ?? []
  const receivables = await db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      description: transactions.description,
      amountCents: transactions.amountCents,
      pending: transactions.pending,
    })
    .from(transactions)
    .where(eq(transactions.sourceProposalId, id))
    .orderBy(asc(transactions.postedOn))
  return {
    ...summarize(proposal, items),
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      sourceQuoteId: item.sourceQuoteId,
    })),
    receivables,
  }
}

export type ProposalDetail = NonNullable<Awaited<ReturnType<typeof getProposal>>>

/* ------------------------------------------------------------------ *
 * Escrita
 * ------------------------------------------------------------------ */
function validateItems(items: ProposalItemInput[]) {
  for (const item of items) {
    if (!item.title.trim()) throw new PricingError('todo serviço precisa de um título')
    if (item.unitPriceCents < 0) throw new PricingError('o preço de um serviço não pode ser negativo')
    if (!(item.quantity > 0)) throw new PricingError('a quantidade de um serviço precisa ser maior que zero')
  }
}

async function replaceItems(proposalId: number, items: ProposalItemInput[]) {
  validateItems(items)
  await db.delete(serviceProposalItems).where(eq(serviceProposalItems.proposalId, proposalId))
  if (items.length === 0) return
  await db.insert(serviceProposalItems).values(
    items.map((item, index) => ({
      proposalId,
      title: item.title.trim(),
      description: item.description?.trim() || null,
      unitPriceCents: Math.round(item.unitPriceCents),
      quantity: item.quantity,
      sortOrder: index,
      sourceQuoteId: item.sourceQuoteId ?? null,
    })),
  )
}

async function defaultValidityDays(): Promise<number> {
  const row = (await db.select().from(proposalIssuerSettings).where(eq(proposalIssuerSettings.id, 1)))[0]
  return row?.defaultValidityDays ?? 15
}

export async function createProposal(input: ProposalInput) {
  if (!input.title.trim()) throw new PricingError('informe o título do orçamento')
  if (!input.clientLabel.trim()) throw new PricingError('informe o cliente')
  validateItems(input.items)
  const status = input.status ?? 'draft'
  if (status === 'sent' && input.items.length === 0) throw new PricingError('inclua pelo menos um serviço para enviar')

  const row = (
    await db
      .insert(serviceProposals)
      .values({
        title: input.title.trim(),
        clientLabel: input.clientLabel.trim(),
        status,
        discountBps: input.discountBps ?? 0,
        validityDays: input.validityDays ?? (await defaultValidityDays()),
        installments: input.installments ?? 1,
        paymentTerms: input.paymentTerms ?? null,
        deliveryTerms: input.deliveryTerms ?? null,
        notes: input.notes ?? null,
        sentAt: status === 'sent' ? new Date().toISOString() : null,
      })
      .returning()
  )[0]!
  await replaceItems(row.id, input.items)
  return getProposal(row.id)
}

/**
 * Edita campos e, se vier, substitui a lista de serviços. Com o orçamento
 * aprovado, serviços e desconto ficam travados (são o que virou receita);
 * condições, prazo e observações continuam editáveis, como nas cotações
 * (decisions/0021). Status, se vier, passa por `setProposalStatus`.
 */
export async function updateProposal(id: number, patch: ProposalPatch) {
  const current = (await db.select().from(serviceProposals).where(eq(serviceProposals.id, id)))[0]
  if (!current) return null

  if (current.status === 'approved') {
    if (patch.items !== undefined) {
      throw new PricingError('orçamento aprovado: volte o status para editar os serviços')
    }
    if (patch.discountBps !== undefined && patch.discountBps !== current.discountBps) {
      throw new PricingError('orçamento aprovado: volte o status para mudar o desconto')
    }
  }
  if (patch.title !== undefined && !patch.title.trim()) throw new PricingError('informe o título do orçamento')
  if (patch.clientLabel !== undefined && !patch.clientLabel.trim()) throw new PricingError('informe o cliente')

  await db
    .update(serviceProposals)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.clientLabel !== undefined ? { clientLabel: patch.clientLabel.trim() } : {}),
      ...(patch.discountBps !== undefined ? { discountBps: patch.discountBps } : {}),
      ...(patch.validityDays !== undefined ? { validityDays: patch.validityDays } : {}),
      ...(patch.installments !== undefined ? { installments: patch.installments } : {}),
      ...(patch.paymentTerms !== undefined ? { paymentTerms: patch.paymentTerms } : {}),
      ...(patch.deliveryTerms !== undefined ? { deliveryTerms: patch.deliveryTerms } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      updatedAt: sql`now_iso()`,
    })
    .where(eq(serviceProposals.id, id))
  if (patch.items !== undefined) await replaceItems(id, patch.items)
  if (patch.status !== undefined && patch.status !== current.status) await setProposalStatus(id, patch.status)
  return getProposal(id)
}

/**
 * Antes de tirar de aprovado ou excluir: as receitas que ainda estão
 * pendentes saem; se alguma já foi recebida (confirmada), recusa e diz qual,
 * porque apagar ali mexeria num valor que já entrou na conta.
 */
async function releaseReceivables(id: number) {
  const rows = await db
    .select({ id: transactions.id, postedOn: transactions.postedOn, pending: transactions.pending })
    .from(transactions)
    .where(eq(transactions.sourceProposalId, id))
  const received = rows.filter((r) => !r.pending)
  if (received.length > 0) {
    const dates = received.map((r) => `${r.postedOn.slice(8, 10)}/${r.postedOn.slice(5, 7)}`).join(', ')
    throw new PricingError(
      `${received.length === 1 ? 'uma receita deste orçamento já foi recebida' : `${received.length} receitas deste orçamento já foram recebidas`} (${dates}): ajuste ou exclua em Lançamentos antes`,
    )
  }
  if (rows.length > 0) {
    await db.delete(transactions).where(and(eq(transactions.sourceProposalId, id), eq(transactions.pending, true)))
  }
}

export async function setProposalStatus(id: number, status: EditableStatus) {
  const current = (await db.select().from(serviceProposals).where(eq(serviceProposals.id, id)))[0]
  if (!current) return null
  if (current.status === status) return getProposal(id)

  if (status === 'sent') {
    const items = (await itemsFor([id])).get(id) ?? []
    if (items.length === 0) throw new PricingError('inclua pelo menos um serviço para enviar')
  }
  if (current.status === 'approved') await releaseReceivables(id)

  await db
    .update(serviceProposals)
    .set({
      status,
      approvedAmountCents: null,
      ...(status === 'sent' && !current.sentAt ? { sentAt: new Date().toISOString() } : {}),
      updatedAt: sql`now_iso()`,
    })
    .where(eq(serviceProposals.id, id))
  return getProposal(id)
}

/** Depois de compartilhar o PDF: rascunho vira enviado. Em qualquer outro status, não muda nada. */
export async function markProposalSent(id: number) {
  const current = (await db.select().from(serviceProposals).where(eq(serviceProposals.id, id)))[0]
  if (!current) return null
  if (current.status !== 'draft') return getProposal(id)
  return setProposalStatus(id, 'sent')
}

export type ApproveProposalInput = {
  accountId: number
  /** vencimento da primeira parcela; as seguintes, mês a mês */
  firstDueOn: string
  installments?: number
  /** a primeira parcela já caiu na conta: entra confirmada, não pendente */
  firstAlreadyReceived?: boolean
}

/**
 * Aprovar gera as receitas a receber: uma por parcela, mês a mês a partir do
 * primeiro vencimento, pendentes (decisions/0003), ligadas ao orçamento por
 * `source_proposal_id`. Quando o pagamento chega pelo extrato, a importação
 * liga sozinha à parcela (decisions/0039, estendida pela 0040).
 */
export async function approveProposal(id: number, input: ApproveProposalInput) {
  const detail = await getProposal(id)
  if (!detail) throw new PricingError('orçamento não encontrado')
  if (detail.status === 'approved') throw new PricingError('este orçamento já foi aprovado')
  if (detail.items.length === 0) throw new PricingError('inclua pelo menos um serviço para aprovar')
  if (detail.totalCents <= 0) throw new PricingError('o total do orçamento precisa ser maior que zero')

  const count = Math.max(1, Math.floor(input.installments ?? detail.installments))
  const amounts = splitProposalInstallments(detail.totalCents, count)
  const base = `Orçamento ${detail.numberLabel}: ${detail.title}`
  for (const [index, amountCents] of amounts.entries()) {
    await createTransaction({
      accountId: input.accountId,
      postedOn: addMonthsToDate(input.firstDueOn, index),
      description: count > 1 ? `${base} (${index + 1}/${count})` : base,
      amountCents,
      source: 'manual',
      sourceProposalId: id,
      pending: !(index === 0 && input.firstAlreadyReceived),
    })
  }

  await db
    .update(serviceProposals)
    .set({
      status: 'approved',
      approvedAmountCents: detail.totalCents,
      installments: count,
      ...(detail.sentAt ? {} : { sentAt: new Date().toISOString() }),
      updatedAt: sql`now_iso()`,
    })
    .where(eq(serviceProposals.id, id))
  return getProposal(id)
}

export async function deleteProposal(id: number) {
  const current = (await db.select().from(serviceProposals).where(eq(serviceProposals.id, id)))[0]
  if (!current) return { removed: 0 }
  await releaseReceivables(id)
  const result = await db.delete(serviceProposals).where(eq(serviceProposals.id, id))
  return { removed: result.count }
}

/** Cópia como rascunho, número novo, sem datas de envio nem aprovação. */
export async function duplicateProposal(id: number) {
  const detail = await getProposal(id)
  if (!detail) return null
  return createProposal({
    title: `${detail.title} (cópia)`,
    clientLabel: detail.clientLabel,
    status: 'draft',
    discountBps: detail.discountBps,
    validityDays: detail.validityDays,
    installments: detail.installments,
    paymentTerms: detail.paymentTerms,
    deliveryTerms: detail.deliveryTerms,
    notes: detail.notes,
    items: detail.items,
  })
}

/* ------------------------------------------------------------------ *
 * Sugestões
 * ------------------------------------------------------------------ */
/** Serviços já usados em outros orçamentos: o título, com a última descrição e o último preço. */
export async function itemSuggestions(q?: string) {
  const like = `%${(q ?? '').trim()}%`
  const rows = await db.execute<{ title: string; description: string | null; unitPriceCents: number }>(sql`
    select distinct on (lower(title)) title, description, unit_price_cents as "unitPriceCents"
    from service_proposal_items
    where title ilike ${like}
    order by lower(title), id desc
    limit 12
  `)
  return rows.map((r) => ({ title: r.title, description: r.description, unitPriceCents: Number(r.unitPriceCents) }))
}

/** Clientes já usados em orçamentos e cotações, para o campo Cliente sugerir. */
export async function clientSuggestions() {
  const rows = await db.execute<{ label: string }>(sql`
    select label from (
      select client_label as label, updated_at as at from service_proposals
      union all
      select client_label as label, updated_at as at from project_quotes
    ) all_clients
    group by label
    order by max(at) desc
    limit 30
  `)
  return rows.map((r) => r.label)
}

/* ------------------------------------------------------------------ *
 * Emissor (cabeçalho do PDF)
 * ------------------------------------------------------------------ */
export type IssuerSettings = {
  businessName: string | null
  document: string | null
  email: string | null
  phone: string | null
  logoPath: string | null
  defaultValidityDays: number
}

export async function getIssuer(): Promise<IssuerSettings> {
  const row = (await db.select().from(proposalIssuerSettings).where(eq(proposalIssuerSettings.id, 1)))[0]
  return {
    businessName: row?.businessName ?? null,
    document: row?.document ?? null,
    email: row?.email ?? null,
    phone: row?.phone ?? null,
    logoPath: row?.logoPath ?? null,
    defaultValidityDays: row?.defaultValidityDays ?? 15,
  }
}

export async function updateIssuer(patch: Partial<IssuerSettings>): Promise<IssuerSettings> {
  const values = {
    ...(patch.businessName !== undefined ? { businessName: patch.businessName?.trim() || null } : {}),
    ...(patch.document !== undefined ? { document: patch.document?.replace(/\D/g, '') || null } : {}),
    ...(patch.email !== undefined ? { email: patch.email?.trim() || null } : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone?.trim() || null } : {}),
    ...(patch.logoPath !== undefined ? { logoPath: patch.logoPath } : {}),
    ...(patch.defaultValidityDays !== undefined ? { defaultValidityDays: patch.defaultValidityDays } : {}),
  }
  await db
    .insert(proposalIssuerSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: proposalIssuerSettings.id, set: values })
  return getIssuer()
}

/** As cotações que dá para trazer como serviço: cliente, horas e o preço recomendado. */
export async function quotesForPicker() {
  return db
    .select({
      id: projectQuotes.id,
      clientLabel: projectQuotes.clientLabel,
      estimatedHours: projectQuotes.estimatedHours,
      recommendedPriceCents: projectQuotes.recommendedPriceCents,
      status: projectQuotes.status,
      createdAt: projectQuotes.createdAt,
    })
    .from(projectQuotes)
    .orderBy(desc(projectQuotes.id))
    .limit(50)
}
