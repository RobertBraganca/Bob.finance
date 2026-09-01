import { addMonths, periodOf, todayIso } from '../core/dates'
import * as engine from './financialEngine'
import * as health from './financialHealth'
import { listDebts, projectPaydown } from './debt'
import { ILLIQUID_ASSET_CLASS, compoundStep, portfolioSummary } from './investments'
import type { Assumptions } from './financialHealth'

/**
 * Simulador de decisões: "e se eu fizesse X?".
 *
 * Duas regras de `decisions/0016` governam este arquivo inteiro:
 *
 *   1. REUSA, NUNCA DUPLICA. Todo número aqui sai da mesma função que serve
 *      a tela real (`gatherScoreInputs`/`composeScoreFromInputs`,
 *      `runway`, `availableForAllocation`, `projectPaydown`), chamada com um
 *      insumo hipoteticamente ajustado. Não existe uma segunda fórmula de
 *      Health Score nem de Runway neste arquivo, e é de propósito: uma
 *      segunda implementação divergiria da real no primeiro ajuste.
 *   2. NUNCA ESCREVE. Nenhuma função deste módulo faz INSERT, UPDATE ou
 *      DELETE em tabela nenhuma. É leitura mais aritmética sobre o
 *      resultado, e o módulo 14 de `scripts/verify.ts` confere isso contando
 *      linhas antes e depois, em vez de confiar na intenção.
 *
 * E uma de `decisions/0010`: tudo aqui é Simulação. O resultado mostra a
 * consequência calculada ("cairia de 78 para 71") e nunca opina sobre ela.
 */

export class SimulatorError extends Error {}

/** De onde o dinheiro hipotético sai. Sem isso não há simulação possível. */
export type MoneySource = 'balance' | 'reserve' | 'investment'

export const SOURCE_LABELS: Record<MoneySource, string> = {
  balance: 'Saldo em conta',
  reserve: 'Reserva de emergência',
  investment: 'Investimentos',
}

export type SimulatedMetric<T> = { before: T; after: T; delta: T }

export type SimulationResult = {
  /** 0 a 10.000 bps, ou null quando não há indicador com dado */
  healthScoreBps: SimulatedMetric<number | null>
  /** meses, ou null sem base de cálculo */
  runwayMonths: SimulatedMetric<number | null>
  availableCents: SimulatedMetric<number>
  assumptions: Assumptions
}

const subtract = (before: number | null, after: number | null): number | null =>
  before === null || after === null ? null : after - before

/**
 * Aplica a saída de dinheiro nos insumos certos conforme a origem.
 *
 * Cada origem toca um conjunto diferente de números, e nenhuma toca todos:
 *
 *   balance     saldo em conta -> liquidez do score, runway e disponível
 *   reserve     reserva acumulada -> indicador de reserva e runway
 *   investment  investimentos líquidos -> só runway
 *
 * `investment` não mexer no Health Score não é esquecimento: nenhum dos
 * cinco indicadores lê o valor total da carteira (a alocação lê o DESVIO
 * entre classes, que uma retirada proporcional não move). Sair dinheiro de
 * investimento muda o runway e o disponível, não o score.
 */
function applyOutflow(
  inputs: health.ScoreInputs,
  source: MoneySource,
  amountCents: number,
): { inputs: health.ScoreInputs; runwayOverrides: health.RunwayOverrides; availableDeltaCents: number } {
  const adjusted: health.ScoreInputs = {
    ...inputs,
    liquidity: { ...inputs.liquidity },
    reserve: { ...inputs.reserve },
  }

  switch (source) {
    case 'balance':
      adjusted.liquidity.availableBalanceCents -= amountCents
      return {
        inputs: adjusted,
        runwayOverrides: { balanceDeltaCents: -amountCents },
        availableDeltaCents: -amountCents,
      }
    case 'reserve':
      adjusted.reserve.currentCents -= amountCents
      // A reserva é feita de ativos, então sai do lado de investimentos do
      // runway, não do saldo em conta.
      return {
        inputs: adjusted,
        runwayOverrides: { investmentsDeltaCents: -amountCents },
        availableDeltaCents: 0,
      }
    case 'investment':
      return {
        inputs: adjusted,
        runwayOverrides: { investmentsDeltaCents: -amountCents },
        availableDeltaCents: 0,
      }
  }
}

