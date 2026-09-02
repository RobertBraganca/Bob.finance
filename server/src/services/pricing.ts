import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { pricingMultiplierOptions, pricingSettings, projectQuotes } from '../db/schema'
import { addMonths, addMonthsToDate, periodOf, periodRange, todayIso } from '../core/dates'
import * as financialEngine from './financialEngine'
import { createTransaction } from './transactions'
import type { Assumptions } from './financialHealth'

/**
 * Precificação de projetos: "quanto cobrar por este projeto", derived from
 * the user's real cost of operating.
 *
 * The hourly rate is NOT computed here. It comes from the break-even the
 * financial engine already produces, minus the tax line of that same
 * response (see `decisions/0012`): two independent answers to "how much do I
 * need to bill" would eventually disagree, and the one on this screen would
 * be the one nobody noticed had drifted. Nothing about cost, pró-labore, tax
 * or monthly margin is stored by this module.
 *
 * Everything here is Simulação in the sense of `decisions/0010`: a
 * hypothetical price for a project that does not exist yet. `simulate` never
 * writes; only `saveQuote` does, and it freezes the numbers.
 */

export const PRICING_DIMENSIONS = ['complexity', 'urgency', 'client_size', 'usage_rights'] as const
export type PricingDimension = (typeof PRICING_DIMENSIONS)[number]

export const DIMENSION_LABELS: Record<PricingDimension, string> = {
  complexity: 'Complexidade',
  urgency: 'Urgência',
  client_size: 'Porte do cliente',
  usage_rights: 'Direitos de uso',
}

export class PricingError extends Error {}

/* ------------------------------------------------------------------ *
 * Settings (singleton, id = 1)
 * ------------------------------------------------------------------ */
export type PricingSettings = {
  availableHoursPerMonth: number
  billablePercentageBps: number
}

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  /** 22 working days x 8h */
  availableHoursPerMonth: 176,
  /** nobody bills 100% of the month: prospecting, admin, unbilled revisions */
  billablePercentageBps: 6_000,
}

export async function getSettings(): Promise<PricingSettings> {
  const row = (await db.select().from(pricingSettings).where(eq(pricingSettings.id, 1)))[0]
  if (!row) return { ...DEFAULT_PRICING_SETTINGS }
  return {
    availableHoursPerMonth: row.availableHoursPerMonth,
    billablePercentageBps: row.billablePercentageBps,
  }
}

export async function updateSettings(patch: Partial<PricingSettings>): Promise<PricingSettings> {
  const existing = (await db.select().from(pricingSettings).where(eq(pricingSettings.id, 1)))[0]
  if (existing) {
    await db.update(pricingSettings).set(patch).where(eq(pricingSettings.id, 1))
  } else {
    await db.insert(pricingSettings).values({ id: 1, ...DEFAULT_PRICING_SETTINGS, ...patch })
  }
  return getSettings()
}

/* ------------------------------------------------------------------ *
 * Multiplier bank
 * ------------------------------------------------------------------ */
export type MultiplierOption = {
  id: number
  dimension: string
  label: string
  description: string | null
  multiplierBps: number
  sortOrder: number
  active: boolean
}

export async function listMultipliers(dimension?: string): Promise<MultiplierOption[]> {
  const base = db
    .select()
    .from(pricingMultiplierOptions)
    .orderBy(asc(pricingMultiplierOptions.dimension), asc(pricingMultiplierOptions.sortOrder))
  const rows = dimension ? await base.where(eq(pricingMultiplierOptions.dimension, dimension as (typeof pricingMultiplierOptions.$inferSelect)['dimension'])) : await base
  return rows.map((r) => ({ ...r, active: !!r.active }))
}

export async function createMultiplier(input: {
  dimension: string
  label: string
  description?: string | null
  multiplierBps: number
  sortOrder?: number
}) {
  return (
    await db
      .insert(pricingMultiplierOptions)
      .values({ ...input, dimension: input.dimension as (typeof pricingMultiplierOptions.$inferSelect)['dimension'] })
      .returning()
  )[0]!
}

export async function updateMultiplier(id: number, patch: Record<string, unknown>) {
  return (
    (
      await db
        .update(pricingMultiplierOptions)
        .set(patch as Partial<typeof pricingMultiplierOptions.$inferInsert>)
        .where(eq(pricingMultiplierOptions.id, id))
        .returning()
    )[0] ?? null
  )
}

