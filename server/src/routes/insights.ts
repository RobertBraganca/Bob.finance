import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { addMonths, periodBounds, todayIso } from '../core/dates'
import * as analytics from '../services/analytics'
import * as benchmarksService from '../services/benchmarks'
import * as cashFlowService from '../services/cashFlow'
import * as creditCardsService from '../services/creditCards'
import * as criteriaService from '../services/criteria'
import * as debtService from '../services/debt'
import * as dreService from '../services/dre'
import * as engineService from '../services/financialEngine'
import * as healthService from '../services/financialHealth'
import * as goalsService from '../services/goals'
import * as investments from '../services/investments'
import * as monthlyClosingService from '../services/monthlyClosing'
import * as quotesService from '../services/quotes'
import { ledgerBounds } from '../services/transactions'
import { accountFlows } from '../services/transfers'

const rangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountId: z.coerce.number().int().positive().optional(),
})

const periodParam = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) })
const idParam = z.object({ id: z.coerce.number().int().positive() })

/**
 * Default range: the last 6 months of whatever the ledger actually holds.
 * Falling back to "today" would show an empty dashboard to someone who just
 * imported historical statements.
 */
async function resolveRange(query: z.infer<typeof rangeQuery>): Promise<analytics.Range> {
  const bounds = await ledgerBounds()
  const anchor = query.to ?? bounds.max ?? todayIso()
  const to = query.to ?? periodBounds(anchor.slice(0, 7)).end
  const from = query.from ?? periodBounds(addMonths(anchor.slice(0, 7), -5)).start
  return { from, to, accountId: query.accountId ?? null }
}

