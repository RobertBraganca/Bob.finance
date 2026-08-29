import '@supabase/functions-js/edge-runtime.d.ts'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z, ZodError } from 'zod'
import { requireAdmin } from '../_shared/auth.ts'
import { addMonths, periodBounds, todayIso } from '../_shared/core/dates.ts'
import * as analytics from '../_shared/services/analytics.ts'
import * as benchmarksService from '../_shared/services/benchmarks.ts'
import * as cashFlowService from '../_shared/services/cashFlow.ts'
import * as creditCardsService from '../_shared/services/creditCards.ts'
import * as criteriaService from '../_shared/services/criteria.ts'
import * as debtService from '../_shared/services/debt.ts'
import * as dreService from '../_shared/services/dre.ts'
import * as engineService from '../_shared/services/financialEngine.ts'
import * as healthService from '../_shared/services/financialHealth.ts'
import * as goalsService from '../_shared/services/goals.ts'
import * as investments from '../_shared/services/investments.ts'
import * as quotesService from '../_shared/services/quotes.ts'
import { ledgerBounds } from '../_shared/services/transactions.ts'
import { accountFlows } from '../_shared/services/transfers.ts'

/**
 * Porta de server/src/routes/insights.ts (Fastify) para Hono/Deno.Serve —
 * mesma lógica de negócio (services/*, copiados verbatim em _shared/), só a
 * casca HTTP muda. Ver decisions/0026 para o porquê dessa migração.
 *
 * Ao contrário de pricing.ts (cujas rotas Fastify já tinham `/pricing/` como
 * prefixo próprio), as rotas aqui não compartilhavam prefixo nenhum no
 * Fastify (`/dashboard`, `/analytics/flows`, `/goals/:period`, etc., todas
 * registradas direto sob `/api`). Como o nome da function vira o primeiro
 * segmento da URL nas Edge Functions, essas rotas ganham aqui um prefixo
 * novo (`/insights`) que não existia antes — decisão registrada em
 * decisions/0026, não um detalhe silencioso.
 */

const rangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountId: z.coerce.number().int().positive().optional(),
})

const periodParam = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) })
const idParam = z.object({ id: z.coerce.number().int().positive() })

async function resolveRange(query: z.infer<typeof rangeQuery>): Promise<analytics.Range> {
  const bounds = await ledgerBounds()
  const anchor = query.to ?? bounds.max ?? todayIso()
  const to = query.to ?? periodBounds(anchor.slice(0, 7)).end
  const from = query.from ?? periodBounds(addMonths(anchor.slice(0, 7), -5)).start
  return { from, to, accountId: query.accountId ?? null }
}

/** O mês sendo medido, com o mesmo fallback de resolveRange — para o mês mais recente do ledger. */
async function resolvePeriod(period?: string): Promise<string> {
  if (period) return period
  const bounds = await ledgerBounds()
  return bounds.max?.slice(0, 7) ?? todayIso().slice(0, 7)
}

const app = new Hono().basePath('/insights')
app.use('*', cors({ origin: '*' }))
app.use('*', requireAdmin)

app.onError((error, c) => {
  if (error instanceof ZodError) return c.json({ error: 'dados inválidos', issues: error.issues }, 400)
  console.error(error)
  return c.json({ error: error instanceof Error ? error.message : 'erro interno' }, 500)
})

app.get('/meta', async (c) => {
  const bounds = await ledgerBounds()
  return c.json({
    ledger: bounds,
    today: todayIso(),
    defaultRange: await resolveRange({}),
    accounts: await analytics.accountBalances(),
    hasData: bounds.count > 0,
  })
})

/* ---------------------------------------------------------------- *
 * Income vs expense dashboard
 * ---------------------------------------------------------------- */
app.get('/dashboard', async (c) => {
  const query = rangeQuery.extend({ futureReceivables: z.coerce.boolean().optional() }).parse(c.req.query())
  const range = await resolveRange(query)
  return c.json(await analytics.dashboard(range, { includeFutureReceivables: query.futureReceivables }))
})

app.get('/analytics/flows', async (c) => {
  const query = rangeQuery.parse(c.req.query())
  const range = await resolveRange(query)
  return c.json(await accountFlows({ from: range.from, to: range.to }))
})