export async function deleteMultiplier(id: number) {
  return { removed: (await db.delete(pricingMultiplierOptions).where(eq(pricingMultiplierOptions.id, id))).count }
}

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */
export type DirectCost = { label: string; amountCents: number }

export type SimulateInput = {
  estimatedHours: number
  directCosts?: DirectCost[]
  complexityOptionId?: number | null
  urgencyOptionId?: number | null
  clientSizeOptionId?: number | null
  usageRightsOptionId?: number | null
  extraMarginBps?: number
  /** defaults to the current month; the break-even is always a monthly figure */
  period?: string
}

export type AppliedMultiplier = {
  dimension: PricingDimension
  dimensionLabel: string
  optionId: number | null
  label: string
  multiplierBps: number
}

/** Puramente informativo: um terceiro ponto de ancoragem para negociação, não um preço que `approveQuote` aceita — a aprovação sempre gera o lançamento no `recommendedPriceCents` (ver `docs/decisions/0012`-style: evidenciar, nunca prescrever). */
const PREMIUM_MULTIPLIER_BPS = 13_000

export type Simulation = {
  hourlyBaseCents: number
  minimumPriceCents: number
  recommendedPriceCents: number
  premiumPriceCents: number
  breakdown: {
    period: string
    breakEvenCents: number
    taxesCents: number
    netFixedCents: number
    availableHoursPerMonth: number
    billablePercentageBps: number
    billableHours: number
    estimatedHours: number
    directCostsCents: number
    basePriceCents: number
    combinedMultiplierBps: number
    adjustedPriceCents: number
    taxRateBps: number
    priceWithTaxCents: number
    extraMarginBps: number
    extraMarginCents: number
  }
  multipliers: AppliedMultiplier[]
  assumptions: Assumptions
}

/** Product of the four dimensions, in bps. A dimension with no option is 1.0x. */
function combineMultipliers(applied: AppliedMultiplier[]): number {
  return Math.round(
    applied.reduce((product, m) => (product * m.multiplierBps) / 10_000, 10_000),
  )
}

async function resolveMultipliers(input: SimulateInput): Promise<AppliedMultiplier[]> {
  const wanted: Array<{ dimension: PricingDimension; optionId: number | null }> = [
    { dimension: 'complexity', optionId: input.complexityOptionId ?? null },
    { dimension: 'urgency', optionId: input.urgencyOptionId ?? null },
    { dimension: 'client_size', optionId: input.clientSizeOptionId ?? null },
    { dimension: 'usage_rights', optionId: input.usageRightsOptionId ?? null },
  ]

  const ids = wanted.map((w) => w.optionId).filter((id): id is number => id !== null)
  const rows = ids.length
    ? await db.select().from(pricingMultiplierOptions).where(inArray(pricingMultiplierOptions.id, ids))
    : []
  const byId = new Map(rows.map((r) => [r.id, r] as const))

  return wanted.map(({ dimension, optionId }) => {
    const row = optionId === null ? undefined : byId.get(optionId)
    // A dimension left unanswered (or pointing at an option the user has
    // since deleted) is NEUTRAL, never a blocker: the spec is explicit that
    // no dimension is mandatory.
    if (!row) {
      return {
        dimension,
        dimensionLabel: DIMENSION_LABELS[dimension],
        optionId: null,
        label: 'não informado',
        multiplierBps: 10_000,
      }
    }
    return {
      dimension,
      dimensionLabel: DIMENSION_LABELS[dimension],
      optionId: row.id,
      label: row.label,
      multiplierBps: row.multiplierBps,
    }
  })
}

