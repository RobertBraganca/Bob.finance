import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { categories, categoryCaps, monthlyGoals } from '../db/schema'
import { addMonths, daysInMonth, periodBounds, periodRange, todayIso } from '../core/dates'
import { categoryBreakdown, totals, type Range } from './analytics'
import { averageRecentQuoteCents } from './pricing'

/**
 * Goals are stored per `YYYY-MM` period so that changing this month's budget
 * never rewrites last month's history — which is what makes the goal-hit
 * streak meaningful.
 */

export type GoalState = 'on_track' | 'at_risk' | 'exceeded' | 'met' | 'missed' | 'no_target'

/** Above this share of the budget we call it at risk rather than on track. */
const AT_RISK_AT = 0.85

export type CapProgress = {
  categoryId: number
  name: string
  color: string
  capCents: number
  spentCents: number
  remainingCents: number
  usedBps: number
  /** what should have been spent by today if spending were even */
  paceCents: number
  state: GoalState
}

export type PeriodProgress = {
  period: string
  isCurrent: boolean
  daysElapsed: number
  daysTotal: number
  goal: {
    incomeTargetCents: number | null
    spendCapCents: number | null
    savingsRateTargetBps: number | null
    note: string | null
  }
  actual: {
    incomeCents: number
    expenseCents: number
    netCents: number
    savingsRateBps: number
    investedCents: number
  }
  progress: {
    income: { targetCents: number | null; actualCents: number; achievedBps: number | null; state: GoalState }
    spend: { capCents: number | null; spentCents: number; usedBps: number | null; paceCents: number | null; state: GoalState }
    savings: { targetBps: number | null; actualBps: number; state: GoalState }
  }
  caps: CapProgress[]
}

function dayCounts(period: string) {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const daysTotal = daysInMonth(y, m)
  const today = todayIso()
  const isCurrent = today.slice(0, 7) === period
  const isPast = today.slice(0, 7) > period
  const daysElapsed = isCurrent ? Number(today.slice(8, 10)) : isPast ? daysTotal : 0
  return { daysTotal, daysElapsed, isCurrent }
}

