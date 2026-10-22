import type { ClientMetrics, ClientsOverview, DealStage } from '@shared/deals'

/**
 * Clientes (docs/specs/clientes-e-negocios), no formato que `/pricing/clients`
 * devolve. Métricas e estágios vêm de `shared/deals.ts`, os mesmos do servidor.
 */

export type ClientKind = 'lead' | 'company' | 'person'
export type ClientStatus = 'active' | 'inactive' | 'ended' | 'archived'

export const CLIENT_KIND_LABEL: Record<ClientKind, string> = { lead: 'Lead', company: 'Empresa', person: 'Pessoa' }
export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  active: 'Ativo',
  inactive: 'Inativo',
  ended: 'Contrato encerrado',
  archived: 'Arquivado',
}
export const CLIENT_STATUS_BADGE: Record<ClientStatus, string> = {
  active: 'badge badge--good',
  inactive: 'badge',
  // Não é ruim nem bom: o trabalho terminou. Âmbar só para destacar de "Ativo" na lista.
  ended: 'badge badge--warning',
  archived: 'badge',
}

export type ClientRecord = {
  id: number
  name: string
  kind: ClientKind
  status: ClientStatus
  segment: string | null
  email: string | null
  phone: string | null
  document: string | null
  website: string | null
  source: string | null
  description: string | null
  isRecurring: boolean
  createdAt: string
  updatedAt: string
}

export type ClientSummary = ClientRecord & {
  metrics: ClientMetrics
  dealCount: number
  primaryContact: { name: string; email: string | null } | null
}

export type ClientsResponse = { clients: ClientSummary[]; overview: ClientsOverview; assumptions: Record<string, string> }

export type ClientContact = {
  id: number
  clientId: number
  name: string
  role: string | null
  email: string | null
  phone: string | null
  isPrimary: boolean
}

export type PayerAlias = { id: number; clientId: number; alias: string }

export type ClientDeal = { kind: 'proposal' | 'quote'; id: number; title: string; stage: DealStage; valueCents: number; updatedAt: string }

export type ClientRevenue = {
  id: number
  postedOn: string
  description: string
  amountCents: number
  pending: boolean
  via: 'manual' | 'proposal' | 'quote' | 'payer'
}

/** Entrada do extrato para escolher à mão (`/pricing/clients/:id/transaction-candidates`). */
export type TransactionCandidate = {
  id: number
  postedOn: string
  description: string
  amountCents: number
  pending: boolean
  accountName: string | null
  categoryName: string | null
  linkedTo: { clientId: number; clientName: string; via: ClientRevenue['via'] } | null
}

export type ClientDetail = ClientRecord & {
  contacts: ClientContact[]
  aliases: PayerAlias[]
  deals: ClientDeal[]
  revenue: ClientRevenue[]
  monthlyRevenue: Array<{ period: string; cents: number }>
  metrics: ClientMetrics
}

export type PayerSuggestion = { alias: string; example: string; totalCents: number; count: number; looksLikeClient: boolean }

export const REVENUE_VIA_LABEL: Record<ClientRevenue['via'], string> = {
  manual: 'escolhido por você',
  proposal: 'orçamento',
  quote: 'cotação',
  payer: 'nome no extrato',
}

/** Por que o cliente conta como recorrente, em português. */
export const RECURRING_REASON_LABEL: Record<NonNullable<ClientMetrics['recurringReason']>, string> = {
  flag: 'marcado como recorrente',
  months: 'receita em 3 meses ou mais',
  deals: '2 negócios aprovados ou mais',
}
