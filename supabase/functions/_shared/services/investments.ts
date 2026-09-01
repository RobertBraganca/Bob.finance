import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  assetTrades,
  assetValuations,
  assets,
  emergencyReserveSettings,
  investmentGoals,
  targetAllocations,
} from '../db/schema.ts'
import { addDays, addMonths, periodBounds, periodOf, periodRange, todayIso } from '../core/dates.ts'
import { totals } from './analytics.ts'
import { notesForAssets } from './criteria.ts'
import type { GoalState } from './goals.ts'

/**
 * Positions are derived from trades, never stored as a running quantity, so
 * editing or deleting a trade can never leave the portfolio inconsistent.
 * Market value comes from the latest valuation row; contributed capital comes
 * from the trades themselves. Plotting both on one axis is what makes real
 * gains visible.
 */

export const ASSET_CLASSES = [
  'stocks',
  'fii',
  'fixed_income',
  'treasury',
  'crypto',
  'funds',
  'etf_intl',
  'cash',
  'pension',
  'other',
  'illiquid',
] as const

/**
 * Imóvel, veículo, joia: entra no PATRIMÔNIO (`financialHealth.netWorth`)
 * mas nunca na POLÍTICA DE ALOCAÇÃO da carteira. Rebalancear pressupõe
 * poder comprar e vender frações a preço de mercado, o que um sofá não
 * permite — antes de 01/09/2026 a classe entrava em `allocation()` junto
 * das demais e um único bem de R$3.150 aparecia como "64,1% da carteira,
 * meta 1,0%, desvio +63,1 p.p.", número real na tela do usuário e sem
 * significado nenhum (nada a fazer com ele, já que vender não é sugerido
 * e nunca será, `decisions/0011`).
 */
export const ILLIQUID_ASSET_CLASS = 'illiquid'

type AssetClass = (typeof assets.$inferSelect)['assetClass']
type TradeKind = (typeof assetTrades.$inferSelect)['kind']
type GoalPurpose = (typeof investmentGoals.$inferSelect)['purpose']

export const ASSET_CLASS_LABELS: Record<string, string> = {
  stocks: 'Ações',
  // Short on purpose: these labels become y-axis categories in the
  // allocation chart, and "Fundos imobiliários" wraps to two lines there,
  // crowding the row band. "FIIs" is the term the market actually uses.
  fii: 'FIIs',
  fixed_income: 'Renda fixa',
  // Tesouro Direto is its own line in "Meus ativos" even though it is a
  // kind of renda fixa — the user tracks its target allocation
  // separately from other fixed income, so it gets its own class rather
  // than folding into `fixed_income` and losing that distinction.
  treasury: 'Tesouro Direto',
  crypto: 'Cripto',
  funds: 'Fundos',
  etf_intl: 'ETFs Internacionais',
  cash: 'Caixa',
  pension: 'Previdência',
  other: 'Outros',
  illiquid: 'Imobilizado',
}

/**
 * Purely an organizing label on `investmentGoals.purpose` — never an input
 * to any calculation. "Reserva de emergência" is deliberately absent: that
 * concern already has its own dedicated, priority-zero mechanism
 * (`emergencyReserveSettings`, `reserveStatus`), and a second "purpose"
 * meaning the same thing would just create two competing signals for one
 * concern. See `specs/investments`, "Propósito da meta".
 */
export const GOAL_PURPOSES = [
  'retirement',
  'buy_property',
  'financial_independence',
  'children_education',
  'travel',
] as const

export const GOAL_PURPOSE_LABELS: Record<string, string> = {
  retirement: 'Aposentadoria',
  buy_property: 'Comprar imóvel',
  financial_independence: 'Independência financeira',
  children_education: 'Educação dos filhos',
  travel: 'Viagem',
}

export type Position = {
  assetId: number
  name: string
  ticker: string | null
  assetClass: string
  assetClassLabel: string
  /** BRAPI's summaryProfile.sector, e.g. "Energia" — null until a quote refresh has populated it */
  sector: string | null
  quantity: number
  /** what was actually paid in, net of sales proceeds, including fees */
  contributedCents: number
  avgUnitPriceCents: number
  lastUnitPriceCents: number | null
  lastPricedOn: string | null
  marketValueCents: number
  dividendsCents: number
  gainCents: number
  gainBps: number | null
  /** "Diagrama do Cerrado" resistance note — null until the questionnaire is answered */
  note: number | null
  answeredCriteria: number
  totalCriteria: number
  /** counts toward the emergency-reserve progress */
  countsTowardReserve: boolean
}

/**
 * `asOfDate` (`YYYY-MM-DD`) é opcional e reconstitui a carteira como ela
 * estava naquela data — trades depois dela não contam, e a cotação usada é
 * a última CONHECIDA até aquela data, não a mais recente de hoje. Omitido
 * (o caso de toda leitura de produção existente), comportamento idêntico a
 * antes: nenhum filtro de data entra na query. Existe pra série histórica
 * de patrimônio líquido (`netWorthHistory`, `financialHealth.ts`, estudo de
 * viabilidade #8, 29/08/2026) — nunca uma segunda função paralela pra
 * "posições no passado".
 */
