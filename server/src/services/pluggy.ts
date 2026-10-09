/**
 * Cliente mínimo da API da Pluggy (Meu Pluggy, uso pessoal), só leitura.
 * As credenciais ficam no servidor (`PLUGGY_CLIENT_ID` e
 * `PLUGGY_CLIENT_SECRET`); a chave de API que a Pluggy devolve vale 2h, e
 * aqui é reaproveitada por 90 minutos.
 */
const BASE = 'https://api.pluggy.ai'
const API_KEY_TTL_MS = 90 * 60 * 1000

export class PluggyError extends Error {}

export type PluggyAccount = {
  id: string
  itemId: string
  type: 'BANK' | 'CREDIT' | string
  subtype: string
  name: string
  marketingName: string | null
  number: string | null
  owner: string | null
  taxNumber: string | null
  balance: number
  /** só nas contas de cartão (`type = CREDIT`) */
  creditData?: {
    creditLimit?: number | null
    availableCreditLimit?: number | null
    balanceCloseDate?: string | null
    balanceDueDate?: string | null
    minimumPayment?: number | null
  } | null
}

/** Fatura fechada de um cartão (`GET /bills`). A aberta e as futuras não vêm aqui. */
export type PluggyBill = {
  id: string
  dueDate: string
  billClosingDate: string | null
  totalAmount: number
  minimumPaymentAmount: number | null
  financeCharges: Array<{ type?: string | null; amount?: number | null; additionalInfo?: string | null }> | null
}

export type PluggyTransaction = {
  id: string
  date: string
  description: string
  descriptionRaw: string | null
  amount: number
  type: 'DEBIT' | 'CREDIT'
  status: 'POSTED' | 'PENDING'
  category: string | null
  operationType: string | null
  /** só nos lançamentos de cartão; ver specs/card-summary-sync, "Desvios" */
  creditCardMetadata?: {
    billForecastDate?: string | null
    purchaseDate?: string | null
    installmentNumber?: number | null
    totalInstallments?: number | null
    feeTypeAdditionalInfo?: string | null
    billId?: string | null
  } | null
}

let cached: { key: string; expiresAt: number } | null = null

function credentials() {
  const clientId = process.env.PLUGGY_CLIENT_ID
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new PluggyError('Pluggy não configurada: faltam PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no servidor')
  return { clientId, clientSecret }
}

async function apiKey(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.key
  const response = await fetch(`${BASE}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials()),
  })
  if (!response.ok) throw new PluggyError(`Pluggy recusou as credenciais (${response.status})`)
  const { apiKey: key } = (await response.json()) as { apiKey: string }
  cached = { key, expiresAt: Date.now() + API_KEY_TTL_MS }
  return key
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { headers: { 'X-API-KEY': await apiKey() } })
  if (response.status === 404) throw new PluggyError('não encontrado na Pluggy (confira o ID da conexão)')
  if (!response.ok) throw new PluggyError(`Pluggy respondeu ${response.status} em ${path.split('?')[0]}`)
  return (await response.json()) as T
}

export async function listAccounts(itemId: string): Promise<PluggyAccount[]> {
  const { results } = await get<{ results: PluggyAccount[] }>(`/accounts?itemId=${encodeURIComponent(itemId)}`)
  return results
}

/** Todas as transações da conta no intervalo, seguindo o cursor da v2 (o `/transactions` antigo responde 410). */
export async function listTransactions(accountId: string, dateFrom: string, dateTo: string): Promise<PluggyTransaction[]> {
  const out: PluggyTransaction[] = []
  let next: string | null =
    `?accountId=${encodeURIComponent(accountId)}&dateFrom=${dateFrom}&dateTo=${dateTo}`
  while (next) {
    const page: { results: PluggyTransaction[]; next: string | null } = await get(`/v2/transactions${next}`)
    out.push(...page.results)
    next = page.next
  }
  return out
}

export async function listBills(accountId: string): Promise<PluggyBill[]> {
  const { results } = await get<{ results: PluggyBill[] }>(`/bills?accountId=${encodeURIComponent(accountId)}`)
  return results
}
