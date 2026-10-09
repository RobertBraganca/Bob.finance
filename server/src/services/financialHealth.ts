import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { financialHealthSettings, monthlySnapshots } from '../db/schema'
import { addDays, addMonths, periodBounds, periodRange, todayIso } from '../core/dates'
import { accountBalances } from './analytics'
import { monthSpendingVsCap, typicalPersonalSpending } from './budget'
import { companyOverview } from './company'
import { debtOverviewV2, debtTrend } from './debt'
import { ILLIQUID_ASSET_CLASS, allocation, positions, reserveStatus } from './investments'
import { accountScope } from './withdrawals'

/**
 * The financial-health layer: Health Score, Runway, Radar de risco.
 *
 * Read-only, in the strictest sense this app has: not one number here is
 * stored. Every value is recomputed from `transactions` and from the debt,
 * card, goal and investment services on each request, exactly like the rest
 * of the app derives instead of caching (see PRD section 4). The single
 * thing this area persists is `financial_health_settings`: the user's own
 * weights and thresholds, so no calculation constant sits buried in code
 * where it can't be seen or changed.
 *
 * EVERY function that produces a number here also produces its
 * `assumptions`: the formula in words plus every input that fed it. That is
 * a data contract, not a UI nicety, and it is required by
 * `decisions/0010` (evidenciar, nunca prescrever): an instrumental sentence
 * without an auditable memory of calculation does not satisfy the ADR.
 *
 * The same ADR is why nothing here ranks, prioritizes or advises. An
 * indicator reports where it stands against a threshold the user chose;
 * what to do about it is never the system's sentence to finish.
 */

/* ------------------------------------------------------------------ *
 * Settings — weights and thresholds, singleton row (id = 1)
 * ------------------------------------------------------------------ */
export type HealthSettings = {
  weightLiquidity: number
  weightDebt: number
  weightSpending: number
  weightReserve: number
  weightAllocation: number
  costLookbackMonths: number
  riskCardShareBps: number
  riskReserveCoverageBps: number
  riskAllocationDriftBps: number
  riskSpendingCapBps: number
  riskDebtToIncomeBps: number
  /** slack, in bps, an indicator must clear on the good side to be a positive outlier */
  riskPositiveMarginBps: number
}

/**
 * Mirrors the column defaults. Kept here as well so a calculation never
 * needs a database round trip to know what "default" means, and so the
 * defaults are testable without a row existing.
 */
export const DEFAULT_HEALTH_SETTINGS: HealthSettings = {
  weightLiquidity: 20,
  weightDebt: 20,
  weightSpending: 20,
  weightReserve: 20,
  weightAllocation: 20,
  costLookbackMonths: 3,
  riskCardShareBps: 3_500,
  riskReserveCoverageBps: 10_000,
  riskAllocationDriftBps: 1_000,
  riskSpendingCapBps: 10_000,
  riskDebtToIncomeBps: 3_000,
  riskPositiveMarginBps: 2_000,
}

/**
 * Which asset classes count as liquid enough to sit inside the runway's
 * net worth. A default, never a hardcode: the caller can pass its own
 * list, and whichever list was used comes back in `assumptions`. Assets
 * the user flagged `countsTowardReserve` are always included, whatever
 * their class, because that flag is already the user saying "this is the
 * money I can reach in an emergency".
 */
export const DEFAULT_LIQUID_ASSET_CLASSES = ['cash', 'fixed_income', 'treasury'] as const

/** Window for "dívida de curto prazo" in the runway's net worth. */
const SHORT_TERM_DEBT_DAYS = 30

export async function getSettings(): Promise<HealthSettings> {
  const row = (await db.select().from(financialHealthSettings).where(eq(financialHealthSettings.id, 1)))[0]
  if (!row) return { ...DEFAULT_HEALTH_SETTINGS }
  return {
    weightLiquidity: row.weightLiquidity,
    weightDebt: row.weightDebt,
    weightSpending: row.weightSpending,
    weightReserve: row.weightReserve,
    weightAllocation: row.weightAllocation,
    costLookbackMonths: row.costLookbackMonths,
    riskCardShareBps: row.riskCardShareBps,
    riskReserveCoverageBps: row.riskReserveCoverageBps,
    riskAllocationDriftBps: row.riskAllocationDriftBps,
    riskSpendingCapBps: row.riskSpendingCapBps,
    riskDebtToIncomeBps: row.riskDebtToIncomeBps,
    riskPositiveMarginBps: row.riskPositiveMarginBps,
  }
}

export async function setSettings(patch: Partial<HealthSettings>): Promise<HealthSettings> {
  const existing = (await db.select().from(financialHealthSettings).where(eq(financialHealthSettings.id, 1)))[0]
  if (existing) {
    await db.update(financialHealthSettings).set(patch).where(eq(financialHealthSettings.id, 1))
  } else {
    await db.insert(financialHealthSettings).values({ id: 1, ...DEFAULT_HEALTH_SETTINGS, ...patch })
  }
  return getSettings()
}

/* ------------------------------------------------------------------ *
 * Indicators — pure math, no database access
 *
 * Each one takes the raw inputs it needs and returns a normalized score
 * plus the memory of calculation. Keeping them free of any query is what
 * makes them checkable against known numbers in scripts/verify.ts
 * without seeding a whole ledger first.
 * ------------------------------------------------------------------ */
export type Assumptions = { formula: string } & Record<string, unknown>

/** `scoreBps` is null whenever the inputs cannot answer the question. Never 0: a
 * missing indicator is not a failed one. `reason` then says what is missing. */
export type IndicatorResult = { scoreBps: number | null; assumptions: Assumptions }

const clampBps = (value: number) => Math.max(0, Math.min(10_000, Math.round(value)))