export async function positions(asOfDate?: string): Promise<Position[]> {
  const tradeCutoff = asOfDate ? sql`and t.traded_on <= ${asOfDate}` : sql``
  const valuationCutoff = asOfDate ? sql`and v.as_of <= ${asOfDate}` : sql``

  const rows = await db.execute<{
    assetId: number
    name: string
    ticker: string | null
    assetClass: string
    sector: string | null
    countsTowardReserve: boolean
    boughtQty: number
    soldQty: number
    boughtCents: number
    soldCents: number
    feesCents: number
    dividendsCents: number
    lastUnitPriceCents: number | null
    lastPricedOn: string | null
  }>(sql`
    select
      a.id as "assetId",
      a.name,
      a.ticker,
      a.asset_class as "assetClass",
      a.sector as sector,
      a.counts_toward_reserve as "countsTowardReserve",
      coalesce(sum(case when t.kind = 'buy'  then t.quantity else 0 end), 0) as "boughtQty",
      coalesce(sum(case when t.kind = 'sell' then t.quantity else 0 end), 0) as "soldQty",
      coalesce(sum(case when t.kind = 'buy'  then round(t.quantity * t.unit_price_cents) else 0 end), 0) as "boughtCents",
      coalesce(sum(case when t.kind = 'sell' then round(t.quantity * t.unit_price_cents) else 0 end), 0) as "soldCents",
      coalesce(sum(t.fees_cents), 0) as "feesCents",
      coalesce(sum(case when t.kind = 'dividend' then round(t.quantity * t.unit_price_cents) else 0 end), 0) as "dividendsCents",
      (select v.unit_price_cents from asset_valuations v
        where v.asset_id = a.id ${valuationCutoff} order by v.as_of desc limit 1) as "lastUnitPriceCents",
      (select v.as_of from asset_valuations v
        where v.asset_id = a.id ${valuationCutoff} order by v.as_of desc limit 1) as "lastPricedOn"
    from assets a
    left join asset_trades t on t.asset_id = a.id ${tradeCutoff}
    where a.archived = false
    group by a.id
    order by a.name
  `)

  const notes = await notesForAssets(rows.map((r) => r.assetId))

  return rows.map((r) => {
    const quantity = r.boughtQty - r.soldQty
    const contributedCents = r.boughtCents - r.soldCents + r.feesCents
    const avgUnitPriceCents =
      r.boughtQty > 0 ? Math.round((r.boughtCents + r.feesCents) / r.boughtQty) : 0
    // With no valuation yet, cost basis is the honest stand-in for value.
    const unitPrice = r.lastUnitPriceCents ?? avgUnitPriceCents
    const marketValueCents = Math.round(quantity * unitPrice)
    const gainCents = marketValueCents - contributedCents + r.dividendsCents
    const note = notes.get(r.assetId)

    return {
      assetId: r.assetId,
      name: r.name,
      ticker: r.ticker,
      assetClass: r.assetClass,
      assetClassLabel: ASSET_CLASS_LABELS[r.assetClass] ?? r.assetClass,
      sector: r.sector,
      quantity,
      contributedCents,
      avgUnitPriceCents,
      lastUnitPriceCents: r.lastUnitPriceCents,
      lastPricedOn: r.lastPricedOn,
      marketValueCents,
      dividendsCents: r.dividendsCents,
      gainCents,
      gainBps: contributedCents > 0 ? Math.round((gainCents / contributedCents) * 10_000) : null,
      note: note?.note ?? null,
      answeredCriteria: note?.answered ?? 0,
      totalCriteria: note?.total ?? 0,
      countsTowardReserve: !!r.countsTowardReserve,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Imobilizado — a leitura própria da classe que `allocation()` de
 * propósito não cobre (ver `ILLIQUID_ASSET_CLASS`). Aqui a pergunta não é
 * "está dentro da política?" e sim "o que eu tenho e quanto vale", então
 * a saída é uma lista de bens com participação no próprio imobilizado,
 * nunca no total da carteira.
 * ------------------------------------------------------------------ */
export type IlliquidItem = {
  assetId: number
  name: string
  valueCents: number
  /** participação DENTRO do imobilizado, não da carteira toda */
  shareBps: number
  lastPricedOn: string | null
}

export type IlliquidOverview = {
  totalCents: number
  items: IlliquidItem[]
  assumptions: Record<string, unknown>
}

export async function illiquidOverview(): Promise<IlliquidOverview> {
  const rows = (await positions())
    .filter((p) => p.assetClass === ILLIQUID_ASSET_CLASS)
    .sort((a, b) => b.marketValueCents - a.marketValueCents)
  const totalCents = rows.reduce((s, p) => s + p.marketValueCents, 0)

  return {
    totalCents,
    items: rows.map((p) => ({
      assetId: p.assetId,
      name: p.name,
      valueCents: p.marketValueCents,
      shareBps: totalCents > 0 ? Math.round((p.marketValueCents / totalCents) * 10_000) : 0,
      lastPricedOn: p.lastPricedOn,
    })),
    assumptions: {
      formula:
        'soma do valor informado de cada bem da classe Imobilizado, com a participação de cada um dentro do próprio imobilizado',
      bensSomados: rows.length,
      valorTotalCents: totalCents,
      origemDoValor:
        'último valor informado manualmente por bem (asset_valuations); nenhum bem desta classe tem cotação de mercado automática',
      semCotacao: rows.filter((p) => p.lastPricedOn === null).length,
      notaDeEscopo:
        'esta classe entra no patrimônio líquido mas fica fora da política de alocação da carteira, porque não se rebalanceia um bem físico',
    },
  }
}

/* ------------------------------------------------------------------ *
 * Emergency reserve — "não investe nada até ter Nx o custo de vida
 * guardado". The target is a multiple of the REAL average monthly
 * expense (never a stored number that could go stale), and progress is
 * the sum of whichever assets the user has flagged as reserve holdings
 * (a CDB, Tesouro Selic — something liquid and safe, by their choice,
 * not a hardcoded asset class).
 *
 * A dedicated "Reserva de emergência" asset (class `cash`, always
 * flagged `countsTowardReserve`) is auto-created on first use so there
 * is always one obvious, one-click place to log a reserve contribution
 * and see its history — the per-asset toggle in "Meus ativos" still
 * works for anyone who'd rather park the reserve in a real CDB/Tesouro
 * Selic instead.
 * ------------------------------------------------------------------ */
export const RESERVE_ASSET_NAME = 'Reserva de emergência'

/** Its unit price is pinned at R$1,00/"cota" — quantity in reais *is* the amount, so no valuation step is ever needed. */
const RESERVE_UNIT_PRICE_CENTS = 100

export async function ensureReserveAsset(): Promise<number> {
  const existing = (
    await db
      .select({ id: assets.id, countsTowardReserve: assets.countsTowardReserve })
      .from(assets)
      .where(eq(assets.name, RESERVE_ASSET_NAME))
  )[0]
  if (existing) {
    if (!existing.countsTowardReserve) {
      await db.update(assets).set({ countsTowardReserve: true }).where(eq(assets.id, existing.id))
    }
    return existing.id
  }
  const created = (
    await db
      .insert(assets)
      .values({ name: RESERVE_ASSET_NAME, assetClass: 'cash', countsTowardReserve: true })
      .returning({ id: assets.id })
  )[0]!
  return created.id
}

/** One buy (or sell, to record a withdrawal) trade against the dedicated reserve asset — creating it on first use. */
export async function contributeToReserve(input: { amountCents: number; tradedOn: string; kind?: 'buy' | 'sell' }) {
  const assetId = await ensureReserveAsset()
  const amountCents = Math.abs(input.amountCents)
  return (
    await db
      .insert(assetTrades)
      .values({
        assetId,
        kind: input.kind ?? 'buy',
        tradedOn: input.tradedOn,
        quantity: amountCents / 100,
        unitPriceCents: RESERVE_UNIT_PRICE_CENTS,
        feesCents: 0,
      })
      .returning()
  )[0]!
}

export type ReserveStatus = {
  assetId: number | null
  multiple: number
  lookbackMonths: number
  monthlyLivingCostCents: number
  /** true when monthlyLivingCostCents is the user's own number, not the computed average */
  livingCostIsManual: boolean
  targetCents: number
  currentCents: number
  gapCents: number
  progressBps: number
}

type ReserveSettingsRow = { multiple: number; lookbackMonths: number; manualLivingCostCents: number | null }

async function reserveSettings(): Promise<ReserveSettingsRow> {
  const row = (await db.select().from(emergencyReserveSettings).where(eq(emergencyReserveSettings.id, 1)))[0]
  return row
    ? { multiple: row.multiple, lookbackMonths: row.lookbackMonths, manualLivingCostCents: row.manualLivingCostCents }
    : { multiple: 6, lookbackMonths: 3, manualLivingCostCents: null }
}

export async function setReserveSettings(patch: {
  multiple?: number
  lookbackMonths?: number
  /** pass null to clear the override and go back to the computed average */
  manualLivingCostCents?: number | null
}): Promise<ReserveSettingsRow> {
  const existing = (await db.select().from(emergencyReserveSettings).where(eq(emergencyReserveSettings.id, 1)))[0]
  if (existing) {
    const updated = (
      await db.update(emergencyReserveSettings).set(patch).where(eq(emergencyReserveSettings.id, 1)).returning()
    )[0]!
    return {
      multiple: updated.multiple,
      lookbackMonths: updated.lookbackMonths,
      manualLivingCostCents: updated.manualLivingCostCents,
    }
  }
  const created = (
    await db
      .insert(emergencyReserveSettings)
      .values({
        id: 1,
        multiple: patch.multiple ?? 6,
        lookbackMonths: patch.lookbackMonths ?? 3,
        manualLivingCostCents: patch.manualLivingCostCents ?? null,
      })
      .returning()
  )[0]!
  return {
    multiple: created.multiple,
    lookbackMonths: created.lookbackMonths,
    manualLivingCostCents: created.manualLivingCostCents,
  }
}

export async function reserveStatus(): Promise<ReserveStatus> {
  const { multiple, lookbackMonths, manualLivingCostCents } = await reserveSettings()

  let monthlyLivingCostCents: number
  if (manualLivingCostCents !== null) {
    monthlyLivingCostCents = manualLivingCostCents
  } else {
    const currentPeriod = todayIso().slice(0, 7)
    const from = periodBounds(addMonths(currentPeriod, -lookbackMonths)).start
    const to = periodBounds(addMonths(currentPeriod, -1)).end
    // The average mixes every account (PF personal AND PJ business) — a
    // real value, but one that can overstate PERSONAL cost of living,
    // which is exactly why a manual override exists above.
    const expenseCents = lookbackMonths > 0 ? (await totals({ from, to })).expenseCents : 0
    monthlyLivingCostCents = lookbackMonths > 0 ? Math.round(expenseCents / lookbackMonths) : 0
  }

  const targetCents = monthlyLivingCostCents * multiple
  const currentCents = (await positions())
    .filter((p) => p.countsTowardReserve)
    .reduce((s, p) => s + p.marketValueCents, 0)
  const gapCents = Math.max(0, targetCents - currentCents)
  // Not auto-created here — reading the reserve card shouldn't conjure the
  // asset into "Meus ativos" before the user actually contributes once.
  const reserveAsset = (await db.select({ id: assets.id }).from(assets).where(eq(assets.name, RESERVE_ASSET_NAME)))[0]

  return {
    assetId: reserveAsset?.id ?? null,
    multiple,
    lookbackMonths,
    monthlyLivingCostCents,
    livingCostIsManual: manualLivingCostCents !== null,
    targetCents,
    currentCents,
    gapCents,
    progressBps: targetCents > 0 ? Math.round((currentCents / targetCents) * 10_000) : 0,
  }
}

export async function portfolioSummary() {
  const rows = await positions()
  const marketValueCents = rows.reduce((s, p) => s + p.marketValueCents, 0)
  const contributedCents = rows.reduce((s, p) => s + p.contributedCents, 0)
  const dividendsCents = rows.reduce((s, p) => s + p.dividendsCents, 0)
  const gainCents = marketValueCents - contributedCents + dividendsCents

  return {
    positions: rows,
    marketValueCents,
    contributedCents,
    dividendsCents,
    gainCents,
    gainBps: contributedCents > 0 ? Math.round((gainCents / contributedCents) * 10_000) : null,
    assetCount: rows.length,
    unpricedCount: rows.filter((p) => p.lastUnitPriceCents === null && p.quantity > 0).length,
  }
}

/* ------------------------------------------------------------------ *
 * Allocation: where the money actually is vs where it should be
 * ------------------------------------------------------------------ */
export type AllocationSlice = {
  assetClass: string
  label: string
  valueCents: number
  actualBps: number
  targetBps: number | null
  driftBps: number | null
  /** what to move to hit the target, signed */
  rebalanceCents: number | null
}

export async function allocation(goalId?: number | null): Promise<AllocationSlice[]> {
  const rows = (await positions()).filter((p) => p.assetClass !== ILLIQUID_ASSET_CLASS)
  const total = rows.reduce((s, p) => s + p.marketValueCents, 0)

  const byClass = new Map<string, number>()
  for (const p of rows) byClass.set(p.assetClass, (byClass.get(p.assetClass) ?? 0) + p.marketValueCents)

  const targets = new Map<string, number>()
  const targetRows = await db
    .select()
    .from(targetAllocations)
    .where(goalId ? eq(targetAllocations.goalId, goalId) : sql`goal_id is null`)
  for (const t of targetRows) {
    if (t.assetClass === ILLIQUID_ASSET_CLASS) continue
    targets.set(t.assetClass, t.targetBps)
  }

  const classes = new Set([...byClass.keys(), ...targets.keys()])
  return [...classes]
    .map((assetClass) => {
      const valueCents = byClass.get(assetClass) ?? 0
      const actualBps = total > 0 ? Math.round((valueCents / total) * 10_000) : 0
      const targetBps = targets.get(assetClass) ?? null
      return {
        assetClass,
        label: ASSET_CLASS_LABELS[assetClass] ?? assetClass,
        valueCents,
        actualBps,
        targetBps,
        driftBps: targetBps === null ? null : actualBps - targetBps,
        rebalanceCents:
          targetBps === null || total === 0
            ? null
            : Math.round((targetBps / 10_000) * total) - valueCents,
      }
    })
    .sort((a, b) => b.valueCents - a.valueCents)
}

/* ------------------------------------------------------------------ *
 * Desvio de alocação
 *
 * The same numbers `allocation()` already derives, narrowed to the one
 * question this view answers: how far is the portfolio from the policy the
 * user set for it. It is a managerial report, not advice.
 *
 * The shape is deliberately poorer than `allocation()`: no `rebalanceCents`,
 * no suggested asset, no recommended action, no field that could be read as
 * one. That absence is the point. `decisions/0010` draws the line, and the
 * Ofício-Circular CVM/SIN 2/2026 is why the line matters for investments
 * specifically: it distinguishes a report on portfolio composition against
 * the client's own investment policy from consultoria de valores
 * mobiliários, which is the regulated activity of recommending. A field
 * naming what to buy would move this endpoint across that line, so no such
 * field exists to be accidentally rendered later.
 *
 * Order is alphabetical by class label, never by size of the deviation:
 * ranking by "what to fix first" would be a recommendation expressed as a
 * sort order.
 * ------------------------------------------------------------------ */
export type AllocationDeviation = {
  assetClass: string
  label: string
  /** current share of the portfolio, basis points */
  actualBps: number
  /** the share the user configured for this class, basis points */
  targetBps: number
  /** actual minus target, in basis points; positive = above the policy */
  deviationBps: number
}

export async function allocationDeviation(goalId?: number | null): Promise<{
  classes: AllocationDeviation[]
  assumptions: Record<string, unknown>
}> {
  const classes = (await allocation(goalId))
    .filter((slice) => slice.targetBps !== null)
    .map((slice) => ({
      assetClass: slice.assetClass,
      label: slice.label,
      actualBps: slice.actualBps,
      targetBps: slice.targetBps!,
      deviationBps: slice.actualBps - slice.targetBps!,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))

  return {
    classes,
    assumptions: {
      formula: 'percentual atual da classe na carteira menos o percentual definido na política de alocação do usuário',
      classesComMeta: classes.length,
      goalId: goalId ?? null,
      origem: 'posições derivadas de asset_trades e asset_valuations, metas de target_allocations',
      ordem: 'alfabética por classe, deliberadamente neutra: a ordem não é calculada a partir do tamanho do desvio',
    },
  }
}

/* ------------------------------------------------------------------ *
 * "Diagrama do Cerrado" — resistance-note-weighted allocation, one
 * level below the class. The class gets its target share of the whole
 * portfolio from `target_allocations` (level 1); WITHIN the class,
 * each scored asset's share is proportional to its resistance note
 * (level 2) — a note-10 asset can claim far more of the class's slice
 * than a note-3 one, and an unscored asset claims none of it until the
 * questionnaire is answered.
 * ------------------------------------------------------------------ */
export type AssetAllocationSlice = {
  assetId: number
  name: string
  ticker: string | null
  sector: string | null
  note: number | null
  answered: number
  totalCriteria: number
  valueCents: number
  /** share of the CLASS's current value (bps) */
  actualBps: number
  /** share of the CLASS's target value, derived from the note (bps) — null if unscored */
  targetBps: number | null
  driftBps: number | null
  /** vs. this asset's note-derived slice of the class's target value */
  rebalanceCents: number | null
  /** last known quote — null until a quote/valuation has ever been recorded */
  lastUnitPriceCents: number | null
}

export type ClassAllocationDetail = {
  assetClass: string
  label: string
  classValueCents: number
  classTargetBps: number | null
  classTargetValueCents: number | null
  unscoredValueCents: number
  assets: AssetAllocationSlice[]
}

export async function assetAllocationWithinClass(
  assetClass: string,
  goalId?: number | null,
  /**
   * Caller já tem a carteira (e o alvo da classe) em mãos — `suggestContribution`
   * chama esta função uma vez por classe dentro de um `Promise.all`, e sem
   * isto cada chamada refazia `positions()` (JOIN+GROUP BY sobre todos os
   * trades) e a busca de metas do zero, N vezes para a MESMA carteira
   * (achado de 29/08/2026). Standalone callers (rota de UI, scripts/verify.ts)
   * seguem se virando sozinhos.
   */
  preloaded?: { allRows: Position[]; classTargetBps: number | null },
): Promise<ClassAllocationDetail> {
  const allRows = preloaded?.allRows ?? (await positions())
  const totalPortfolioCents = allRows.reduce((s, p) => s + p.marketValueCents, 0)
  const classRows = allRows.filter((p) => p.assetClass === assetClass)
  const classValueCents = classRows.reduce((s, p) => s + p.marketValueCents, 0)

  const classTargetBps =
    preloaded !== undefined
      ? preloaded.classTargetBps
      : ((
          await db
            .select({ targetBps: targetAllocations.targetBps })
            .from(targetAllocations)
            .where(
              and(
                eq(targetAllocations.assetClass, assetClass as AssetClass),
                goalId ? eq(targetAllocations.goalId, goalId) : sql`goal_id is null`,
              ),
            )
        )[0]?.targetBps ?? null)
  const classTargetValueCents =
    classTargetBps === null ? null : Math.round((classTargetBps / 10_000) * totalPortfolioCents)

  // Cada Position já carrega sua própria nota — `positions()` já buscou
  // `notesForAssets` uma vez para a carteira inteira (linha acima). Reconsultar
  // aqui só pra fatia da classe seria o mesmo dado, uma segunda vez.
  // An asset with no note (nothing answered yet) has no valid weight —
  // excluding it from the sum is what makes "unscored" mean "claims
  // nothing yet" rather than "scored zero", which is a very different,
  // unfair statement.
  const noteSum = classRows.reduce((sum, p) => (p.note === null ? sum : sum + p.note), 0)

  let unscoredValueCents = 0
  const assetSlices: AssetAllocationSlice[] = classRows.map((p) => {
    const note = p.note
    const scored = note !== null
    if (!scored) unscoredValueCents += p.marketValueCents

    const actualBps = classValueCents > 0 ? Math.round((p.marketValueCents / classValueCents) * 10_000) : 0
    const targetBps = scored && noteSum > 0 ? Math.round((note / noteSum) * 10_000) : null
    const targetValueCents =
      targetBps === null || classTargetValueCents === null
        ? null
        : Math.round((targetBps / 10_000) * classTargetValueCents)

    return {
      assetId: p.assetId,
      name: p.name,
      ticker: p.ticker,
      sector: p.sector,
      note: p.note,
      answered: p.answeredCriteria,
      totalCriteria: p.totalCriteria,
      valueCents: p.marketValueCents,
      actualBps,
      targetBps,
      driftBps: targetBps === null ? null : actualBps - targetBps,
      rebalanceCents: targetValueCents === null ? null : targetValueCents - p.marketValueCents,
      lastUnitPriceCents: p.lastUnitPriceCents,
    }
  })

  return {
    assetClass,
    label: ASSET_CLASS_LABELS[assetClass] ?? assetClass,
    classValueCents,
    classTargetBps,
    classTargetValueCents,
    unscoredValueCents,
    assets: assetSlices.sort((a, b) => b.valueCents - a.valueCents),
  }
}

/* ------------------------------------------------------------------ *
 * Contribution waterfall — "aportar sem vender". Given a new
 * contribution, points at the single most underweight class, then the
 * single most underweight scored asset within it, filling each in turn
 * until the money runs out. Never suggests selling anything; an asset
 * already at or above its note-derived slice simply stops receiving
 * new money until the rest of the portfolio catches up.
 * ------------------------------------------------------------------ */
export type ContributionAssetSuggestion = {
  assetId: number
  name: string
  ticker: string | null
  sector: string | null
  note: number
  suggestedCents: number
  /** null when the asset has no recorded quote yet — suggestedCents is then a raw rebalance amount, not a whole-share purchase */
  unitPriceCents: number | null
  /** whole shares `suggestedCents` actually buys at unitPriceCents — 0 when unitPriceCents is null */
  quantity: number
}

export type ContributionClassSuggestion = {
  assetClass: string
  label: string
  /** how underweight the class was before this contribution, in cents */
  deltaCents: number
  allocatedCents: number
  assets: ContributionAssetSuggestion[]
}

export type ContributionPlan = {
  amountCents: number
  totalBeforeCents: number
  totalAfterCents: number
  /**
   * The reserve-first step, ahead of any class in the waterfall — "não
   * investe nada até ter a reserva completa" isn't a suggestion among
   * others, it is priority zero. `allocatedCents` is capped at the
   * reserve's own gap, so once it is full this is always zero and the
   * whole contribution flows to the classes below.
   */
  reserve: {
    allocatedCents: number
    gapCents: number
    targetCents: number
    currentCents: number
    multiple: number
  }
  classes: ContributionClassSuggestion[]
  /**
   * Money the waterfall could not place — every eligible class/asset was
   * already at or above target. Surfaced rather than silently dropped,
   * per the no-silent-caps rule: the honest answer is "nothing left to
   * rebalance toward", not a number that quietly doesn't add up.
   */
  unallocatedCents: number
}

/**
 * Round-robins across sectors instead of letting the single highest-note
 * asset (or a handful of them in the same sector) absorb the whole class
 * allocation before a second sector gets a look. Same "biggest gap
 * first" ordering the plan always used — assets within a sector still
 * queue by how underweight they are — just taking turns BY SECTOR so a
 * contribution actually diversifies instead of concentrating wherever
 * the top-scored asset happens to sit. Assets with no sector on record
 * yet (quote never refreshed) share one "Sem setor" bucket rather than
 * each acting as its own sector of one.
 */
function allocateAcrossSectors(
  candidates: Array<{ a: AssetAllocationSlice; delta: number }>,
  budgetCents: number,
): ContributionAssetSuggestion[] {
  const bySector = new Map<string, Array<{ a: AssetAllocationSlice; delta: number }>>()
  for (const item of candidates) {
    const key = item.a.sector ?? 'Sem setor'
    const list = bySector.get(key) ?? []
    list.push(item)
    bySector.set(key, list)
  }
  for (const list of bySector.values()) list.sort((x, y) => y.delta - x.delta)

  const sectorKeys = [...bySector.keys()]
  const suggestions: ContributionAssetSuggestion[] = []
  let remaining = budgetCents
  let sectorIndex = 0
  // Conta candidatos ainda não tentados, não "rodadas vazias em sequência":
  // um setor só com ativos que não cabem no orçamento não pode encerrar o
  // laço enquanto outro ativo do MESMO setor, mais barato, ainda nem foi
  // tentado — um `emptyStreak` comparado a `sectorKeys.length` fazia
  // exatamente isso quando havia 1 ou poucos setores (ex. Tesouro Direto,
  // sempre "Sem setor"): o primeiro título caro descartava o rateio
  // inteiro daquela classe antes de chegar ao segundo, mais barato.
  let candidatesLeft = candidates.length

  while (remaining > 0 && candidatesLeft > 0) {
    const key = sectorKeys[sectorIndex % sectorKeys.length]!
    sectorIndex++
    const queue = bySector.get(key)!
    const next = queue.shift()
    if (!next) continue
    candidatesLeft--

    const unitPriceCents = next.a.lastUnitPriceCents
    const basics = {
      assetId: next.a.assetId,
      name: next.a.name,
      ticker: next.a.ticker,
      sector: next.a.sector,
      note: next.a.note!,
    }

    // No quote on record yet — can't reason about whole shares, so fall
    // back to a raw monetary amount rather than blocking the suggestion.
    if (!unitPriceCents || unitPriceCents <= 0) {
      const suggestedCents = Math.min(remaining, next.delta)
      if (suggestedCents <= 0) continue
      suggestions.push({ ...basics, suggestedCents, unitPriceCents: null, quantity: 0 })
      remaining -= suggestedCents
      continue
    }

    // A suggestion nobody can execute (less than the cost of one share)
    // is worse than no suggestion at all — round to whole shares, and
    // once at least one is affordable, buy at least that one even if it
    // slightly overshoots this asset's rebalance gap.
    const affordableQty = Math.floor(remaining / unitPriceCents)
    if (affordableQty < 1) continue
    const desiredQty = Math.max(1, Math.round(next.delta / unitPriceCents))
    const quantity = Math.min(affordableQty, desiredQty)
    const suggestedCents = quantity * unitPriceCents
    suggestions.push({ ...basics, suggestedCents, unitPriceCents, quantity })
    remaining -= suggestedCents
  }
  return suggestions
}

export async function suggestContribution(amountCents: number, goalId?: number | null): Promise<ContributionPlan> {
  // Uma só leitura da carteira serve o total E cada classe abaixo — antes
  // eram N+1 chamadas idênticas a positions() (uma aqui pro total,
  // descartada, mais uma por classe dentro do Promise.all), cada uma
  // refazendo o mesmo JOIN+GROUP BY sobre todos os trades e a mesma busca
  // de notas por ativo (achado de 29/08/2026).
  const allRows = await positions()
  const totalBeforeCents = allRows.reduce((s, p) => s + p.marketValueCents, 0)
  const totalAfterCents = totalBeforeCents + amountCents

  const reserve = await reserveStatus()
  const reserveAllocatedCents = Math.min(amountCents, reserve.gapCents)

  const classTargets = await db
    .select({ assetClass: targetAllocations.assetClass, targetBps: targetAllocations.targetBps })
    .from(targetAllocations)
    .where(goalId ? eq(targetAllocations.goalId, goalId) : sql`goal_id is null`)

  // Kept unfiltered (unlike classQueue below) so LEVEL 4 can still reach a
  // class that started at or above its own target — see decisions/0019.
  const allClasses = await Promise.all(
    classTargets.map(async (ct) => {
      const detail = await assetAllocationWithinClass(ct.assetClass, goalId, {
        allRows,
        classTargetBps: ct.targetBps,
      })
      const targetValueCents = Math.round((ct.targetBps / 10_000) * totalAfterCents)
      return {
        assetClass: ct.assetClass,
        label: detail.label,
        detail,
        targetBps: ct.targetBps,
        deltaCents: targetValueCents - detail.classValueCents,
      }
    }),
  )

  const classQueue = allClasses.filter((c) => c.deltaCents > 0).sort((a, b) => b.deltaCents - a.deltaCents)

  const remainingAfterReserve = amountCents - reserveAllocatedCents
  const classes: ContributionClassSuggestion[] = []

  /**
   * LEVEL 1 (class) distributes PROPORTIONALLY TO THE GAP, all eligible
   * classes in the same round — it used to be a sequential waterfall that
   * filled the most underweight class completely before anything reached the
   * second, which made every contribution smaller than the largest gap look
   * like an all-or-nothing bet on one class. See `decisions/0013`.
   *
   * Only classes with `deltaCents > 0` are in `classQueue`, so a class
   * already at or above its target has no share by construction — that is
   * the bug the reference tool had, and the reason the split is over the gap
   * and not over the target percentage.
   *
   * LEVEL 2 (asset within the class, `allocateAcrossSectors`) is untouched:
   * it solves a different problem (spreading across sectors while respecting
   * whole shares).
   */
  const candidatesFor = (c: (typeof classQueue)[number]) =>
    c.detail.assets
      .filter((a) => a.note !== null && a.answered > 0 && (a.rebalanceCents ?? 0) > 0)
      .map((a) => ({ a, delta: a.rebalanceCents! }))

  const totalDeltaCents = classQueue.reduce((sum, c) => sum + c.deltaCents, 0)
  const closesEveryGap = totalDeltaCents <= remainingAfterReserve

  if (totalDeltaCents > 0 && remainingAfterReserve > 0) {
    if (closesEveryGap) {
      // Cada classe recebe exatamente o próprio gap — sem disputa por
      // dinheiro entre classes, então não há o que redistribuir aqui.
      for (const c of classQueue) {
        const assetSuggestions = allocateAcrossSectors(candidatesFor(c), c.deltaCents)
        const allocatedCents = assetSuggestions.reduce((sum, s) => sum + s.suggestedCents, 0)
        if (allocatedCents > 0) {
          classes.push({ assetClass: c.assetClass, label: c.label, deltaCents: c.deltaCents, allocatedCents, assets: assetSuggestions })
        }
      }
    } else {
      // decisions/0022: o aporte não fecha todo gap, então a fatia de cada
      // classe é proporcional ao gap — mas em rodadas, não uma vez só. Uma
      // classe cuja capacidade real (ativos elegíveis, cotas inteiras) é
      // menor que a fatia que lhe cabia devolve a diferença para as
      // classes que ainda têm gap aberto E espaço livre, em vez de deixar
      // parado em unallocatedCents enquanto outra classe teria absorvido.
      const entries = classQueue.map((c) => ({
        c,
        // Sonda com o teto real (nunca mais que o próprio gap) para achar
        // a capacidade verdadeira, já respeitando preço por cota inteira —
        // não uma segunda fórmula paralela a allocateAcrossSectors.
        ceilingCents: allocateAcrossSectors(
          candidatesFor(c),
          Math.min(c.deltaCents, remainingAfterReserve),
        ).reduce((sum, s) => sum + s.suggestedCents, 0),
        allocCents: 0,
      }))

      let pool = remainingAfterReserve
      let active = entries.filter((e) => e.ceilingCents > 0)
      for (let round = 0; round < entries.length + 1 && pool > 0 && active.length > 0; round++) {
        const poolAtRoundStart = pool
        const totalActiveDelta = active.reduce((sum, e) => sum + e.c.deltaCents, 0)
        if (totalActiveDelta <= 0) break

        let anyCapped = false
        for (const e of active) {
          const offer = Math.min(
            Math.round((e.c.deltaCents / totalActiveDelta) * poolAtRoundStart),
            pool,
          )
          const room = e.ceilingCents - e.allocCents
          const grant = Math.min(offer, room)
          e.allocCents += grant
          pool -= grant
          if (grant >= room) anyCapped = true
        }
        active = active.filter((e) => e.allocCents < e.ceilingCents)
        // Nenhuma classe bateu no teto nesta rodada: a fatia proporcional
        // já cobriu tudo o que cada uma pedia, convergiu.
        if (!anyCapped) break
      }

      for (const e of entries) {
        if (e.allocCents <= 0) continue
        const assetSuggestions = allocateAcrossSectors(candidatesFor(e.c), e.allocCents)
        const allocatedCents = assetSuggestions.reduce((sum, s) => sum + s.suggestedCents, 0)
        if (allocatedCents > 0) {
          classes.push({
            assetClass: e.c.assetClass,
            label: e.c.label,
            deltaCents: e.c.deltaCents,
            allocatedCents,
            assets: assetSuggestions,
          })
        }
      }
    }
  }

  // Whatever the classes actually absorbed, summed after the loop. The rest
  // (rounding, plus any share a class's scored assets could not take in
  // whole shares) stays unallocated rather than being silently reassigned.
  const allocatedToClassesCents = classes.reduce((sum, c) => sum + c.allocatedCents, 0)
  const remaining = remainingAfterReserve - allocatedToClassesCents

  /**
   * LEVEL 4 — once every eligible class's gap is fully closed (the
   * contribution is bigger than the sum of every gap), the rest doesn't sit
   * unallocated: it distributes across ALL classes with a configured target
   * proportional to that target weight (`targetBps`), since with every gap
   * at zero there is no longer a "who's most behind" to break the tie.
   * See `decisions/0019` — this is a distinct pool from `remaining` above:
   * only triggers when EVERY gap actually closed (`closesEveryGap`), never
   * when the contribution was merely too small and some classes got a
   * partial, proportional-to-gap share instead of their full delta.
   */
  const overflowAfterGapsCents = closesEveryGap ? Math.max(0, remainingAfterReserve - totalDeltaCents) : 0
  const targetWeightedClasses = allClasses.filter((c) => c.targetBps > 0)
  const totalTargetBpsEligible = targetWeightedClasses.reduce((sum, c) => sum + c.targetBps, 0)

  // Same round-based redistribution as the !closesEveryGap branch above
  // (decisions/0022), applied here too: a single pass that dropped a
  // class's undelivered share on the floor (whole-share rounding, or too
  // few scored assets to absorb its proportional cut) used to leave real
  // money in `unallocatedCents` even though other target-weighted classes
  // still had room — achado da revisão de 29/08/2026, mesmo defeito, agora
  // corrigido do mesmo jeito.
  const candidatesForTarget = (c: (typeof targetWeightedClasses)[number]) =>
    c.detail.assets
      .filter((a) => a.note !== null && a.answered > 0 && (a.rebalanceCents ?? 0) > 0)
      .map((a) => ({ a, delta: a.rebalanceCents! }))

  let overflowRemaining = overflowAfterGapsCents
  if (overflowAfterGapsCents > 0 && totalTargetBpsEligible > 0) {
    const entries = targetWeightedClasses.map((c) => ({
      c,
      // Sonda com o teto do overflow inteiro (não a fatia proporcional) —
      // mesma lógica de "achar a capacidade real primeiro" do outro ramo.
      ceilingCents: allocateAcrossSectors(candidatesForTarget(c), overflowAfterGapsCents).reduce(
        (sum, s) => sum + s.suggestedCents,
        0,
      ),
      allocCents: 0,
    }))

    let pool = overflowAfterGapsCents
    let active = entries.filter((e) => e.ceilingCents > 0)
    for (let round = 0; round < entries.length + 1 && pool > 0 && active.length > 0; round++) {
      const poolAtRoundStart = pool
      const totalActiveTargetBps = active.reduce((sum, e) => sum + e.c.targetBps, 0)
      if (totalActiveTargetBps <= 0) break

      let anyCapped = false
      for (const e of active) {
        const offer = Math.min(
          Math.round((e.c.targetBps / totalActiveTargetBps) * poolAtRoundStart),
          pool,
        )
        const room = e.ceilingCents - e.allocCents
        const grant = Math.min(offer, room)
        e.allocCents += grant
        pool -= grant
        if (grant >= room) anyCapped = true
      }
      active = active.filter((e) => e.allocCents < e.ceilingCents)
      if (!anyCapped) break
    }
    overflowRemaining = pool

    for (const e of entries) {
      if (e.allocCents <= 0) continue
      const assetSuggestions = allocateAcrossSectors(candidatesForTarget(e.c), e.allocCents)
      const allocatedCents = assetSuggestions.reduce((sum, s) => sum + s.suggestedCents, 0)
      if (allocatedCents <= 0) continue

      const existing = classes.find((entry) => entry.assetClass === e.c.assetClass)
      if (existing) {
        existing.allocatedCents += allocatedCents
        existing.assets = mergeAssetSuggestions(existing.assets, assetSuggestions)
      } else {
        classes.push({
          assetClass: e.c.assetClass,
          label: e.c.label,
          deltaCents: e.c.deltaCents,
          allocatedCents,
          assets: assetSuggestions,
        })
      }
    }
  }

  return {
    amountCents,
    totalBeforeCents,
    totalAfterCents,
    reserve: {
      allocatedCents: reserveAllocatedCents,
      gapCents: reserve.gapCents,
      targetCents: reserve.targetCents,
      currentCents: reserve.currentCents,
      multiple: reserve.multiple,
    },
    classes,
    unallocatedCents: Math.max(0, remaining - (overflowAfterGapsCents - overflowRemaining)),
  }
}

/** Combines two suggestion batches for the same class, summing entries that hit the same asset twice (once from the gap-driven waterfall, once from the target-weight overflow of decisions/0019). */
function mergeAssetSuggestions(
  a: ContributionAssetSuggestion[],
  b: ContributionAssetSuggestion[],
): ContributionAssetSuggestion[] {
  const merged = new Map<number, ContributionAssetSuggestion>()
  for (const s of a) merged.set(s.assetId, { ...s })
  for (const s of b) {
    const current = merged.get(s.assetId)
    if (!current) {
      merged.set(s.assetId, { ...s })
      continue
    }
    current.suggestedCents += s.suggestedCents
    current.quantity += s.quantity
  }
  return [...merged.values()]
}

/* ------------------------------------------------------------------ *
 * Performance: portfolio value vs contributed capital, same axis.
 * ------------------------------------------------------------------ */
export type PerformancePoint = {
  period: string
  contributedCents: number
  valueCents: number
  gainCents: number
}

/** `and a.asset_class = X`, or nothing — composed straight into the SQL below. */
const classFilter = (assetClass?: string | null) =>
  assetClass ? sql`and a.asset_class = ${assetClass}` : sql``

export async function performanceSeries(months = 24, assetClass?: string | null): Promise<PerformancePoint[]> {
  const rows = await db.execute<{ first: string | null }>(sql`
    select min(t.traded_on) as first
    from asset_trades t join assets a on a.id = t.asset_id
    where a.archived = false ${classFilter(assetClass)}
  `)
  const first = rows[0]
  if (!first?.first) return []

  const endPeriod = todayIso().slice(0, 7)
  const startPeriod = periodOf(first.first)
  const window = periodRange(startPeriod, endPeriod).slice(-months)

  return Promise.all(
    window.map(async (period) => {
      const cutoff = `${period}-31`
      const snap = await snapshotAsOf(cutoff, assetClass)
      return {
        period,
        contributedCents: snap.contributedCents,
        valueCents: snap.valueCents,
        gainCents: snap.valueCents - snap.contributedCents,
      }
    }),
  )
}

export type MonthlyReturnPoint = { period: string; returnBps: number | null }

/**
 * Approximates each month's return as (end value − net contribution in
 * the month) / start value − 1: a Modified-Dietz-style simplification
 * that ignores exactly when in the month a contribution landed. Good
 * enough to compare the portfolio's shape against a benchmark; not a
 * precise time-weighted return. The first month in the series has no
 * prior value to divide by, so it comes back `null` rather than a
 * misleading 0%.
 */
export async function portfolioMonthlyReturns(assetClass?: string | null): Promise<MonthlyReturnPoint[]> {
  const series = await performanceSeries(100_000, assetClass)
  return series.map((point, i) => {
    if (i === 0) return { period: point.period, returnBps: null }
    const prev = series[i - 1]!
    const netContributionCents = point.contributedCents - prev.contributedCents
    if (prev.valueCents <= 0) return { period: point.period, returnBps: null }
    const returnBps = Math.round(((point.valueCents - netContributionCents) / prev.valueCents - 1) * 10_000)
    return { period: point.period, returnBps }
  })
}

export type ProfitabilityYearRow = {
  year: number
  /** index 0 = January .. 11 = December */
  months: Array<number | null>
  annualReturnBps: number | null
  /** cumulative return since inception, through the end of this year */
  cumulativeReturnBps: number
}

/** Year rows (most recent first) × month columns, plus annual and running-cumulative return. */
export async function profitabilityTable(assetClass?: string | null): Promise<ProfitabilityYearRow[]> {
  const monthly = await portfolioMonthlyReturns(assetClass)
  const byYear = new Map<number, Array<number | null>>()
  for (const point of monthly) {
    const year = Number(point.period.slice(0, 4))
    const month = Number(point.period.slice(5, 7)) - 1
    const months = byYear.get(year) ?? Array(12).fill(null)
    months[month] = point.returnBps
    byYear.set(year, months)
  }

  let cumulativeGrowth = 1
  const rows: ProfitabilityYearRow[] = [...byYear.keys()].sort().map((year) => {
    const months = byYear.get(year)!
    let yearGrowth = 1
    let hasData = false
    for (const bps of months) {
      if (bps === null) continue
      yearGrowth *= 1 + bps / 10_000
      hasData = true
    }
    cumulativeGrowth *= yearGrowth
    return {
      year,
      months,
      annualReturnBps: hasData ? Math.round((yearGrowth - 1) * 10_000) : null,
      cumulativeReturnBps: Math.round((cumulativeGrowth - 1) * 10_000),
    }
  })

  return rows.reverse()
}

/**
 * The same value/contributed/dividend snapshot `performanceSeries` builds
 * per month, but for one arbitrary cutoff date — the building block
 * `rangeSummary` needs to diff "as of the window start" against "as of
 * now" without duplicating the SQL for every caller.
 */
export type Snapshot = { contributedCents: number; valueCents: number; dividendsCents: number }

export async function snapshotAsOf(cutoffIso: string, assetClass?: string | null): Promise<Snapshot> {
  const rows = await db.execute<{ contributed: number; value: number; dividends: number }>(sql`
    select
      coalesce(sum(net.contributed), 0) as contributed,
      coalesce(sum(net.value), 0) as value,
      coalesce(sum(net.dividends), 0) as dividends
    from (
      select
        a.id,
        coalesce(sum(case when t.kind = 'buy'  then round(t.quantity * t.unit_price_cents) + t.fees_cents
                          when t.kind = 'sell' then -round(t.quantity * t.unit_price_cents)
                          else 0 end), 0) as contributed,
        coalesce(sum(case when t.kind = 'dividend' then round(t.quantity * t.unit_price_cents) else 0 end), 0) as dividends,
        round(
          coalesce(sum(case when t.kind = 'buy' then t.quantity when t.kind = 'sell' then -t.quantity else 0 end), 0)
          * coalesce(
              (select v.unit_price_cents from asset_valuations v
                where v.asset_id = a.id and v.as_of <= ${cutoffIso}
                order by v.as_of desc limit 1),
              case when coalesce(sum(case when t.kind = 'buy' then t.quantity else 0 end), 0) > 0
                then coalesce(sum(case when t.kind = 'buy' then round(t.quantity * t.unit_price_cents) else 0 end), 0)
                     / coalesce(sum(case when t.kind = 'buy' then t.quantity else 0 end), 1)
                else 0 end
            )
        ) as value
      from assets a
      left join asset_trades t on t.asset_id = a.id and t.traded_on <= ${cutoffIso}
      where a.archived = false ${classFilter(assetClass)}
      group by a.id
    ) net
  `)
  const row = rows[0]
  return { contributedCents: row?.contributed ?? 0, valueCents: row?.value ?? 0, dividendsCents: row?.dividends ?? 0 }
}

/**
 * Everything the summary dashboard's KPI row needs for one window: the
 * "in range" figures net out money added DURING the window (the diff
 * between the two contributed snapshots), so a big new deposit never
 * masquerades as market gain. `fromIso: null` means "desde o início" —
 * the window start snapshot is then all zeros, which collapses
 * "in range" into "all time" exactly, with no special-casing needed.
 */
export type RangeSummary = {
  fromIso: string | null
  toIso: string
  assetClass: string | null
  valueCents: number
  contributedCents: number
  dividendsCents: number
  dividendsInRangeCents: number
  capitalGainCents: number
  capitalGainInRangeCents: number
  totalGainCents: number
  gainBpsAllTime: number | null
  gainBpsInRange: number | null
  valueGrowthBpsInRange: number | null
}

export async function rangeSummary(fromIso: string | null, toIso: string, assetClass?: string | null): Promise<RangeSummary> {
  const now = await snapshotAsOf(toIso, assetClass)
  // `snapshotAsOf` is inclusive of its cutoff date, so diffing two snapshots
  // taken AT `fromIso` and `toIso` would silently drop anything traded on
  // `fromIso` itself from the "in range" figures (dividends, contributions)
  // — that activity happened ON the first day of the window, not before
  // it. Snapshotting the day BEFORE `fromIso` instead makes the diff cover
  // the whole inclusive [fromIso, toIso] range.
  const start = fromIso
    ? await snapshotAsOf(addDays(fromIso, -1), assetClass)
    : { contributedCents: 0, valueCents: 0, dividendsCents: 0 }

  const contributedInRangeCents = now.contributedCents - start.contributedCents
  const dividendsInRangeCents = now.dividendsCents - start.dividendsCents
  const capitalGainCents = now.valueCents - now.contributedCents
  const capitalGainInRangeCents = now.valueCents - start.valueCents - contributedInRangeCents
  const totalGainCents = capitalGainCents + now.dividendsCents

  return {
    fromIso,
    toIso,
    assetClass: assetClass ?? null,
    valueCents: now.valueCents,
    contributedCents: now.contributedCents,
    dividendsCents: now.dividendsCents,
    dividendsInRangeCents,
    capitalGainCents,
    capitalGainInRangeCents,
    totalGainCents,
    gainBpsAllTime: now.contributedCents > 0 ? Math.round((totalGainCents / now.contributedCents) * 10_000) : null,
    gainBpsInRange: start.valueCents > 0 ? Math.round((capitalGainInRangeCents / start.valueCents) * 10_000) : null,
    valueGrowthBpsInRange:
      start.valueCents > 0 ? Math.round(((now.valueCents - start.valueCents) / start.valueCents) * 10_000) : null,
  }
}

/* ------------------------------------------------------------------ *
 * Goals: contribution planning + projected growth
 * ------------------------------------------------------------------ */
export type GoalProjectionPoint = {
  month: number
  period: string
  /** value if only past contributions keep compounding */
  baselineCents: number
  /** value with the planned monthly contribution */
  projectedCents: number
  contributedCents: number
}

export async function goalProjection(
  goalId: number,
  horizonMonths = 120,
  /** a hypothetical one-time top-up TODAY, on top of the plan's own monthly contribution — Aportar tab asks "what if I put X in right now", never a second contribution schedule */
  extraContributionCents = 0,
) {
  const goal = (await db.select().from(investmentGoals).where(eq(investmentGoals.id, goalId)))[0]
  if (!goal) return null

  const summary = await portfolioSummary()
  const monthlyReturn = Math.pow(1 + goal.expectedReturnBps / 10_000, 1 / 12) - 1
  const startPeriod = todayIso().slice(0, 7)

  const series: GoalProjectionPoint[] = []
  // Only `projected` gets the one-time top-up — `baseline` answers a
  // different question ("if the monthly plan stopped"), orthogonal to a
  // hypothetical extra contribution on top of the existing plan.
  let projected = summary.marketValueCents + extraContributionCents
  let baseline = summary.marketValueCents
  let contributed = summary.contributedCents
  let reachedMonth: number | null = null

  const targetMonth = goal.targetDate ? monthsBetween(startPeriod, periodOf(goal.targetDate)) : null
  // A target beyond the default view horizon must EXTEND it, not shrink it —
  // capping at `Math.min` here used to truncate a 20-year goal's series to
  // the default 10-year window, so "valor projetado na data-alvo" silently
  // read off month 120 instead of month 240 (a value roughly a third of the
  // real compounded figure). 1200 (100 years) is just a sanity ceiling.
  const cap =
    targetMonth !== null && targetMonth > 0
      ? Math.min(Math.max(horizonMonths, targetMonth + 12), 1200)
      : horizonMonths

  for (let month = 0; month <= cap; month++) {
    if (month > 0) {
      projected = compoundStep(projected, monthlyReturn, goal.monthlyContributionCents)
      baseline = compoundStep(baseline, monthlyReturn, 0)
      contributed += goal.monthlyContributionCents
    }
    series.push({
      month,
      period: addMonths(startPeriod, month),
      baselineCents: Math.round(baseline),
      projectedCents: Math.round(projected),
      contributedCents: Math.round(contributed),
    })
    if (reachedMonth === null && goal.targetValueCents > 0 && projected >= goal.targetValueCents) {
      reachedMonth = month
    }
  }

  const valueAtTarget =
    targetMonth !== null && targetMonth >= 0 ? series[Math.min(targetMonth, series.length - 1)] : null

  /**
   * Estudo de viabilidade #10, 29/08/2026: cogitou-se reusar `targetState()`
   * (goals.ts) direto aqui pra unificar o vocabulário de estado entre metas.
   * Não dá certo — `targetState` compara o valor ATUAL contra 85% do alvo
   * FINAL, sem levar em conta quanto tempo ainda falta; pra uma meta de anos,
   * isso marcaria "at_risk" quase o tempo todo, mesmo no ritmo perfeito (só
   * bateria 85% perto do fim). `onTrack` acima já é o cálculo certo pra este
   * domínio (usa a trajetória projetada inteira e a data-alvo). O que dá pra
   * unificar sem regressão é só o VOCABULÁRIO de saída — mesmo union type
   * `GoalState`, pra badge/cor consistente na UI — nunca a fórmula.
   */
  const state: GoalState =
    goal.targetValueCents <= 0
      ? 'no_target'
      : summary.marketValueCents >= goal.targetValueCents
        ? 'met'
        : targetMonth === null
          ? reachedMonth !== null
            ? 'on_track'
            : 'at_risk'
          : targetMonth < 0
            ? 'missed'
            : reachedMonth !== null && reachedMonth <= targetMonth
              ? 'on_track'
              : 'at_risk'

  return {
    goal,
    series,
    currentValueCents: summary.marketValueCents,
    progressBps:
      goal.targetValueCents > 0
        ? Math.round((summary.marketValueCents / goal.targetValueCents) * 10_000)
        : null,
    reachedMonth,
    reachedPeriod: reachedMonth === null ? null : addMonths(startPeriod, reachedMonth),
    onTrack:
      targetMonth === null || reachedMonth === null ? null : reachedMonth <= targetMonth,
    state,
    /** monthly contribution that would hit the target exactly on the date */
    requiredMonthlyCents:
      targetMonth !== null && targetMonth > 0 && goal.targetValueCents > 0
        ? requiredContribution(
            summary.marketValueCents,
            goal.targetValueCents,
            monthlyReturn,
            targetMonth,
          )
        : null,
    projectedAtTargetCents: valueAtTarget?.projectedCents ?? null,
    /**
     * Quanto do que falta HOJE (valor atual, sem compor) este aporte
     * hipotético cobre — não quanto falta na data-alvo, que já muda com o
     * próprio aporte. `null` sem aporte ou sem gap real (meta já batida).
     */
    contributionShareOfGapBps:
      extraContributionCents > 0 && goal.targetValueCents > summary.marketValueCents
        ? Math.round((extraContributionCents / (goal.targetValueCents - summary.marketValueCents)) * 10_000)
        : null,
  }
}

/**
 * Um passo de composição mensal: valor anterior, rendendo o retorno mensal,
 * mais um fluxo fixo do mês (positivo = aporte, negativo = retirada).
 * Núcleo compartilhado entre `goalProjection` (aporte) e a simulação de
 * decumulação de `services/simulator.ts` (retirada, mesmo passo com o sinal
 * invertido) — `decisions/0035` exige reusar, nunca duplicar esta fórmula.
 */
export function compoundStep(valueCents: number, monthlyReturn: number, monthlyFlowCents: number): number {
  return valueCents * (1 + monthlyReturn) + monthlyFlowCents
}

/** Future-value of an annuity, solved for the payment. */
function requiredContribution(
  presentCents: number,
  targetCents: number,
  monthlyReturn: number,
  months: number,
): number {
  if (months <= 0) return 0
  if (monthlyReturn === 0) return Math.max(0, Math.round((targetCents - presentCents) / months))
  const growth = Math.pow(1 + monthlyReturn, months)
  const needed = targetCents - presentCents * growth
  if (needed <= 0) return 0
  return Math.max(0, Math.round((needed * monthlyReturn) / (growth - 1)))
}

const monthsBetween = (from: string, to: string) => {
  const [fy, fm] = from.split('-').map(Number) as [number, number]
  const [ty, tm] = to.split('-').map(Number) as [number, number]
  return (ty - fy) * 12 + (tm - fm)
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */
export async function listAssets() {
  return db.select().from(assets).where(eq(assets.archived, false))
}

export async function createAsset(input: {
  name: string
  ticker?: string | null
  assetClass?: string
  accountId?: number | null
}) {
  return (
    await db
      .insert(assets)
      .values({ ...input, assetClass: input.assetClass as AssetClass | undefined })
      .returning()
  )[0]!
}

export async function updateAsset(id: number, patch: Record<string, unknown>) {
  return (
    (await db.update(assets).set(patch as Partial<typeof assets.$inferInsert>).where(eq(assets.id, id)).returning())[0] ?? null
  )
}

export async function deleteAsset(id: number) {
  return { removed: (await db.delete(assets).where(eq(assets.id, id))).count }
}

export async function listTrades(assetId?: number) {
  const query = db
    .select({
      id: assetTrades.id,
      assetId: assetTrades.assetId,
      assetName: assets.name,
      kind: assetTrades.kind,
      tradedOn: assetTrades.tradedOn,
      quantity: assetTrades.quantity,
      unitPriceCents: assetTrades.unitPriceCents,
      feesCents: assetTrades.feesCents,
    })
    .from(assetTrades)
    .innerJoin(assets, eq(assets.id, assetTrades.assetId))
    .orderBy(desc(assetTrades.tradedOn))
  return assetId ? query.where(eq(assetTrades.assetId, assetId)) : query
}

export async function createTrade(input: {
  assetId: number
  kind?: string
  tradedOn: string
  quantity: number
  unitPriceCents: number
  feesCents?: number
}) {
  return (
    await db
      .insert(assetTrades)
      .values({ ...input, kind: input.kind as TradeKind | undefined })
      .returning()
  )[0]!
}

/** Corrects a posting mistake in place — same fields `createTrade` accepts, all optional. */
export async function updateTrade(
  id: number,
  patch: {
    assetId?: number
    kind?: string
    tradedOn?: string
    quantity?: number
    unitPriceCents?: number
    feesCents?: number
  },
) {
  return (
    (
      await db
        .update(assetTrades)
        .set({ ...patch, kind: patch.kind as TradeKind | undefined })
        .where(eq(assetTrades.id, id))
        .returning()
    )[0] ?? null
  )
}

export async function deleteTrade(id: number) {
  return { removed: (await db.delete(assetTrades).where(eq(assetTrades.id, id))).count }
}

export async function recordValuation(assetId: number, asOf: string, unitPriceCents: number) {
  const existing = (
    await db
      .select()
      .from(assetValuations)
      .where(sql`${assetValuations.assetId} = ${assetId} and ${assetValuations.asOf} = ${asOf}`)
  )[0]
  if (existing) {
    return (
      await db.update(assetValuations).set({ unitPriceCents }).where(eq(assetValuations.id, existing.id)).returning()
    )[0]!
  }
  return (await db.insert(assetValuations).values({ assetId, asOf, unitPriceCents }).returning())[0]!
}

export async function listGoals() {
  return db.select().from(investmentGoals).where(eq(investmentGoals.active, true))
}

export async function createGoal(input: {
  name: string
  targetValueCents: number
  targetDate?: string | null
  monthlyContributionCents?: number
  expectedReturnBps?: number
  purpose?: string | null
}) {
  return (
    await db
      .insert(investmentGoals)
      .values({ ...input, purpose: input.purpose as GoalPurpose | undefined })
      .returning()
  )[0]!
}

export async function updateGoal(id: number, patch: Record<string, unknown>) {
  return (
    (
      await db
        .update(investmentGoals)
        .set(patch as Partial<typeof investmentGoals.$inferInsert>)
        .where(eq(investmentGoals.id, id))
        .returning()
    )[0] ?? null
  )
}

export async function deleteGoal(id: number) {
  return { removed: (await db.delete(investmentGoals).where(eq(investmentGoals.id, id))).count }
}

export async function setTargetAllocation(
  goalId: number | null,
  entries: Array<{ assetClass: string; targetBps: number }>,
) {
  await db.transaction(async (tx) => {
    await tx.delete(targetAllocations).where(goalId === null ? sql`goal_id is null` : eq(targetAllocations.goalId, goalId))
    for (const entry of entries) {
      if (entry.targetBps <= 0) continue
      await tx.insert(targetAllocations).values({ goalId, assetClass: entry.assetClass as AssetClass, targetBps: entry.targetBps })
    }
  })
  return allocation(goalId)
}