app.get('/analytics/monthly', async (c) => {
  const range = await resolveRange(rangeQuery.parse(c.req.query()))
  return c.json({ range, series: await analytics.monthlySeries(range) })
})

app.get('/analytics/dre', async (c) => {
  const range = await resolveRange(rangeQuery.parse(c.req.query()))
  return c.json(await dreService.dreReport(range))
})

app.get('/analytics/categories', async (c) => {
  const query = rangeQuery
    .extend({
      flow: z.enum(['expense', 'income', 'investment']).default('expense'),
      level: z.enum(['parent', 'leaf']).default('parent'),
    })
    .parse(c.req.query())
  const range = await resolveRange(query)
  return c.json({
    range,
    slices: await analytics.categoryBreakdown(range, { flow: query.flow, level: query.level }),
  })
})

/* ---------------------------------------------------------------- *
 * Daily tracker
 * ---------------------------------------------------------------- */
app.get('/analytics/daily', async (c) => {
  const query = rangeQuery.extend({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(c.req.query())
  const range: analytics.Range = query.period
    ? {
        from: periodBounds(query.period).start,
        to: periodBounds(query.period).end,
        accountId: query.accountId ?? null,
      }
    : await resolveRange(query)

  const days = await analytics.dailySeries(range)
  const period = range.from.slice(0, 7)
  const progress = await goalsService.getPeriodProgress(period, range.accountId)

  const spentSoFar = days.filter((d) => d.day <= todayIso()).reduce((sum, d) => sum + d.expenseCents, 0)
  const cap = progress.goal.spendCapCents
  const paceCents = cap !== null ? Math.round(cap * (progress.daysElapsed / progress.daysTotal)) : null

  return c.json({
    range,
    period,
    days,
    pace: {
      daysElapsed: progress.daysElapsed,
      daysTotal: progress.daysTotal,
      spentCents: spentSoFar,
      capCents: cap,
      paceCents,
      aheadOfPaceCents: paceCents === null ? null : spentSoFar - paceCents,
      projectedMonthCents: progress.daysElapsed > 0 ? Math.round((spentSoFar / progress.daysElapsed) * progress.daysTotal) : 0,
      dailyAllowanceCents:
        cap !== null && progress.daysTotal - progress.daysElapsed > 0
          ? Math.max(0, Math.round((cap - spentSoFar) / (progress.daysTotal - progress.daysElapsed)))
          : null,
    },
    receivableCents: await analytics.receivable(range),
  })
})

/* ---------------------------------------------------------------- *
 * Monthly goals
 * ---------------------------------------------------------------- */
app.get('/goals/:period', async (c) => {
  const { period } = periodParam.parse(c.req.param())
  const query = z.object({ accountId: z.coerce.number().int().positive().optional() }).parse(c.req.query())
  return c.json(await goalsService.getPeriodProgress(period, query.accountId ?? null))
})

app.put('/goals/:period', async (c) => {
  const { period } = periodParam.parse(c.req.param())
  const body = z
    .object({
      incomeTargetCents: z.number().int().nonnegative().nullable().optional(),
      spendCapCents: z.number().int().nonnegative().nullable().optional(),
      savingsRateTargetBps: z.number().int().min(0).max(10_000).nullable().optional(),
      note: z.string().nullable().optional(),
    })
    .parse(await c.req.json())
  await goalsService.upsertGoal(period, body)
  return c.json(await goalsService.getPeriodProgress(period))
})

app.put('/goals/:period/caps/:categoryId', async (c) => {
  const params = z
    .object({ period: z.string().regex(/^\d{4}-\d{2}$/), categoryId: z.coerce.number().int().positive() })
    .parse(c.req.param())
  const body = z.object({ capCents: z.number().int().nonnegative() }).parse(await c.req.json())
  await goalsService.upsertCap(params.period, params.categoryId, body.capCents)
  return c.json(await goalsService.getPeriodProgress(params.period))
})

app.delete('/goals/:period/caps/:categoryId', async (c) => {
  const params = z
    .object({ period: z.string().regex(/^\d{4}-\d{2}$/), categoryId: z.coerce.number().int().positive() })
    .parse(c.req.param())
  await goalsService.deleteCap(params.period, params.categoryId)
  return c.json(await goalsService.getPeriodProgress(params.period))
})

app.post('/goals/:period/copy-from/:source', async (c) => {
  const params = z
    .object({ period: z.string().regex(/^\d{4}-\d{2}$/), source: z.string().regex(/^\d{4}-\d{2}$/) })
    .parse(c.req.param())
  await goalsService.copyGoals(params.source, params.period)
  return c.json(await goalsService.getPeriodProgress(params.period))
})

app.get('/goals/:period/suggestions', async (c) => {
  const { period } = periodParam.parse(c.req.param())
  return c.json({ suggestions: await goalsService.suggestCaps(period) })
})

app.get('/goals/:period/gap-in-projects', async (c) => {
  const { period } = periodParam.parse(c.req.param())
  const query = z.object({ sample: z.coerce.number().int().min(1).max(50).optional() }).parse(c.req.query())
  return c.json(await goalsService.gapInProjects(period, query.sample ?? 5))
})

app.get('/goals-history', async (c) => {
  const query = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }).parse(c.req.query())
  return c.json(await goalsService.goalHistory(query.months))
})