export async function simulate(input: SimulateInput): Promise<Simulation> {
  const period = input.period ?? periodOf(todayIso())
  const settings = await getSettings()

  // The one source of truth for "how much do I need to bill this month".
  const breakEven = await financialEngine.breakEven(period)
  if (breakEven.breakEvenCents === null) {
    throw new PricingError(
      'não há ponto de equilíbrio para este mês (a alíquota configurada é igual ou maior que 100% do faturamento), então não há base para calcular a hora',
    )
  }

  const taxesCents = breakEven.lines.find((l) => l.key === 'taxes')?.amountCents ?? 0
  // Net of tax on purpose: the tax is added back at the end, on the price
  // charged to the client, instead of being baked into the hourly rate twice.
  const netFixedCents = breakEven.breakEvenCents - taxesCents

  const billableHours = settings.availableHoursPerMonth * (settings.billablePercentageBps / 10_000)
  if (billableHours <= 0) {
    throw new PricingError(
      'sem horas faturáveis configuradas (horas disponíveis x percentual faturável resulta em zero), não há base para calcular a hora',
    )
  }

  const hourlyBaseCents = Math.round(netFixedCents / billableHours)

  // Minimum price is hours x hourly base, and NOTHING else touches it: no
  // multiplier may push the floor down (spec, "preço mínimo nunca é
  // reescrito pelos multiplicadores").
  const minimumPriceCents = Math.round(input.estimatedHours * hourlyBaseCents)

  const directCosts = input.directCosts ?? []
  const directCostsCents = directCosts.reduce((sum, c) => sum + c.amountCents, 0)
  const basePriceCents = minimumPriceCents + directCostsCents

  const multipliers = await resolveMultipliers(input)
  const combinedMultiplierBps = combineMultipliers(multipliers)
  const adjustedPriceCents = Math.round((basePriceCents * combinedMultiplierBps) / 10_000)

  // Gross-up with the SAME rate the break-even uses. Not a second tax
  // setting: the tax is embedded in what the client pays, never discounted
  // from what the professional meant to receive.
  const engineParams = await financialEngine.getSettings()
  const taxRateBps = engineParams.taxRateBps
  const priceWithTaxCents =
    taxRateBps > 0 ? Math.round(adjustedPriceCents / (1 - taxRateBps / 10_000)) : adjustedPriceCents

  const extraMarginBps = input.extraMarginBps ?? 0
  const extraMarginCents = Math.round((priceWithTaxCents * extraMarginBps) / 10_000)
  const recommendedPriceCents = priceWithTaxCents + extraMarginCents
  // Terceiro ponto de ancoragem, não um quarto preço aprovável — ver a
  // constante acima.
  const premiumPriceCents = Math.round((recommendedPriceCents * PREMIUM_MULTIPLIER_BPS) / 10_000)

  return {
    hourlyBaseCents,
    minimumPriceCents,
    recommendedPriceCents,
    premiumPriceCents,
    breakdown: {
      period,
      breakEvenCents: breakEven.breakEvenCents,
      taxesCents,
      netFixedCents,
      availableHoursPerMonth: settings.availableHoursPerMonth,
      billablePercentageBps: settings.billablePercentageBps,
      billableHours,
      estimatedHours: input.estimatedHours,
      directCostsCents,
      basePriceCents,
      combinedMultiplierBps,
      adjustedPriceCents,
      taxRateBps,
      priceWithTaxCents,
      extraMarginBps,
      extraMarginCents,
    },
    multipliers,
    assumptions: {
      formula:
        'hora base = (ponto de equilíbrio do mês menos os impostos) ÷ horas faturáveis; preço mínimo = horas estimadas × hora base; preço recomendado = (preço mínimo + custos diretos) × multiplicadores, com o imposto embutido no preço e a margem extra por cima; preço premium = preço recomendado × 1,3 (referência de ancoragem para negociação, não um preço que a aprovação aceita)',
      periodo: period,
      pontoDeEquilibrioCents: breakEven.breakEvenCents,
      impostosNoPontoDeEquilibrioCents: taxesCents,
      custoFixoLiquidoCents: netFixedCents,
      horasDisponiveisPorMes: settings.availableHoursPerMonth,
      percentualFaturavelBps: settings.billablePercentageBps,
      horasFaturaveis: billableHours,
      horaBaseCents: hourlyBaseCents,
      horasEstimadas: input.estimatedHours,
      precoMinimoCents: minimumPriceCents,
      custosDiretosCents: directCostsCents,
      custosDiretosDetalhe: directCosts,
      multiplicadoresAplicados: multipliers.map((m) => ({
        label: `${m.dimensionLabel}: ${m.label}`,
        multiplicadorBps: m.multiplierBps,
      })),
      multiplicadorCombinadoBps: combinedMultiplierBps,
      precoAjustadoCents: adjustedPriceCents,
      aliquotaBps: taxRateBps,
      aliquotaOrigem: 'a mesma de financialEngineSettings, nunca uma segunda configuração de imposto',
      precoComImpostoCents: priceWithTaxCents,
      margemExtraBps: extraMarginBps,
      margemExtraCents: extraMarginCents,
      precoPremiumCents: premiumPriceCents,
      origemDoPontoDeEquilibrio: 'specs/motor-financeiro (financialEngine.breakEven)',
    },
  }
}