export async function getPeriodProgress(period: string, accountId?: number | null): Promise<PeriodProgress> {
  const { start, end } = periodBounds(period)
  const range: Range = { from: start, to: end, accountId: accountId ?? null }
  const [actual, goal, caps, expenseLeaf, categoryRows] = await Promise.all([
    totals(range),
    db.select().from(monthlyGoals).where(eq(monthlyGoals.period, period)).then((r) => r[0]),
    db
      .select({
        categoryId: categoryCaps.categoryId,
        capCents: categoryCaps.capCents,
        name: categories.name,
        color: categories.color,
      })
      .from(categoryCaps)
      .innerJoin(categories, eq(categories.id, categoryCaps.categoryId))
      .where(eq(categoryCaps.period, period)),
    categoryBreakdown(range, { flow: 'expense', level: 'leaf' }),
    db.select({ id: categories.id, parentId: categories.parentId }).from(categories),
  ])
  const { daysTotal, daysElapsed, isCurrent } = dayCounts(period)
  const elapsedShare = daysTotal > 0 ? daysElapsed / daysTotal : 0

  /**
   * LEAF level only. The leaf breakdown groups by the category actually on
   * each transaction, so it already contains a parent row when something is
   * filed directly against the parent. Mixing in the parent-level breakdown
   * here would double-count, because the parent row in that breakdown
   * already includes its children and the loop below adds them again.
   */
  const spentByCategory = new Map<number, number>()
  for (const slice of expenseLeaf) {
    if (slice.categoryId !== null) spentByCategory.set(slice.categoryId, slice.amountCents)
  }
  // A cap on a parent category covers its children too.
  const childrenOf = new Map<number, number[]>()
  for (const c of categoryRows) {
    if (c.parentId === null) continue
    const bucket = childrenOf.get(c.parentId)
    if (bucket) bucket.push(c.id)
    else childrenOf.set(c.parentId, [c.id])
  }

  const capProgress: CapProgress[] = caps.map((cap) => {
    const own = spentByCategory.get(cap.categoryId) ?? 0
    const kids = (childrenOf.get(cap.categoryId) ?? []).reduce(
      (sum, id) => sum + (spentByCategory.get(id) ?? 0),
      0,
    )
    const spentCents = own + kids
    const paceCents = Math.round(cap.capCents * elapsedShare)
    return {
      categoryId: cap.categoryId,
      name: cap.name,
      color: cap.color,
      capCents: cap.capCents,
      spentCents,
      remainingCents: cap.capCents - spentCents,
      usedBps: cap.capCents > 0 ? Math.round((spentCents / cap.capCents) * 10_000) : 0,
      paceCents,
      state: capState(spentCents, cap.capCents, paceCents, isCurrent),
    }
  })

  return {
    period,
    isCurrent,
    daysElapsed,
    daysTotal,
    goal: {
      incomeTargetCents: goal?.incomeTargetCents ?? null,
      spendCapCents: goal?.spendCapCents ?? null,
      savingsRateTargetBps: goal?.savingsRateTargetBps ?? null,
      note: goal?.note ?? null,
    },
    actual: {
      incomeCents: actual.incomeCents,
      expenseCents: actual.expenseCents,
      netCents: actual.netCents,
      savingsRateBps: actual.savingsRateBps,
      investedCents: actual.investedCents,
    },
    progress: {
      income: {
        targetCents: goal?.incomeTargetCents ?? null,
        actualCents: actual.incomeCents,
        achievedBps: goal?.incomeTargetCents
          ? Math.round((actual.incomeCents / goal.incomeTargetCents) * 10_000)
          : null,
        state: targetState(actual.incomeCents, goal?.incomeTargetCents ?? null, isCurrent),
      },
      spend: {
        capCents: goal?.spendCapCents ?? null,
        spentCents: actual.expenseCents,
        usedBps: goal?.spendCapCents
          ? Math.round((actual.expenseCents / goal.spendCapCents) * 10_000)
          : null,
        paceCents: goal?.spendCapCents ? Math.round(goal.spendCapCents * elapsedShare) : null,
        state: goal?.spendCapCents
          ? capState(
              actual.expenseCents,
              goal.spendCapCents,
              Math.round(goal.spendCapCents * elapsedShare),
              isCurrent,
            )
          : 'no_target',
      },
      savings: {
        targetBps: goal?.savingsRateTargetBps ?? null,
        actualBps: actual.savingsRateBps,
        state: targetState(actual.savingsRateBps, goal?.savingsRateTargetBps ?? null, isCurrent),
      },
    },
    caps: capProgress,
  }
}

/** A cap is about staying UNDER; pace decides "on track" vs "at risk". */
function capState(spent: number, cap: number, pace: number, isCurrent: boolean): GoalState {
  if (cap <= 0) return 'no_target'
  if (spent > cap) return 'exceeded'
  if (!isCurrent) return 'met'
  if (spent > pace && spent / cap >= AT_RISK_AT) return 'at_risk'
  if (spent > Math.max(pace, cap * AT_RISK_AT)) return 'at_risk'
  return 'on_track'
}

/**
 * A target is about reaching a number by the end of the period. Exported
 * because `specs/dashboard` ("Modo mês") reuses this exact classification
 * for destinations that are also "reach a floor by the end of the period"
 * (investimento, dívida, reserva) — never a second formula for the same
 * green/yellow/red judgement.
 */