/**
 * Liquidez: how much of one month of living cost the available balance
 * already covers. One full month is full marks, and anything beyond it is
 * capped rather than rewarded, since this indicator asks "does the money
 * on hand cover the month", not "how rich is the account".
 */
export function liquidityIndicator(input: {
  availableBalanceCents: number
  monthlyCostCents: number
  lookbackMonths: number
}): IndicatorResult {
  const assumptions: Assumptions = {
    formula: 'saldo disponível ÷ custo mensal médio, com 1 mês de cobertura valendo 100',
    saldoDisponivelCents: input.availableBalanceCents,
    custoMensalMedioCents: input.monthlyCostCents,
    janelaCustoMeses: input.lookbackMonths,
  }
  if (input.monthlyCostCents <= 0) {
    return { scoreBps: null, assumptions: { ...assumptions, semDado: 'nenhuma despesa registrada na janela' } }
  }
  const coverageBps = Math.round((input.availableBalanceCents / input.monthlyCostCents) * 10_000)
  return { scoreBps: clampBps(coverageBps), assumptions: { ...assumptions, coberturaBps: coverageBps } }
}

/**
 * Endividamento: the inverse of debt service as a share of income, where
 * committing half the income to debt is the floor of the scale.
 */
export function debtIndicator(input: {
  debtToIncomeBps: number | null
  debtCount: number
  scheduledCents: number
  /** renda TÍPICA (mediana da janela), que é o denominador de debtToIncomeBps */
  typicalMonthlyIncomeCents: number
  incomeWindowMonths: number
  incomeSampleMonths: number
  period: string
}): IndicatorResult {
  const assumptions: Assumptions = {
    formula: '100 menos o comprometimento do Endividamento (parcelas + faturas do mês ÷ renda típica pessoal), chegando a 0 quando metade da renda está comprometida',
    comprometimentoBps: input.debtToIncomeBps,
    parcelasDoMesCents: input.scheduledCents,
    // A renda que aparece aqui é a que REPRODUZ o comprometimento acima.
    // Antes era a do mês de referência, que não era mais o denominador e
    // por isso não fechava a conta na memória de cálculo.
    rendaMensalTipicaCents: input.typicalMonthlyIncomeCents,
    janelaDaRendaMeses: input.incomeWindowMonths,
    mesesComMovimentoNaJanela: input.incomeSampleMonths,
    baseDaRenda: 'renda típica pessoal do Orçamento: mediana de 6 meses fechados, contas pessoais + repasse da PJ',
    origem: 'Endividamento (mesmo número da tela)',
    mesDeReferencia: input.period,
    dividasAtivas: input.debtCount,
  }
  if (input.debtCount === 0) {
    return { scoreBps: null, assumptions: { ...assumptions, semDado: 'nenhuma dívida nem limite de cartão usado' } }
  }
  if (input.debtToIncomeBps === null) {
    return { scoreBps: null, assumptions: { ...assumptions, semDado: 'sem receita registrada na janela de referência' } }
  }
  return { scoreBps: clampBps(10_000 - input.debtToIncomeBps * 2), assumptions }
}

/** Above this multiple of the cap the spending indicator bottoms out. */
const SPENDING_FLOOR_MULTIPLE = 1.5

/**
 * Controle de gastos: full marks anywhere within the cap, falling to zero
 * at half again over it. Without a cap there is nothing to measure against,
 * so the indicator steps out of the average rather than scoring 0 (which
 * would read as failure) or 100 (which would read as success).
 */
export function spendingIndicator(input: { spentCents: number; capCents: number | null }): IndicatorResult {
  const assumptions: Assumptions = {
    formula: '100 dentro do teto do Orçamento (previsto dos grupos de gasto do plano), caindo a 0 quando o gasto chega a 150% do teto',
    origem: 'Orçamento: gasto do mês nas contas pessoais',
    gastoCents: input.spentCents,
    tetoCents: input.capCents,
    limiteInferiorDoTeto: SPENDING_FLOOR_MULTIPLE,
  }
  if (input.capCents === null || input.capCents <= 0) {
    return { scoreBps: null, assumptions: { ...assumptions, semDado: 'sem plano no Orçamento para o mês' } }
  }
  const usedRatio = input.spentCents / input.capCents
  const scoreRatio = (SPENDING_FLOOR_MULTIPLE - usedRatio) / (SPENDING_FLOOR_MULTIPLE - 1)
  return {
    scoreBps: clampBps(scoreRatio * 10_000),
    assumptions: { ...assumptions, usoDoTetoBps: Math.round(usedRatio * 10_000) },
  }
}

/** Reserva: progress toward the reserve target the user configured. */
export function reserveIndicator(input: {
  currentCents: number
  targetCents: number
  multiple: number
  monthlyLivingCostCents: number
  livingCostIsManual: boolean
}): IndicatorResult {
  const assumptions: Assumptions = {
    formula: 'reserva acumulada ÷ meta da reserva (custo de vida mensal × múltiplo configurado)',
    reservaAtualCents: input.currentCents,
    metaCents: input.targetCents,
    multiplo: input.multiple,
    custoDeVidaMensalCents: input.monthlyLivingCostCents,
    custoDeVidaManual: input.livingCostIsManual,
  }
  if (input.targetCents <= 0) {
    return { scoreBps: null, assumptions: { ...assumptions, semDado: 'meta de reserva ainda não calculável' } }
  }
  return { scoreBps: clampBps((input.currentCents / input.targetCents) * 10_000), assumptions }
}

/**
 * Metas de alocação: the mean absolute distance between the portfolio and
 * the allocation policy the user set, subtracted from full marks. Classes
 * without a configured target are not part of the average, since there is
 * no policy to be distant from.
 */