/* ------------------------------------------------------------------ *
 * Quotes — the only thing that persists
 * ------------------------------------------------------------------ */
export const QUOTE_STATUSES = ['draft', 'sent', 'in_review', 'needs_changes', 'rejected', 'approved'] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

export type QuoteRow = {
  id: number
  clientLabel: string
  estimatedHours: number
  directCosts: DirectCost[]
  complexityOptionId: number | null
  urgencyOptionId: number | null
  clientSizeOptionId: number | null
  usageRightsOptionId: number | null
  extraMarginBps: number
  hourlyBaseCents: number
  minimumPriceCents: number
  recommendedPriceCents: number
  premiumPriceCents: number
  actualPriceCents: number | null
  /** condição comercial, não insumo de preço: 1 = à vista */
  installments: number
  paymentTerms: string | null
  status: QuoteStatus
  createdAt: string
  updatedAt: string
}

const toQuoteRow = (row: typeof projectQuotes.$inferSelect): QuoteRow => ({
  ...row,
  directCosts: (row.directCosts as DirectCost[] | null) ?? [],
  status: row.status as QuoteStatus,
})

/**
 * Runs the simulation and freezes its three numbers. A quote already sent to
 * a client must not change because the user edited their monthly costs the
 * week after (spec, "números congelados").
 */
export async function saveQuote(
  input: SimulateInput & { clientLabel: string; installments?: number; paymentTerms?: string | null },
): Promise<QuoteRow> {
  const result = await simulate(input)
  const row = (
    await db
      .insert(projectQuotes)
      .values({
        clientLabel: input.clientLabel,
        estimatedHours: input.estimatedHours,
        directCosts: input.directCosts ?? [],
        complexityOptionId: input.complexityOptionId ?? null,
        urgencyOptionId: input.urgencyOptionId ?? null,
        clientSizeOptionId: input.clientSizeOptionId ?? null,
        usageRightsOptionId: input.usageRightsOptionId ?? null,
        extraMarginBps: input.extraMarginBps ?? 0,
        installments: input.installments ?? 1,
        paymentTerms: input.paymentTerms ?? null,
        hourlyBaseCents: result.hourlyBaseCents,
        minimumPriceCents: result.minimumPriceCents,
        recommendedPriceCents: result.recommendedPriceCents,
        premiumPriceCents: result.premiumPriceCents,
      })
      .returning()
  )[0]!
  return toQuoteRow(row)
}

export async function listQuotes(): Promise<QuoteRow[]> {
  const rows = await db.select().from(projectQuotes).orderBy(asc(projectQuotes.id))
  return rows.map(toQuoteRow).reverse()
}

export async function getQuote(id: number): Promise<QuoteRow | null> {
  const row = (await db.select().from(projectQuotes).where(eq(projectQuotes.id, id)))[0]
  return row ? toQuoteRow(row) : null
}

/**
 * `clientLabel`, `installments` e `paymentTerms` são campos COMERCIAIS:
 * nenhum deles entra em `simulate()`, então nenhum recomputa os preços
 * congelados e todos continuam editáveis depois da aprovação. Só os
 * `CALCULATION_FIELDS` abaixo é que ficam travados nesse ponto.
 */
export type QuoteEdit = Partial<SimulateInput> & {
  clientLabel?: string
  installments?: number
  paymentTerms?: string | null
}

const CALCULATION_FIELDS = [
  'estimatedHours',
  'directCosts',
  'complexityOptionId',
  'urgencyOptionId',
  'clientSizeOptionId',
  'usageRightsOptionId',
  'extraMarginBps',
] as const satisfies readonly (keyof QuoteEdit)[]

