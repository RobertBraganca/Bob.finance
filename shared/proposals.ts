/**
 * Contas do orçamento de serviço (decisions/0040, specs/service-proposals).
 *
 * Funções puras, usadas pela tela (enquanto o formulário é editado) e pelo
 * servidor (lista, detalhe, aprovação). O espelho para as Edge Functions,
 * que não alcançam esta pasta, é `supabase/functions/_shared/core/proposals.ts`
 * e precisa ficar idêntico a este arquivo.
 *
 * Os totais nunca são guardados no banco ("derivar, nunca guardar", PRD §4):
 * só a aprovação congela o valor que foi para as receitas.
 */

export type ProposalLine = { unitPriceCents: number; quantity: number }

export type ProposalTotals = {
  subtotalCents: number
  discountCents: number
  totalCents: number
  itemCount: number
}

/** Valor de uma linha: preço unitário × quantidade (que aceita decimais), arredondado ao centavo. */
export function lineTotalCents(line: ProposalLine): number {
  return Math.round(line.unitPriceCents * line.quantity)
}

/** Subtotal, desconto (em pontos-base sobre o subtotal, 10000 = 100%) e total. */
export function proposalTotals(lines: ProposalLine[], discountBps: number): ProposalTotals {
  const subtotalCents = lines.reduce((sum, line) => sum + lineTotalCents(line), 0)
  const bps = Math.min(10_000, Math.max(0, discountBps))
  const discountCents = Math.round((subtotalCents * bps) / 10_000)
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents, itemCount: lines.length }
}

/**
 * Parcelas iguais em centavos; a sobra do arredondamento vai para a última,
 * para a soma bater exatamente com o total (R$ 100,00 em 3 = 33,33 + 33,33 + 33,34).
 */
export function splitProposalInstallments(totalCents: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count))
  const base = Math.floor(totalCents / n)
  const parts = Array.from({ length: n }, () => base)
  parts[n - 1] = totalCents - base * (n - 1)
  return parts
}

/** Data-limite da proposta: dia da criação mais a validade em dias, `YYYY-MM-DD`. */
export function proposalValidUntil(createdAtIso: string, validityDays: number): string {
  const date = new Date(`${createdAtIso.slice(0, 10)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + Math.max(0, Math.floor(validityDays)))
  return date.toISOString().slice(0, 10)
}

/** `#0001`. */
export function formatProposalNumber(n: number): string {
  return `#${String(n).padStart(4, '0')}`
}
