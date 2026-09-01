import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { monthlyClosingReviews } from '../db/schema.ts'
import { periodBounds } from '../core/dates.ts'
import { totals } from './analytics.ts'
import { reconciliationCandidates } from './cashFlow.ts'

/**
 * Checklist de fechamento mensal — estudo de viabilidade #7, 29/08/2026.
 * Não existe um precedente de "revisado" em nenhuma outra área: a maioria
 * dos itens é 100% derivada (categorização, conciliação, Diário — nunca
 * guardada, sempre recomputada do período pedido), e o único item que
 * exige uma marcação humana ("revisei a DRE deste mês") é o único que
 * grava algo, em `monthly_closing_reviews`. Sequencial de propósito, mesmo
 * risco de pooler das demais séries desta área.
 */
export type ClosingChecklistItem = {
  key: string
  label: string
  kind: 'auto' | 'manual'
  done: boolean
  detail: string
}

export type ClosingChecklist = {
  period: string
  items: ClosingChecklistItem[]
  reviewedAt: string | null
}

export async function closingChecklist(period: string): Promise<ClosingChecklist> {
  const { start, end } = periodBounds(period)

  const periodTotals = await totals({ from: start, to: end })
  const allCandidates = await reconciliationCandidates()
  const pendingReconciliations = allCandidates.filter(
    (c) => c.pending.postedOn >= start && c.pending.postedOn <= end,
  )
  const dailyRows = await db.execute<{ days: number }>(sql`
    select count(distinct posted_on) as days
    from transactions
    where source = 'daily' and posted_on between ${start} and ${end}
  `)
  const dailyDays = dailyRows[0]?.days ?? 0
  const reviewRows = await db
    .select({ reviewedAt: monthlyClosingReviews.reviewedAt })
    .from(monthlyClosingReviews)
    .where(eq(monthlyClosingReviews.period, period))

  const reviewedAt = reviewRows[0]?.reviewedAt ?? null

  const items: ClosingChecklistItem[] = [
    {
      key: 'categorization',
      label: 'Todas as transações do mês categorizadas',
      kind: 'auto',
      done: periodTotals.uncategorizedCount === 0,
      detail:
        periodTotals.uncategorizedCount === 0
          ? 'Nenhuma pendente'
          : `${periodTotals.uncategorizedCount} sem categoria`,
    },
    {
      key: 'reconciliation',
      label: 'Fila de conciliação zerada',
      kind: 'auto',
      done: pendingReconciliations.length === 0,
      detail:
        pendingReconciliations.length === 0
          ? 'Nenhuma sugestão pendente'
          : `${pendingReconciliations.length} sugestão(ões) pendente(s)`,
    },
    {
      key: 'daily-log',
      label: 'Diário com pelo menos um registro no mês',
      kind: 'auto',
      done: dailyDays > 0,
      detail: dailyDays === 0 ? 'Nenhum dia registrado' : `${dailyDays} dia(s) com lançamento`,
    },
    {
      key: 'dre-review',
      label: 'DRE do mês revisada',
      kind: 'manual',
      done: reviewedAt !== null,
      detail: reviewedAt !== null ? `Revisada em ${reviewedAt.slice(0, 10)}` : 'Ainda não revisada',
    },
  ]

  return { period, items, reviewedAt }
}

export async function setClosingReview(period: string, reviewed: boolean): Promise<void> {
  if (reviewed) {
    await db.insert(monthlyClosingReviews).values({ period }).onConflictDoNothing()
  } else {
    await db.delete(monthlyClosingReviews).where(eq(monthlyClosingReviews.period, period))
  }
}
