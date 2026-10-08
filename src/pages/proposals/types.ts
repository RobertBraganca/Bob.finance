/**
 * Tipos e rótulos dos orçamentos de serviço (decisions/0040,
 * specs/service-proposals), no formato que `/pricing/proposals` devolve.
 */

export type ProposalStatus = 'draft' | 'sent' | 'approved' | 'rejected'
export type ProposalSort = 'recent' | 'oldest' | 'value_desc' | 'value_asc'

export type ProposalSummary = {
  id: number
  number: number
  numberLabel: string
  title: string
  clientLabel: string
  status: ProposalStatus
  discountBps: number
  validityDays: number
  validUntil: string
  installments: number
  paymentTerms: string | null
  deliveryTerms: string | null
  notes: string | null
  sentAt: string | null
  approvedAmountCents: number | null
  createdAt: string
  updatedAt: string
  subtotalCents: number
  discountCents: number
  totalCents: number
  itemCount: number
}

export type ProposalItem = {
  id?: number
  title: string
  description: string | null
  unitPriceCents: number
  quantity: number
  sourceQuoteId: number | null
}

export type ProposalReceivable = {
  id: number
  postedOn: string
  description: string
  amountCents: number
  pending: boolean
}

export type ProposalDetail = ProposalSummary & { items: ProposalItem[]; receivables: ProposalReceivable[] }

export type IssuerSettings = {
  businessName: string | null
  document: string | null
  email: string | null
  phone: string | null
  logoPath: string | null
  defaultValidityDays: number
}

export const STATUS_LABEL: Record<ProposalStatus, string> = {
  draft: 'Rascunho',
  sent: 'Enviado',
  approved: 'Aprovado',
  rejected: 'Recusado',
}

/** Selos que já existem no app: neutro, azul, verde, vermelho. */
export const STATUS_BADGE: Record<ProposalStatus, string> = {
  draft: 'badge',
  sent: 'badge badge--info',
  approved: 'badge badge--good',
  rejected: 'badge badge--critical',
}

export const SORT_OPTIONS: Array<{ value: ProposalSort; label: string }> = [
  { value: 'recent', label: 'Mais recente' },
  { value: 'oldest', label: 'Mais antigo' },
  { value: 'value_desc', label: 'Maior valor' },
  { value: 'value_asc', label: 'Menor valor' },
]

/** Quantidade como o usuário escreve: "1", "12,5". */
export function formatQuantity(quantity: number): string {
  return quantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
}

/** CPF (11 dígitos) ou CNPJ (14) com máscara; outro tamanho volta como veio. */
export function formatDocument(digits: string | null): string {
  if (!digits) return ''
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
  if (digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
  return digits
}
