import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { assets, debts, investmentGoals, propertyPlans } from '../db/schema'
import { addMonths, todayIso } from '../core/dates'
import { needAt, projectPlan, type AmortizationSystem, type CostItem, type PlanInputs } from '../core/propertyPlan'
import { createDebt, debtOverview, materializeDebtInstallments } from './debt'
import {
  InvestmentRuleError,
  createAsset,
  createTrade,
  deleteAsset,
  goalBase,
  recordValuation,
  reserveStatus,
  setGoalAssets,
  tradablePositions,
} from './investments'

/**
 * Plano de compra de imóvel (specs/property-plan, decisions/0041): as
 * premissas de uma meta `buy_property`, o dinheiro separado para ela e a
 * compra que vira dívida amortizada e bem imobilizado. As contas moram em
 * `core/propertyPlan`; aqui só se junta o dado do app a elas.
 */

/** Premissas editáveis do plano (as colunas de `property_plans` que o usuário mexe). */
export type PlanFields = {
  priceCents: number
  appreciationBps: number
  downPaymentBps: number
  costs: CostItem[]
  otherResourcesCents: number
  financingRateBps: number
  termMonths: number
  system: AmortizationSystem
  monthlyFeesCents: number
  incomeOverrideCents: number | null
  incomeLimitBps: number
  expenseReliefCents: number
}

export type GoalFields = { name: string; monthlyContributionCents: number; expectedReturnBps: number }

export type PlanDefaults = {
  reserve: { currentCents: number; livingCostCents: number; multiple: number }
  typicalIncomeCents: number
  incomeSampleMonths: number
}

type PlanRow = typeof propertyPlans.$inferSelect
type GoalRow = typeof investmentGoals.$inferSelect

const notFound = () => new InvestmentRuleError('plano de imóvel não encontrado', 404)

/** O que o app já sabe para preencher a calculadora e o plano: reserva, custo de vida e renda típica. */
export async function planDefaults(): Promise<PlanDefaults> {
  const [reserve, overview] = await Promise.all([reserveStatus(), debtOverview()])
  return {
    reserve: { currentCents: reserve.currentCents, livingCostCents: reserve.monthlyLivingCostCents, multiple: reserve.multiple },
    typicalIncomeCents: overview.typicalMonthlyIncomeCents,
    incomeSampleMonths: overview.incomeSampleMonths,
  }
}

function fieldsOf(plan: PlanRow): PlanFields {
  return {
    priceCents: plan.priceCents,
    appreciationBps: plan.appreciationBps,
    downPaymentBps: plan.downPaymentBps,
    costs: plan.costs as CostItem[],
    otherResourcesCents: plan.otherResourcesCents,
    financingRateBps: plan.financingRateBps,
    termMonths: plan.termMonths,
    system: plan.system,
    monthlyFeesCents: plan.monthlyFeesCents,
    incomeOverrideCents: plan.incomeOverrideCents,
    incomeLimitBps: plan.incomeLimitBps,
    expenseReliefCents: plan.expenseReliefCents,
  }
}

function inputsOf(goal: GoalRow, fields: PlanFields, defaults: PlanDefaults, savedCents: number): PlanInputs {
  return {
    ...fields,
    incomeCents: fields.incomeOverrideCents ?? (defaults.typicalIncomeCents > 0 ? defaults.typicalIncomeCents : null),
    livingCostCents: defaults.reserve.livingCostCents,
    reserveMultiple: defaults.reserve.multiple,
    reserveCurrentCents: defaults.reserve.currentCents,
    savedCents,
    monthlyContributionCents: goal.monthlyContributionCents,
    expectedReturnBps: goal.expectedReturnBps,
  }
}

/** Soma dos ativos separados para a meta; 0 sem nenhum (o plano não usa a carteira inteira). */
async function savedFor(goalId: number): Promise<number> {
  const base = await goalBase(goalId)
  return base.linked.length > 0 ? base.marketValueCents : 0
}

