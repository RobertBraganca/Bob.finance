import { useEffect, useState } from 'react'

/**
 * Per-browser Home layout — which cards show, how wide, and in what order.
 * Deliberately localStorage, not a server table: this is a personal screen
 * preference, not data about the user's finances, and the app already
 * treats "which browser you're on" as the unit of session (no login).
 */

/**
 * Desde 01/09/2026 o bento tem DUAS colunas, então só existem dois
 * tamanhos: 6 é meia largura e 12 é a linha inteira. Os valores
 * intermediários continuam no tipo porque layouts salvos em `localStorage`
 * antes dessa mudança ainda os contêm — `normalizeSpan` abaixo os traduz na
 * leitura, e o CSS mapeia qualquer coisa até 6 para metade de qualquer
 * forma (`base.css`), então um layout antigo nunca quebra a tela.
 */
export type BentoSpan = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12
export const BENTO_SPAN_OPTIONS: BentoSpan[] = [6, 12]

export const BENTO_SPAN_LABELS: Record<number, string> = { 6: 'Metade', 12: 'Inteira' }

/** Layout salvo antes das duas colunas: 3/4/5 viram metade, 7/8/9 viram inteira. */
export const normalizeSpan = (span: number): BentoSpan => (span <= 6 ? 6 : 12)

export type BentoCardId =
  | 'month-mode'
  | 'hero'
  | 'income-expense-kpi'
  | 'accounts'
  | 'credit-cards'
  | 'reconciliation'
  | 'pending-income'
  | 'pending-expense'
  | 'income-expense-chart'
  | 'income-by-category'
  | 'expense-by-category'
  | 'net-flow'
  | 'top-merchants'
  | 'account-flow'
  | 'uncategorized-banner'

export const BENTO_CARD_LABELS: Record<BentoCardId, string> = {
  'month-mode': 'Modo mês',
  hero: 'Resultado do período',
  'income-expense-kpi': 'Entradas e saídas (KPI)',
  accounts: 'Contas',
  'credit-cards': 'Cartões de crédito',
  reconciliation: 'Possíveis conciliações',
  'pending-income': 'Receitas pendentes',
  'pending-expense': 'Despesas pendentes',
  'income-expense-chart': 'Gráfico de entradas e saídas',
  'income-by-category': 'Entradas por categoria',
  'expense-by-category': 'Gastos por categoria',
  'net-flow': 'Resultado acumulado',
  'top-merchants': 'Onde o dinheiro mais foi',
  'account-flow': 'Fluxo entre contas',
  'uncategorized-banner': 'Aviso de sem categoria',
}

export type BentoCardConfig = { id: BentoCardId; span: BentoSpan; visible: boolean }

/** Matches the order and spans the Home shipped with, before anyone customizes it. */
export const DEFAULT_BENTO_LAYOUT: BentoCardConfig[] = [
  { id: 'month-mode', span: 12, visible: true },
  { id: 'hero', span: 6, visible: true },
  { id: 'income-expense-kpi', span: 6, visible: true },
  { id: 'accounts', span: 6, visible: true },
  { id: 'credit-cards', span: 6, visible: true },
  { id: 'reconciliation', span: 12, visible: true },
  { id: 'pending-income', span: 6, visible: true },
  { id: 'pending-expense', span: 6, visible: true },
  { id: 'income-expense-chart', span: 12, visible: true },
  { id: 'income-by-category', span: 6, visible: true },
  { id: 'expense-by-category', span: 6, visible: true },
  { id: 'net-flow', span: 6, visible: true },
  { id: 'top-merchants', span: 6, visible: true },
  { id: 'account-flow', span: 12, visible: true },
  { id: 'uncategorized-banner', span: 12, visible: true },
]

const STORAGE_KEY = 'bento-layout:dashboard:v1'

/**
 * Reconciles whatever is in storage with the current default set: a card
 * added in a later release appears at its default position, visible; a card
 * removed from the app just disappears — neither case corrupts what the
 * user already customized.
 */
function reconcile(stored: BentoCardConfig[]): BentoCardConfig[] {
  const byId = new Map(stored.map((c) => [c.id, c]))
  const knownOrder = stored.map((c) => c.id).filter((id) => byId.has(id) && DEFAULT_BENTO_LAYOUT.some((d) => d.id === id))

  /**
   * A card added in a later release enters at ITS DEFAULT POSITION, not at
   * the end. Appending was fine while every new card was a footnote, but a
   * card meant for the top of the page (the month summary) would land below
   * everything for anyone who had already customized the layout, which is
   * exactly the users most likely to keep it there.
   */
  const order = [...knownOrder]
  DEFAULT_BENTO_LAYOUT.forEach((fallback, defaultIndex) => {
    if (order.includes(fallback.id)) return
    // Ancora no vizinho anterior do layout padrão que o usuário já tem, para
    // o card novo aparecer onde ele nasceu, e não sempre no topo nem sempre
    // no fim.
    const previous = DEFAULT_BENTO_LAYOUT.slice(0, defaultIndex)
      .map((d) => d.id)
      .filter((id) => order.includes(id))
      .pop()
    const at = previous === undefined ? 0 : order.indexOf(previous) + 1
    order.splice(at, 0, fallback.id)
  })

  return order.map((id) => {
    const fromStorage = byId.get(id)
    const fallback = DEFAULT_BENTO_LAYOUT.find((d) => d.id === id)!
    if (!fromStorage) return fallback
    // Layout salvo antes das duas colunas pode trazer 3/4/5/7/8/9: traduz na
    // leitura para o dropdown de tamanho não mostrar um valor que não existe
    // mais entre as opções.
    return { ...fallback, ...fromStorage, span: normalizeSpan(fromStorage.span) }
  })
}

function load(): BentoCardConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_BENTO_LAYOUT
    return reconcile(JSON.parse(raw))
  } catch {
    return DEFAULT_BENTO_LAYOUT
  }
}

export function useBentoLayout() {
  const [layout, setLayout] = useState<BentoCardConfig[]>(load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  }, [layout])

  const setSpan = (id: BentoCardId, span: BentoSpan) =>
    setLayout((prev) => prev.map((c) => (c.id === id ? { ...c, span } : c)))

  const setVisible = (id: BentoCardId, visible: boolean) =>
    setLayout((prev) => prev.map((c) => (c.id === id ? { ...c, visible } : c)))

  const move = (id: BentoCardId, direction: -1 | 1) =>
    setLayout((prev) => {
      const index = prev.findIndex((c) => c.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      const a = next[index]!
      const b = next[target]!
      next[index] = b
      next[target] = a
      return next
    })

  /** Jumps straight to a 0-based position, for the "posição" dropdown — no repeated clicks. */
  const moveTo = (id: BentoCardId, targetIndex: number) =>
    setLayout((prev) => {
      const index = prev.findIndex((c) => c.id === id)
      if (index < 0 || targetIndex < 0 || targetIndex >= prev.length || targetIndex === index) return prev
      const next = prev.slice()
      const [card] = next.splice(index, 1)
      next.splice(targetIndex, 0, card!)
      return next
    })

  const reset = () => setLayout(DEFAULT_BENTO_LAYOUT)

  return { layout, setSpan, setVisible, move, moveTo, reset }
}