export function targetState(actual: number, target: number | null, isCurrent: boolean): GoalState {
  if (target === null || target === 0) return 'no_target'
  if (actual >= target) return 'met'
  if (isCurrent) return actual >= target * AT_RISK_AT ? 'on_track' : 'at_risk'
  return 'missed'
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */
export type GoalPatch = {
  incomeTargetCents?: number | null
  spendCapCents?: number | null
  savingsRateTargetBps?: number | null
  note?: string | null
}

export async function upsertGoal(period: string, patch: GoalPatch) {
  const existing = (await db.select().from(monthlyGoals).where(eq(monthlyGoals.period, period)))[0]
  if (existing) {
    return (
      await db
        .update(monthlyGoals)
        .set({ ...patch, updatedAt: sql`now_iso()` })
        .where(eq(monthlyGoals.period, period))
        .returning()
    )[0]!
  }
  return (await db.insert(monthlyGoals).values({ period, ...patch }).returning())[0]!
}

export async function upsertCap(period: string, categoryId: number, capCents: number) {
  const existing = (
    await db
      .select()
      .from(categoryCaps)
      .where(and(eq(categoryCaps.period, period), eq(categoryCaps.categoryId, categoryId)))
  )[0]
  if (existing) {
    return (
      await db.update(categoryCaps).set({ capCents }).where(eq(categoryCaps.id, existing.id)).returning()
    )[0]!
  }
  return (await db.insert(categoryCaps).values({ period, categoryId, capCents }).returning())[0]!
}

export async function deleteCap(period: string, categoryId: number) {
  const result = await db
    .delete(categoryCaps)
    .where(and(eq(categoryCaps.period, period), eq(categoryCaps.categoryId, categoryId)))
  return { removed: result.count }
}

/** Copies a period's whole budget forward — the common "same as last month". */
export async function copyGoals(fromPeriod: string, toPeriod: string) {
  const source = (await db.select().from(monthlyGoals).where(eq(monthlyGoals.period, fromPeriod)))[0]
  if (source) {
    await upsertGoal(toPeriod, {
      incomeTargetCents: source.incomeTargetCents,
      spendCapCents: source.spendCapCents,
      savingsRateTargetBps: source.savingsRateTargetBps,
      note: source.note,
    })
  }
  const caps = await db.select().from(categoryCaps).where(eq(categoryCaps.period, fromPeriod))
  for (const cap of caps) await upsertCap(toPeriod, cap.categoryId, cap.capCents)
  return { goal: source !== undefined, caps: caps.length }
}

/* ------------------------------------------------------------------ *
 * History + streak
 * ------------------------------------------------------------------ */
export type PeriodOutcome = {
  period: string
  incomeCents: number
  expenseCents: number
  savingsRateBps: number
  targets: number
  hits: number
  allHit: boolean
  hasTargets: boolean
}

export async function goalHistory(months = 12, accountId?: number | null) {
  const currentPeriod = todayIso().slice(0, 7)
  const periods = periodRange(addMonths(currentPeriod, -(months - 1)), currentPeriod)

  const outcomes: PeriodOutcome[] = await Promise.all(
    periods.map(async (period) => {
      const progress = await getPeriodProgress(period, accountId)
      const checks = [
        progress.progress.income.state,
        progress.progress.spend.state,
        progress.progress.savings.state,
      ].filter((s) => s !== 'no_target')
      const hits = checks.filter((s) => s === 'met' || s === 'on_track').length
      return {
        period,
        incomeCents: progress.actual.incomeCents,
        expenseCents: progress.actual.expenseCents,
        savingsRateBps: progress.actual.savingsRateBps,
        targets: checks.length,
        hits,
        allHit: checks.length > 0 && hits === checks.length,
        hasTargets: checks.length > 0,
      }
    }),
  )

  // Streak counts back from the most recent CLOSED period, so an unfinished
  // month can neither inflate nor break the streak.
  let streak = 0
  for (let i = outcomes.length - 1; i >= 0; i--) {
    const o = outcomes[i]!
    if (o.period === currentPeriod) continue
    if (!o.hasTargets) break
    if (!o.allHit) break
    streak++
  }

  const withTargets = outcomes.filter((o) => o.hasTargets && o.period !== currentPeriod)
  return {
    outcomes,
    streak,
    hitRateBps:
      withTargets.length > 0
        ? Math.round((withTargets.filter((o) => o.allHit).length / withTargets.length) * 10_000)
        : null,
  }
}

/* ------------------------------------------------------------------ *
 * Home banners — "termômetro mensal"
 *
 * Avisos TEMPORÁRIOS e dispensáveis (não um card fixo — isso já existe,
 * é "Modo mês" no Painel) que só aparecem quando há algo específico a
 * dizer sobre o mês corrente: estourou (ou está no ritmo de estourar) o
 * teto geral ou de uma categoria, uma categoria concentra boa parte do
 * gasto, ou a projeção do mês foge muito do mês passado. Nunca um
 * veredito ("você falhou") — sempre uma leitura do que já está
 * acontecendo, mesma régua de "mês corrente sempre mostra progresso,
 * nunca veredito prematuro". Retorna dado bruto (cents, bps, nome da
 * categoria), não a frase pronta — a formatação de moeda/texto é sempre
 * client-side (`lib/format.ts`), nunca duplicada aqui.
 * ------------------------------------------------------------------ */
export type BannerSeverity = 'good' | 'warning' | 'critical'

export type HomeBanner = { id: string; severity: BannerSeverity } & (
  | { kind: 'spend_cap_exceeded'; spentCents: number; capCents: number }
  | { kind: 'spend_cap_at_risk'; projectedCents: number; capCents: number }
  | { kind: 'category_cap_exceeded'; categoryName: string; spentCents: number; capCents: number }
  | { kind: 'category_cap_at_risk'; categoryName: string; spentCents: number; capCents: number }
  | { kind: 'category_concentration'; categoryName: string; shareBps: number }
  | { kind: 'trend_up'; deltaBps: number }
  | { kind: 'trend_down'; deltaBps: number }
)

/** Categoria concentrando mais que isso do gasto do mês vira aviso — abaixo disso é distribuição normal, não notícia. */
const CONCENTRATION_AT_BPS = 4000
/** Projeção de fechamento do mês comparada ao mês passado — dentro dessa faixa é variação normal, não notícia. */
const TREND_UP_AT_BPS = 1500
const TREND_DOWN_AT_BPS = -1000
/** Nunca mais que isso ao mesmo tempo — "aviso" implica exceção, não um mural. */
const MAX_BANNERS = 3

/** Projeta o fechamento do mês pelo ritmo até agora — mesma ideia de `paceCents`, na direção oposta (dado o gasto real, qual o total esperado). */
function projectMonthEnd(spentCentsSoFar: number, period: string): number {
  const { daysElapsed, daysTotal } = dayCounts(period)
  if (daysElapsed <= 0) return spentCentsSoFar
  return Math.round((spentCentsSoFar / daysElapsed) * daysTotal)
}

export async function homeBanners(accountId?: number | null): Promise<HomeBanner[]> {
  const currentPeriod = todayIso().slice(0, 7)
  const lastPeriod = addMonths(currentPeriod, -1)
  const { start, end } = periodBounds(currentPeriod)

  const [current, last, concentration] = await Promise.all([
    getPeriodProgress(currentPeriod, accountId),
    getPeriodProgress(lastPeriod, accountId),
    categoryBreakdown({ from: start, to: end, accountId: accountId ?? null }, { flow: 'expense', level: 'parent' }),
  ])

  const banners: HomeBanner[] = []
  const flaggedCategoryIds = new Set<number>()

  // 1) Teto geral do mês — só quando o ritmo ou o total já preocupa.
  const spend = current.progress.spend
  if (spend.capCents !== null) {
    if (spend.state === 'exceeded') {
      banners.push({
        id: 'spend-cap',
        severity: 'critical',
        kind: 'spend_cap_exceeded',
        spentCents: spend.spentCents,
        capCents: spend.capCents,
      })
    } else if (spend.state === 'at_risk') {
      banners.push({
        id: 'spend-cap',
        severity: 'warning',
        kind: 'spend_cap_at_risk',
        projectedCents: projectMonthEnd(spend.spentCents, currentPeriod),
        capCents: spend.capCents,
      })
    }
  }

  // 2) Pior categoria com teto (no máximo uma, a mais grave) — evita que
  // 3+ categorias apertadas virem 3+ avisos separados sobre a mesma coisa.
  const worstCap = [...current.caps]
    .filter((c) => c.state === 'exceeded' || c.state === 'at_risk')
    .sort((a, b) => b.usedBps - a.usedBps)[0]
  if (worstCap) {
    flaggedCategoryIds.add(worstCap.categoryId)
    banners.push(
      worstCap.state === 'exceeded'
        ? {
            id: `cap-${worstCap.categoryId}`,
            severity: 'critical',
            kind: 'category_cap_exceeded',
            categoryName: worstCap.name,
            spentCents: worstCap.spentCents,
            capCents: worstCap.capCents,
          }
        : {
            id: `cap-${worstCap.categoryId}`,
            severity: 'warning',
            kind: 'category_cap_at_risk',
            categoryName: worstCap.name,
            spentCents: worstCap.spentCents,
            capCents: worstCap.capCents,
          },
    )
  }

  // 3) Concentração — observação neutra, independe de ter teto configurado;
  // pula a categoria que já virou aviso de teto acima (mesma notícia, duas vezes).
  const topCategory = concentration
    .filter((c) => c.categoryId !== null && !flaggedCategoryIds.has(c.categoryId))
    .sort((a, b) => b.shareBps - a.shareBps)[0]
  if (topCategory && topCategory.shareBps >= CONCENTRATION_AT_BPS) {
    banners.push({
      id: `concentration-${topCategory.categoryId}`,
      severity: 'warning',
      kind: 'category_concentration',
      categoryName: topCategory.name,
      shareBps: topCategory.shareBps,
    })
  }

  // 4) Tendência vs. mês passado — projeção de fechamento contra o total
  // JÁ FECHADO do mês anterior, nunca o parcial de hoje contra o fechado
  // (senão todo início de mês pareceria uma economia enorme).
  if (last.actual.expenseCents > 0) {
    const projectedCents = projectMonthEnd(current.actual.expenseCents, currentPeriod)
    const deltaBps = Math.round(((projectedCents - last.actual.expenseCents) / last.actual.expenseCents) * 10_000)
    if (deltaBps >= TREND_UP_AT_BPS) {
      banners.push({ id: 'trend', severity: 'warning', kind: 'trend_up', deltaBps })
    } else if (deltaBps <= TREND_DOWN_AT_BPS) {
      banners.push({ id: 'trend', severity: 'good', kind: 'trend_down', deltaBps })
    }
  }

  const rank: Record<BannerSeverity, number> = { critical: 0, warning: 1, good: 2 }
  return banners.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, MAX_BANNERS)
}