export function allocationIndicator(input: {
  drifts: Array<{ assetClass: string; label: string; driftBps: number }>
}): IndicatorResult {
  const assumptions: Assumptions = {
    formula: '100 menos o desvio médio absoluto entre alocação atual e meta por classe, em pontos percentuais',
    classesComMeta: input.drifts.length,
    desvioPorClasse: input.drifts,
  }
  if (input.drifts.length === 0) {
    return { scoreBps: null, assumptions: { ...assumptions, semDado: 'nenhuma meta de alocação configurada' } }
  }
  const meanAbsDriftBps = Math.round(
    input.drifts.reduce((sum, d) => sum + Math.abs(d.driftBps), 0) / input.drifts.length,
  )
  return {
    scoreBps: clampBps(10_000 - meanAbsDriftBps),
    assumptions: { ...assumptions, desvioMedioAbsolutoBps: meanAbsDriftBps },
  }
}

/* ------------------------------------------------------------------ *
 * Health Score — the weighted composition of the five indicators
 * ------------------------------------------------------------------ */
export type IndicatorKey = 'liquidity' | 'debt' | 'spending' | 'reserve' | 'allocation'

export const INDICATOR_LABELS: Record<IndicatorKey, string> = {
  liquidity: 'Liquidez',
  debt: 'Endividamento',
  spending: 'Controle de gastos',
  reserve: 'Reserva de emergência',
  allocation: 'Metas de alocação',
}

export type ScoredIndicator = {
  key: IndicatorKey
  label: string
  /** 0 to 10.000 basis points, matching every other percentage in this app. Null = sem dado. */
  scoreBps: number | null
  /** the weight the user configured for this indicator */
  weight: number
  /** the share this indicator actually took of the final score, after redistribution */
  appliedWeightBps: number | null
  assumptions: Assumptions
}

export type HealthScore = {
  period: string
  accountId: number | null
  scoreBps: number | null
  indicators: ScoredIndicator[]
  assumptions: Assumptions
}

/**
 * Composes the five indicators. An indicator with no data does not score
 * zero and does not silently count as full marks: it leaves the average,
 * and its weight is redistributed proportionally across the ones that do
 * have data, which is reported in `appliedWeightBps` so the composition is
 * never a black box.
 */
export function composeScore(
  entries: Array<{ key: IndicatorKey; weight: number; result: IndicatorResult }>,
): { scoreBps: number | null; indicators: ScoredIndicator[]; activeWeight: number } {
  const scored = entries.filter((e) => e.result.scoreBps !== null && e.weight > 0)
  const activeWeight = scored.reduce((sum, e) => sum + e.weight, 0)

  const indicators: ScoredIndicator[] = entries.map((e) => ({
    key: e.key,
    label: INDICATOR_LABELS[e.key],
    scoreBps: e.result.scoreBps,
    weight: e.weight,
    appliedWeightBps:
      e.result.scoreBps === null || activeWeight <= 0 || e.weight <= 0
        ? null
        : Math.round((e.weight / activeWeight) * 10_000),
    assumptions: e.result.assumptions,
  }))

  const scoreBps =
    activeWeight > 0
      ? Math.round(scored.reduce((sum, e) => sum + e.result.scoreBps! * e.weight, 0) / activeWeight)
      : null

  return { scoreBps, indicators, activeWeight }
}

/**
 * Os insumos crus dos cinco indicadores, num objeto só.
 *
 * Extraído de `healthScore` para o simulador poder pegar exatamente os
 * MESMOS números, mexer em um só e recompor. Sem isto, o simulador teria a
 * própria coleta e as duas versões divergiriam no primeiro ajuste que
 * alguém fizesse aqui e esquecesse de replicar lá (ver `decisions/0016`:
 * reusa, nunca duplica).
 */
export type ScoreInputs = {
  settings: HealthSettings
  liquidity: Parameters<typeof liquidityIndicator>[0]
  debt: Parameters<typeof debtIndicator>[0]
  spending: Parameters<typeof spendingIndicator>[0]
  reserve: Parameters<typeof reserveIndicator>[0]
  allocation: Parameters<typeof allocationIndicator>[0]
}

/**
 * O que não muda de mês para mês dentro de uma leitura (dívida de hoje,
 * reserva, alocação, saldos, custo de vida). O histórico calcula uma vez e
 * reaproveita em cada mês, em vez de refazer tudo 12 vezes.
 */
export type SharedInputs = {
  v2: Awaited<ReturnType<typeof debtOverviewV2>>
  reserve: Awaited<ReturnType<typeof reserveStatus>>
  allocationSlices: Awaited<ReturnType<typeof allocation>>
  personalCashCents: number
  personalCost: { typicalCents: number; sampleMonths: number }
}

/** Saldo das contas pessoais (sem a PJ e sem conta de investimento, que é carteira e não saldo). */
async function personalCash(asOfDate?: string) {
  const scope = await accountScope()
  const balances = await accountBalances(asOfDate)
  const cash = balances.filter((a) => a.kind !== 'investment')
  return {
    scope,
    personal: cash.filter((a) => scope.personal.includes(Number(a.id))),
    company: cash.filter((a) => scope.pjAccountId !== null && Number(a.id) === scope.pjAccountId),
  }
}

// Sequencial, não Promise.all: sob o pooler de transação das Edge Functions,
// fan-out concorrente demais numa conexão trava a requisição (goals.ts#goalHistory).
export async function sharedInputs(): Promise<SharedInputs> {
  const v2 = await debtOverviewV2()
  const reserve = await reserveStatus()
  const allocationSlices = await allocation()
  const cash = await personalCash()
  const personalCost = await typicalPersonalSpending()
  return {
    v2,
    reserve,
    allocationSlices,
    personalCashCents: cash.personal.reduce((sum, a) => sum + Number(a.balanceCents), 0),
    personalCost,
  }
}

/**
 * Os insumos dos indicadores (decisions/0045): cada número vem da tela dona.
 * `accountId` fica na assinatura por compatibilidade; o escopo agora é o
 * pessoal do Orçamento.
 */