async function load(goalId: number): Promise<{ goal: GoalRow; plan: PlanRow }> {
  const rows = await db
    .select({ goal: investmentGoals, plan: propertyPlans })
    .from(propertyPlans)
    .innerJoin(investmentGoals, eq(investmentGoals.id, propertyPlans.goalId))
    .where(eq(propertyPlans.goalId, goalId))
  if (!rows[0]) throw notFound()
  return rows[0]
}

/**
 * A meta guarda o necessário de hoje e o mês da compra, para as telas que
 * leem só a meta (planejador de aporte, lista de metas) continuarem
 * coerentes com o plano.
 */
async function syncGoal(goalId: number): Promise<void> {
  const { goal, plan } = await load(goalId)
  const [defaults, saved] = await Promise.all([planDefaults(), savedFor(goalId)])
  const inputs = inputsOf(goal, fieldsOf(plan), defaults, saved)
  const projection = projectPlan(inputs)
  await db
    .update(investmentGoals)
    .set({
      targetValueCents: needAt(inputs, 0).totalCents,
      targetDate: projection.purchaseMonth === null ? null : `${addMonths(todayIso().slice(0, 7), projection.purchaseMonth)}-28`,
    })
    .where(eq(investmentGoals.id, goalId))
}

export type PlanAsset = {
  assetId: number
  name: string
  assetClassLabel: string
  marketValueCents: number
  linked: boolean
  /** por que não pode ser separado para este plano; nulo = pode */
  blockedReason: string | null
}

export async function getPlan(goalId: number) {
  const { goal, plan } = await load(goalId)
  const [defaults, positions, goals] = await Promise.all([
    planDefaults(),
    tradablePositions(),
    db.select({ id: investmentGoals.id, name: investmentGoals.name }).from(investmentGoals),
  ])
  const goalName = new Map(goals.map((g) => [g.id, g.name]))
  const planAssets: PlanAsset[] = positions
    .filter((p) => p.goalId === goalId || p.quantity > 0)
    .map((p) => ({
      assetId: p.assetId,
      name: p.name,
      assetClassLabel: p.assetClassLabel,
      marketValueCents: p.marketValueCents,
      linked: p.goalId === goalId,
      blockedReason: p.countsTowardReserve
        ? 'conta para a reserva'
        : p.goalId !== null && p.goalId !== goalId
          ? `separado para ${goalName.get(p.goalId) ?? 'outra meta'}`
          : null,
    }))
    .sort((a, b) => Number(b.linked) - Number(a.linked) || b.marketValueCents - a.marketValueCents)
  const savedCents = planAssets.filter((a) => a.linked).reduce((sum, a) => sum + a.marketValueCents, 0)
  const fields = fieldsOf(plan)
  const inputs = inputsOf(goal, fields, defaults, savedCents)
  return {
    goal,
    plan: { ...fields, id: plan.id, status: plan.status, debtId: plan.debtId, assetId: plan.assetId, purchasedOn: plan.purchasedOn },
    defaults,
    assets: planAssets,
    savedCents,
    inputs,
    projection: projectPlan(inputs),
  }
}

export async function createPlan(input: { goal: GoalFields; plan: PlanFields; assetIds?: number[] }): Promise<{ goalId: number }> {
  const goal = (
    await db
      .insert(investmentGoals)
      .values({ ...input.goal, name: input.goal.name.trim(), targetValueCents: 0, purpose: 'buy_property' })
      .returning()
  )[0]!
  try {
    await db.insert(propertyPlans).values({ ...input.plan, goalId: goal.id })
    if (input.assetIds?.length) await setGoalAssets(goal.id, input.assetIds)
    await syncGoal(goal.id)
  } catch (error) {
    // Sem transação entre serviços: desfaz a meta (o plano vai junto, cascade).
    await db.delete(investmentGoals).where(eq(investmentGoals.id, goal.id))
    throw error
  }
  return { goalId: goal.id }
}