/** Suggests caps from the median of the last N months of actual spending. */
export async function suggestCaps(period: string, lookbackMonths = 3) {
  const from = periodBounds(addMonths(period, -lookbackMonths)).start
  const to = periodBounds(addMonths(period, -1)).end
  const slices = await categoryBreakdown({ from, to }, { flow: 'expense', level: 'parent' })
  return slices
    .filter((s) => s.categoryId !== null)
    .map((s) => ({
      categoryId: s.categoryId!,
      name: s.name,
      color: s.color,
      suggestedCapCents: Math.round(s.amountCents / lookbackMonths / 100) * 100,
      basedOnMonths: lookbackMonths,
    }))
}

/* ------------------------------------------------------------------ *
 * Meta de receita traduzida em número de projetos
 *
 * Divide dois números que já existem em outras áreas: o gap da meta de
 * receita (aqui) pelo ticket médio recente (`specs/project-pricing`).
 * Nenhum cálculo novo, nenhuma tabela nova.
 * ------------------------------------------------------------------ */
export type GapInProjects = {
  period: string
  /** null quando não há meta de receita definida para o mês (`no_target`) */
  gapCents: number | null
  averageQuoteCents: number | null
  /** null quando falta meta, quando o gap já foi coberto, ou quando não há cotação salva */
  projectsNeeded: number | null
  sampleSize: number
  assumptions: Record<string, unknown>
}

