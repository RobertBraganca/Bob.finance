import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { financialEngineSettings } from '../db/schema.ts'
import { addMonths, periodBounds, periodRange, todayIso } from '../core/dates.ts'
import { accountBalances, totals } from './analytics.ts'
import { listPending } from './cashFlow.ts'
import { listCards } from './creditCards.ts'
import { debtOverview } from './debt.ts'
import { targetState, type GoalState } from './goals.ts'
import { listGoals, reserveStatus } from './investments.ts'
import { accountFlows } from './transfers.ts'
import type { Assumptions } from './financialHealth.ts'

/**
 * The financial engine: how much of the balance is still uncommitted, and
 * what revenue would cover everything already configured.
 *
 * Both features only cross numbers that other areas already own (Metas,
 * Dívida, Investimentos, DRE, Cartões). Nothing is stored and no aggregation
 * is duplicated: every term traces back to the service that owns it, and
 * says so in its `assumptions`.
 *
 * Two rules from `decisions/0010` shape the API itself, not just the copy:
 *
 *   1. Every composed number ships the terms it was composed from, so the
 *      UI can show the memory of calculation instead of a bare total.
 *   2. Destinations come back in a NEUTRAL order (alphabetical). Sorting
 *      them by computed "urgency" would be a recommendation wearing the
 *      costume of a layout decision, which is exactly what the ADR rules
 *      out. If that ever needs to change, it changes to an order the USER
 *      configured, never one the system inferred.
 */

/* ------------------------------------------------------------------ *
 * Parameters
 *
 * Three layers, in this order: the exported defaults, whatever the user
 * saved in `financial_engine_settings`, then any per-request override.
 * Nothing is hardcoded inside a calculation, and the response reports
 * which layer each parameter actually came from, so a number on screen
 * can always be traced back to who chose its inputs.
 * ------------------------------------------------------------------ */
export type BreakEvenParams = {
  /** which account holds the PJ books; null reads the whole ledger */
  pjAccountId: number | null
  /** which account receives the pró-labore; null skips the paired-flow derivation */
  pfAccountId: number | null
  /** overrides the pró-labore derived from the paired PJ to PF transfer */
  proLaboreCents: number | null
  /** tax as a share of revenue, in basis points; 0 means not configured */
  taxRateBps: number
  /** what the user plans to put into the reserve this month */
  reservePlannedCents: number
  /** the margin the user wants on top of everything else */
  marginCents: number
}

export const DEFAULT_BREAK_EVEN_PARAMS: BreakEvenParams = {
  pjAccountId: null,
  pfAccountId: null,
  proLaboreCents: null,
  taxRateBps: 0,
  reservePlannedCents: 0,
  marginCents: 0,
}

/** Where a parameter's value came from, reported alongside the result. */
export type ParamOrigin = 'default' | 'configurado' | 'requisição'

export async function getSettings(): Promise<BreakEvenParams> {
  const row = (await db.select().from(financialEngineSettings).where(eq(financialEngineSettings.id, 1)))[0]
  if (!row) return { ...DEFAULT_BREAK_EVEN_PARAMS }
  return {
    pjAccountId: row.pjAccountId,
    pfAccountId: row.pfAccountId,
    proLaboreCents: row.proLaboreCents,
    taxRateBps: row.taxRateBps,
    reservePlannedCents: row.reservePlannedCents,
    marginCents: row.marginCents,
  }
}

export async function setSettings(patch: Partial<BreakEvenParams>): Promise<BreakEvenParams> {
  const existing = (await db.select().from(financialEngineSettings).where(eq(financialEngineSettings.id, 1)))[0]
  if (existing) {
    await db.update(financialEngineSettings).set(patch).where(eq(financialEngineSettings.id, 1))
  } else {
    await db.insert(financialEngineSettings).values({ id: 1, ...DEFAULT_BREAK_EVEN_PARAMS, ...patch })
  }
  return getSettings()
}

/**
 * Resolves the three layers and records which one won for each key. A
 * parameter saved as the same value the default already had is reported as
 * `default`: what matters downstream is that nobody had to make a choice for
 * it, not which row it was read from.
 */