/* ---------------------------------------------------------------- *
 * Debt
 * ---------------------------------------------------------------- */
app.get('/debts', async (c) => {
  const query = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(c.req.query())
  const [overview, trend] = await Promise.all([debtService.debtOverview(query), debtService.debtTrend()])
  return c.json({ ...overview, trend })
})

app.post('/debts', async (c) => {
  const body = z
    .object({
      name: z.string().min(1),
      kind: z.enum(['credit_card', 'personal_loan', 'financing', 'overdraft', 'student', 'other']).default('credit_card'),
      institution: z.string().nullable().optional(),
      principalCents: z.number().int().nonnegative(),
      aprBps: z.number().int().min(0).max(1_000_000),
      minimumPaymentCents: z.number().int().nonnegative().default(0),
      scheduledPaymentCents: z.number().int().nonnegative().default(0),
      dueDay: z.number().int().min(1).max(31).default(10),
      installmentCount: z.number().int().positive().nullable().optional(),
      accountId: z.number().int().positive().nullable().optional(),
    })
    .parse(await c.req.json())
  const debt = await debtService.createDebt(body)
  await debtService.materializeDebtInstallments(debt.id)
  return c.json(debt)
})

app.patch('/debts/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      name: z.string().min(1).optional(),
      kind: z.string().optional(),
      institution: z.string().nullable().optional(),
      principalCents: z.number().int().nonnegative().optional(),
      aprBps: z.number().int().min(0).max(1_000_000).optional(),
      minimumPaymentCents: z.number().int().nonnegative().optional(),
      scheduledPaymentCents: z.number().int().nonnegative().optional(),
      dueDay: z.number().int().min(1).max(31).optional(),
      installmentCount: z.number().int().positive().nullable().optional(),
      accountId: z.number().int().positive().nullable().optional(),
      active: z.boolean().optional(),
    })
    .parse(await c.req.json())
  const debt = await debtService.updateDebt(id, body)
  if (debt) await debtService.materializeDebtInstallments(id)
  return c.json(debt)
})

app.delete('/debts/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await debtService.deleteDebt(id))
})

app.post('/debts/:id/snapshot', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIso()),
      balanceCents: z.number().int().nonnegative(),
    })
    .parse(await c.req.json())
  return c.json(await debtService.recordSnapshot(id, body.asOf, body.balanceCents))
})

app.get('/debts/payments', async (c) => {
  const query = z.object({ debtId: z.coerce.number().int().positive().optional() }).parse(c.req.query())
  return c.json({ payments: await debtService.listPayments(query.debtId) })
})

app.post('/debts/payments', async (c) => {
  const body = z
    .object({
      debtId: z.number().int().positive(),
      kind: z.enum(['payment', 'charge']).default('payment'),
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      amountCents: z.number().int().positive(),
      notes: z.string().nullable().optional(),
    })
    .parse(await c.req.json())
  return c.json(await debtService.createPayment(body))
})

app.delete('/debts/payments/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await debtService.deletePayment(id))
})

app.get('/debts/projection', async (c) => {
  const query = z
    .object({
      extraMonthlyCents: z.coerce.number().int().nonnegative().default(0),
      strategy: z.enum(['avalanche', 'snowball']).default('avalanche'),
    })
    .parse(c.req.query())
  return c.json(await debtService.paydownComparison(query.extraMonthlyCents, query.strategy))
})

