import { useEffect, useState } from 'react'

/**
 * Per-browser Home layout — which cards show, how wide, and in what order.
 * Deliberately localStorage, not a server table: this is a personal screen
 * preference, not data about the user's finances, and the app already
 * treats "which browser you're on" as the unit of session (no login).
 *
 * Fase 4 da migração pro shadcn/ui: largura deixou de ser um span discreto
 * de 12 colunas (o que uma grade CSS decidia) e virou uma fração contínua
 * de verdade, arrastando o `Resizable` do shadcn — cada linha do bento é
 * um grupo de painéis redimensionáveis, não mais uma célula de grid.
 * Reordenar dentro da mesma linha e mover a linha inteira continuam
 * disponíveis; mover um card para OUTRA linha não é suportado nesta fase
 * (ver ADR 0031) — as linhas em si são um conjunto fixo de cards, só a
 * ordem e a largura dentro delas mudam.
 */

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

export type BentoRow = { id: string; cards: BentoCardId[] }

/** Matches the row grouping and rough proportions the Home shipped with
 * (the old 12-column spans), before anyone customizes it. */
export const DEFAULT_BENTO_ROWS: BentoRow[] = [
  { id: 'row-month-mode', cards: ['month-mode'] },
  { id: 'row-hero', cards: ['hero', 'income-expense-kpi', 'accounts'] },
  { id: 'row-credit-cards', cards: ['credit-cards'] },
  { id: 'row-reconciliation', cards: ['reconciliation'] },
  { id: 'row-pending', cards: ['pending-income', 'pending-expense'] },
  { id: 'row-income-expense-chart', cards: ['income-expense-chart'] },
  { id: 'row-by-category', cards: ['income-by-category', 'expense-by-category'] },
  { id: 'row-net-flow', cards: ['net-flow', 'top-merchants'] },
  { id: 'row-account-flow', cards: ['account-flow'] },
  { id: 'row-uncategorized-banner', cards: ['uncategorized-banner'] },
]

const DEFAULT_SIZES: Partial<Record<BentoCardId, number>> = {
  hero: 33,
  'income-expense-kpi': 33,
  accounts: 34,
  'pending-income': 50,
  'pending-expense': 50,
  'income-by-category': 50,
  'expense-by-category': 50,
  'net-flow': 58,
  'top-merchants': 42,
}

type StoredLayout = {
  version: 2
  rows: BentoRow[]
  sizes: Partial<Record<BentoCardId, number>>
  visible: Partial<Record<BentoCardId, boolean>>
}

/** Pre-Fase-4 shape: a flat list with a discrete 12-column `span`. */
type StoredLayoutV1 = Array<{ id: BentoCardId; span: number; visible: boolean }>

const STORAGE_KEY = 'bento-layout:dashboard:v1'

function defaultLayout(): StoredLayout {
  return {
    version: 2,
    rows: DEFAULT_BENTO_ROWS.map((row) => ({ ...row, cards: [...row.cards] })),
    sizes: { ...DEFAULT_SIZES },
    visible: {},
  }
}

/** One-time upgrade for whoever already customized the old span/order grid
 * — same row-wrapping rule the CSS grid used (accumulate spans, wrap past
 * 12), so the arrangement someone already built stays recognizable, just
 * continuous instead of stepped. */
function migrateFromV1(old: StoredLayoutV1): StoredLayout {
  const visible: Partial<Record<BentoCardId, boolean>> = {}
  const sizes: Partial<Record<BentoCardId, number>> = {}
  const rows: BentoRow[] = []
  let current: Array<{ id: BentoCardId; span: number }> = []
  let currentSum = 0

  const flush = () => {
    if (current.length === 0) return
    const total = current.reduce((sum, c) => sum + c.span, 0)
    current.forEach((c) => {
      sizes[c.id] = Math.round((c.span / total) * 100)
    })
    rows.push({ id: `row-${rows.length}`, cards: current.map((c) => c.id) })
    current = []
    currentSum = 0
  }

  for (const card of old) {
    visible[card.id] = card.visible
    if (currentSum + card.span > 12 && current.length > 0) flush()
    current.push({ id: card.id, span: card.span })
    currentSum += card.span
  }
  flush()

  return { version: 2, rows, sizes, visible }
}