export async function gatherScoreInputs(period: string, _accountId: number | null = null, shared?: SharedInputs): Promise<ScoreInputs> {
  const settings = await getSettings()
  const base = shared ?? (await sharedInputs())
  const spend = await monthSpendingVsCap(period)
  const { v2, reserve, allocationSlices } = base

  const drifts = allocationSlices
    .filter((slice) => slice.driftBps !== null)
    .map((slice) => ({ assetClass: slice.assetClass, label: slice.label, driftBps: slice.driftBps! }))

  return {
    settings,
    // Fora do score desde 10/2026 (o Runway responde); continua aqui para o simulador.
    liquidity: {
      availableBalanceCents: base.personalCashCents,
      monthlyCostCents: base.personalCost.typicalCents,
      lookbackMonths: 6,
    },
    debt: {
      debtToIncomeBps: v2.commitment.shareBps,
      debtCount: v2.debts.length + v2.cards.filter((c) => c.usedCents > 0).length,
      scheduledCents: v2.commitment.debtCents + v2.commitment.cardCents,
      typicalMonthlyIncomeCents: v2.income.typicalCents,
      incomeWindowMonths: 6,
      incomeSampleMonths: v2.income.sampleMonths,
      period: v2.startPeriod,
    },
    spending: {
      spentCents: spend.spentCents,
      capCents: spend.capCents,
    },
    reserve: {
      currentCents: reserve.currentCents,
      targetCents: reserve.targetCents,
      multiple: reserve.multiple,
      monthlyLivingCostCents: reserve.monthlyLivingCostCents,
      livingCostIsManual: reserve.livingCostIsManual,
    },
    allocation: { drifts },
  }
}

/** Compõe o score a partir de insumos já coletados. O simulador chama esta. */
export function composeScoreFromInputs(inputs: ScoreInputs) {
  const { settings } = inputs
  // Liquidez saiu do score (decisions/0045): o Runway responde a mesma pergunta melhor.
  return composeScore([
    { key: 'debt', weight: settings.weightDebt, result: debtIndicator(inputs.debt) },
    { key: 'spending', weight: settings.weightSpending, result: spendingIndicator(inputs.spending) },
    { key: 'reserve', weight: settings.weightReserve, result: reserveIndicator(inputs.reserve) },
    { key: 'allocation', weight: settings.weightAllocation, result: allocationIndicator(inputs.allocation) },
  ])
}

export async function healthScore(period: string, accountId: number | null = null, shared?: SharedInputs): Promise<HealthScore> {
  const { start, end } = periodBounds(period)
  const inputs = await gatherScoreInputs(period, accountId, shared)
  const settings = inputs.settings

  const { scoreBps, indicators, activeWeight } = composeScoreFromInputs(inputs)

  return {
    period,
    accountId,
    scoreBps,
    indicators,
    assumptions: {
      formula: 'média dos indicadores com dado disponível, ponderada pelos pesos configurados',
      periodo: period,
      intervalo: { from: start, to: end },
      pesosConfigurados: {
        debt: settings.weightDebt,
        spending: settings.weightSpending,
        reserve: settings.weightReserve,
        allocation: settings.weightAllocation,
      },
      pesoTotalAtivo: activeWeight,
      liquidez: 'fora do score desde 10/2026: o Runway responde a mesma pergunta',
      fontes: 'Endividamento (comprometimento), Orçamento (gasto e teto), Investimentos (reserva e alocação)',
      indicadoresComDado: indicators.filter((i) => i.scoreBps !== null).map((i) => i.key),
      indicadoresSemDado: indicators.filter((i) => i.scoreBps === null).map((i) => i.key),
      ...(scoreBps === null ? { semDado: 'nenhum indicador tem dado suficiente no período' } : {}),
    },
  }
}

/**
 * Série histórica do Health Score — estudo de viabilidade #3 de 29/08/2026.
 * Nunca persiste nada: chama `healthScore(period)` sem alterá-la, uma vez
 * por mês, exatamente como `goalHistory` já faz em `goals.ts`. Um "snapshot"
 * gravado ficaria defasado se uma transação de um mês antigo fosse corrigida
 * depois — recalcular sempre evita esse problema por completo (mesmo
 * espírito de "derivar, nunca guardar" do PRD, seção 4).
 *
 * Sequencial de propósito, não Promise.all: `healthScore` já dispara várias
 * queries internas (`gatherScoreInputs` cruza saldo, dívida, gasto, reserva
 * e alocação); rodar N meses ao mesmo tempo arrisca o mesmo travamento de
 * pooler de transação já documentado em `goalHistory`/`homeBanners` sob
 * Edge Functions.
 */