/* ---------------------------------------------------------------- *
 * Credit cards
 * ---------------------------------------------------------------- */
app.get('/credit-cards', async (c) => c.json({ cards: await creditCardsService.listCards() }))

app.post('/credit-cards', async (c) => {
  const body = z
    .object({
      name: z.string().min(1),
      institution: z.string().nullable().optional(),
      accountId: z.number().int().positive().nullable().optional(),
      creditLimitCents: z.number().int().nonnegative(),
      closingDay: z.number().int().min(1).max(31).default(1),
      dueDay: z.number().int().min(1).max(31).default(10),
    })
    .parse(await c.req.json())
  return c.json(await creditCardsService.createCard(body))
})

app.patch('/credit-cards/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      name: z.string().min(1).optional(),
      institution: z.string().nullable().optional(),
      accountId: z.number().int().positive().nullable().optional(),
      creditLimitCents: z.number().int().nonnegative().optional(),
      closingDay: z.number().int().min(1).max(31).optional(),
      dueDay: z.number().int().min(1).max(31).optional(),
      active: z.boolean().optional(),
    })
    .parse(await c.req.json())
  return c.json(await creditCardsService.updateCard(id, body))
})

app.delete('/credit-cards/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await creditCardsService.deleteCard(id))
})

app.post('/credit-cards/:id/snapshot', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIso()),
      availableLimitCents: z.number().int().nonnegative(),
    })
    .parse(await c.req.json())
  return c.json(await creditCardsService.recordSnapshot(id, body.asOf, body.availableLimitCents))
})

/* ---------------------------------------------------------------- *
 * Saúde financeira
 * ---------------------------------------------------------------- */
const healthQuery = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  accountId: z.coerce.number().int().positive().optional(),
})

app.get('/financial-health/score', async (c) => {
  const query = healthQuery.parse(c.req.query())
  return c.json(await healthService.healthScore(await resolvePeriod(query.period), query.accountId ?? null))
})

app.get('/financial-health/runway', async (c) => {
  const query = z.object({ liquidClasses: z.string().optional() }).parse(c.req.query())
  const liquidClasses = query.liquidClasses
    ? query.liquidClasses.split(',').map((v) => v.trim()).filter(Boolean)
    : healthService.DEFAULT_LIQUID_ASSET_CLASSES
  return c.json(await healthService.runway(liquidClasses))
})

app.get('/financial-health/net-worth', async (c) => {
  const query = z.object({ scope: z.enum(['pf', 'pj', 'consolidado']).optional() }).parse(c.req.query())
  const result = await healthService.netWorth()
  return c.json({ ...result, scope: 'consolidado' as const, requestedScope: query.scope ?? null })
})

app.get('/financial-health/risk-radar', async (c) => {
  const query = healthQuery.parse(c.req.query())
  return c.json(await healthService.riskRadar(await resolvePeriod(query.period), query.accountId ?? null))
})

app.get('/financial-health/settings', async (c) =>
  c.json({ settings: await healthService.getSettings(), defaults: healthService.DEFAULT_HEALTH_SETTINGS }),
)

app.put('/financial-health/settings', async (c) => {
  const weight = z.number().int().min(0).max(100)
  const bps = z.number().int().min(0).max(100_000)
  const body = z
    .object({
      weightLiquidity: weight.optional(),
      weightDebt: weight.optional(),
      weightSpending: weight.optional(),
      weightReserve: weight.optional(),
      weightAllocation: weight.optional(),
      costLookbackMonths: z.number().int().min(1).max(24).optional(),
      riskCardShareBps: bps.optional(),
      riskReserveCoverageBps: bps.optional(),
      riskAllocationDriftBps: bps.optional(),
      riskSpendingCapBps: bps.optional(),
      riskDebtToIncomeBps: bps.optional(),
      riskPositiveMarginBps: bps.optional(),
    })
    .parse(await c.req.json())
  return c.json({ settings: await healthService.setSettings(body), defaults: healthService.DEFAULT_HEALTH_SETTINGS })
})

/* ---------------------------------------------------------------- *
 * Motor financeiro
 * ---------------------------------------------------------------- */