export async function updatePlan(goalId: number, patch: { goal?: Partial<GoalFields>; plan?: Partial<PlanFields> }) {
  const { plan } = await load(goalId)
  if (plan.status === 'purchased') throw new InvestmentRuleError('compra já registrada: o financiamento agora está em Dívidas')
  if (patch.goal && Object.keys(patch.goal).length) {
    await db
      .update(investmentGoals)
      .set({ ...patch.goal, ...(patch.goal.name ? { name: patch.goal.name.trim() } : {}) })
      .where(eq(investmentGoals.id, goalId))
  }
  if (patch.plan && Object.keys(patch.plan).length) {
    await db.update(propertyPlans).set({ ...patch.plan, updatedAt: new Date().toISOString() }).where(eq(propertyPlans.goalId, goalId))
  }
  await syncGoal(goalId)
  return getPlan(goalId)
}

export async function setPlanAssets(goalId: number, assetIds: number[]) {
  const { plan } = await load(goalId)
  if (plan.status === 'purchased') throw new InvestmentRuleError('compra já registrada')
  await setGoalAssets(goalId, assetIds)
  await syncGoal(goalId)
  return getPlan(goalId)
}

export type PurchaseInput = {
  purchasePriceCents: number
  purchasedOn: string
  financedCents: number
  rateBps: number
  termMonths: number
  system: AmortizationSystem
  monthlyFeesCents: number
  firstDueOn: string
  accountId: number
  institution?: string | null
  registerAsset: boolean
  assetName?: string | null
}

/** Nome livre para o bem: `assets.name` é único, então acrescenta " (2)", " (3)"... */
async function uniqueAssetName(base: string): Promise<string> {
  const taken = new Set((await db.select({ name: assets.name }).from(assets)).map((r) => r.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`
}

/**
 * Concretiza a compra: a dívida amortizada com as parcelas no fluxo de
 * caixa, o imóvel no Imobilizado (opcional), o plano como comprado, a meta
 * inativa e os ativos soltos. Sem transação entre serviços, então o que já
 * foi criado é desfeito se um passo seguinte falhar.
 */
export async function purchase(goalId: number, input: PurchaseInput): Promise<{ debtId: number | null; assetId: number | null }> {
  const { goal, plan } = await load(goalId)
  if (plan.status === 'purchased') throw new InvestmentRuleError('compra já registrada')
  if (input.financedCents > input.purchasePriceCents) throw new InvestmentRuleError('o valor financiado não pode passar do valor de compra', 400)

  let debtId: number | null = null
  let assetId: number | null = null
  try {
    if (input.financedCents > 0) {
      const debt = await createDebt({
        name: `Financiamento: ${goal.name}`,
        kind: 'financing',
        institution: input.institution?.trim() || null,
        principalCents: input.financedCents,
        aprBps: input.rateBps,
        installmentCount: input.termMonths,
        amortization: input.system,
        monthlyFeesCents: input.monthlyFeesCents,
        dueDay: Number(input.firstDueOn.slice(8, 10)),
        accountId: input.accountId,
        openedOn: input.firstDueOn,
      })
      debtId = debt.id
      await materializeDebtInstallments(debt.id)
    }

    if (input.registerAsset) {
      const name = await uniqueAssetName(input.assetName?.trim() || `Imóvel: ${goal.name}`)
      const asset = await createAsset({ name, assetClass: 'illiquid' })
      assetId = asset.id
      await createTrade({ assetId: asset.id, kind: 'buy', tradedOn: input.purchasedOn, quantity: 1, unitPriceCents: input.purchasePriceCents })
      await recordValuation(asset.id, input.purchasedOn, input.purchasePriceCents)
    }

    await db
      .update(propertyPlans)
      .set({ status: 'purchased', debtId, assetId, purchasedOn: input.purchasedOn, updatedAt: new Date().toISOString() })
      .where(eq(propertyPlans.goalId, goalId))
    await db.update(investmentGoals).set({ active: false }).where(eq(investmentGoals.id, goalId))
    await db.update(assets).set({ goalId: null }).where(eq(assets.goalId, goalId))
  } catch (error) {
    if (assetId !== null) await deleteAsset(assetId)
    if (debtId !== null) await db.delete(debts).where(eq(debts.id, debtId))
    throw error
  }
  return { debtId, assetId }
}
