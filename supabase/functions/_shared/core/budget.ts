/**
 * Contas do orçamento por grupos (specs/budget-groups, decisions/0042).
 * Puras: quem chama traz renda, gastos e aportes já somados. Valores em
 * centavos, percentuais em pontos-base (2500 = 25%).
 */

export type BudgetGroupSource = 'categories' | 'goal_contributions' | 'other_contributions'

/** Os seis grupos do método, a semente de uma conta nova. Cores da paleta de séries e da marca. */
export const METHOD_SEED: Array<{ name: string; color: string; source: BudgetGroupSource; targetBps: number }> = [
  { name: 'Custos Fixos', color: '#007bff', source: 'categories', targetBps: 3000 },
  { name: 'Conforto', color: '#ff2ea6', source: 'categories', targetBps: 1500 },
  { name: 'Prazeres', color: '#e8590c', source: 'categories', targetBps: 1000 },
  { name: 'Conhecimento', color: '#ffc700', source: 'categories', targetBps: 500 },
  { name: 'Metas', color: '#ba2be2', source: 'goal_contributions', targetBps: 1500 },
  { name: 'Liberdade Financeira', color: '#1e8e3c', source: 'other_contributions', targetBps: 2500 },
]

export const FULL_BPS = 10_000

export type Allocation = { groupId: number; targetBps: number }
export type BudgetPlanRow = { effectivePeriod: string; allocations: Allocation[] }

/** O plano que vale no mês: o de maior `effectivePeriod ≤ period`; antes do primeiro, o primeiro. */
export function planFor(period: string, plans: BudgetPlanRow[]): BudgetPlanRow | null {
  if (plans.length === 0) return null
  const sorted = [...plans].sort((a, b) => a.effectivePeriod.localeCompare(b.effectivePeriod))
  let chosen: BudgetPlanRow | null = null
  for (const plan of sorted) if (plan.effectivePeriod <= period) chosen = plan
  return chosen ?? sorted[0]!
}

export type CategoryNode = {
  id: number
  parentId: number | null
  kind: string
  budgetGroupId: number | null
  budgetExcluded: boolean
}

export type EffectiveGroup = { groupId: number | null; excluded: boolean }

/**
 * Grupo efetivo de uma TAG: o próprio, senão o da mãe. "Fora do orçamento"
 * herda do mesmo jeito; uma filha com grupo próprio vale sobre a mãe
 * excluída (é a escolha mais específica).
 */
export function effectiveGroupOf(categoryId: number, byId: Map<number, CategoryNode>): EffectiveGroup {
  const seen = new Set<number>()
  let current = byId.get(categoryId)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.budgetGroupId !== null) return { groupId: current.budgetGroupId, excluded: false }
    if (current.budgetExcluded) return { groupId: null, excluded: true }
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return { groupId: null, excluded: false }
}

export type BudgetIncome = {
  /** a base dos percentuais */
  cents: number
  receivedCents: number
  typicalCents: number
  /** verdadeiro quando a base é a renda típica porque a do mês ainda não entrou */
  estimated: boolean
}

/** Mês fechado usa o recebido; mês corrente usa a renda típica enquanto o recebido for menor. */
export function budgetIncome({ receivedCents, typicalCents, isCurrentMonth }: { receivedCents: number; typicalCents: number; isCurrentMonth: boolean }): BudgetIncome {
  const received = Math.max(0, receivedCents)
  const typical = Math.max(0, typicalCents)
  const estimated = isCurrentMonth && received < typical
  return { cents: estimated ? typical : received, receivedCents: received, typicalCents: typical, estimated }
}

export type GroupLine = {
  groupId: number
  targetBps: number
  plannedCents: number
  actualCents: number
  /** previsto − realizado; negativo = passou do previsto */
  remainingCents: number
  /** realizado ÷ renda */
  shareBps: number | null
  /** realizado ÷ previsto (a barra) */
  usedBps: number | null
}

export function groupLine(groupId: number, targetBps: number, incomeCents: number, actualCents: number): GroupLine {
  const plannedCents = Math.round((incomeCents * targetBps) / FULL_BPS)
  return {
    groupId,
    targetBps,
    plannedCents,
    actualCents,
    remainingCents: plannedCents - actualCents,
    shareBps: incomeCents > 0 ? Math.round((actualCents / incomeCents) * FULL_BPS) : null,
    usedBps: plannedCents > 0 ? Math.round((actualCents / plannedCents) * FULL_BPS) : null,
  }
}

/**
 * Arredonda para inteiros que somam exatamente 10000, distribuindo a sobra
 * pelos maiores restos (método de Hamilton). Tudo zero continua zero.
 */
export function normalizeTo10000(values: number[]): number[] {
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const total = clean.reduce((sum, v) => sum + v, 0)
  if (total <= 0) return clean.map(() => 0)
  const exact = clean.map((v) => (v / total) * FULL_BPS)
  const floors = exact.map(Math.floor)
  let rest = FULL_BPS - floors.reduce((sum, v) => sum + v, 0)
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (rest <= 0) break
    floors[i]! += 1
    rest -= 1
  }
  return floors
}

/**
 * Quanto cada grupo levou da renda em média, ponderado pela renda: soma dos
 * realizados ÷ soma das rendas. Mês sem renda não entra.
 */
export function historyShares(months: Array<{ incomeCents: number; actuals: Map<number, number> }>, groupIds: number[]): Map<number, number> {
  const valid = months.filter((m) => m.incomeCents > 0)
  const incomeTotal = valid.reduce((sum, m) => sum + m.incomeCents, 0)
  const out = new Map<number, number>()
  for (const id of groupIds) {
    const actual = valid.reduce((sum, m) => sum + (m.actuals.get(id) ?? 0), 0)
    out.set(id, incomeTotal > 0 ? Math.round((actual / incomeTotal) * FULL_BPS) : 0)
  }
  return out
}

/** Nome sem acento e em minúsculas, para comparar TAGs. */
export const normalizeName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

/**
 * Proposta inicial de grupo pela TAG (só sugestão; grava ao Salvar). Chave
 * é o nome do grupo da semente, ou 'excluded' para "Fora do orçamento".
 * A sub-TAG procura pelo próprio nome primeiro e depois pelo da mãe.
 */
const SUGGESTIONS: Array<[string, string[]]> = [
  [
    'Custos Fixos',
    [
      'moradia', 'aluguel', 'condominio', 'energia', 'agua', 'gas', 'internet', 'iptu', 'manutencao casa',
      'supermercado', 'padaria e cafe', 'saude', 'plano de saude', 'farmacia', 'consultas e exames',
      'combustivel', 'transporte publico', 'manutencao veiculo', 'ipva e licenciamento',
      'juros e multas', 'tarifas bancarias', 'seguros', 'emprestimos', 'pets', 'mensalidade',
    ],
  ],
  ['Conforto', ['academia', 'app de transporte', 'estacionamento', 'assinaturas', 'vestuario', 'beleza']],
  ['Prazeres', ['restaurante', 'delivery', 'lazer', 'presentes', 'flores']],
  ['Conhecimento', ['educacao', 'cursos', 'livros']],
  ['excluded', ['negocio']],
]
const SUGGESTION_BY_NAME = new Map<string, string>(SUGGESTIONS.flatMap(([group, names]) => names.map((n) => [n, group] as [string, string])))

export function suggestGroup(categoryName: string, parentName: string | null): string | null {
  return SUGGESTION_BY_NAME.get(normalizeName(categoryName)) ?? (parentName ? SUGGESTION_BY_NAME.get(normalizeName(parentName)) ?? null : null)
}