app.get('/financial-engine/available', async (c) => {
  const query = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(c.req.query())
  return c.json(await engineService.availableForAllocation(await resolvePeriod(query.period)))
})

app.get('/financial-engine/break-even', async (c) => {
  const query = z
    .object({
      period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      pjAccountId: z.coerce.number().int().positive().optional(),
      pfAccountId: z.coerce.number().int().positive().optional(),
      proLaboreCents: z.coerce.number().int().nonnegative().optional(),
      taxRateBps: z.coerce.number().int().min(0).max(10_000).optional(),
      reservePlannedCents: z.coerce.number().int().nonnegative().optional(),
      marginCents: z.coerce.number().int().nonnegative().optional(),
    })
    .parse(c.req.query())
  const period = await resolvePeriod(query.period)
  const overrides = {
    pjAccountId: query.pjAccountId ?? null,
    pfAccountId: query.pfAccountId ?? null,
    proLaboreCents: query.proLaboreCents ?? null,
    ...(query.taxRateBps === undefined ? {} : { taxRateBps: query.taxRateBps }),
    ...(query.reservePlannedCents === undefined ? {} : { reservePlannedCents: query.reservePlannedCents }),
    ...(query.marginCents === undefined ? {} : { marginCents: query.marginCents }),
  }

  const [comMetas, minimo] = await Promise.all([
    engineService.breakEven(period, overrides),
    engineService.breakEven(period, overrides, { includeGoals: false }),
  ])

  return c.json({
    ...comMetas,
    minimoCents: minimo.breakEvenCents,
    minimo: { breakEvenCents: minimo.breakEvenCents, lines: minimo.lines, assumptions: minimo.assumptions },
    metasCents:
      comMetas.breakEvenCents === null || minimo.breakEvenCents === null
        ? null
        : comMetas.breakEvenCents - minimo.breakEvenCents,
  })
})

app.get('/financial-engine/settings', async (c) =>
  c.json({ settings: await engineService.getSettings(), defaults: engineService.DEFAULT_BREAK_EVEN_PARAMS }),
)

app.put('/financial-engine/settings', async (c) => {
  const body = z
    .object({
      pjAccountId: z.number().int().positive().nullable().optional(),
      pfAccountId: z.number().int().positive().nullable().optional(),
      proLaboreCents: z.number().int().nonnegative().nullable().optional(),
      taxRateBps: z.number().int().min(0).max(10_000).optional(),
      reservePlannedCents: z.number().int().nonnegative().optional(),
      marginCents: z.number().int().nonnegative().optional(),
    })
    .parse(await c.req.json())
  return c.json({ settings: await engineService.setSettings(body), defaults: engineService.DEFAULT_BREAK_EVEN_PARAMS })
})

/* ---------------------------------------------------------------- *
 * Investments
 * ---------------------------------------------------------------- */
app.get('/investments', async (c) => {
  const query = z.object({ goalId: z.coerce.number().int().positive().optional() }).parse(c.req.query())
  const [summary, allocation, performance, goals] = await Promise.all([
    investments.portfolioSummary(),
    investments.allocation(query.goalId ?? null),
    investments.performanceSeries(),
    investments.listGoals(),
  ])
  return c.json({
    ...summary,
    allocation,
    performance,
    goals,
    assetClasses: investments.ASSET_CLASSES.map((value) => ({ value, label: investments.ASSET_CLASS_LABELS[value] ?? value })),
    goalPurposes: investments.GOAL_PURPOSES.map((value) => ({ value, label: investments.GOAL_PURPOSE_LABELS[value] ?? value })),
  })
})

app.get('/investments/trades', async (c) => {
  const query = z.object({ assetId: z.coerce.number().int().positive().optional() }).parse(c.req.query())
  return c.json({ trades: await investments.listTrades(query.assetId) })
})

app.get('/investments/summary', async (c) => {
  const query = z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIso()),
      assetClass: z.enum(investments.ASSET_CLASSES).optional(),
    })
    .parse(c.req.query())
  return c.json(await investments.rangeSummary(query.from ?? null, query.to, query.assetClass ?? null))
})

app.get('/investments/performance', async (c) => {
  const query = z
    .object({
      months: z.coerce.number().int().positive().max(1200).default(24),
      assetClass: z.enum(investments.ASSET_CLASSES).optional(),
    })
    .parse(c.req.query())
  return c.json({ performance: await investments.performanceSeries(query.months, query.assetClass ?? null) })
})

