import type { QueryClient } from '@tanstack/react-query'

/**
 * Telas que só leem o extrato (lançamentos, contas, cartões, dívidas,
 * pendências, DRE, parceiros) e nunca dados de investimento. Conferido nos
 * serviços em 04/10/2026: `analytics`, `dre`, `cashFlow`, `debt`,
 * `transactions`, `categories` e `partners` não importam `investments`,
 * `financialEngine` nem `financialHealth`, e nenhuma gravação de investimento
 * escreve em `transactions`.
 *
 * É uma lista do que PODE ficar de fora, não do que recarregar: uma chave nova
 * que ninguém lembrou de pôr aqui continua sendo recarregada. Errar para o
 * lado de buscar a mais custa tempo; errar para o outro lado mostraria número
 * velho.
 */
const LEDGER_ONLY_KEYS = new Set([
  'accounts',
  'bank-connections',
  'cash-flow-forecasts',
  'cash-flow-pending',
  'categories',
  'category-spending',
  'credit-card-invoices',
  'credit-cards',
  'daily',
  'daily-entries',
  'daily-series',
  'dashboard',
  'debt-payments',
  'debt-projection',
  'debt-reconciliation',
  'debts',
  'debts-for-simulator',
  'dre',
  'dre-formal',
  'flows',
  'history-monthly',
  'imports',
  'installments',
  'monthly-series',
  'partner-commissions',
  'partners',
  'partners-evolution',
  'profile',
  'profiles',
  'reconciliation-candidates',
  'rules',
  'subscription-candidates',
  'transactions',
])

/**
 * Depois de gravar um ativo, uma operação, uma cotação, uma meta de
 * investimento ou a reserva. Antes cada uma dessas gravações chamava
 * `invalidateQueries()` sem chave, e o React Query rebuscava toda consulta
 * ativa da tela, inclusive as do extrato que nada têm a ver com a carteira
 * (revisão de desempenho de 04/10/2026).
 */
export function invalidateInvestmentData(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    predicate: (query) => !LEDGER_ONLY_KEYS.has(String(query.queryKey[0])),
  })
}