async function resolveParams(overrides: Partial<BreakEvenParams>): Promise<{
  params: BreakEvenParams
  origins: Record<keyof BreakEvenParams, ParamOrigin>
}> {
  const stored = await getSettings()
  const keys = Object.keys(DEFAULT_BREAK_EVEN_PARAMS) as Array<keyof BreakEvenParams>

  /**
   * A null override means "the query did not say", NOT "clear the saved
   * value": the route fills every absent query param with null, so a plain
   * spread would let an omitted param erase the user's own configuration.
   * Clearing a saved value is done through PUT /financial-engine/settings,
   * which is the only place that writes.
   */
  const explicit = Object.fromEntries(
    keys
      .filter((key) => overrides[key] !== undefined && overrides[key] !== null)
      .map((key) => [key, overrides[key]]),
  ) as Partial<BreakEvenParams>

  const params = { ...DEFAULT_BREAK_EVEN_PARAMS, ...stored, ...explicit }
  const origins = {} as Record<keyof BreakEvenParams, ParamOrigin>
  for (const key of keys) {
    origins[key] =
      explicit[key] !== undefined
        ? 'requisição'
        : params[key] === DEFAULT_BREAK_EVEN_PARAMS[key]
          ? 'default'
          : 'configurado'
  }
  return { params, origins }
}

/* ------------------------------------------------------------------ *
 * What was already put toward each destination inside the period
 * ------------------------------------------------------------------ */

/** Reserve contributions: buy trades on whichever assets the user flagged as reserve. */
async function reserveContributedCents(from: string, to: string): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select coalesce(sum(round(t.quantity * t.unit_price_cents)), 0) as total
    from asset_trades t
    join assets a on a.id = t.asset_id
    where t.kind = 'buy'
      and a.counts_toward_reserve = true
      and t.traded_on between ${from} and ${to}
  `)
  return rows[0]?.total ?? 0
}

/** Investment contributions: buy trades on everything that is NOT the reserve. */
async function investmentContributedCents(from: string, to: string): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select coalesce(sum(round(t.quantity * t.unit_price_cents) + t.fees_cents), 0) as total
    from asset_trades t
    join assets a on a.id = t.asset_id
    where t.kind = 'buy'
      and a.counts_toward_reserve = false
      and t.traded_on between ${from} and ${to}
  `)
  return rows[0]?.total ?? 0
}