app.post('/investments/assets', async (c) => {
  const body = z
    .object({
      name: z.string().min(1),
      ticker: z.string().nullable().optional(),
      assetClass: z.enum(investments.ASSET_CLASSES).default('stocks'),
      accountId: z.number().int().positive().nullable().optional(),
    })
    .parse(await c.req.json())
  return c.json(await investments.createAsset(body))
})

app.patch('/investments/assets/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      name: z.string().min(1).optional(),
      ticker: z.string().nullable().optional(),
      assetClass: z.enum(investments.ASSET_CLASSES).optional(),
      countsTowardReserve: z.boolean().optional(),
      archived: z.boolean().optional(),
    })
    .parse(await c.req.json())
  return c.json(await investments.updateAsset(id, body))
})

app.delete('/investments/assets/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await investments.deleteAsset(id))
})

app.post('/investments/trades', async (c) => {
  const body = z
    .object({
      assetId: z.number().int().positive(),
      kind: z.enum(['buy', 'sell', 'dividend']).default('buy'),
      tradedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      quantity: z.number().positive(),
      unitPriceCents: z.number().int().nonnegative(),
      feesCents: z.number().int().nonnegative().default(0),
    })
    .parse(await c.req.json())
  return c.json(await investments.createTrade(body))
})

app.patch('/investments/trades/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      assetId: z.number().int().positive().optional(),
      kind: z.enum(['buy', 'sell', 'dividend']).optional(),
      tradedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      quantity: z.number().positive().optional(),
      unitPriceCents: z.number().int().nonnegative().optional(),
      feesCents: z.number().int().nonnegative().optional(),
    })
    .parse(await c.req.json())
  return c.json(await investments.updateTrade(id, body))
})

app.delete('/investments/trades/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await investments.deleteTrade(id))
})

app.post('/investments/assets/:id/valuation', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIso()), unitPriceCents: z.number().int().nonnegative() })
    .parse(await c.req.json())
  return c.json(await investments.recordValuation(id, body.asOf, body.unitPriceCents))
})

app.post('/investments/assets/:id/refresh-quote', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await quotesService.refreshAssetQuote(id))
})

app.post('/investments/quotes/refresh-all', async (c) => {
  return c.json(await quotesService.refreshAllQuotes(await investments.positions()))
})

app.post('/investments/goals', async (c) => {
  const body = z
    .object({
      name: z.string().min(1),
      targetValueCents: z.number().int().nonnegative(),
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      monthlyContributionCents: z.number().int().nonnegative().default(0),
      expectedReturnBps: z.number().int().min(-10_000).max(100_000).default(800),
      purpose: z.enum(investments.GOAL_PURPOSES).nullable().optional(),
    })
    .parse(await c.req.json())
  return c.json(await investments.createGoal(body))
})

app.patch('/investments/goals/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      name: z.string().min(1).optional(),
      targetValueCents: z.number().int().nonnegative().optional(),
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      monthlyContributionCents: z.number().int().nonnegative().optional(),
      expectedReturnBps: z.number().int().min(-10_000).max(100_000).optional(),
      purpose: z.enum(investments.GOAL_PURPOSES).nullable().optional(),
      active: z.boolean().optional(),
    })
    .parse(await c.req.json())
  return c.json(await investments.updateGoal(id, body))
})

app.delete('/investments/goals/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await investments.deleteGoal(id))
})

app.get('/investments/goals/:id/projection', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const query = z.object({ extraContributionCents: z.coerce.number().int().nonnegative().default(0) }).parse(c.req.query())
  const projection = await investments.goalProjection(id, undefined, query.extraContributionCents)
  if (!projection) return c.json({ error: 'meta não encontrada' }, 404)
  return c.json(projection)
})

app.get('/investments/profitability', async (c) => {
  const query = z.object({ assetClass: z.enum(investments.ASSET_CLASSES).optional() }).parse(c.req.query())
  const [portfolio, benchmarks, table] = await Promise.all([
    investments.portfolioMonthlyReturns(query.assetClass ?? null),
    benchmarksService.listBenchmarkSeries(benchmarksService.ALL_BENCHMARK_CODES),
    investments.profitabilityTable(query.assetClass ?? null),
  ])
  return c.json({ portfolio, benchmarks, table, benchmarkLabels: benchmarksService.BENCHMARK_LABELS })
})