export async function gapInProjects(period: string, sampleWindow = 5): Promise<GapInProjects> {
  const progress = await getPeriodProgress(period)
  const target = progress.goal.incomeTargetCents
  const gapCents = target === null ? null : target - progress.actual.incomeCents

  const { averageCents, sampleSize } = await averageRecentQuoteCents(sampleWindow)

  /**
   * Sempre arredondado para CIMA: "1,7 projeto" não é uma coisa que se
   * fecha, então a resposta honesta é 2. Meta já batida (gap <= 0) devolve
   * null em vez de 0, porque a pergunta "quantos projetos faltam" deixa de
   * fazer sentido, não passa a ter resposta zero.
   */
  const projectsNeeded =
    gapCents !== null && gapCents > 0 && averageCents !== null && averageCents > 0
      ? Math.ceil(gapCents / averageCents)
      : null

  return {
    period,
    gapCents,
    averageQuoteCents: averageCents,
    projectsNeeded,
    sampleSize,
    assumptions: {
      formula:
        'quanto falta para a meta de receita do mês, dividido pelo ticket médio das últimas cotações salvas, arredondado para cima',
      metaDeReceitaCents: target,
      receitaRealizadaCents: progress.actual.incomeCents,
      gapCents,
      ticketMedioCents: averageCents,
      cotacoesConsideradas: sampleSize,
      janelaDeCotacoes: sampleWindow,
      origem: 'specs/monthly-goals (meta e realizado) e specs/project-pricing (cotações salvas)',
      ...(target === null ? { semDado: 'nenhuma meta de receita definida para o período' } : {}),
      ...(sampleSize === 0 ? { semTicketMedio: 'nenhuma cotação salva ainda' } : {}),
    },
  }
}