function scoreOf(inputs: health.ScoreInputs): number | null {
  return health.composeScoreFromInputs(inputs).scoreBps
}

/* ------------------------------------------------------------------ *
 * Gasto único
 * ------------------------------------------------------------------ */
export type OneTimeExpenseInput = {
  amountCents: number
  source: MoneySource
  accountId?: number | null
  period?: string
}

export async function simulateOneTimeExpense(input: OneTimeExpenseInput): Promise<SimulationResult> {
  const period = input.period ?? periodOf(todayIso())
  const accountId = input.accountId ?? null

  const baseInputs = await health.gatherScoreInputs(period, accountId)
  const { inputs: afterInputs, runwayOverrides, availableDeltaCents } = applyOutflow(
    baseInputs,
    input.source,
    input.amountCents,
  )

  const [runwayBeforeScope, runwayAfterScope, availableBefore, availableAfter] = await Promise.all([
    health.runway(),
    health.runway(health.DEFAULT_LIQUID_ASSET_CLASSES, runwayOverrides),
    engine.availableForAllocation(period),
    engine.availableForAllocation(period, { consolidatedBalanceDeltaCents: availableDeltaCents }),
  ])
  const runwayBefore = runwayBeforeScope.consolidated
  const runwayAfter = runwayAfterScope.consolidated

  const scoreBefore = scoreOf(baseInputs)
  const scoreAfter = scoreOf(afterInputs)

  return {
    healthScoreBps: { before: scoreBefore, after: scoreAfter, delta: subtract(scoreBefore, scoreAfter) },
    runwayMonths: {
      before: runwayBefore.months,
      after: runwayAfter.months,
      delta: subtract(runwayBefore.months, runwayAfter.months),
    },
    availableCents: {
      before: availableBefore.availableCents,
      after: availableAfter.availableCents,
      delta: availableAfter.availableCents - availableBefore.availableCents,
    },
    assumptions: {
      formula:
        'os mesmos cálculos de Health Score, Runway e disponível para alocação, rodados uma segunda vez com o insumo da origem escolhida reduzido pelo valor hipotético',
      tipo: 'gasto único hipotético',
      valorCents: input.amountCents,
      origem: SOURCE_LABELS[input.source],
      periodo: period,
      insumoAjustado:
        input.source === 'balance'
          ? 'saldo em conta (liquidez do score, runway e disponível)'
          : input.source === 'reserve'
            ? 'reserva acumulada (indicador de reserva e runway)'
            : 'investimentos líquidos (apenas runway)',
      healthScoreAfetado: scoreBefore !== scoreAfter,
      notaDeEscopo:
        input.source === 'investment'
          ? 'nenhum dos cinco indicadores do Health Score lê o valor total da carteira, então esta origem move runway e não move o score'
          : undefined,
      naoPersiste: 'esta simulação não grava nada em nenhuma tabela',
      origemDosCalculos:
        'services/financialHealth (score e runway) e services/financialEngine (disponível), as mesmas funções das telas reais',
    },
  }
}

/* ------------------------------------------------------------------ *
 * Quitação de dívida
 * ------------------------------------------------------------------ */
export type DebtPayoffInput = {
  debtId: number
  source: MoneySource
  period?: string
}

export type DebtPayoffResult = SimulationResult & {
  debtName: string
  payoffCents: number
  /** juro que essa dívida ainda pagaria no ritmo atual, e que a quitação evita */
  savedInterestCents: number
}