app.post('/investments/benchmarks/refresh', async (c) => c.json(await benchmarksService.refreshBenchmarks()))

app.get('/investments/allocation-deviation', async (c) => {
  const query = z.object({ goalId: z.coerce.number().int().positive().optional() }).parse(c.req.query())
  return c.json(await investments.allocationDeviation(query.goalId ?? null))
})

app.put('/investments/allocation', async (c) => {
  const body = z
    .object({
      goalId: z.number().int().positive().nullable().default(null),
      entries: z.array(z.object({ assetClass: z.enum(investments.ASSET_CLASSES), targetBps: z.number().int().min(0).max(10_000) })),
    })
    .parse(await c.req.json())
  return c.json({ allocation: await investments.setTargetAllocation(body.goalId, body.entries) })
})

/* ---------------------------------------------------------------- *
 * "Diagrama do Cerrado" — critérios de resistência
 * ---------------------------------------------------------------- */
app.get('/criteria', async (c) => {
  const query = z.object({ assetClass: z.enum(investments.ASSET_CLASSES).optional() }).parse(c.req.query())
  return c.json({ criteria: await criteriaService.listCriteria(query.assetClass) })
})

app.post('/criteria', async (c) => {
  const body = z
    .object({ assetClass: z.enum(investments.ASSET_CLASSES), label: z.string().min(1), sortOrder: z.number().int().optional() })
    .parse(await c.req.json())
  return c.json(await criteriaService.createCriterion(body))
})

app.patch('/criteria/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({ label: z.string().min(1).optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional() })
    .parse(await c.req.json())
  return c.json(await criteriaService.updateCriterion(id, body))
})

app.delete('/criteria/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await criteriaService.deleteCriterion(id))
})

app.get('/investments/assets/:id/note', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const note = await criteriaService.getAssetNote(id)
  if (!note) return c.json({ error: 'ativo não encontrado' }, 404)
  return c.json(note)
})

app.put('/investments/assets/:assetId/criteria/:criteriaId', async (c) => {
  const params = z
    .object({ assetId: z.coerce.number().int().positive(), criteriaId: z.coerce.number().int().positive() })
    .parse(c.req.param())
  const body = z.object({ checked: z.boolean() }).parse(await c.req.json())
  await criteriaService.setAnswer(params.assetId, params.criteriaId, body.checked)
  return c.json(await criteriaService.getAssetNote(params.assetId))
})

app.delete('/investments/assets/:assetId/criteria/:criteriaId', async (c) => {
  const params = z
    .object({ assetId: z.coerce.number().int().positive(), criteriaId: z.coerce.number().int().positive() })
    .parse(c.req.param())
  await criteriaService.clearAnswer(params.assetId, params.criteriaId)
  return c.json(await criteriaService.getAssetNote(params.assetId))
})

app.get('/investments/allocation/:assetClass', async (c) => {
  const params = z.object({ assetClass: z.enum(investments.ASSET_CLASSES) }).parse(c.req.param())
  const query = z.object({ goalId: z.coerce.number().int().positive().optional() }).parse(c.req.query())
  return c.json(await investments.assetAllocationWithinClass(params.assetClass, query.goalId ?? null))
})

app.get('/investments/contribution-plan', async (c) => {
  const query = z
    .object({ amountCents: z.coerce.number().int().positive(), goalId: z.coerce.number().int().positive().optional() })
    .parse(c.req.query())
  return c.json(await investments.suggestContribution(query.amountCents, query.goalId ?? null))
})

/* ---------------------------------------------------------------- *
 * Emergency reserve
 * ---------------------------------------------------------------- */
app.get('/investments/reserve', async (c) => c.json(await investments.reserveStatus()))

app.put('/investments/reserve', async (c) => {
  const body = z
    .object({
      multiple: z.number().int().refine((v) => [6, 12, 24].includes(v), 'multiple deve ser 6, 12 ou 24').optional(),
      lookbackMonths: z.number().int().min(1).max(24).optional(),
      manualLivingCostCents: z.number().int().nonnegative().nullable().optional(),
    })
    .parse(await c.req.json())
  return c.json(await investments.setReserveSettings(body))
})

