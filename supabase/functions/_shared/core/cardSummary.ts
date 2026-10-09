/**
 * Resumo do cartão a partir dos lançamentos da Pluggy (specs/card-summary-sync,
 * decisions/0044). Puro: recebe as compras como vieram e devolve, por mês de
 * fatura, o já lançado, as parcelas projetadas e os encargos. Nenhuma
 * compra vira lançamento do app.
 *
 * Sinal: na conta de cartão da Pluggy, valor positivo é gasto (compra,
 * juros) e negativo é crédito (estorno, pagamento).
 */

export type CardTxn = {
  /** data de lançamento (YYYY-MM-DD) */
  date: string
  amountCents: number
  description: string
  billForecastDate?: string | null
  purchaseDate?: string | null
  installmentNumber?: number | null
  totalInstallments?: number | null
  feeInfo?: string | null
  /** categoria da Pluggy (ex.: "Credit card payment") */
  category?: string | null
}

export type CardMonth = {
  period: string
  postedCents: number
  projectedCents: number
  chargesCents: number
  installmentPurchases: number
}

/** Ciclo de fatura: lançamentos até `closing` (inclusive) caem na fatura do mês `period`. */
export type BillCycle = { closing: string; period: string }

const addMonths = (period: string, n: number) => {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/**
 * Mês da fatura pelo fechamento real das faturas (e do ciclo aberto). O
 * `billForecastDate` da Pluggy não é confiável para isso: no Nubank, compras
 * de uma fatura já paga vieram marcadas para a fatura seguinte. Sem ciclo
 * que cubra a data, cai em `billPeriodOf`.
 */
export function cyclePeriodOf(t: Pick<CardTxn, 'date' | 'billForecastDate'>, cycles: BillCycle[]): string {
  const i = cycles.findIndex((c) => t.date <= c.closing)
  if (i > 0) return cycles[i]!.period
  const first = cycles[0]
  if (i === 0 && first && t.date > shiftDate(first.closing, -1)) return first.period
  const last = cycles[cycles.length - 1]
  if (i === -1 && last) return addMonths(last.period, 1)
  return billPeriodOf(t)
}

const shiftDate = (isoDate: string, months: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

/**
 * Mês da fatura em que o lançamento cai: `billForecastDate` quando não é
 * anterior ao mês do lançamento (alguns bancos mandam ali o mês da compra
 * original de uma parcela); senão o mês do próprio lançamento.
 */
export function billPeriodOf(t: Pick<CardTxn, 'date' | 'billForecastDate'>): string {
  const posted = t.date.slice(0, 7)
  const forecast = t.billForecastDate && /^\d{4}-\d{2}/.test(t.billForecastDate) ? t.billForecastDate.slice(0, 7) : null
  return forecast && forecast >= posted ? forecast : posted
}

const CHARGE = /juros|iof|multa|encargo|tarifa|anuidade/i

/** Encargo do cartão (juros, IOF, multa...); estornos entram com o sinal deles e abatem. */
export const isCharge = (t: Pick<CardTxn, 'description' | 'feeInfo'>) => CHARGE.test(t.description) || CHARGE.test(t.feeInfo ?? '')

const PAYMENT = /pagamento (recebido|de fatura)|pgto fatura/i

/**
 * Pagamento da fatura anterior: não é compra nem crédito desta fatura, e
 * somar ele zera ou deixa negativa a fatura do mês em que caiu.
 */
export const isBillPayment = (t: Pick<CardTxn, 'description' | 'category'>) =>
  t.category === 'Credit card payment' || PAYMENT.test(t.description)

/** Descrição sem o "3/12", "TPARC12/24" etc., para agrupar as parcelas da mesma compra. */
const baseDescription = (d: string) =>
  d
    .toLowerCase()
    .replace(/\b(t?parc(ela)?)?\s*\d{1,2}\s*\/\s*\d{1,2}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Por mês de fatura: soma do lançado (sem os pagamentos de fatura),
 * encargos e as parcelas que ainda vão cair. Cada compra parcelada é agrupada por (data da compra, total de
 * parcelas, descrição sem o "x/y"); a partir da maior parcela já lançada,
 * as que faltam caem uma por mês com o valor dela.
 */
export function summarizeCard(txns: CardTxn[], cycles: BillCycle[] = []): CardMonth[] {
  const months = new Map<string, CardMonth>()
  const slot = (period: string) => {
    let m = months.get(period)
    if (!m) months.set(period, (m = { period, postedCents: 0, projectedCents: 0, chargesCents: 0, installmentPurchases: 0 }))
    return m
  }

  // Encargo anulado pelo banco: um crédito do mesmo valor no mesmo dia
  // ("Juros de dívida encerrada" + "Encerramento de dívida") não é custo.
  const credits = new Map<string, number>()
  for (const t of txns) {
    if (t.amountCents < 0 && !isBillPayment(t) && !isCharge(t)) {
      const k = `${t.date}|${-t.amountCents}`
      credits.set(k, (credits.get(k) ?? 0) + 1)
    }
  }
  const cancelled = (t: CardTxn) => {
    const k = `${t.date}|${t.amountCents}`
    const n = credits.get(k) ?? 0
    if (n === 0) return false
    credits.set(k, n - 1)
    return true
  }

  const latest = new Map<string, { txn: CardTxn; period: string }>()
  for (const t of txns) {
    if (isBillPayment(t)) continue
    const period = cycles.length ? cyclePeriodOf(t, cycles) : billPeriodOf(t)
    const m = slot(period)
    m.postedCents += t.amountCents
    if (isCharge(t) && !(t.amountCents > 0 && cancelled(t))) m.chargesCents += t.amountCents
    const total = t.totalInstallments ?? 0
    const number = t.installmentNumber ?? 0
    if (total > 1 && number >= 1 && t.amountCents > 0) {
      const key = `${(t.purchaseDate ?? '').slice(0, 10)}|${total}|${baseDescription(t.description)}`
      const prev = latest.get(key)
      if (!prev || (prev.txn.installmentNumber ?? 0) < number) latest.set(key, { txn: t, period })
    }
  }

  // Antecipação: o banco lança as parcelas que faltavam de uma vez, com outra
  // descrição ("ANTECIPACAO PARCELA 12/12" de uma "PARC SALDO TOT 6/12"). A
  // compra (mesma data e mesmo total de parcelas) termina na maior parcela
  // lançada de qualquer descrição dela.
  const purchaseMax = new Map<string, number>()
  for (const t of txns) {
    const total = t.totalInstallments ?? 0
    const number = Math.min(t.installmentNumber ?? 0, total)
    if (total > 1 && number >= 1 && t.amountCents > 0 && t.purchaseDate) {
      const k = `${t.purchaseDate.slice(0, 10)}|${total}`
      purchaseMax.set(k, Math.max(purchaseMax.get(k) ?? 0, number))
    }
  }

  for (const { txn, period } of latest.values()) {
    const done = txn.purchaseDate ? (purchaseMax.get(`${txn.purchaseDate.slice(0, 10)}|${txn.totalInstallments}`) ?? 0) : 0
    const remaining = (txn.totalInstallments ?? 0) - Math.max(txn.installmentNumber ?? 0, done)
    for (let k = 1; k <= remaining; k++) {
      const m = slot(addMonths(period, k))
      m.projectedCents += txn.amountCents
      if (k === 1) m.installmentPurchases += 1
    }
  }
  return [...months.values()].sort((a, b) => a.period.localeCompare(b.period))
}

/** Encargos de uma fatura fechada da Pluggy, fora `OTHER` (que é saldo levado, não encargo). */
export function billChargesCents(charges: Array<{ type?: string | null; amount?: number | null }> | null | undefined): number {
  return Math.round((charges ?? []).filter((c) => c.type && c.type !== 'OTHER').reduce((s, c) => s + (c.amount ?? 0), 0) * 100)
}