/**
 * `clientLabel` alone never touches the frozen numbers. Any calculation
 * field recomputes them via `simulate()` — the same function a new
 * simulation uses, never a second formula — using the current break-even
 * and tax rate, not the ones from when the quote was first created
 * (decisions/0021: that is exactly what "editing" means here). Blocked
 * once `approved`: the approval already created a real transaction at a
 * specific amount, and recalculating afterward would make the quote
 * disagree with the ledger.
 */
export async function updateQuote(id: number, patch: QuoteEdit): Promise<QuoteRow | null> {
  const existing = (await db.select().from(projectQuotes).where(eq(projectQuotes.id, id)))[0]
  if (!existing) return null

  const touchesCalculation = CALCULATION_FIELDS.some((field) => patch[field] !== undefined)

  if (touchesCalculation && existing.status === 'approved') {
    throw new PricingError(
      'esta cotação já foi aprovada e gerou um lançamento de receita com o valor anterior — editar horas, custos ou multiplicadores não é permitido, porque o preço exibido deixaria de bater com o que está no ledger. Só o rótulo pode ser editado.',
    )
  }

  const updateValues: Record<string, unknown> = {}
  if (patch.clientLabel !== undefined) updateValues.clientLabel = patch.clientLabel
  if (patch.installments !== undefined) updateValues.installments = patch.installments
  if (patch.paymentTerms !== undefined) updateValues.paymentTerms = patch.paymentTerms

  if (touchesCalculation) {
    const mergedInput: SimulateInput = {
      estimatedHours: patch.estimatedHours ?? existing.estimatedHours,
      directCosts: patch.directCosts ?? ((existing.directCosts as DirectCost[] | null) ?? []),
      complexityOptionId: patch.complexityOptionId !== undefined ? patch.complexityOptionId : existing.complexityOptionId,
      urgencyOptionId: patch.urgencyOptionId !== undefined ? patch.urgencyOptionId : existing.urgencyOptionId,
      clientSizeOptionId: patch.clientSizeOptionId !== undefined ? patch.clientSizeOptionId : existing.clientSizeOptionId,
      usageRightsOptionId: patch.usageRightsOptionId !== undefined ? patch.usageRightsOptionId : existing.usageRightsOptionId,
      extraMarginBps: patch.extraMarginBps ?? existing.extraMarginBps,
    }
    const result = await simulate(mergedInput)
    Object.assign(updateValues, {
      estimatedHours: mergedInput.estimatedHours,
      directCosts: mergedInput.directCosts,
      complexityOptionId: mergedInput.complexityOptionId,
      urgencyOptionId: mergedInput.urgencyOptionId,
      clientSizeOptionId: mergedInput.clientSizeOptionId,
      usageRightsOptionId: mergedInput.usageRightsOptionId,
      extraMarginBps: mergedInput.extraMarginBps,
      hourlyBaseCents: result.hourlyBaseCents,
      minimumPriceCents: result.minimumPriceCents,
      recommendedPriceCents: result.recommendedPriceCents,
      premiumPriceCents: result.premiumPriceCents,
    })
  }

  if (Object.keys(updateValues).length === 0) return toQuoteRow(existing)

  updateValues.updatedAt = sql`now_iso()`
  const row = (
    await db
      .update(projectQuotes)
      .set(updateValues as Partial<typeof projectQuotes.$inferInsert>)
      .where(eq(projectQuotes.id, id))
      .returning()
  )[0]
  return row ? toQuoteRow(row) : null
}

export async function deleteQuote(id: number) {
  return { removed: (await db.delete(projectQuotes).where(eq(projectQuotes.id, id))).count }
}

/** Status is always manually editable back and forth — never a locked state machine. */
export async function setQuoteStatus(id: number, status: QuoteStatus): Promise<QuoteRow | null> {
  const row = (await db.update(projectQuotes).set({ status }).where(eq(projectQuotes.id, id)).returning())[0]
  return row ? toQuoteRow(row) : null
}

