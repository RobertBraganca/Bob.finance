import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { pricingMultiplierOptions, pricingSettings, projectQuotes } from '../db/schema.ts'
import { periodOf, todayIso } from '../core/dates.ts'
import * as financialEngine from './financialEngine.ts'
import { createTransaction } from './transactions.ts'
import type { Assumptions } from './financialHealth.ts'

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

export type Simulation = {
  hourlyBaseCents: number
  minimumPriceCents: number
  recommendedPriceCents: number
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

  return {
    hourlyBaseCents,
    minimumPriceCents,
    recommendedPriceCents,
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
        'hora base = (ponto de equilíbrio do mês menos os impostos) ÷ horas faturáveis; preço mínimo = horas estimadas × hora base; preço recomendado = (preço mínimo + custos diretos) × multiplicadores, com o imposto embutido no preço e a margem extra por cima',
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
export async function saveQuote(input: SimulateInput & { clientLabel: string }): Promise<QuoteRow> {
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
        hourlyBaseCents: result.hourlyBaseCents,
        minimumPriceCents: result.minimumPriceCents,
        recommendedPriceCents: result.recommendedPriceCents,
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

export type QuoteEdit = Partial<SimulateInput> & { clientLabel?: string }

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
 */
export async function approveQuote(id: number, input: { accountId: number; paidOn: string }): Promise<QuoteRow> {
  const quote = await getQuote(id)
  if (!quote) throw new PricingError('cotação não encontrada')
  if (quote.status === 'approved') throw new PricingError('esta cotação já foi aprovada')

  await createTransaction({
    accountId: input.accountId,
    postedOn: input.paidOn,
    description: `Projeto: ${quote.clientLabel}`,
    amountCents: Math.abs(quote.recommendedPriceCents),
    source: 'manual',
  })

  const row = (
    await db.update(projectQuotes).set({ status: 'approved' }).where(eq(projectQuotes.id, id)).returning()
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