export async function insightsRoutes(app: FastifyInstance) {
  app.get('/meta', async () => {
    const bounds = await ledgerBounds()
    return {
      ledger: bounds,
      today: todayIso(),
      defaultRange: await resolveRange({}),
      accounts: await analytics.accountBalances(),
      hasData: bounds.count > 0,
    }
  })

  /* ---------------------------------------------------------------- *
   * Income vs expense dashboard
   * ---------------------------------------------------------------- */
  app.get('/dashboard', async (req) => {
    const query = rangeQuery.extend({ futureReceivables: z.coerce.boolean().optional() }).parse(req.query)
    const range = await resolveRange(query)
    return analytics.dashboard(range, { includeFutureReceivables: query.futureReceivables })
  })

  /**
   * Account-to-account flow. Deliberately ignores accountId: a flow diagram
   * IS the cross-account picture, so scoping it to one account would leave
   * nothing to draw.
   */
  app.get('/analytics/flows', async (req) => {
    const query = rangeQuery.parse(req.query)
    const range = await resolveRange(query)
    return accountFlows({ from: range.from, to: range.to })
  })

  app.get('/analytics/monthly', async (req) => {
    const range = await resolveRange(rangeQuery.parse(req.query))
    return { range, series: await analytics.monthlySeries(range) }
  })

  /**
   * DRE per account — every leaf category as its own line, plus the
   * uncategorized rows grouped by merchant so the biggest unclassified
   * chunks surface first. accountId is required in practice (the DRE
   * page always calls it once per account) but falls back to the whole
   * ledger like every other range-scoped endpoint here.
   */
  app.get('/analytics/dre', async (req) => {
    const range = await resolveRange(rangeQuery.parse(req.query))
    return dreService.dreReport(range)
  })

  /** DRE formal (PJ), ver specs/dre "DRE PJ formal" — accountId é a conta PJ, resolvida no front igual o resto desta tela. */
  app.get('/analytics/dre/formal', async (req) => {
    const range = await resolveRange(rangeQuery.parse(req.query))
    return dreService.formalDre(range)
  })

  app.get('/analytics/categories', async (req) => {
    const query = rangeQuery
      .extend({
        flow: z.enum(['expense', 'income', 'investment']).default('expense'),
        level: z.enum(['parent', 'leaf']).default('parent'),
      })
      .parse(req.query)
    const range = await resolveRange(query)
    return {
      range,
      slices: await analytics.categoryBreakdown(range, { flow: query.flow, level: query.level }),
    }
  })

  /* ---------------------------------------------------------------- *
   * Daily tracker
   * ---------------------------------------------------------------- */
  app.get('/analytics/daily', async (req) => {
    const query = rangeQuery.extend({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query)
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

    const spentSoFar = days
      .filter((d) => d.day <= todayIso())
      .reduce((sum, d) => sum + d.expenseCents, 0)
    const cap = progress.goal.spendCapCents
    const paceCents = cap !== null ? Math.round(cap * (progress.daysElapsed / progress.daysTotal)) : null

    return {
      range,
      period,
      days,
      pace: {
        daysElapsed: progress.daysElapsed,
        daysTotal: progress.daysTotal,
        spentCents: spentSoFar,
        capCents: cap,
        paceCents,
        /** ahead of pace = spending faster than the budget allows */
        aheadOfPaceCents: paceCents === null ? null : spentSoFar - paceCents,
        projectedMonthCents:
          progress.daysElapsed > 0
            ? Math.round((spentSoFar / progress.daysElapsed) * progress.daysTotal)
            : 0,
        dailyAllowanceCents:
          cap !== null && progress.daysTotal - progress.daysElapsed > 0
            ? Math.max(0, Math.round((cap - spentSoFar) / (progress.daysTotal - progress.daysElapsed)))
            : null,
      },
      receivableCents: await analytics.receivable(range),
      streak: await analytics.dailyStreak(),
    }
  })

  /* ---------------------------------------------------------------- *
   * Monthly goals
   * ---------------------------------------------------------------- */
  app.get('/goals/:period', async (req) => {
    const { period } = periodParam.parse(req.params)
    const query = z.object({ accountId: z.coerce.number().int().positive().optional() }).parse(req.query)
    return goalsService.getPeriodProgress(period, query.accountId ?? null)
  })

  app.put('/goals/:period', async (req) => {
    const { period } = periodParam.parse(req.params)
    const body = z
      .object({
        incomeTargetCents: z.number().int().nonnegative().nullable().optional(),
        spendCapCents: z.number().int().nonnegative().nullable().optional(),
        savingsRateTargetBps: z.number().int().min(0).max(10_000).nullable().optional(),
        note: z.string().nullable().optional(),
      })
      .parse(req.body)
    await goalsService.upsertGoal(period, body)
    return goalsService.getPeriodProgress(period)
  })

  app.put('/goals/:period/caps/:categoryId', async (req) => {
    const params = z
      .object({
        period: z.string().regex(/^\d{4}-\d{2}$/),
        categoryId: z.coerce.number().int().positive(),
      })
      .parse(req.params)
    const body = z.object({ capCents: z.number().int().nonnegative() }).parse(req.body)
    await goalsService.upsertCap(params.period, params.categoryId, body.capCents)
    return goalsService.getPeriodProgress(params.period)
  })

  app.delete('/goals/:period/caps/:categoryId', async (req) => {
    const params = z
      .object({
        period: z.string().regex(/^\d{4}-\d{2}$/),
        categoryId: z.coerce.number().int().positive(),
      })
      .parse(req.params)
    await goalsService.deleteCap(params.period, params.categoryId)
    return goalsService.getPeriodProgress(params.period)
  })

  app.post('/goals/:period/copy-from/:source', async (req) => {
    const params = z
      .object({
        period: z.string().regex(/^\d{4}-\d{2}$/),
        source: z.string().regex(/^\d{4}-\d{2}$/),
      })
      .parse(req.params)
    await goalsService.copyGoals(params.source, params.period)
    return goalsService.getPeriodProgress(params.period)
  })

  app.get('/goals/:period/suggestions', async (req) => {
    const { period } = periodParam.parse(req.params)
    return { suggestions: await goalsService.suggestCaps(period) }
  })

  /**
   * O que falta da meta de receita, traduzido em número de projetos do
   * tamanho dos que o usuário andou cotando. Divide dois números que já
   * existem, um daqui e um de `specs/project-pricing`.
   */
  app.get('/goals/:period/gap-in-projects', async (req) => {
    const { period } = periodParam.parse(req.params)
    const query = z.object({ sample: z.coerce.number().int().min(1).max(50).optional() }).parse(req.query)
    return goalsService.gapInProjects(period, query.sample ?? 5)
  })

  app.get('/goals-history', async (req) => {
    const query = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }).parse(req.query)
    return goalsService.goalHistory(query.months)
  })

  /** "Termômetro mensal" — avisos dispensáveis do Painel, ver goals.ts. */
  app.get('/home/banners', async () => ({ banners: await goalsService.homeBanners() }))

  /* ---------------------------------------------------------------- *
   * Debt
   * ---------------------------------------------------------------- */
  app.get('/debts', async (req) => {
    const query = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query)
    const [overview, trend] = await Promise.all([debtService.debtOverview(query), debtService.debtTrend()])
    return { ...overview, trend }
  })

  app.post('/debts', async (req) => {
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
      .parse(req.body)
    const debt = await debtService.createDebt(body)
    await debtService.materializeDebtInstallments(debt.id)
    return debt
  })

  app.patch('/debts/:id', async (req) => {
    const { id } = idParam.parse(req.params)
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
      .parse(req.body)
    const debt = await debtService.updateDebt(id, body)
    if (debt) await debtService.materializeDebtInstallments(id)
    return debt
  })

  app.delete('/debts/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return debtService.deleteDebt(id)
  })

  app.post('/debts/:id/snapshot', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIso()),
        balanceCents: z.number().int().nonnegative(),
      })
      .parse(req.body)
    return debtService.recordSnapshot(id, body.asOf, body.balanceCents)
  })

  /** The payment ledger — "parcelas pagas / novo uso", mirroring investments' trade log. */
  app.get('/debts/payments', async (req) => {
    const query = z.object({ debtId: z.coerce.number().int().positive().optional() }).parse(req.query)
    return { payments: await debtService.listPayments(query.debtId) }
  })

  app.post('/debts/payments', async (req) => {
    const body = z
      .object({
        debtId: z.number().int().positive(),
        kind: z.enum(['payment', 'charge']).default('payment'),
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        amountCents: z.number().int().positive(),
        notes: z.string().nullable().optional(),
      })
      .parse(req.body)
    return debtService.createPayment(body)
  })

  app.delete('/debts/payments/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return debtService.deletePayment(id)
  })

  app.get('/debts/projection', async (req) => {
    const query = z
      .object({
        extraMonthlyCents: z.coerce.number().int().nonnegative().default(0),
        strategy: z.enum(['avalanche', 'snowball']).default('avalanche'),
      })
      .parse(req.query)
    return debtService.paydownComparison(query.extraMonthlyCents, query.strategy)
  })

  /* ---------------------------------------------------------------- *
   * Credit cards
   * ---------------------------------------------------------------- */
  app.get('/credit-cards', async () => ({ cards: await creditCardsService.listCards() }))

  app.post('/credit-cards', async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        institution: z.string().nullable().optional(),
        accountId: z.number().int().positive().nullable().optional(),
        creditLimitCents: z.number().int().nonnegative(),
        closingDay: z.number().int().min(1).max(31).default(1),
        dueDay: z.number().int().min(1).max(31).default(10),
      })
      .parse(req.body)
    return creditCardsService.createCard(body)
  })

  app.patch('/credit-cards/:id', async (req) => {
    const { id } = idParam.parse(req.params)
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
      .parse(req.body)
    return creditCardsService.updateCard(id, body)
  })

  app.delete('/credit-cards/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return creditCardsService.deleteCard(id)
  })

  app.post('/credit-cards/:id/snapshot', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIso()),
        availableLimitCents: z.number().int().nonnegative(),
      })
      .parse(req.body)
    return creditCardsService.recordSnapshot(id, body.asOf, body.availableLimitCents)
  })

  /* ---------------------------------------------------------------- *
   * Saúde financeira — Health Score, Runway, Radar de risco.
   *
   * Read-only by construction: this whole area derives from
   * `transactions` and from the debt/card/goal/investment services, and
   * stores nothing but the user's own weights and thresholds.
   *
   * Every response here carries `assumptions`, the memory of calculation
   * required by decisions/0010 — it is part of the data contract, not
   * something the client is trusted to reconstruct. See
   * specs/financial-health.
   * ---------------------------------------------------------------- */

  /** The month being measured, defaulting to the ledger's most recent one for the same reason `resolveRange` does. */
  async function resolvePeriod(period?: string): Promise<string> {
    if (period) return period
    const bounds = await ledgerBounds()
    return bounds.max?.slice(0, 7) ?? todayIso().slice(0, 7)
  }

  const healthQuery = z.object({
    period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    accountId: z.coerce.number().int().positive().optional(),
  })

  app.get('/financial-health/score', async (req) => {
    const query = healthQuery.parse(req.query)
    return healthService.healthScore(await resolvePeriod(query.period), query.accountId ?? null)
  })

  app.get('/financial-health/score-history', async (req) => {
    const query = z
      .object({ months: z.coerce.number().int().min(1).max(36).default(12), accountId: z.coerce.number().int().positive().optional() })
      .parse(req.query)
    return { history: await healthService.healthScoreHistory(query.months, query.accountId ?? null) }
  })

  app.get('/financial-health/net-worth-history', async (req) => {
    const query = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }).parse(req.query)
    return { history: await healthService.netWorthHistory(query.months) }
  })

  app.get('/financial-health/closing-checklist', async (req) => {
    const query = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query)
    return monthlyClosingService.closingChecklist(query.period)
  })

  app.post('/financial-health/closing-checklist', async (req) => {
    const body = z
      .object({ period: z.string().regex(/^\d{4}-\d{2}$/), reviewed: z.boolean() })
      .parse(req.body)
    await monthlyClosingService.setClosingReview(body.period, body.reviewed)
    return monthlyClosingService.closingChecklist(body.period)
  })

  app.get('/financial-health/runway', async (req) => {
    const query = z
      .object({ liquidClasses: z.string().optional() })
      .parse(req.query)
    const liquidClasses = query.liquidClasses
      ? query.liquidClasses.split(',').map((c) => c.trim()).filter(Boolean)
      : healthService.DEFAULT_LIQUID_ASSET_CLASSES
    return healthService.runway(liquidClasses)
  })

  /**
   * Patrimônio consolidado. O `scope` é aceito e deliberadamente ignorado:
   * investimentos não são atribuíveis a uma conta corrente, então a única
   * resposta honesta é a consolidada, e `assumptions.notaDeEscopo` diz isso
   * em vez de a rota fingir um recorte por conta.
   */
  app.get('/financial-health/net-worth', async (req) => {
    const query = z.object({ scope: z.enum(['pf', 'pj', 'consolidado']).optional() }).parse(req.query)
    const result = await healthService.netWorth()
    return {
      ...result,
      scope: 'consolidado' as const,
      requestedScope: query.scope ?? null,
    }
  })

  app.get('/financial-health/risk-radar', async (req) => {
    const query = healthQuery.parse(req.query)
    return healthService.riskRadar(await resolvePeriod(query.period), query.accountId ?? null)
  })

  /**
   * Weights and thresholds. The only writable surface in this area, and
   * deliberately so: a threshold that lives in code is a judgement the
   * product made on the user's behalf, which is what decisions/0010 rules
   * out. Defaults come back until the user saves something else.
   */
  app.get('/financial-health/settings', async () => ({
    settings: await healthService.getSettings(),
    defaults: healthService.DEFAULT_HEALTH_SETTINGS,
  }))

  app.put('/financial-health/settings', async (req) => {
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
      // Mesmo bug de /financial-engine/settings (corpo vazio travava o
      // update do Drizzle com 500 em vez de 400) — achado da avaliação de
      // uso de 01/09/2026, corrigido aqui por precaução (nunca observado
      // neste endpoint especificamente, mas é o mesmo padrão exato).
      .refine((v) => Object.keys(v).length > 0, { message: 'nada para atualizar' })
      .parse(req.body)
    return { settings: await healthService.setSettings(body), defaults: healthService.DEFAULT_HEALTH_SETTINGS }
  })

  /* ---------------------------------------------------------------- *
   * Motor financeiro — alocação do disponível e ponto de equilíbrio.
   *
   * Both endpoints return the composition, not just the total: the terms
   * of the subtraction in one, the line-by-line sum in the other. See
   * specs/motor-financeiro and decisions/0010.
   * ---------------------------------------------------------------- */
  app.get('/financial-engine/available', async (req) => {
    const query = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query)
    return engineService.availableForAllocation(await resolvePeriod(query.period))
  })

  /** Recordes observacionais — estudo de viabilidade #5, 29/08/2026. */
  app.get('/financial-engine/records', async (req) => {
    const query = z.object({ months: z.coerce.number().int().min(1).max(60).default(24) }).parse(req.query)
    return engineService.financialEngineRecords(query.months)
  })

  app.get('/financial-engine/break-even', async (req) => {
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
      .parse(req.query)
    const period = await resolvePeriod(query.period)
    const overrides = {
      pjAccountId: query.pjAccountId ?? null,
      pfAccountId: query.pfAccountId ?? null,
      proLaboreCents: query.proLaboreCents ?? null,
      ...(query.taxRateBps === undefined ? {} : { taxRateBps: query.taxRateBps }),
      ...(query.reservePlannedCents === undefined ? {} : { reservePlannedCents: query.reservePlannedCents }),
      ...(query.marginCents === undefined ? {} : { marginCents: query.marginCents }),
    }

    /*
     * Dois números da MESMA função, nunca duas fórmulas. `breakEvenCents`
     * mantém o nome e o valor de sempre (com metas), para não quebrar quem
     * já consome esta rota; `minimoCents` é o campo novo, sem as metas.
     */
    const [comMetas, minimo] = await Promise.all([
      engineService.breakEven(period, overrides),
      engineService.breakEven(period, overrides, { includeGoals: false }),
    ])

    return {
      ...comMetas,
      minimoCents: minimo.breakEvenCents,
      minimo: {
        breakEvenCents: minimo.breakEvenCents,
        lines: minimo.lines,
        assumptions: minimo.assumptions,
      },
      // O que as metas configuradas acrescentam ao mínimo. Null quando
      // algum dos dois lados não tem ponto de equilíbrio (alíquota >= 100%).
      metasCents:
        comMetas.breakEvenCents === null || minimo.breakEvenCents === null
          ? null
          : comMetas.breakEvenCents - minimo.breakEvenCents,
    }
  })

  /**
   * Engine parameters. Same singleton shape and same single GET/PUT pair as
   * `/financial-health/settings`: pró-labore override, alíquota, reserva
   * planejada, margem and which accounts hold the PJ/PF books are the user's
   * choices, not derived data. Anything derivable stays out of here.
   */
  app.get('/financial-engine/settings', async () => ({
    settings: await engineService.getSettings(),
    defaults: engineService.DEFAULT_BREAK_EVEN_PARAMS,
  }))

  app.put('/financial-engine/settings', async (req) => {
    const body = z
      .object({
        pjAccountId: z.number().int().positive().nullable().optional(),
        pfAccountId: z.number().int().positive().nullable().optional(),
        proLaboreCents: z.number().int().nonnegative().nullable().optional(),
        taxRateBps: z.number().int().min(0).max(10_000).optional(),
        reservePlannedCents: z.number().int().nonnegative().optional(),
        marginCents: z.number().int().nonnegative().optional(),
      })
      // Corpo vazio ({}) travava o update do Drizzle com "No values to
      // set" (500 em vez de 400) — achado da avaliação de uso de
      // 01/09/2026.
      .refine((v) => Object.keys(v).length > 0, { message: 'nada para atualizar' })
      .parse(req.body)
    return {
      settings: await engineService.setSettings(body),
      defaults: engineService.DEFAULT_BREAK_EVEN_PARAMS,
    }
  })

  /* ---------------------------------------------------------------- *
   * Investments
   * ---------------------------------------------------------------- */
  app.get('/investments', async (req) => {
    const query = z.object({ goalId: z.coerce.number().int().positive().optional() }).parse(req.query)
    const [summary, allocation, performance, goals] = await Promise.all([
      investments.portfolioSummary(),
      investments.allocation(query.goalId ?? null),
      investments.performanceSeries(),
      investments.listGoals(),
    ])
    return {
      ...summary,
      allocation,
      performance,
      goals,
      assetClasses: investments.ASSET_CLASSES.map((value) => ({
        value,
        label: investments.ASSET_CLASS_LABELS[value] ?? value,
      })),
      /**
       * Só as classes que podem receber META. O modal de alocação-alvo usa
       * esta, e o cadastro de ativo usa a de cima — que precisa do
       * imobilizado para um carro poder ser cadastrado como carro.
       */
      allocatableAssetClasses: investments.ALLOCATABLE_ASSET_CLASSES.map((value) => ({
        value,
        label: investments.ASSET_CLASS_LABELS[value] ?? value,
      })),
      goalPurposes: investments.GOAL_PURPOSES.map((value) => ({
        value,
        label: investments.GOAL_PURPOSE_LABELS[value] ?? value,
      })),
    }
  })

  app.get('/investments/illiquid', async () => investments.illiquidOverview())

  app.get('/investments/trades', async (req) => {
    const query = z.object({ assetId: z.coerce.number().int().positive().optional() }).parse(req.query)
    return { trades: await investments.listTrades(query.assetId) }
  })

  /** Powers the summary dashboard's KPI row — one window, optionally one class. */
  app.get('/investments/summary', async (req) => {
    const query = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIso()),
        assetClass: z.enum(investments.ASSET_CLASSES).optional(),
      })
      .parse(req.query)
    return investments.rangeSummary(query.from ?? null, query.to, query.assetClass ?? null)
  })

  /** Powers the "Evolução do Patrimônio" stacked chart — same window/class filter as the summary. */
  app.get('/investments/performance', async (req) => {
    const query = z
      .object({
        months: z.coerce.number().int().positive().max(1200).default(24),
        assetClass: z.enum(investments.ASSET_CLASSES).optional(),
      })
      .parse(req.query)
    return { performance: await investments.performanceSeries(query.months, query.assetClass ?? null) }
  })

  app.post('/investments/assets', async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        ticker: z.string().nullable().optional(),
        assetClass: z.enum(investments.ASSET_CLASSES).default('stocks'),
        accountId: z.number().int().positive().nullable().optional(),
      })
      .parse(req.body)
    return investments.createAsset(body)
  })

  app.patch('/investments/assets/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        name: z.string().min(1).optional(),
        ticker: z.string().nullable().optional(),
        assetClass: z.enum(investments.ASSET_CLASSES).optional(),
        countsTowardReserve: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body)
    return investments.updateAsset(id, body)
  })

  app.delete('/investments/assets/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return investments.deleteAsset(id)
  })

  app.post('/investments/trades', async (req) => {
    const body = z
      .object({
        assetId: z.number().int().positive(),
        kind: z.enum(['buy', 'sell', 'dividend']).default('buy'),
        tradedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        quantity: z.number().positive(),
        unitPriceCents: z.number().int().nonnegative(),
        feesCents: z.number().int().nonnegative().default(0),
      })
      .parse(req.body)
    return investments.createTrade(body)
  })

  app.patch('/investments/trades/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        assetId: z.number().int().positive().optional(),
        kind: z.enum(['buy', 'sell', 'dividend']).optional(),
        tradedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        quantity: z.number().positive().optional(),
        unitPriceCents: z.number().int().nonnegative().optional(),
        feesCents: z.number().int().nonnegative().optional(),
      })
      .parse(req.body)
    return investments.updateTrade(id, body)
  })

  app.delete('/investments/trades/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return investments.deleteTrade(id)
  })

  app.post('/investments/assets/:id/valuation', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIso()),
        unitPriceCents: z.number().int().nonnegative(),
      })
      .parse(req.body)
    return investments.recordValuation(id, body.asOf, body.unitPriceCents)
  })

  /** One BRAPI request, one asset — records a fresh valuation from the live B3 quote. */
  app.post('/investments/assets/:id/refresh-quote', async (req) => {
    const { id } = idParam.parse(req.params)
    return quotesService.refreshAssetQuote(id)
  })

  /**
   * Every quotable position, one BRAPI request each, run sequentially —
   * the free plan allows exactly one ticker per request, so this is a
   * loop, never a batch call.
   */
  app.post('/investments/quotes/refresh-all', async () => {
    return quotesService.refreshAllQuotes(await investments.positions())
  })

  app.post('/investments/goals', async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        targetValueCents: z.number().int().nonnegative(),
        targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        monthlyContributionCents: z.number().int().nonnegative().default(0),
        expectedReturnBps: z.number().int().min(-10_000).max(100_000).default(800),
        purpose: z.enum(investments.GOAL_PURPOSES).nullable().optional(),
      })
      .parse(req.body)
    return investments.createGoal(body)
  })

  app.patch('/investments/goals/:id', async (req) => {
    const { id } = idParam.parse(req.params)
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
      .parse(req.body)
    return investments.updateGoal(id, body)
  })

  app.delete('/investments/goals/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return investments.deleteGoal(id)
  })

  app.get('/investments/goals/:id/projection', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const query = z.object({ extraContributionCents: z.coerce.number().int().nonnegative().default(0) }).parse(req.query)
    const projection = await investments.goalProjection(id, undefined, query.extraContributionCents)
    if (!projection) return reply.code(404).send({ error: 'meta não encontrada' })
    return projection
  })

  /**
   * "Rentabilidade" section — the portfolio's own monthly returns plus
   * every benchmark this app tracks, and the year×month table built
   * from the same monthly series.
   */
  app.get('/investments/profitability', async (req) => {
    const query = z.object({ assetClass: z.enum(investments.ASSET_CLASSES).optional() }).parse(req.query)
    const [portfolio, benchmarks, table] = await Promise.all([
      investments.portfolioMonthlyReturns(query.assetClass ?? null),
      benchmarksService.listBenchmarkSeries(benchmarksService.ALL_BENCHMARK_CODES),
      investments.profitabilityTable(query.assetClass ?? null),
    ])
    return {
      portfolio,
      benchmarks,
      table,
      benchmarkLabels: benchmarksService.BENCHMARK_LABELS,
    }
  })

  /** Manual refresh — CDI/IPCA come back complete every time; the ETF-proxied indices add whatever the free BRAPI window covers. */
  app.post('/investments/benchmarks/refresh', async () => benchmarksService.refreshBenchmarks())

  /**
   * Desvio de alocação: current share vs the user's own policy, per class.
   * Returns no suggested asset and no recommended action, by contract
   * rather than by omission in the UI — see the note above
   * `allocationDeviation` in services/investments.ts for why that absence
   * is load-bearing (decisions/0010, Ofício-Circular CVM/SIN 2/2026).
   */
  app.get('/investments/allocation-deviation', async (req) => {
    const query = z.object({ goalId: z.coerce.number().int().positive().optional() }).parse(req.query)
    return investments.allocationDeviation(query.goalId ?? null)
  })

  app.put('/investments/allocation', async (req) => {
    const body = z
      .object({
        goalId: z.number().int().positive().nullable().default(null),
        entries: z.array(
          z.object({
            // Lista ALOCÁVEL, não a completa: imobilizado não recebe meta.
            assetClass: z.enum(investments.ALLOCATABLE_ASSET_CLASSES),
            targetBps: z.number().int().min(0).max(10_000),
          }),
        ),
      })
      .parse(req.body)
    return { allocation: await investments.setTargetAllocation(body.goalId, body.entries) }
  })

  /* ---------------------------------------------------------------- *
   * "Diagrama do Cerrado" — resistance criteria, per-asset notes, the
   * note-weighted allocation within a class, and the contribution
   * waterfall. See server/src/services/criteria.ts and the relevant
   * section of server/src/services/investments.ts for the model.
   * ---------------------------------------------------------------- */
  app.get('/criteria', async (req) => {
    const query = z.object({ assetClass: z.enum(investments.ASSET_CLASSES).optional() }).parse(req.query)
    return { criteria: await criteriaService.listCriteria(query.assetClass) }
  })

  app.post('/criteria', async (req) => {
    const body = z
      .object({
        assetClass: z.enum(investments.ASSET_CLASSES),
        label: z.string().min(1),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body)
    return criteriaService.createCriterion(body)
  })

  app.patch('/criteria/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        label: z.string().min(1).optional(),
        active: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body)
    return criteriaService.updateCriterion(id, body)
  })

  app.delete('/criteria/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return criteriaService.deleteCriterion(id)
  })

  app.get('/investments/assets/:id/note', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const note = await criteriaService.getAssetNote(id)
    if (!note) return reply.code(404).send({ error: 'ativo não encontrado' })
    return note
  })

  app.put('/investments/assets/:assetId/criteria/:criteriaId', async (req) => {
    const params = z
      .object({ assetId: z.coerce.number().int().positive(), criteriaId: z.coerce.number().int().positive() })
      .parse(req.params)
    const body = z.object({ checked: z.boolean() }).parse(req.body)
    await criteriaService.setAnswer(params.assetId, params.criteriaId, body.checked)
    return criteriaService.getAssetNote(params.assetId)
  })

  app.delete('/investments/assets/:assetId/criteria/:criteriaId', async (req) => {
    const params = z
      .object({ assetId: z.coerce.number().int().positive(), criteriaId: z.coerce.number().int().positive() })
      .parse(req.params)
    await criteriaService.clearAnswer(params.assetId, params.criteriaId)
    return criteriaService.getAssetNote(params.assetId)
  })

  app.get('/investments/allocation/:assetClass', async (req) => {
    const params = z.object({ assetClass: z.enum(investments.ASSET_CLASSES) }).parse(req.params)
    const query = z.object({ goalId: z.coerce.number().int().positive().optional() }).parse(req.query)
    return investments.assetAllocationWithinClass(params.assetClass, query.goalId ?? null)
  })

  app.get('/investments/contribution-plan', async (req) => {
    const query = z
      .object({
        amountCents: z.coerce.number().int().positive(),
        goalId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query)
    return investments.suggestContribution(query.amountCents, query.goalId ?? null)
  })

  /* ---------------------------------------------------------------- *
   * Emergency reserve
   * ---------------------------------------------------------------- */
  app.get('/investments/reserve', async () => investments.reserveStatus())

  app.put('/investments/reserve', async (req) => {
    const body = z
      .object({
        multiple: z.number().int().refine((v) => [6, 12, 24].includes(v), 'multiple deve ser 6, 12 ou 24').optional(),
        lookbackMonths: z.number().int().min(1).max(24).optional(),
        manualLivingCostCents: z.number().int().nonnegative().nullable().optional(),
      })
      .parse(req.body)
    return investments.setReserveSettings(body)
  })

  /**
   * One click from the reserve card (or the contribution planner's reserve
   * step) straight into a trade on the dedicated "Reserva de emergência"
   * asset — created on first call. `kind: 'sell'` records a withdrawal.
   */
  app.post('/investments/reserve/contribute', async (req) => {
    const body = z
      .object({
        amountCents: z.number().int().positive(),
        tradedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIso()),
        kind: z.enum(['buy', 'sell']).default('buy'),
      })
      .parse(req.body)
    await investments.contributeToReserve(body)
    return investments.reserveStatus()
  })

  /* ---------------------------------------------------------------- *
   * Cash-flow forecasts — a recurring/installment template that
   * materializes real, pending rows into `transactions`, unified with
   * the normal ledger rather than a side preview.
   * ---------------------------------------------------------------- */
  app.get('/cash-flow/forecasts', async () => {
    await cashFlowService.materializeAll()
    return { forecasts: await cashFlowService.listForecasts() }
  })

  app.post('/cash-flow/forecasts', async (req) => {
    const body = z
      .object({
        description: z.string().min(1),
        kind: z.enum(['recurring', 'installment', 'single']).default('recurring'),
        // signed cents: positive = expected income, negative = expected expense
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
      /**
       * Um fim ANTES do inicio nao gera ocorrencia nenhuma, e a previsao
       * ficaria salva sem nunca aparecer em lugar algum — o mesmo tipo de
       * silencio que `decisions/0020` fechou para o horizonte de
       * materializacao. Comparacao de string funciona porque `YYYY-MM` e
       * lexicograficamente ordenavel (02/09/2026).
       */
      .refine((v) => v.endPeriod == null || v.endPeriod >= v.startPeriod, {
        message: 'o fim nao pode ser antes do inicio',
        path: ['endPeriod'],
      })
      .parse(req.body)
    return cashFlowService.createForecast(body)
  })

  app.patch('/cash-flow/forecasts/:id', async (req) => {
    const { id } = idParam.parse(req.params)
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
      .parse(req.body)
    return cashFlowService.updateForecast(id, body)
  })

  app.delete('/cash-flow/forecasts/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return cashFlowService.deleteForecast(id)
  })

  /** The two "pendentes" home widgets read straight from here, scoped to the exact same from/to as the rest of the dashboard. */
  /**
   * A serie que olha para frente. Fica em /cash-flow porque e o mesmo
   * dominio das previsoes que a alimentam, ainda que o calculo viva em
   * `services/analytics`.
   */
  app.get('/cash-flow/projection', async (req) => {
    const query = z
      .object({
        monthsBack: z.coerce.number().int().min(0).max(60).default(12),
        monthsAhead: z.coerce.number().int().min(0).max(60).default(12),
        accountId: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query)
    return analytics.cashFlowProjection({
      monthsBack: query.monthsBack,
      monthsAhead: query.monthsAhead,
      accountId: query.accountId ?? null,
    })
  })

  app.get('/cash-flow/pending', async (req) => {
    const query = z
      .object({
        flow: z.enum(['income', 'expense']),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.query)
    // Nothing else in the app polls /cash-flow/forecasts, so this is the
    // only place a recurring template's rolling 6-month horizon (see
    // MATERIALIZE_HORIZON_MONTHS) actually advances as real time passes
    // without a new forecast being created — every load of either
    // "pendentes" widget re-checks it. Debt installments materialize the
    // same way (debt.ts's own MATERIALIZE_HORIZON_MONTHS) so "Despesas
    // pendentes" also reflects upcoming parcelas without a separate UI.
    await Promise.all([cashFlowService.materializeAll(), debtService.materializeAllDebts()])
    const range = query.from && query.to ? { from: query.from, to: query.to } : undefined
    return { pending: await cashFlowService.listPending(query.flow, range) }
  })

  app.delete('/cash-flow/pending/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const query = z.object({ scope: z.enum(['only', 'this_and_future', 'all']).default('only') }).parse(req.query)
    return cashFlowService.deletePending(id, query.scope)
  })

  /** Suggested pairs (pending <-> a real posted transaction) — never auto-applied. */
  app.get('/cash-flow/reconciliation-candidates', async () => ({
    candidates: await cashFlowService.reconciliationCandidates(),
  }))

  app.post('/cash-flow/pending/:id/confirm-match', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ matchId: z.number().int().positive().optional() }).parse(req.body ?? {})
    return cashFlowService.confirmReconciliation(id, body.matchId)
  })

  app.post('/cash-flow/pending/:id/settle', async (req) => {
    const { id } = idParam.parse(req.params)
    return cashFlowService.settlePending(id)
  })

  app.post('/cash-flow/reconciliation-candidates/dismiss', async (req) => {
    const body = z
      .object({ pendingId: z.number().int().positive(), matchId: z.number().int().positive() })
      .parse(req.body)
    return cashFlowService.dismissReconciliation(body.pendingId, body.matchId)
  })
}