/**
 * Approving a quote is the simple conversion that doesn't depend on
 * `specs/client-projects` existing: one real income transaction, not a
 * recurring template. Blocked once already approved so the same quote can
 * never create the transaction twice.
 *
 * `actualPriceCents` (opcional) é o valor de fato negociado com o cliente,
 * quando difere do recomendado — sem ele, o lançamento usa o recomendado,
 * exatamente como antes. O valor gravado em `projectQuotes.actualPriceCents`
 * é sempre o mesmo que foi de fato lançado no ledger (nunca um "valor real"
 * solto que discorda do lançamento) — coerente com a mesma regra que já
 * bloqueia editar horas/multiplicadores depois de aprovada.
 */
/**
 * Divide um total em `count` parcelas inteiras em centavos. A ÚLTIMA
 * absorve o resto da divisão, então a soma das parcelas é exatamente o
 * total — nunca um centavo a mais ou a menos escondido no arredondamento
 * (R$ 674,94 em 3x vira 224,98 + 224,98 + 224,98; R$ 100,00 em 3x vira
 * 33,33 + 33,33 + 33,34).
 */
export function splitInstallments(totalCents: number, count: number): number[] {
  const base = Math.floor(totalCents / count)
  const parts = Array.from({ length: count }, () => base)
  parts[count - 1] = totalCents - base * (count - 1)
  return parts
}

export type ApproveInput = {
  accountId: number
  paidOn: string
  actualPriceCents?: number
  /**
   * Data da SEGUNDA parcela. Da terceira em diante o vencimento anda de
   * mês em mês a partir dela — a convenção "1 + N mensais". Obrigatória
   * quando a cotação tem parcelamento; ignorada quando é à vista.
   */
  secondInstallmentOn?: string
}

export async function approveQuote(id: number, input: ApproveInput): Promise<QuoteRow> {
  const quote = await getQuote(id)
  if (!quote) throw new PricingError('cotação não encontrada')
  if (quote.status === 'approved') throw new PricingError('esta cotação já foi aprovada')

  const actualPriceCents = input.actualPriceCents ?? quote.recommendedPriceCents
  if (actualPriceCents <= 0) throw new PricingError('valor fechado precisa ser maior que zero')

  const count = Math.max(1, quote.installments)
  if (count > 1 && !input.secondInstallmentOn) {
    throw new PricingError(
      `esta cotação está parcelada em ${count}x: informe a data da segunda parcela para as futuras entrarem em Lançamentos com o vencimento certo`,
    )
  }

  /**
   * Parcelado gera UMA linha por parcela, não uma linha com o valor cheio
   * (pedido do usuário, 01/09/2026: "hoje a transação está entrando com
   * valor cheio"). A primeira é real e já recebida (dia da aprovação); as
   * seguintes são pendências — linhas reais com `pending = true`, o
   * mecanismo do `decisions/0003` — então aparecem em "A receber" e no
   * fluxo de caixa sem inflar nenhum mês já fechado, e cada uma pode ser
   * conciliada ou editada individualmente depois.
   */
  const amounts = splitInstallments(Math.abs(actualPriceCents), count)
  for (const [index, amountCents] of amounts.entries()) {
    const postedOn =
      index === 0 ? input.paidOn : addMonthsToDate(input.secondInstallmentOn!, index - 1)
    await createTransaction({
      accountId: input.accountId,
      postedOn,
      description:
        count > 1
          ? `Projeto: ${quote.clientLabel} (${index + 1}/${count})`
          : `Projeto: ${quote.clientLabel}`,
      amountCents,
      source: 'manual',
      sourceQuoteId: id,
      pending: index > 0,
    })
  }

  const row = (
    await db
      .update(projectQuotes)
      .set({ status: 'approved', actualPriceCents })
      .where(eq(projectQuotes.id, id))
      .returning()
  )[0]!
  return toQuoteRow(row)
}

/** Grouped for the four selectors in the form, active options only. */
export async function multipliersByDimension(): Promise<Record<string, MultiplierOption[]>> {
  const grouped: Record<string, MultiplierOption[]> = {}
  for (const dimension of PRICING_DIMENSIONS) grouped[dimension] = []
  for (const option of await listMultipliers()) {
    if (!option.active) continue
    ;(grouped[option.dimension] ??= []).push(option)
  }
  return grouped
}