/**
 * Reconciles whatever is in storage with the current default set: a card
 * added in a later release appears at its default position, visible; a card
 * removed from the app just disappears — neither case corrupts what the
 * user already customized. Unlike v1, a whole ROW disappears once every
 * card in it is gone (no empty resizable group left behind).
 */
function reconcile(stored: StoredLayout): StoredLayout {
  const knownIds = new Set(DEFAULT_BENTO_ROWS.flatMap((r) => r.cards))
  let rows = stored.rows
    .map((row) => ({ ...row, cards: row.cards.filter((id) => knownIds.has(id)) }))
    .filter((row) => row.cards.length > 0)

  const present = new Set(rows.flatMap((r) => r.cards))
  DEFAULT_BENTO_ROWS.forEach((defaultRow, defaultRowIndex) => {
    const missing = defaultRow.cards.filter((id) => !present.has(id))
    if (missing.length === 0) return
    // Anchor next to the nearest earlier default card that survived, same
    // idea as v1's reconcile — a card new to this release lands where it
    // was designed to, not always at the very end.
    const anchorId = DEFAULT_BENTO_ROWS.slice(0, defaultRowIndex)
      .flatMap((r) => r.cards)
      .filter((id) => present.has(id))
      .pop()
    const anchorRowIndex = anchorId ? rows.findIndex((r) => r.cards.includes(anchorId)) : -1
    const insertAt = anchorRowIndex === -1 ? 0 : anchorRowIndex + 1
    rows = [...rows.slice(0, insertAt), { id: defaultRow.id, cards: missing }, ...rows.slice(insertAt)]
    missing.forEach((id) => present.add(id))
  })

  return { version: 2, rows, sizes: { ...stored.sizes }, visible: { ...stored.visible } }
}

function load(): StoredLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultLayout()
    const parsed = JSON.parse(raw)
    return reconcile(Array.isArray(parsed) ? migrateFromV1(parsed) : (parsed as StoredLayout))
  } catch {
    return defaultLayout()
  }
}

export function useBentoLayout() {
  const [state, setState] = useState<StoredLayout>(load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  const isVisible = (id: BentoCardId) => state.visible[id] ?? true

  const setVisible = (id: BentoCardId, visible: boolean) =>
    setState((prev) => ({ ...prev, visible: { ...prev.visible, [id]: visible } }))

  /** Last known share of its row's width, for a card's initial/collapsed size. */
  const sizeFor = (id: BentoCardId, siblingCount: number) => state.sizes[id] ?? 100 / Math.max(1, siblingCount)

  /** Wired to `ResizablePanelGroup`'s `onLayoutChanged` — persists a row's new split. */
  const setRowSizes = (layout: Record<string, number>) =>
    setState((prev) => ({ ...prev, sizes: { ...prev.sizes, ...layout } }))

  const moveRow = (rowId: string, direction: -1 | 1) =>
    setState((prev) => {
      const index = prev.rows.findIndex((r) => r.id === rowId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= prev.rows.length) return prev
      const rows = prev.rows.slice()
      ;[rows[index], rows[target]] = [rows[target]!, rows[index]!]
      return { ...prev, rows }
    })

  const moveWithinRow = (rowId: string, cardId: BentoCardId, direction: -1 | 1) =>
    setState((prev) => {
      const rowIndex = prev.rows.findIndex((r) => r.id === rowId)
      if (rowIndex < 0) return prev
      const row = prev.rows[rowIndex]!
      const index = row.cards.indexOf(cardId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= row.cards.length) return prev
      const cards = row.cards.slice()
      ;[cards[index], cards[target]] = [cards[target]!, cards[index]!]
      const rows = prev.rows.slice()
      rows[rowIndex] = { ...row, cards }
      return { ...prev, rows }
    })

  const reset = () => setState(defaultLayout())

  return { rows: state.rows, isVisible, setVisible, sizeFor, setRowSizes, moveRow, moveWithinRow, reset }
}