export async function simulateDebtPayoff(input: DebtPayoffInput): Promise<DebtPayoffResult> {
  const period = input.period ?? periodOf(todayIso())

  const debt = (await listDebts()).find((d) => d.id === input.debtId)
  if (!debt) throw new SimulatorError(`dívida ${input.debtId} não encontrada`)
  if (debt.balanceCents <= 0) {
    throw new SimulatorError(`a dívida "${debt.name}" já está quitada, não há economia de juros para calcular`)
  }

  /*
   * O juro economizado NÃO é recalculado aqui. `projectPaydown` já simula
   * mês a mês, no ritmo atual, e devolve por dívida quanto de juro cada uma
   * ainda vai pagar até o fim: quitar hoje é exatamente não pagar isso.
   */
  const baseline = await projectPaydown({ extraMonthlyCents: 0, label: 'Pagamento atual' })
  const savedInterestCents = baseline.perDebt.find((d) => d.debtId === input.debtId)?.interestCents ?? 0

  const payoffCents = debt.balanceCents
  const baseInputs = await health.gatherScoreInputs(period, null)
  const { inputs: afterOutflow, runwayOverrides, availableDeltaCents } = applyOutflow(
    baseInputs,
    input.source,
    payoffCents,
  )

  /*
   * Quitar também muda o indicador de endividamento: uma dívida a menos e a
   * parcela dela fora do comprometimento de renda. O comprometimento é
   * recalculado com os mesmos termos que `debtOverview` usa (parcelas ÷
   * renda do mês), sem nova fórmula.
   */
  const scheduledAfterCents = Math.max(0, afterOutflow.debt.scheduledCents - debt.scheduledPaymentCents)
  const monthlyIncomeCents = afterOutflow.debt.monthlyIncomeCents
  const afterInputs: health.ScoreInputs = {
    ...afterOutflow,
    debt: {
      ...afterOutflow.debt,
      debtCount: Math.max(0, afterOutflow.debt.debtCount - 1),
      scheduledCents: scheduledAfterCents,
      debtToIncomeBps:
        monthlyIncomeCents > 0 ? Math.round((scheduledAfterCents / monthlyIncomeCents) * 10_000) : null,
    },
  }

  const [runwayBeforeScope, runwayAfterScope, availableBefore, availableAfter] = await Promise.all([
    health.runway(),
    // A dívida de curto prazo do runway olha parcelas pendentes já
    // materializadas; quitar não as apaga do ledger (nada é gravado), então o
    // efeito modelado aqui é só a saída de dinheiro da origem escolhida.
    health.runway(health.DEFAULT_LIQUID_ASSET_CLASSES, runwayOverrides),
    engine.availableForAllocation(period),
    engine.availableForAllocation(period, { consolidatedBalanceDeltaCents: availableDeltaCents }),
  ])
  const runwayBefore = runwayBeforeScope.consolidated
  const runwayAfter = runwayAfterScope.consolidated

  const scoreBefore = scoreOf(baseInputs)
  const scoreAfter = scoreOf(afterInputs)

  return {
    debtName: debt.name,
    payoffCents,
    savedInterestCents,
    healthScoreBps: { before: scoreBefore, after: scoreAfter, delta: subtract(scoreBefore, scoreAfter) },
    runwayMonths: {
      before: runwayBefore.months,
      after: runwayAfter.months,
      delta: subtract(runwayBefore.months, runwayAfter.months),
    },
    availableCents: {
      before: availableBefore.availableCents,
      after: availableAfter.availableCents,
      delta: availableAfter.availableCents - availableBefore.availableCents,
    },
    assumptions: {
      formula:
        'quitação total da dívida escolhida: o juro futuro dela sai da projeção que o Endividamento já publica, e o valor quitado sai da origem escolhida, com Health Score, Runway e disponível recalculados pelas mesmas funções das telas reais',
      tipo: 'quitação de dívida hipotética',
      dividaId: input.debtId,
      dividaNome: debt.name,
      saldoQuitadoCents: payoffCents,
      parcelaMensalCents: debt.scheduledPaymentCents,
      juroFuturoEconomizadoCents: savedInterestCents,
      juroOrigem: 'services/debt, projectPaydown no cenário de pagamento atual (perDebt.interestCents)',
      origem: SOURCE_LABELS[input.source],
      periodo: period,
      comprometimentoAntesBps: baseInputs.debt.debtToIncomeBps,
      comprometimentoDepoisBps: afterInputs.debt.debtToIncomeBps,
      notaDeEscopo:
        'as parcelas pendentes já materializadas em transactions continuam existindo, porque a simulação não grava nada; o efeito no runway é o da saída de dinheiro da origem escolhida',
      naoPersiste: 'esta simulação não grava nada em nenhuma tabela',
    },
  }
}