/**
 * Ticket médio recente: média das últimas N cotações salvas.
 *
 * As ÚLTIMAS N, não o histórico inteiro: um ticket de dois anos atrás não
 * representa o que o usuário cobra hoje, e é justamente para traduzir "o
 * que falta neste mês" que este número existe (ver `specs/monthly-goals`,
 * "Meta de receita em número de projetos").
 *
 * Devolve `null` sem nenhuma cotação salva, nunca zero: zero dividiria a
 * meta por nada e produziria um número inventado.
 */
export async function averageRecentQuoteCents(n = 5): Promise<{ averageCents: number | null; sampleSize: number }> {
  // `listQuotes` já vem do mais recente para o mais antigo.
  const recent = (await listQuotes()).slice(0, n)
  if (recent.length === 0) return { averageCents: null, sampleSize: 0 }
  const total = recent.reduce((sum, q) => sum + q.recommendedPriceCents, 0)
  return { averageCents: Math.round(total / recent.length), sampleSize: recent.length }
}

/* ------------------------------------------------------------------ *
 * Analitico de cotacoes — o que os graficos da pagina Precificacao
 * consomem.
 * ------------------------------------------------------------------ */

export type QuoteStatusSlice = {
  status: QuoteStatus
  count: number
  /** soma do preco recomendado, o unico valor que TODA cotacao tem */
  recommendedCents: number
  /** soma do valor fechado, so existe em aprovada */
  actualCents: number
  shareBps: number
}

export type QuotePeriodPoint = {
  period: string
  /** cotacoes que sairam do rascunho, a valor recomendado */
  sentCents: number
  sentCount: number
  /** cotacoes aprovadas, a valor efetivamente fechado */
  approvedCents: number
  approvedCount: number
  /** aprovado sobre enviado, em bps; null quando nada foi enviado */
  conversionBps: number | null
}

export type QuoteFunnelStage = {
  key: string
  label: string
  count: number
  /** sobre o total de cotacoes criadas */
  shareBps: number
  /** quantas se perderam entre a etapa anterior e esta */
  dropFromPreviousCount: number
}

export type QuoteAnalytics = {
  byStatus: QuoteStatusSlice[]
  byPeriod: QuotePeriodPoint[]
  funnel: QuoteFunnelStage[]
  totalCount: number
  assumptions: Record<string, unknown>
}

/**
 * Tres leituras da mesma tabela de cotacoes, num pedido so.
 *
 * O FUNIL merece explicacao, porque ele infere. Uma cotacao guarda o
 * status ATUAL, nao o historico de transicoes — nao existe log de
 * mudanca de etapa. Entao "chegou ate a etapa N" e derivado por
 * implicacao: para estar aprovada, ela precisou ter sido enviada e
 * analisada. A implicacao e segura para o fluxo em frente e esta
 * declarada em `assumptions`; o que ela NAO consegue dizer e quantas
 * voltaram atras (needs_changes e um retorno, nao uma etapa).
 *
 * O agrupamento por PERIODO usa `createdAt`, e isso e uma limitacao
 * real: nao existe coluna de data de aprovacao. `updatedAt` muda a cada
 * edicao (decisions/0021) e o `paidOn` fica na transacao, nao aqui.
 * Entao uma cotacao aprovada aparece no mes em que foi CRIADA, nao no
 * mes em que fechou. Para janelas mensais isso costuma coincidir; para
 * um ciclo de venda longo, nao. Declarado tambem (02/09/2026).
 */