export async function healthScoreHistory(
  months = 12,
  accountId: number | null = null,
): Promise<Array<{ period: string; scoreBps: number | null; source: 'foto' | 'reconstruído' }>> {
  const currentPeriod = todayIso().slice(0, 7)
  const periods = periodRange(addMonths(currentPeriod, -(months - 1)), currentPeriod)
  // A foto do mês vale quando existe (decisions/0045); antes dela, reconstrói
  // com a dívida, a reserva e a alocação de hoje (marcado como tal).
  const snaps = new Map((await db.select().from(monthlySnapshots)).map((r) => [r.period, r]))
  const missing = periods.filter((p) => !snaps.has(p))
  const shared = missing.length > 0 ? await sharedInputs() : undefined

  const out: Array<{ period: string; scoreBps: number | null; source: 'foto' | 'reconstruído' }> = []
  for (const period of periods) {
    const snap = snaps.get(period)
    if (snap) out.push({ period, scoreBps: snap.scoreBps, source: 'foto' })
    else out.push({ period, scoreBps: (await healthScore(period, accountId, shared)).scoreBps, source: 'reconstruído' })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Runway — how many months the current resources cover
 * ------------------------------------------------------------------ */
export type RunwayScope = {
  /** null on the consolidated row; an account id on each per-account row */
  accountId: number | null
  label: string
  /** null when there is no expense history to divide by */
  months: number | null
  netWorthCents: number
  monthlyCostCents: number
  assumptions: Assumptions
}

/**
 * Debt installments already materialized as pending rows and falling due
 * inside the short-term window. Reads the same pending rows the "Despesas
 * pendentes" widget shows, so the runway and that widget can never
 * disagree about what is about to leave the account.
 */
async function shortTermDebtCents(accountId: number | null): Promise<number> {
  const today = todayIso()
  const horizon = addDays(today, SHORT_TERM_DEBT_DAYS)
  const rows = await db.execute<{ total: number }>(sql`
    select coalesce(sum(abs(amount_cents)), 0) as total
    from transactions
    where pending = true
      and debt_id is not null
      and posted_on between ${today} and ${horizon}
      ${accountId ? sql`and account_id = ${accountId}` : sql``}
  `)
  return rows[0]?.total ?? 0
}

async function liquidInvestmentsCents(liquidClasses: readonly string[]): Promise<number> {
  return (await positions())
    .filter((p) => p.countsTowardReserve || liquidClasses.includes(p.assetClass))
    .reduce((sum, p) => sum + p.marketValueCents, 0)
}

/** Ajustes hipotéticos do simulador. Ausentes em toda chamada de produção. */
export type RunwayOverrides = { balanceDeltaCents?: number; investmentsDeltaCents?: number }

async function runwayPersonal(liquidClasses: readonly string[], overrides: RunwayOverrides = {}): Promise<RunwayScope> {
  const today = todayIso()
  const horizon = addDays(today, SHORT_TERM_DEBT_DAYS)
  const cash = await personalCash()
  const personalCost = await typicalPersonalSpending()
  const v2 = await debtOverviewV2()

  const balanceDeltaCents = overrides.balanceDeltaCents ?? 0
  const investmentsDeltaCents = overrides.investmentsDeltaCents ?? 0
  const balanceCents = cash.personal.reduce((sum, a) => sum + Number(a.balanceCents), 0) + balanceDeltaCents
  const investmentsCents = (await liquidInvestmentsCents(liquidClasses)) + investmentsDeltaCents
  const pendingDebtCents = await shortTermDebtCents(null)
  // Faturas abertas que vencem na janela (as dívidas pagas no cartão já saíram
  // delas); cartão pago pela conta PJ é da empresa e fica fora.
  const cardBillsCents = v2.cards
    .filter((c) => c.accountId !== cash.scope.pjAccountId && c.openBillCents !== null && c.dueOn >= today && c.dueOn <= horizon)
    .reduce((sum, c) => sum + (c.byPeriod[v2.startPeriod] ?? 0), 0)
  const shortTermCents = pendingDebtCents + cardBillsCents
  const netWorthCents = balanceCents + investmentsCents - shortTermCents
  const monthlyCostCents = personalCost.typicalCents

  const assumptions: Assumptions = {
    formula:
      'patrimônio pessoal considerado ÷ custo de vida pessoal, onde patrimônio = saldo das contas pessoais + investimentos líquidos − o que vence em 30 dias (parcelas e faturas)',
    saldoContasPessoaisCents: balanceCents,
    investimentosLiquidosCents: investmentsCents,
    parcelasEm30DiasCents: pendingDebtCents,
    faturasEm30DiasCents: cardBillsCents,
    patrimonioConsideradoCents: netWorthCents,
    custoDeVidaPessoalCents: monthlyCostCents,
    custoDeVida: `mediana de ${personalCost.sampleMonths} meses fechados das despesas das contas pessoais (Orçamento)`,
    diasCurtoPrazo: SHORT_TERM_DEBT_DAYS,
    classesLiquidas: [...liquidClasses],
    escopo: 'pessoal: a conta PJ fica de fora; a linha da empresa mostra o retirável da Minha empresa',
    ...(balanceDeltaCents !== 0 || investmentsDeltaCents !== 0
      ? {
          ajusteHipoteticoSaldoCents: balanceDeltaCents,
          ajusteHipoteticoInvestimentosCents: investmentsDeltaCents,
          notaDeSimulacao:
            'estes números incluem um ajuste hipotético pedido pelo simulador, não o estado real do ledger',
        }
      : {}),
  }

  if (monthlyCostCents <= 0) {
    return { accountId: null, label: 'Pessoal', months: null, netWorthCents, monthlyCostCents, assumptions: { ...assumptions, semDado: 'nenhuma despesa nas contas pessoais para calcular o custo de vida' } }
  }
  return {
    accountId: null,
    label: 'Pessoal',
    // Uma casa decimal: "4,2 meses" é projeção, mais dígitos sugeririam uma precisão que não existe.
    months: Math.round((netWorthCents / monthlyCostCents) * 10) / 10,
    netWorthCents,
    monthlyCostCents,
    assumptions,
  }
}

/**
 * Runway pessoal (decisions/0045) e, à parte, quanto ele cresce se o
 * retirável da Minha empresa for retirado. A empresa não entra no número
 * principal: o caixa da PJ tem DAS, contas e o colchão dela.
 */
export async function runway(
  liquidClasses: readonly string[] = DEFAULT_LIQUID_ASSET_CLASSES,
  overrides: RunwayOverrides = {},
): Promise<{
  scopes: RunwayScope[]
  consolidated: RunwayScope
}> {
  const personal = await runwayPersonal(liquidClasses, overrides)
  const scopes: RunwayScope[] = [personal]
  try {
    const company = await companyOverview(todayIso().slice(0, 7))
    const w = company.withdrawable?.withdrawableCents ?? null
    if (w !== null && company.pjAccount?.id) {
      scopes.push({
        accountId: Number(company.pjAccount.id),
        label: 'Com o retirável da empresa',
        months: personal.monthlyCostCents > 0 ? Math.round(((personal.netWorthCents + w) / personal.monthlyCostCents) * 10) / 10 : null,
        netWorthCents: w,
        monthlyCostCents: personal.monthlyCostCents,
        assumptions: {
          formula: '(patrimônio pessoal considerado + retirável da Minha empresa) ÷ custo de vida pessoal',
          retiravelCents: w,
          origem: 'Minha empresa: caixa da PJ menos DAS, pendências e o colchão configurado',
        },
      })
    }
  } catch {
    // Sem conta PJ configurada: só a linha pessoal.
  }
  return { scopes, consolidated: personal }
}

/* ------------------------------------------------------------------ *
 * Radar de risco — indicators against user-configured thresholds
 * ------------------------------------------------------------------ */
export type RiskRule = {
  key: string
  label: string
  /** the measured value, in basis points, against `thresholdBps` */
  valueBps: number
  thresholdBps: number
  /**
   * How to read those basis points: 'share' is a percentage OF something,
   * 'points' is a difference BETWEEN two percentages. Allocation drift is
   * the second kind, and rendering it with a % sign would claim something
   * the number does not say, so the unit travels with the value instead of
   * being inferred from the rule's key on the client.
   */
  unit: 'share' | 'points'
  /** 'above' = flagged when the value exceeds the threshold; 'below' = flagged when it falls short */
  direction: 'above' | 'below'
  outsideRange: boolean
  /**
   * The good side, by a configured margin. INDEPENDENT from `outsideRange`,
   * not its opposite: an indicator can be comfortably inside its limit and
   * still not clear the slack, in which case both flags are false. Only one
   * of the two can ever be true at a time.
   */
  exceedsPositively: boolean
  assumptions: Assumptions
}

/**
 * Every rule whose inputs exist, each measured against a threshold the
 * user configured. A rule without data is left out entirely rather than
 * reported as being within range, which would be a claim the data does
 * not support.
 */
export async function riskRadar(period: string, accountId: number | null = null): Promise<{
  period: string
  rules: RiskRule[]
  assumptions: Assumptions
}> {
  const settings = await getSettings()
  const rules: RiskRule[] = []

  const flagged = (valueBps: number, thresholdBps: number, direction: 'above' | 'below') =>
    direction === 'above' ? valueBps > thresholdBps : valueBps < thresholdBps

  /**
   * The mirror of `flagged`: clearly on the GOOD side, by the configured
   * slack. For an 'above' rule the good side is downward, and the bar is
   * floored at zero so a threshold smaller than the margin cannot demand a
   * negative value that no indicator can reach.
   */
  const positive = (valueBps: number, thresholdBps: number, direction: 'above' | 'below') => {
    const margin = settings.riskPositiveMarginBps
    return direction === 'above'
      ? valueBps <= Math.max(0, thresholdBps - margin)
      : valueBps >= thresholdBps + margin
  }

  // Uma fonte para cada número (decisions/0045); em sequência pelo pooler.
  void accountId
  const spend = await monthSpendingVsCap(period)
  const reserve = await reserveStatus()
  const allocationSlices = await allocation()
  const v2 = await debtOverviewV2()

  /* Cobertura da reserva de emergência. */
  if (reserve.targetCents > 0) {
    rules.push({
      key: 'reserve_coverage',
      label: 'Cobertura da reserva de emergência',
      valueBps: reserve.progressBps,
      thresholdBps: settings.riskReserveCoverageBps,
      unit: 'share',
      direction: 'below',
      outsideRange: flagged(reserve.progressBps, settings.riskReserveCoverageBps, 'below'),
      exceedsPositively: positive(reserve.progressBps, settings.riskReserveCoverageBps, 'below'),
      assumptions: {
        formula: 'reserva acumulada ÷ meta da reserva',
        reservaAtualCents: reserve.currentCents,
        metaCents: reserve.targetCents,
        multiplo: reserve.multiple,
        custoDeVidaMensalCents: reserve.monthlyLivingCostCents,
      },
    })
  }

  /* Desvio de alocação, a maior distância entre carteira e política. */
  const drifts = allocationSlices.filter((slice) => slice.driftBps !== null)
  if (drifts.length > 0) {
    const worst = drifts.reduce((max, s) => (Math.abs(s.driftBps!) > Math.abs(max.driftBps!) ? s : max))
    const valueBps = Math.abs(worst.driftBps!)
    rules.push({
      key: 'allocation_drift',
      label: 'Maior desvio entre carteira e política de alocação',
      valueBps,
      thresholdBps: settings.riskAllocationDriftBps,
      unit: 'points',
      direction: 'above',
      outsideRange: flagged(valueBps, settings.riskAllocationDriftBps, 'above'),
      exceedsPositively: positive(valueBps, settings.riskAllocationDriftBps, 'above'),
      assumptions: {
        formula: 'maior valor absoluto de desvio, em pontos percentuais, entre percentual atual e meta por classe',
        classe: worst.assetClass,
        classeLabel: worst.label,
        atualBps: worst.actualBps,
        metaBps: worst.targetBps,
        classesComMeta: drifts.length,
      },
    })
  }

  /* Gasto do mês contra o teto do Orçamento. */
  if (spend.capCents !== null && spend.capCents > 0) {
    const valueBps = Math.round((spend.spentCents / spend.capCents) * 10_000)
    rules.push({
      key: 'spending_cap',
      label: 'Uso do teto de gasto do mês',
      valueBps,
      thresholdBps: settings.riskSpendingCapBps,
      unit: 'share',
      direction: 'above',
      outsideRange: flagged(valueBps, settings.riskSpendingCapBps, 'above'),
      exceedsPositively: positive(valueBps, settings.riskSpendingCapBps, 'above'),
      assumptions: {
        formula: 'gasto do mês nas contas pessoais ÷ previsto dos grupos de gasto do plano do Orçamento',
        gastoCents: spend.spentCents,
        tetoCents: spend.capCents,
        periodo: period,
        origem: 'Orçamento',
      },
    })
  }

  /* Comprometimento da renda, o mesmo do Endividamento (dívidas e faturas). */
  const commitmentBps = v2.commitment.shareBps
  if (commitmentBps !== null && (v2.commitment.debtCents > 0 || v2.commitment.cardCents > 0)) {
    rules.push({
      key: 'debt_to_income',
      label: 'Renda comprometida com dívidas e cartões',
      valueBps: commitmentBps,
      thresholdBps: settings.riskDebtToIncomeBps,
      unit: 'share',
      direction: 'above',
      outsideRange: flagged(commitmentBps, settings.riskDebtToIncomeBps, 'above'),
      exceedsPositively: positive(commitmentBps, settings.riskDebtToIncomeBps, 'above'),
      assumptions: {
        formula: '(parcelas das dívidas do mês + faturas abertas dos cartões ligados) ÷ renda típica pessoal',
        parcelasDoMesCents: v2.commitment.debtCents,
        faturasDoMesCents: v2.commitment.cardCents,
        rendaTipicaPessoalCents: v2.income.typicalCents,
        mesDeReferencia: v2.startPeriod,
        origem: 'Endividamento (mesmo número da tela)',
      },
    })
  }

  return {
    period,
    rules,
    assumptions: {
      formula: 'cada regra compara um indicador derivado com o limite configurado pelo usuário',
      periodo: period,
      thresholdsConfigurados: {
        reserve_coverage: settings.riskReserveCoverageBps,
        allocation_drift: settings.riskAllocationDriftBps,
        spending_cap: settings.riskSpendingCapBps,
        debt_to_income: settings.riskDebtToIncomeBps,
      },
      margemDeFolgaPositivaBps: settings.riskPositiveMarginBps,
      regrasAvaliadas: rules.length,
      regrasForaDaFaixa: rules.filter((r) => r.outsideRange).map((r) => r.key),
      regrasAcimaDaFolga: rules.filter((r) => r.exceedsPositively).map((r) => r.key),
      regrasSemDado: [
        'reserve_coverage',
        'allocation_drift',
        'spending_cap',
        'debt_to_income',
      ].filter((key) => !rules.some((r) => r.key === key)),
    },
  }
}

/* ------------------------------------------------------------------ *
 * Patrimônio consolidado
 *
 * "Quanto eu tenho contra quanto eu devo", num lugar só. Parece o
 * numerador do Runway, e de propósito NÃO é: usa recortes diferentes nas
 * duas pontas, porque as duas perguntas são diferentes.
 *
 *   Runway            "por quanto tempo eu me sustento"
 *                     investimentos LÍQUIDOS, dívida de CURTO PRAZO (30d)
 *   Patrimônio        "quanto eu tenho contra quanto eu devo"
 *                     investimentos TOTAIS, dívida TOTAL
 *
 * Os dois números serem diferentes na tela é o comportamento correto, não
 * uma inconsistência. Ver `specs/financial-health`, "Patrimônio consolidado".
 * ------------------------------------------------------------------ */
export type NetWorth = {
  balanceCents: number
  /** TODOS os investimentos, imobilizado incluído — mantido como estava */
  investmentsCents: number
  /** só a classe Imobilizado (imóvel, veículo, joia) */
  illiquidCents: number
  /** saldo em conta + investimentos LÍQUIDOS (tudo menos o imobilizado) */
  financialCents: number
  /** "Quanto você deve" do Endividamento: dívidas + limite usado dos cartões */
  debtCents: number
  debtBreakdown: { debtsCents: number; cardsCents: number }
  /** saldo pessoal + investimentos − dívida: o patrimônio PESSOAL */
  liquidityCents: number
  /** a empresa à parte, fora do número principal (decisions/0045) */
  company: { accountName: string | null; balanceCents: number; cardsCents: number; withdrawableCents: number | null } | null
  assumptions: Assumptions
}

export async function netWorth(): Promise<NetWorth> {
  // Em sequência pelo pooler das Edge Functions.
  const cash = await personalCash()
  const holdings = await positions()
  const v2 = await debtOverviewV2()
  const balanceCents = cash.personal.reduce((sum, a) => sum + Number(a.balanceCents), 0)

  // TODOS os investimentos, não só os que contam para a reserva: aqui a
  // pergunta é patrimônio, não liquidez de emergência.
  const investmentsCents = holdings.reduce((sum, p) => sum + p.marketValueCents, 0)
  // Financeiro x Imobilizado (01/09/2026): um carro não paga uma conta.
  const illiquidCents = holdings
    .filter((p) => p.assetClass === ILLIQUID_ASSET_CLASS)
    .reduce((sum, p) => sum + p.marketValueCents, 0)
  const financialCents = balanceCents + investmentsCents - illiquidCents

  // A dívida do Endividamento (dívidas + limite usado, sem a parte que é
  // dívida paga na fatura), menos os cartões pagos pela conta PJ: esses são
  // da empresa e vão para a linha dela (decisions/0045).
  const isCompanyCard = (c: { accountId: number | null }) => cash.scope.pjAccountId !== null && c.accountId === cash.scope.pjAccountId
  const companyCardsCents = v2.cards.filter(isCompanyCard).reduce((sum, c) => sum + c.usedCents, 0)
  const personalCardsCents = v2.total.cardsUsedCents - companyCardsCents
  const debtCents = v2.total.debtsCents + personalCardsCents

  let company: NetWorth['company'] = null
  if (cash.scope.pjAccountId !== null) {
    let withdrawableCents: number | null = null
    try {
      withdrawableCents = (await companyOverview(todayIso().slice(0, 7))).withdrawable?.withdrawableCents ?? null
    } catch {
      withdrawableCents = null
    }
    company = {
      accountName: cash.company[0]?.name ?? null,
      balanceCents: cash.company.reduce((sum, a) => sum + Number(a.balanceCents), 0),
      cardsCents: companyCardsCents,
      withdrawableCents,
    }
  }

  return {
    balanceCents,
    investmentsCents,
    illiquidCents,
    financialCents,
    debtCents,
    debtBreakdown: { debtsCents: v2.total.debtsCents, cardsCents: personalCardsCents },
    liquidityCents: balanceCents + investmentsCents - debtCents,
    company,
    assumptions: {
      formula: 'saldo das contas pessoais + investimentos a valor de mercado − quanto você deve (Endividamento)',
      saldoContasPessoaisCents: balanceCents,
      contasSomadas: cash.personal.length,
      investimentosCents: investmentsCents,
      ativosSomados: holdings.length,
      investimentosEscopo: 'todos os ativos da carteira, não apenas os marcados como reserva',
      financeiroCents: financialCents,
      imobilizadoCents: illiquidCents,
      dividaCents: debtCents,
      dividasCents: v2.total.debtsCents,
      cartoesPessoaisCents: personalCardsCents,
      cartoesDaEmpresaCents: companyCardsCents,
      dividaEscopo: '"Quanto você deve" do Endividamento (dívidas + limite usado dos cartões), sem os cartões pagos pela conta PJ, que vão para a linha da empresa',
      escopo: 'pessoal: a conta PJ e conta de investimento ficam fora do saldo; a empresa aparece à parte',
      ...(company ? { empresaSaldoCents: company.balanceCents, empresaCartoesCents: company.cardsCents, empresaRetiravelCents: company.withdrawableCents } : {}),
    },
  }
}

/**
 * Série histórica de patrimônio líquido — estudo de viabilidade #8,
 * 29/08/2026. O ponto em aberto do estudo (positions() suporta corte de
 * data?) foi resolvido estendendo `positions`/`accountBalances` com um
 * parâmetro `asOfDate` opcional (default preserva o comportamento de
 * sempre) — nenhuma segunda função paralela pra "posições no passado".
 * Lado da dívida reusa `debtTrend()`, que já é histórico de verdade
 * (`debt_snapshots`); "como estava a dívida no fim deste mês" é o ponto de
 * `debtTrend()` mais recente com `asOf` até o fim do mês, forward-fill
 * igual o próprio `debtTrend()` já faz internamente entre contas.
 * Sequencial de propósito (mesmo risco de pooler já documentado em
 * `goalHistory`/`healthScoreHistory`).
 */
export async function netWorthHistory(months = 12): Promise<Array<{ period: string; netWorthCents: number; source: 'foto' | 'reconstruído' }>> {
  const currentPeriod = todayIso().slice(0, 7)
  const periods = periodRange(addMonths(currentPeriod, -(months - 1)), currentPeriod)
  const snaps = new Map((await db.select().from(monthlySnapshots)).map((r) => [r.period, r]))
  const debtSeries = await debtTrend()
  const scope = await accountScope()

  const out: Array<{ period: string; netWorthCents: number; source: 'foto' | 'reconstruído' }> = []
  for (const period of periods) {
    const snap = snaps.get(period)
    if (snap) {
      out.push({ period, netWorthCents: Number(snap.netWorthCents), source: 'foto' })
      continue
    }
    // Reconstrução: contas pessoais e dívidas medidas até o fim do mês (os
    // cartões não têm série; as fotos mensais resolvem isso daqui em diante).
    const asOfDate = periodBounds(period).end
    const balances = await accountBalances(asOfDate)
    const holdings = await positions(asOfDate)
    const balanceCents = balances
      .filter((a) => a.kind !== 'investment' && scope.personal.includes(Number(a.id)))
      .reduce((sum, a) => sum + Number(a.balanceCents), 0)
    const investmentsCents = holdings.reduce((sum, p) => sum + p.marketValueCents, 0)
    const debtPoint = [...debtSeries].reverse().find((p) => p.asOf <= asOfDate)
    const debtCents = Number(debtPoint?.balanceCents ?? 0)
    out.push({ period, netWorthCents: balanceCents + investmentsCents - debtCents, source: 'reconstruído' })
  }
  return out
}

/**
 * A foto do mês (decisions/0045): score e patrimônio pessoal de hoje,
 * gravados no mês corrente. A rotina diária chama todo dia; a última
 * gravação do mês fica como a foto dele.
 */
export async function writeMonthlySnapshot(): Promise<{ period: string; scoreBps: number | null; netWorthCents: number }> {
  const period = todayIso().slice(0, 7)
  const score = await healthScore(period)
  const nw = await netWorth()
  const values = {
    period,
    scoreBps: score.scoreBps,
    netWorthCents: nw.liquidityCents,
    companyCents: nw.company?.balanceCents ?? 0,
    debtCents: nw.debtCents,
    details: {
      indicadores: Object.fromEntries(score.indicators.map((i) => [i.key, i.scoreBps])),
      saldoPessoalCents: nw.balanceCents,
      investimentosCents: nw.investmentsCents,
      imobilizadoCents: nw.illiquidCents,
      retiravelEmpresaCents: nw.company?.withdrawableCents ?? null,
    },
    takenAt: new Date().toISOString(),
  }
  await db.insert(monthlySnapshots).values(values).onConflictDoUpdate({ target: monthlySnapshots.period, set: values })
  return { period, scoreBps: score.scoreBps, netWorthCents: nw.liquidityCents }
}
