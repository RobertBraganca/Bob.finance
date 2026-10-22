/** O mês da empresa como o contador vê (`/accountant/month`), só a conta PJ. */

export type AccountantTransaction = {
  id: number
  postedOn: string
  description: string
  amountCents: number
  categoryName: string | null
  pending: boolean
  clientName: string | null
}

export type AccountantMonth = {
  period: string
  pjAccount: { id: number; name: string } | null
  summary: {
    revenueCents: number
    dasCents: number
    costsCents: number
    profitCents: number
    withdrawalsCents: number
    dasMonthlyCents: number
    dasPending: boolean
  } | null
  ceiling: { yearRevenueCents: number; limitCents: number; usedBps: number; projectedYearCents: number; state: 'ok' | 'attention' | 'critical' } | null
  revenueSeries: Array<{ period: string; revenueCents: number }>
  transactions: AccountantTransaction[]
  invoices: Array<{ title: string; clientName: string | null; dueOn: string; reference: string | null; doneAt: string }>
  totals: { inCents: number; outCents: number; count: number }
}

export type AccountantPackage = { period: string; createdAt: string; files: Array<{ name: string; url: string | null }> }

export type AccessUser = { userId: string; email: string; role: 'accountant'; invitedAt: string; revokedAt: string | null }

export const PACKAGE_BUCKET = 'accountant-packages'
/** Validade do link enviado ao contador. */
export const SHARE_DAYS = 7

/** O extrato PJ do mês em CSV (separador ";" e vírgula decimal, como o Excel em português abre). */
export function transactionsCsv(month: AccountantMonth): string {
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const value = (cents: number) => (cents / 100).toFixed(2).replace('.', ',')
  const lines = ['Data;Descrição;TAG;Cliente;Valor;Situação']
  for (const t of month.transactions) {
    lines.push([t.postedOn.split('-').reverse().join('/'), esc(t.description), esc(t.categoryName ?? ''), esc(t.clientName ?? ''), value(t.amountCents), t.pending ? 'pendente' : 'realizado'].join(';'))
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}