export async function quoteAnalytics(monthsBack = 12): Promise<QuoteAnalytics> {
  const rows = await db
    .select({
      status: projectQuotes.status,
      createdAt: projectQuotes.createdAt,
      recommendedPriceCents: projectQuotes.recommendedPriceCents,
      actualPriceCents: projectQuotes.actualPriceCents,
    })
    .from(projectQuotes)

  const totalCount = rows.length

  // ---- 1. Rosca por status ----
  const STATUSES: QuoteStatus[] = [
    'draft',
    'sent',
    'in_review',
    'needs_changes',
    'rejected',
    'approved',
  ]
  const byStatus: QuoteStatusSlice[] = STATUSES.map((status) => {
    const own = rows.filter((r) => r.status === status)
    return {
      status,
      count: own.length,
      recommendedCents: own.reduce((sum, r) => sum + r.recommendedPriceCents, 0),
      actualCents: own.reduce((sum, r) => sum + (r.actualPriceCents ?? 0), 0),
      shareBps: totalCount > 0 ? Math.round((own.length / totalCount) * 10_000) : 0,
    }
  }).filter((slice) => slice.count > 0)

  // ---- 2. Enviado x aprovado por mes ----
  const current = todayIso().slice(0, 7)
  const first = addMonths(current, -(monthsBack - 1))
  const byPeriod: QuotePeriodPoint[] = periodRange(first, current).map((period) => {
    const own = rows.filter((r) => r.createdAt.slice(0, 7) === period)
    const saiuDoRascunho = own.filter((r) => r.status !== 'draft')
    const aprovadas = own.filter((r) => r.status === 'approved')
    const sentCents = saiuDoRascunho.reduce((sum, r) => sum + r.recommendedPriceCents, 0)
    const approvedCents = aprovadas.reduce(
      (sum, r) => sum + (r.actualPriceCents ?? r.recommendedPriceCents),
      0,
    )
    return {
      period,
      sentCents,
      sentCount: saiuDoRascunho.length,
      approvedCents,
      approvedCount: aprovadas.length,
      conversionBps: sentCents > 0 ? Math.round((approvedCents / sentCents) * 10_000) : null,
    }
  })

  // ---- 3. Funil cumulativo ----
  const naoRascunho = rows.filter((r) => r.status !== 'draft')
  const analisadas = rows.filter((r) =>
    (['in_review', 'needs_changes', 'rejected', 'approved'] as QuoteStatus[]).includes(r.status),
  )
  const aprovadasTotal = rows.filter((r) => r.status === 'approved')
  const etapas: Array<{ key: string; label: string; count: number }> = [
    { key: 'created', label: 'Criadas', count: totalCount },
    { key: 'sent', label: 'Enviadas', count: naoRascunho.length },
    { key: 'reviewed', label: 'Em análise ou além', count: analisadas.length },
    { key: 'approved', label: 'Aprovadas', count: aprovadasTotal.length },
  ]
  const funnel: QuoteFunnelStage[] = etapas.map((e, i) => ({
    ...e,
    shareBps: totalCount > 0 ? Math.round((e.count / totalCount) * 10_000) : 0,
    dropFromPreviousCount: i === 0 ? 0 : Math.max(0, etapas[i - 1]!.count - e.count),
  }))

  const rejeitadas = rows.filter((r) => r.status === 'rejected').length

  return {
    byStatus,
    byPeriod,
    funnel,
    totalCount,
    assumptions: {
      formula:
        'contagem e soma de valores da tabela de cotacoes, agrupadas por status, por mes de criacao e por etapa acumulada do funil',
      cotacoesConsideradas: totalCount,
      janela: `${monthsBack} meses, de ${first} a ${current}`,
      valorEnviado:
        'preco RECOMENDADO das cotacoes que sairam do rascunho — e o unico valor que toda cotacao tem, independente de status',
      valorAprovado:
        'valor efetivamente FECHADO (actual_price_cents), caindo para o recomendado quando a aprovacao nao registrou um valor proprio',
      funilEInferido:
        'a cotacao guarda o status ATUAL, nao o historico de transicoes: nao existe log de mudanca de etapa. "Chegou ate a etapa N" e derivado por implicacao (para estar aprovada, foi enviada e analisada). A implicacao vale para frente; o que o funil NAO diz e quantas voltaram atras, porque "Em ajuste" e um retorno, nao uma etapa',
      limiteDeDataDeAprovacao:
        'nao existe coluna de data de aprovacao. Uma cotacao aprovada e contada no mes em que foi CRIADA, nao no mes em que fechou — updatedAt muda a cada edicao (decisions/0021) e o paidOn fica na transacao. Para ciclo de venda curto isso coincide; para longo, nao',
      reprovadas: rejeitadas,
      notaDeVolume:
        totalCount < 10
          ? 'volume baixo: com menos de dez cotacoes, proporcao e taxa de conversao oscilam muito a cada nova cotacao e nao devem ser lidas como tendencia'
          : 'volume suficiente para ler proporcao entre status',
      origem: 'tabela project_quotes, sem cache nem tabela derivada',
    },
  }
}