app.post('/investments/reserve/contribute', async (c) => {
  const body = z
    .object({
      amountCents: z.number().int().positive(),
      tradedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIso()),
      kind: z.enum(['buy', 'sell']).default('buy'),
    })
    .parse(await c.req.json())
  await investments.contributeToReserve(body)
  return c.json(await investments.reserveStatus())
})

/* ---------------------------------------------------------------- *
 * Cash-flow forecasts
 * ---------------------------------------------------------------- */
app.get('/cash-flow/forecasts', async (c) => {
  await cashFlowService.materializeAll()
  return c.json({ forecasts: await cashFlowService.listForecasts() })
})

app.post('/cash-flow/forecasts', async (c) => {
  const body = z
    .object({
      description: z.string().min(1),
      kind: z.enum(['recurring', 'installment', 'single']).default('recurring'),
      amountCents: z.number().int().refine((v) => v !== 0, 'valor não pode ser zero'),
      accountId: z.number().int().positive(),
      categoryId: z.number().int().positive().nullable().optional(),
      startPeriod: z.string().regex(/^\d{4}-\d{2}$/),
      dueDay: z.number().int().min(1).max(31).default(1),
      installmentCount: z.number().int().positive().nullable().optional(),
      installmentsRealized: z.number().int().nonnegative().default(0),
      endPeriod: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
      notes: z.string().nullable().optional(),
    })
    .parse(await c.req.json())
  return c.json(await cashFlowService.createForecast(body))
})

app.patch('/cash-flow/forecasts/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const body = z
    .object({
      description: z.string().min(1).optional(),
      amountCents: z.number().int().refine((v) => v !== 0, 'valor não pode ser zero').optional(),
      accountId: z.number().int().positive().optional(),
      categoryId: z.number().int().positive().nullable().optional(),
      startPeriod: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      dueDay: z.number().int().min(1).max(31).optional(),
      installmentCount: z.number().int().positive().nullable().optional(),
      installmentsRealized: z.number().int().nonnegative().optional(),
      endPeriod: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
      notes: z.string().nullable().optional(),
      active: z.boolean().optional(),
    })
    .parse(await c.req.json())
  return c.json(await cashFlowService.updateForecast(id, body))
})

app.delete('/cash-flow/forecasts/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await cashFlowService.deleteForecast(id))
})

app.get('/cash-flow/pending', async (c) => {
  const query = z
    .object({
      flow: z.enum(['income', 'expense']),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .parse(c.req.query())
  await Promise.all([cashFlowService.materializeAll(), debtService.materializeAllDebts()])
  const range = query.from && query.to ? { from: query.from, to: query.to } : undefined
  return c.json({ pending: await cashFlowService.listPending(query.flow, range) })
})

app.delete('/cash-flow/pending/:id', async (c) => {
  const { id } = idParam.parse(c.req.param())
  const query = z.object({ scope: z.enum(['only', 'this_and_future', 'all']).default('only') }).parse(c.req.query())
  return c.json(await cashFlowService.deletePending(id, query.scope))
})

app.get('/cash-flow/reconciliation-candidates', async (c) =>
  c.json({ candidates: await cashFlowService.reconciliationCandidates() }),
)

app.post('/cash-flow/pending/:id/confirm-match', async (c) => {
  const { id } = idParam.parse(c.req.param())
  let raw: unknown = {}
  try {
    raw = await c.req.json()
  } catch {
    // corpo vazio é válido aqui — matchId é opcional
  }
  const body = z.object({ matchId: z.number().int().positive().optional() }).parse(raw)
  return c.json(await cashFlowService.confirmReconciliation(id, body.matchId))
})

app.post('/cash-flow/pending/:id/settle', async (c) => {
  const { id } = idParam.parse(c.req.param())
  return c.json(await cashFlowService.settlePending(id))
})

app.post('/cash-flow/reconciliation-candidates/dismiss', async (c) => {
  const body = z.object({ pendingId: z.number().int().positive(), matchId: z.number().int().positive() }).parse(await c.req.json())
  return c.json(await cashFlowService.dismissReconciliation(body.pendingId, body.matchId))
})

Deno.serve(app.fetch)
