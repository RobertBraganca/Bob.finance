import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { subscriptionDismissals, transactions } from '../db/schema'
import { merchantSignature } from '../core/normalize'
import { addMonths } from '../core/dates'
import { createForecast } from './cashFlow'

/**
 * Item 8 do backlog de 07/09/2026. Medido contra dado real (07/09/2026,
 * 805 grupos de comerciante): só 5 batem os dois critérios abaixo, e
 * nenhum é uma assinatura de verdade (Pix mensal pra prefeitura, Pix pra
 * pessoa, financeira, "Empréstimo" já rastreado em Endividamento, uma
 * compra repetida 2x) — construído mesmo assim, a pedido do usuário,
 * ciente de que hoje não tem nenhuma sugestão real pra mostrar. Sempre
 * SUGESTÃO revisável (decisions/0003): nunca cria `cashFlowForecasts`
 * sozinha, e uma vez descartada (ou aceita) nunca mais aparece pro mesmo
 * comerciante (`subscriptionDismissals`, mesmo padrão de
 * `reconciliationDismissals`).
 */
const AMOUNT_TOLERANCE = 0.05
const MIN_GAP_DAYS = 25
const MAX_GAP_DAYS = 35

export type SubscriptionCandidate = {
  signature: string
  description: string
  occurrences: number
  avgAmountCents: number
  lastPostedOn: string
  accountId: number
  categoryId: number | null
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

export async function detectSubscriptionCandidates(): Promise<SubscriptionCandidate[]> {
  const dismissed = new Set(
    (await db.select({ signature: subscriptionDismissals.signature }).from(subscriptionDismissals)).map(
      (r) => r.signature,
    ),
  )

  const rows = await db
    .select({
      description: transactions.description,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      accountId: transactions.accountId,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(and(eq(transactions.pending, false), sql`${transactions.amountCents} < 0`))
    .orderBy(transactions.postedOn)

  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const signature = merchantSignature(row.description)
    if (!signature || dismissed.has(signature)) continue
    const list = groups.get(signature) ?? []
    list.push(row)
    groups.set(signature, list)
  }

  const candidates: SubscriptionCandidate[] = []
  for (const [signature, list] of groups) {
    // 2+ ocorrências é o mínimo pra medir intervalo — a referência (item 8
    // do backlog) pede exatamente isso: "pelo menos 2 pagamentos".
    if (list.length < 2) continue

    const amounts = list.map((r) => Math.abs(r.amountCents))
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length
    const stable = amounts.every((a) => Math.abs(a - avg) / avg <= AMOUNT_TOLERANCE)
    if (!stable) continue

    const sorted = [...list].sort((a, b) => a.postedOn.localeCompare(b.postedOn))
    const gaps: number[] = []
    for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1]!.postedOn, sorted[i]!.postedOn))
    const regular = gaps.length > 0 && gaps.every((g) => g >= MIN_GAP_DAYS && g <= MAX_GAP_DAYS)
    if (!regular) continue

    const latest = sorted[sorted.length - 1]!
    // Categoria mais frequente do grupo inteiro, não só a da última
    // ocorrência — uma recategorização isolada não deveria virar a
    // sugestão.
    const categoryCounts = new Map<number | null, number>()
    for (const r of list) categoryCounts.set(r.categoryId, (categoryCounts.get(r.categoryId) ?? 0) + 1)
    const categoryId = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0]

    candidates.push({
      signature,
      description: latest.description,
      occurrences: list.length,
      avgAmountCents: Math.round(avg),
      lastPostedOn: latest.postedOn,
      accountId: latest.accountId,
      categoryId,
    })
  }

  return candidates.sort((a, b) => b.lastPostedOn.localeCompare(a.lastPostedOn))
}

export async function dismissSubscription(signature: string) {
  await db.insert(subscriptionDismissals).values({ signature }).onConflictDoNothing()
  return { dismissed: true }
}

/** Aceita a sugestão: vira uma previsão recorrente de verdade, sem motor novo — mesma `createForecast` que a criação manual já usa. */
export async function confirmSubscription(signature: string) {
  const candidates = await detectSubscriptionCandidates()
  const candidate = candidates.find((c) => c.signature === signature)
  if (!candidate) return null

  const dueDay = Number(candidate.lastPostedOn.slice(8, 10))
  const startPeriod = addMonths(candidate.lastPostedOn.slice(0, 7), 1)

  const forecast = await createForecast({
    description: candidate.description,
    kind: 'recurring',
    amountCents: -candidate.avgAmountCents,
    accountId: candidate.accountId,
    categoryId: candidate.categoryId,
    startPeriod,
    dueDay,
  })

  await dismissSubscription(signature)
  return forecast
}