/** Debt paid inside the period, from the same payment ledger `specs/debt` counts parcelas with. */
async function debtPaidCents(from: string, to: string): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select coalesce(sum(amount_cents), 0) as total
    from debt_payments
    where kind = 'payment' and paid_on between ${from} and ${to}
  `)
  return rows[0]?.total ?? 0
}

/* ------------------------------------------------------------------ *
 * Disponível para alocação
 * ------------------------------------------------------------------ */
export type DestinationKey = 'debt' | 'investment' | 'free' | 'reserve'

export type Destination = {
  key: DestinationKey
  label: string
  /** null when the destination has no configured target, which is the case for "Livre" */
  targetCents: number | null
  realizedCents: number
  differenceCents: number | null
  /**
   * Same green/yellow/red judgement `specs/monthly-goals` already computes
   * for income (`targetState`) — reused, not a second formula, so "Modo
   * mês" (specs/dashboard) can color every line the same way.
   */
  state: GoalState
  assumptions: Assumptions
}

export type AvailableForAllocation = {
  period: string
  availableCents: number
  terms: {
    consolidatedBalanceCents: number
    futureCommitmentsCents: number
    provisionedCardBillCents: number
    alreadyAllocatedCents: number
  }
  destinations: Destination[]
  assumptions: Assumptions
}

/** Ajuste hipotético do simulador. Ausente em toda chamada de produção. */
export type AvailableOverrides = { consolidatedBalanceDeltaCents?: number }

export async function availableForAllocation(
  period: string,
  overrides: AvailableOverrides = {},
): Promise<AvailableForAllocation> {
  const { start, end } = periodBounds(period)

  const balanceDeltaCents = overrides.consolidatedBalanceDeltaCents ?? 0
  // Sequencial, não Promise.all: sob o pooler de transação desta Edge
  // Function, fan-out concorrente demais numa mesma conexão trava a
  // requisição para sempre (sem erro nenhum) em vez de só ficar lenta —
  // mesmo achado e mesmo fix de goals.ts#goalHistory. `debtOverview` sozinho
  // já faz seu próprio fan-out por dívida, então rodar as outras 8 chamadas
  // ao mesmo tempo empilhava concorrência suficiente para travar.
  const balances = await accountBalances()
  // Pending expenses, bounded by the period's end. `listPending` deliberately
  // keeps overdue rows in the list (see specs/cash-flow-reconciliation), and
  // that is the right behaviour here too: something still owed from last
  // month is still money that is not free.
  const pending = await listPending('expense', { from: start, to: end })
  const cards = await listCards()
  const reserve = await reserveStatus()
  const reserveRealizedCents = await reserveContributedCents(start, end)
  const investmentRealizedCents = await investmentContributedCents(start, end)
  const debtRealizedCents = await debtPaidCents(start, end)
  // `listGoals` already returns only the active ones.
  const investmentGoals = await listGoals()
  const debt = await debtOverview({ period })

  // O delta entra ANTES das subtrações, porque o que a hipótese muda é
  // quanto existe em conta, não quanto está comprometido.
  const consolidatedBalanceCents = balances.reduce((sum, a) => sum + a.balanceCents, 0) + balanceDeltaCents

  const futureCommitmentsCents = pending.reduce((sum, p) => sum + Math.abs(p.amountCents), 0)
  const provisionedCardBillCents = cards.reduce((sum, c) => sum + c.usedCents, 0)
  const alreadyAllocatedCents = reserveRealizedCents + investmentRealizedCents + debtRealizedCents

  const availableCents =
    consolidatedBalanceCents - futureCommitmentsCents - provisionedCardBillCents - alreadyAllocatedCents

  const investmentTargetCents = investmentGoals.reduce((sum, g) => sum + g.monthlyContributionCents, 0)
  const isCurrentPeriod = period === todayIso().slice(0, 7)

  const unorderedDestinations: Destination[] = [
    {
      key: 'reserve',
      label: 'Reserva de emergência',
      targetCents: reserve.gapCents,
      realizedCents: reserveRealizedCents,
      differenceCents: reserve.gapCents - reserveRealizedCents,
      // targetCents aqui é o GAP restante, não uma meta mensal fixa — gap
      // zero é a reserva completa (`met`), nunca "sem meta configurada"
      // (que é o que targetState leria de um alvo igual a zero).
      state: reserve.gapCents <= 0 ? 'met' : targetState(reserveRealizedCents, reserve.gapCents, isCurrentPeriod),
      assumptions: {
        formula: 'meta = o que falta para completar a reserva; realizado = aportes do período nos ativos marcados como reserva',
        metaDaReservaCents: reserve.targetCents,
        reservaAtualCents: reserve.currentCents,
        multiplo: reserve.multiple,
        origem: 'specs/investments',
      },
    },
    {
      key: 'investment',
      label: 'Investimento',
      targetCents: investmentTargetCents,
      realizedCents: investmentRealizedCents,
      differenceCents: investmentTargetCents - investmentRealizedCents,
      state: targetState(investmentRealizedCents, investmentTargetCents, isCurrentPeriod),
      assumptions: {
        formula: 'meta = soma do aporte mensal das metas de investimento ativas; realizado = compras do período fora da reserva',
        metasAtivas: investmentGoals.length,
        origem: 'specs/investments (investment_goals)',
      },
    },
    {
      key: 'debt',
      label: 'Dívida',
      targetCents: debt.scheduledCents,
      realizedCents: debtRealizedCents,
      differenceCents: debt.scheduledCents - debtRealizedCents,
      state: targetState(debtRealizedCents, debt.scheduledCents, isCurrentPeriod),
      assumptions: {
        formula: 'meta = parcelas programadas do mês; realizado = pagamentos registrados no período',
        dividasAtivas: debt.debts.length,
        parcelaMinimaTotalCents: debt.minimumCents,
        origem: 'specs/debt (debt_payments)',
      },
    },
    {
      key: 'free',
      label: 'Livre',
      targetCents: null,
      realizedCents: 0,
      differenceCents: null,
      state: 'no_target',
      assumptions: {
        formula: 'o que resta depois de compromissos, limite de cartão comprometido e metas; por definição não tem meta configurada',
        valorDisponivelCents: availableCents,
        origem: 'este cálculo',
      },
    },
  ]

  // Neutral, stable order. Never by amount, never by "urgency": see the
  // note at the top of this file.
  const destinations = [...unorderedDestinations].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))

  return {
    period,
    availableCents,
    terms: {
      consolidatedBalanceCents,
      futureCommitmentsCents,
      provisionedCardBillCents,
      alreadyAllocatedCents,
    },
    destinations,
    assumptions: {
      formula:
        'saldo consolidado, menos compromissos futuros confirmados, menos limite de cartão comprometido, menos o valor já destinado a metas no período',
      periodo: period,
      intervalo: { from: start, to: end },
      saldoConsolidadoCents: consolidatedBalanceCents,
      contasSomadas: balances.length,
      compromissosFuturosCents: futureCommitmentsCents,
      compromissosFuturosCount: pending.length,
      compromissosFuturosOrigem: 'specs/cash-flow-reconciliation (transactions pendentes)',
      limiteCartaoComprometidoCents: provisionedCardBillCents,
      limiteCartaoOrigem: 'soma do limite usado de todos os cartões ativos; inclui parcelamento em andamento e saldo revolvente, não separável do que vence neste ciclo sem o gasto por lançamento de cartão, que este app não rastreia separado da conta vinculada',
      jaDestinadoAMetasCents: alreadyAllocatedCents,
      jaDestinadoDetalhe: {
        reservaCents: reserveRealizedCents,
        investimentoCents: investmentRealizedCents,
        dividaCents: debtRealizedCents,
      },
      ordemDosDestinos: 'alfabética por rótulo, deliberadamente neutra: a ordem não é calculada a partir dos valores',
      ...(balanceDeltaCents !== 0
        ? {
            ajusteHipoteticoSaldoCents: balanceDeltaCents,
            notaDeSimulacao:
              'este saldo inclui um ajuste hipotético pedido pelo simulador, não o estado real do ledger',
          }
        : {}),
    },
  }
}

/**
 * Recordes observacionais do motor financeiro — estudo de viabilidade #5,
 * 29/08/2026. Nenhuma tabela nova: "maior disponível" reusa
 * `availableForAllocation(period)` sem alterá-la, num loop sequencial
 * (mesmo padrão de `goalHistory`/`healthScoreHistory` — nunca `Promise.all`
 * entre períodos, cada `availableForAllocation` já faz seu próprio fan-out
 * interno). "Dias desde o último saldo negativo" é uma derivação diferente
 * (saldo consolidado dia a dia, não "disponível"): soma corrida do saldo de
 * abertura de todas as contas mais os lançamentos confirmados até cada dia,
 * uma única query com janela SQL, sem precisar materializar uma linha por
 * dia em código.
 */
export type FinancialEngineRecords = {
  highestAvailable: { periodo: string; valorCents: number } | null
  daysSinceNegativeBalance: number | null
  /** null quando o saldo NUNCA ficou negativo no histórico observado */
  lastNegativeOn: string | null
}

export async function financialEngineRecords(months = 24): Promise<FinancialEngineRecords> {
  const currentPeriod = todayIso().slice(0, 7)
  const periods = periodRange(addMonths(currentPeriod, -(months - 1)), currentPeriod)

  let highestAvailable: { periodo: string; valorCents: number } | null = null
  for (const period of periods) {
    const { availableCents } = await availableForAllocation(period)
    if (highestAvailable === null || availableCents > highestAvailable.valorCents) {
      highestAvailable = { periodo: period, valorCents: availableCents }
    }
  }

  const openingTotal = (
    await db.execute<{ total: number }>(sql`select coalesce(sum(opening_balance_cents), 0) as total from accounts where archived = false`)
  )[0]?.total ?? 0

  const rows = await db.execute<{ day: string; runningCents: number }>(sql`
    select
      day,
      ${openingTotal} + sum(daily_delta) over (order by day) as "runningCents"
    from (
      select posted_on as day, sum(amount_cents) as daily_delta
      from transactions
      where pending = false
      group by posted_on
    ) x
    order by day
  `)

  let lastNegativeOn: string | null = null
  for (const row of rows) {
    if (row.runningCents < 0) lastNegativeOn = row.day
  }

  const daysSinceNegativeBalance =
    lastNegativeOn === null
      ? null
      : Math.round((Date.parse(todayIso()) - Date.parse(lastNegativeOn)) / 86_400_000)

  return { highestAvailable, daysSinceNegativeBalance, lastNegativeOn }
}

/* ------------------------------------------------------------------ *
 * Ponto de equilíbrio de faturamento
 * ------------------------------------------------------------------ */
export type BreakEvenLine = {
  key: string
  label: string
  amountCents: number
  assumptions: Assumptions
}

export type BreakEven = {
  period: string
  /** null when the parameters make the equilibrium unreachable (tax at or above 100% of revenue) */
  breakEvenCents: number | null
  lines: BreakEvenLine[]
  billedCents: number
  differenceCents: number | null
  assumptions: Assumptions
}

/**
 * Pró-labore derived from the ledger rather than typed in: the paired PJ to
 * PF transfer for the period, the same pairing `specs/dre` reconciles the
 * two columns with (services/transfers.ts). An explicit value in the params
 * overrides it, and `assumptions.origem` always says which of the two the
 * number came from.
 */
async function proLaboreFor(
  period: string,
  params: BreakEvenParams,
  origin: ParamOrigin,
): Promise<{ cents: number; origin: string }> {
  if (params.proLaboreCents !== null) {
    return {
      cents: params.proLaboreCents,
      origin: origin === 'requisição' ? 'informado na requisição' : 'valor salvo pelo usuário, sobrepondo o derivado',
    }
  }
  if (params.pjAccountId === null || params.pfAccountId === null) {
    return { cents: 0, origin: 'não derivável: contas PJ e PF não informadas' }
  }
  const { start, end } = periodBounds(period)
  const flows = await accountFlows({ from: start, to: end })
  const cents = flows.edges
    .filter((e) => e.fromAccountId === params.pjAccountId && e.toAccountId === params.pfAccountId)
    .reduce((sum, e) => sum + e.amountCents, 0)
  return { cents, origin: 'derivado do repasse pareado PJ para PF no período (specs/dre)' }
}

/**
 * The revenue at which everything already configured is covered.
 *
 * Tax is a share of revenue, which makes this an equation rather than a sum:
 * revenue = fixed + taxRate × revenue, so revenue = fixed ÷ (1 − taxRate).
 * Adding the tax on top of the fixed costs instead would understate the
 * target, because the tax owed grows with the revenue that pays it.
 */
/**
 * `includeGoals: false` responde a outra pergunta: quanto precisa entrar
 * para cobrir só o custo de existir (custos PJ, pró-labore, impostos),
 * sem as metas que o usuário escolheu perseguir.
 *
 * A linha de investimento planejado é REMOVIDA, não zerada. Uma linha de
 * R$ 0,00 na composição diria "a meta foi considerada e vale zero", quando
 * o que aconteceu foi o contrário: ela não entrou nesta conta. Ver
 * `specs/motor-financeiro`, "Ponto de equilíbrio mínimo e com metas".
 */
export async function breakEven(
  period: string,
  overrides: Partial<BreakEvenParams> = {},
  options: { includeGoals?: boolean } = {},
): Promise<BreakEven> {
  const includeGoals = options.includeGoals ?? true
  const { params, origins } = await resolveParams(
    includeGoals ? overrides : { ...overrides, reservePlannedCents: 0 },
  )
  const { start, end } = periodBounds(period)

  const [pjTotals, investmentGoals, reserve] = await Promise.all([
    totals({ from: start, to: end, accountId: params.pjAccountId }),
    listGoals(),
    reserveStatus(),
  ])
  const proLabore = await proLaboreFor(period, params, origins.proLaboreCents)
  const plannedInvestmentCents = investmentGoals.reduce((sum, g) => sum + g.monthlyContributionCents, 0)

  const lines: BreakEvenLine[] = [
    {
      key: 'pj_costs',
      label: 'Custos PJ',
      amountCents: pjTotals.expenseCents,
      assumptions: {
        formula: 'despesa realizada no período na conta PJ',
        contaPJ: params.pjAccountId,
        escopo: params.pjAccountId === null ? 'ledger inteiro, nenhuma conta PJ informada' : 'apenas a conta PJ informada',
        origem: 'specs/dre',
      },
    },
    {
      key: 'pro_labore',
      label: 'Pró-labore',
      amountCents: proLabore.cents,
      assumptions: { formula: 'repasse PJ para PF do período', origem: proLabore.origin },
    },
    {
      key: 'planned_investment',
      label: 'Investimento planejado',
      amountCents: plannedInvestmentCents,
      assumptions: {
        formula: 'soma do aporte mensal das metas de investimento ativas',
        metasAtivas: investmentGoals.length,
        origem: 'specs/investments (investment_goals)',
      },
    },
    {
      key: 'planned_reserve',
      label: 'Reserva planejada',
      amountCents: params.reservePlannedCents,
      // The gap travels alongside without being forced into the month: how
      // much of it to close, and when, is the user's call, not a number this
      // service gets to assume (decisions/0010).
      assumptions: {
        formula: 'valor que o usuário planeja destinar à reserva neste mês',
        gapDaReservaCents: reserve.gapCents,
        metaDaReservaCents: reserve.targetCents,
        configurado: origins.reservePlannedCents !== 'default',
        origem: origins.reservePlannedCents,
        nota: 'o gap da reserva aparece como referência, nunca como valor assumido para o mês',
      },
    },
    {
      key: 'margin',
      label: 'Margem',
      amountCents: params.marginCents,
      assumptions: {
        formula: 'margem definida pelo usuário sobre o total',
        configurado: origins.marginCents !== 'default',
        origem: origins.marginCents,
      },
    },
  ]

  // Removida, nunca zerada: ver a nota na assinatura desta função.
  const composedLines = includeGoals ? lines : lines.filter((l) => l.key !== 'planned_investment')

  const fixedCents = composedLines.reduce((sum, l) => sum + l.amountCents, 0)
  const taxRate = params.taxRateBps / 10_000
  const reachable = taxRate < 1
  const breakEvenCents = reachable ? Math.round(fixedCents / (1 - taxRate)) : null
  const taxCents = breakEvenCents === null ? 0 : breakEvenCents - fixedCents

  // The tax line is appended after the equation because its value depends on
  // the result, but it is still a line of the composition, not a footnote.
  composedLines.push({
    key: 'taxes',
    label: 'Impostos estimados',
    amountCents: taxCents,
    assumptions: {
      formula: 'alíquota configurada aplicada sobre o próprio faturamento de equilíbrio',
      aliquotaBps: params.taxRateBps,
      configurado: origins.taxRateBps !== 'default',
      origem: origins.taxRateBps,
    },
  })

  const billedCents = pjTotals.incomeCents

  return {
    period,
    breakEvenCents,
    lines: composedLines,
    billedCents,
    differenceCents: breakEvenCents === null ? null : billedCents - breakEvenCents,
    assumptions: {
      formula:
        'faturamento de equilíbrio = (custos PJ + pró-labore + investimento planejado + reserva planejada + margem) ÷ (1 menos a alíquota), porque o imposto incide sobre o próprio faturamento',
      periodo: period,
      intervalo: { from: start, to: end },
      somaDosCustosFixosCents: fixedCents,
      aliquotaBps: params.taxRateBps,
      faturadoNoPeriodoCents: billedCents,
      parametrosUsados: params,
      // Which layer decided each parameter: o default exportado, o valor
      // salvo pelo usuário, ou um override desta requisição.
      origemDosParametros: origins,
      ...(reachable
        ? {}
        : { semDado: 'alíquota igual ou maior que 100% do faturamento: não existe ponto de equilíbrio' }),
    },
  }
}