/* ------------------------------------------------------------------ *
 * Decumulação (retirada mensal sobre a carteira de investimentos)
 *
 * Terceiro tipo de hipótese do Simulador, `decisions/0035`: extensão direta
 * do `decisions/0016`, nunca uma segunda fórmula. O sistema NUNCA calcula
 * "quanto você pode retirar" — o usuário propõe um valor de retirada
 * mensal e um retorno esperado, e a resposta é sempre a consequência
 * (esgota em Z, ou não esgota dentro do horizonte simulado). Reusa
 * `compoundStep` (mesmo núcleo de `investments.ts#goalProjection`, fluxo
 * invertido) e o valor atual de `portfolioSummary()` — nenhuma fórmula
 * nova de juros compostos escrita aqui.
 * ------------------------------------------------------------------ */
export type DecumulationPoint = { month: number; period: string; valueCents: number }

export type DecumulationInput = {
  monthlyWithdrawalCents: number
  /** retorno anual esperado, em bps — insumo do usuário, não um cálculo do sistema */
  expectedReturnBps: number
  horizonMonths?: number
}

export type DecumulationResult = {
  series: DecumulationPoint[]
  startingValueCents: number
  monthlyWithdrawalCents: number
  expectedReturnBps: number
  depletionMonth: number | null
  depletionPeriod: string | null
  assumptions: Assumptions
}

const DEFAULT_DECUMULATION_HORIZON_MONTHS = 360

export async function simulateDecumulation(input: DecumulationInput): Promise<DecumulationResult> {
  const horizonMonths = Math.min(Math.max(input.horizonMonths ?? DEFAULT_DECUMULATION_HORIZON_MONTHS, 1), 1200)
  const summary = await portfolioSummary()
  const monthlyReturn = Math.pow(1 + input.expectedReturnBps / 10_000, 1 / 12) - 1
  const startPeriod = periodOf(todayIso())

  /**
   * Só a carteira NEGOCIÁVEL sustenta uma retirada mensal — o imobilizado
   * entra no patrimônio (`financialHealth.netWorth`) mas ninguém saca R$X
   * por mês de um imóvel sem vendê-lo, e vender não é algo que este produto
   * simule (`decisions/0011`). Incluí-lo aqui inflaria a base e faria a
   * simulação dizer que o dinheiro dura muito mais do que duraria.
   */
  const startingValueCents = summary.positions
    .filter((p) => p.assetClass !== ILLIQUID_ASSET_CLASS)
    .reduce((sum, p) => sum + p.marketValueCents, 0)

  const series: DecumulationPoint[] = [{ month: 0, period: startPeriod, valueCents: startingValueCents }]
  let value = startingValueCents
  let depletionMonth: number | null = null

  for (let month = 1; month <= horizonMonths; month++) {
    value = compoundStep(value, monthlyReturn, -input.monthlyWithdrawalCents)
    if (value <= 0) {
      value = 0
      depletionMonth = month
    }
    series.push({ month, period: addMonths(startPeriod, month), valueCents: Math.round(value) })
    if (depletionMonth !== null) break
  }

  return {
    series,
    startingValueCents,
    monthlyWithdrawalCents: input.monthlyWithdrawalCents,
    expectedReturnBps: input.expectedReturnBps,
    depletionMonth,
    depletionPeriod: depletionMonth === null ? null : addMonths(startPeriod, depletionMonth),
    assumptions: {
      formula:
        'projeção mês a mês do valor atual da carteira sob uma retirada mensal fixa, reusando o mesmo passo de composição de goalProjection (investments.ts#compoundStep), com o fluxo mensal invertido (retirada em vez de aporte)',
      tipo: 'decumulação hipotética (retirada mensal simulada)',
      valorInicialCents: startingValueCents,
      valorInicialEscopo:
        'apenas a carteira negociável; o imobilizado fica de fora porque não se saca uma retirada mensal de um bem físico',
      retiradaMensalCents: input.monthlyWithdrawalCents,
      retornoEsperadoAnualBps: input.expectedReturnBps,
      horizonteMeses: horizonMonths,
      esgotaEm:
        depletionMonth === null
          ? 'o patrimônio não se esgota dentro do horizonte simulado, nas premissas configuradas'
          : `mês ${depletionMonth} (${addMonths(startPeriod, depletionMonth)})`,
      naoPersiste: 'esta simulação não grava nada em nenhuma tabela',
      origemDosCalculos:
        'services/investments (valor atual da carteira e núcleo de composição), mesma função usada por goalProjection',
    },
  }
}
