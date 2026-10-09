import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { accounts, debtPayments, debtRenegotiations, debtSnapshots, debts, skippedOccurrences, transactions } from '../db/schema'
import { addMonths, daysInMonth, periodBounds, todayIso } from '../core/dates'
import { medianCents, monthlyRateOf } from '../core/money'
import { dedupeHash, directionOf, normalizeDescription } from '../core/normalize'
import { balanceAfter, installmentsCents, type AmortizationSystem, type AmortizedContract } from '../core/propertyPlan'
import {
  agreementTerms,
  debtPlan,
  estimatedInterestCents,
  exitCalendar,
  impliedAnnualBps,
  scheduledInterestCents,
  type CalendarSource,
  type DebtPlanInput,
} from '../core/debtPlan'
import { monthlyTotals, totals } from './analytics'
import { typicalPersonalIncome } from './budget'
import { listCards } from './creditCards'

/** Regra do Endividamento violada (taxa que não fecha, acordo inválido): 400/404/409. */
export class DebtError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

/**
 * Debt is modelled as a set of balances with rates, plus an optional history
 * of measured balances. Projections are computed, never stored, so changing a
 * rate or a payment immediately changes every chart.
 */

const MAX_MONTHS = 600 // 50 years — the guard against a never-amortizing loan

type DebtKind = (typeof debts.$inferSelect)['kind']
type DebtPaymentKind = (typeof debtPayments.$inferSelect)['kind']
type DebtRecord = typeof debts.$inferSelect

/**
 * Contrato amortizado (decisions/0041): SAC ou Price com número de parcelas.
 * Cada parcela sai do cronograma e o saldo é o do cronograma depois das
 * parcelas pagas. Qualquer outra dívida segue a regra antiga (parcela fixa,
 * pagamento inteiro abate o saldo).
 */
const isAmortized = (d: Pick<DebtRecord, 'amortization' | 'installmentCount'>) => d.amortization !== null && d.installmentCount !== null
const contractOf = (d: Pick<DebtRecord, 'principalCents' | 'aprBps' | 'installmentCount' | 'amortization' | 'monthlyFeesCents'>): AmortizedContract => ({
  principalCents: d.principalCents,
  aprBps: d.aprBps,
  installmentCount: d.installmentCount,
  amortization: d.amortization,
  monthlyFeesCents: d.monthlyFeesCents,
})
/** Parcela de um contrato amortizado a pagar depois de `paid` parcelas (0 se acabou). */
const nextInstallment = (d: DebtRecord, paid: number) => installmentsCents(contractOf(d))[paid] ?? 0
/** Quantos meses do período âncora até `period` (a parcela k desse período). */
const monthIndex = (anchor: string, period: string) => {
  const [ay, am] = anchor.split('-').map(Number) as [number, number]
  const [py, pm] = period.split('-').map(Number) as [number, number]
  return (py - ay) * 12 + (pm - am)
}

export type DebtRow = {
  id: number
  name: string
  kind: string
  institution: string | null
  accountId: number | null
  accountName: string | null
  balanceCents: number
  aprBps: number
  minimumPaymentCents: number
  scheduledPaymentCents: number
  dueDay: number
  /** interest accruing this month at the current balance */
  monthlyInterestCents: number
  /**
   * Taxa mensal equivalente à taxa efetiva anual gravada. Exposta porque é
   * o número que o usuário reconhece de cabeça: uma dívida de cartão que
   * aparece com 3% ao mês está com a taxa anual errada, e ver a mensal ao
   * lado da anual é o que torna esse erro visível sem precisar de conta.
   */
  monthlyRateBps: number
  shareBps: number
  /** total parcelas in the contract — null for revolving debt that has none */
  installmentCount: number | null
  /** parcelas already logged in `debt_payments` (kind = 'payment') */
  installmentsPaid: number
  /** installmentCount - installmentsPaid — null whenever installmentCount is null */
  installmentsRemaining: number | null
  lastPaymentOn: string | null
  /** sistema do contrato amortizado; nulo na dívida de parcela fixa */
  amortization: AmortizationSystem | null
  /** seguros e taxas somados a cada parcela de um contrato amortizado */
  monthlyFeesCents: number
  /** principal do contrato (base do cronograma de um contrato amortizado) */
  principalCents: number
  /** TAG padrão das parcelas (specs/debt-v2) */
  categoryId: number | null
  /** mês da parcela 0 (YYYY-MM-DD) */
  openedOn: string | null
  /** paga dentro da fatura deste cartão (specs/personal-picture) */
  paidViaCardId: number | null
}

/** Latest measured balance if there is one, otherwise the opening principal. */
export async function currentBalance(debt: typeof debts.$inferSelect): Promise<number> {
  const snapshot = (
    await db
      .select()
      .from(debtSnapshots)
      .where(eq(debtSnapshots.debtId, debt.id))
      .orderBy(desc(debtSnapshots.asOf))
      .limit(1)
  )[0]
  return snapshot?.balanceCents ?? debt.principalCents
}

/** Parcelas pagas + the most recent payment date, from the payment ledger. */
export async function paymentStats(debtId: number): Promise<{ count: number; lastPaidOn: string | null }> {
  const rows = await db.execute<{ count: number; lastPaidOn: string | null }>(sql`
    select count(*) as count, max(paid_on) as "lastPaidOn"
    from debt_payments
    where debt_id = ${debtId} and kind = 'payment'
  `)
  const row = rows[0]
  return { count: row?.count ?? 0, lastPaidOn: row?.lastPaidOn ?? null }
}

export async function listDebts(): Promise<DebtRow[]> {
  const rows = await db
    .select({ debt: debts, accountName: accounts.name })
    .from(debts)
    .leftJoin(accounts, eq(accounts.id, debts.accountId))
    .where(eq(debts.active, true))
  const withBalance = await Promise.all(
    rows.map(async ({ debt: d, accountName }) => {
      const balanceCents = await currentBalance(d)
      const { count: installmentsPaid, lastPaidOn } = await paymentStats(d.id)
      return {
        id: d.id,
        name: d.name,
        kind: d.kind,
        institution: d.institution,
        accountId: d.accountId,
        accountName: accountName ?? null,
        balanceCents,
        aprBps: d.aprBps,
        minimumPaymentCents: d.minimumPaymentCents,
        // Contrato amortizado: a parcela da vez (no SAC ela cai todo mês).
        scheduledPaymentCents: isAmortized(d) ? nextInstallment(d, installmentsPaid) : d.scheduledPaymentCents || d.minimumPaymentCents,
        dueDay: d.dueDay,
        monthlyInterestCents: Math.round(balanceCents * monthlyRate(d.aprBps)),
        monthlyRateBps: Math.round(monthlyRate(d.aprBps) * 10_000),
        shareBps: 0,
        installmentCount: d.installmentCount,
        installmentsPaid,
        installmentsRemaining: d.installmentCount === null ? null : Math.max(0, d.installmentCount - installmentsPaid),
        lastPaymentOn: lastPaidOn,
        amortization: d.amortization,
        monthlyFeesCents: d.monthlyFeesCents,
        principalCents: d.principalCents,
        categoryId: d.categoryId,
        openedOn: d.openedOn,
        paidViaCardId: d.paidViaCardId,
      }
    }),
  )
  const total = withBalance.reduce((sum, d) => sum + d.balanceCents, 0)
  return withBalance
    .map((d) => ({ ...d, shareBps: total > 0 ? Math.round((d.balanceCents / total) * 10_000) : 0 }))
    .sort((a, b) => b.balanceCents - a.balanceCents)
}

/**
 * Mesmo formato de `DebtRow` (para reaproveitar `DebtModal`/`DebtPaymentModal`/
 * `DebtPaymentHistoryModal` sem nenhuma variante nova), mais os dois campos
 * que só uma dívida quitada tem.
 */
export type ClosedDebtRow = DebtRow & {
  closedOn: string | null
  totalPaidCents: number
  /** quitada, renegociada ou encerrada à mão; nulo nas encerradas antes de 10/2026 */
  closedReason: 'paid' | 'renegotiated' | 'manual' | null
}

/**
 * Dividas com active=false — a secao "Quitadas" que closeDebtIfFullyPaid
 * agora alimenta (e que o fechamento manual via deletePending scope='all'
 * ja alimentava, sem nenhum lugar na UI para mostra-lo). Antes desta
 * correcao (bug 2, 03/09/2026) nao havia nenhuma leitura de active=false
 * em lugar nenhum do app — uma divida fechada simplesmente desaparecia,
 * sem virar historico visivel em canto nenhum.
 *
 * Devolve o mesmo formato de `listDebts()` (ver `ClosedDebtRow`) — bug
 * corrigido em 07/09/2026: a "Quitadas" nao tinha nenhuma acao (editar,
 * ver historico, excluir) porque o formato estreito de antes nao dava pros
 * mesmos modais da tabela ativa, so usados aqui com `DebtRow` completo.
 */
export async function listClosedDebts(): Promise<ClosedDebtRow[]> {
  const rows = await db
    .select({ debt: debts, accountName: accounts.name })
    .from(debts)
    .leftJoin(accounts, eq(accounts.id, debts.accountId))
    .where(eq(debts.active, false))
  return Promise.all(
    rows.map(async ({ debt: d, accountName }) => {
      const balanceCents = await currentBalance(d)
      const { count: installmentsPaid, lastPaidOn } = await paymentStats(d.id)
      const stats = await db.execute<{ total: number }>(sql`
        select coalesce(sum(amount_cents), 0) as total
        from debt_payments where debt_id = ${d.id} and kind = 'payment'`)
      return {
        id: d.id,
        name: d.name,
        kind: d.kind,
        institution: d.institution,
        accountId: d.accountId,
        accountName: accountName ?? null,
        balanceCents,
        aprBps: d.aprBps,
        minimumPaymentCents: d.minimumPaymentCents,
        // Contrato amortizado: a parcela da vez (no SAC ela cai todo mês).
        scheduledPaymentCents: isAmortized(d) ? nextInstallment(d, installmentsPaid) : d.scheduledPaymentCents || d.minimumPaymentCents,
        dueDay: d.dueDay,
        monthlyInterestCents: Math.round(balanceCents * monthlyRate(d.aprBps)),
        monthlyRateBps: Math.round(monthlyRate(d.aprBps) * 10_000),
        shareBps: 0,
        installmentCount: d.installmentCount,
        installmentsPaid,
        installmentsRemaining: d.installmentCount === null ? null : Math.max(0, d.installmentCount - installmentsPaid),
        lastPaymentOn: lastPaidOn,
        amortization: d.amortization,
        monthlyFeesCents: d.monthlyFeesCents,
        principalCents: d.principalCents,
        categoryId: d.categoryId,
        openedOn: d.openedOn,
        paidViaCardId: d.paidViaCardId,
        closedOn: d.closedOn,
        totalPaidCents: stats[0]?.total ?? 0,
        closedReason: d.closedReason,
      }
    }),
  )
}

/**
 * Materializes the debt's remaining parcelas as pending EXPENSE rows in
 * `transactions` — same mechanism cashFlow.ts uses for recurring/
 * installment income, so a debt's upcoming payments show up in
 * "Despesas pendentes" and in Lançamentos (editable, with a "previsto"
 * badge) without a separate UI. A revolving debt (no installmentCount —
 * cartão, cheque especial) materializes indefinitely within the same
 * horizon, mirroring a "recorrente" forecast; an installment debt only
 * generates periods `installmentsPaid..installmentCount-1` — exactly
 * cashFlow.ts's own `pendingOccurrences` shape for its 'installment'
 * kind, just counting from the debt_payments ledger instead of a
 * `installmentsRealized` column.
 */
// decisions/0028 raised this to 24 for cashFlow.ts's forecasts; this file
// was left at the old value (achado da revisão de 29/08/2026) — a debt
// installment/revolving charge should have the same rolling window as a
// recurring forecast, not a shorter one just because nobody updated it here.
const MATERIALIZE_HORIZON_MONTHS = 24

export async function materializeDebtInstallments(debtId: number): Promise<{ created: number }> {
  const debt = (await db.select().from(debts).where(eq(debts.id, debtId)))[0]
  // Paga na fatura do cartão: o dinheiro sai pela fatura, não por esta conta (specs/personal-picture).
  if (!debt || !debt.accountId || !debt.active || debt.paidViaCardId) return { created: 0 }

  const fixedAmountCents = debt.scheduledPaymentCents || debt.minimumPaymentCents
  // Contrato amortizado: cada parcela tem o valor do cronograma.
  const scheduleAmounts = isAmortized(debt) ? installmentsCents(contractOf(debt)) : null
  if (!scheduleAmounts && fixedAmountCents <= 0) return { created: 0 }

  const { count: installmentsPaid } = await paymentStats(debtId)
  const currentPeriod = todayIso().slice(0, 7)
  const horizon = addMonths(currentPeriod, MATERIALIZE_HORIZON_MONTHS - 1)

  const existingRows = await db
    .select({ occurrencePeriod: transactions.occurrencePeriod, postedOn: transactions.postedOn })
    .from(transactions)
    .where(eq(transactions.debtId, debtId))
  const existingPeriods = new Set(existingRows.map((r) => r.occurrencePeriod ?? r.postedOn.slice(0, 7)))

  /**
   * Ancora da parcela 0, NAO "hoje" -- bug corrigido em 03/09/2026
   * (achado: toda divida parcelada ativa e nao paga tinha uma pendencia a
   * mais do que installmentCount, sempre no mes corrente).
   *
   * Antes, o laco abaixo recomputava o periodo de cada parcela como
   * addMonths(currentPeriod, i - installmentsPaid) -- ou seja, a parcela
   * "proxima a pagar" era sempre remapeada para o MES EM QUE A FUNCAO
   * RODA. Como materializeAllDebts() roda a cada carregamento do widget
   * de pendentes da Home (GET /cash-flow/pending), uma divida com 1
   * parcela criada em agosto e ainda nao paga ganhava uma SEGUNDA
   * pendencia em setembro na primeira visita a Home depois da virada do
   * mes -- sem nenhuma acao do usuario, e sem que a de agosto (ainda
   * pendente, agora isOverdue) fosse removida. Uma divida de N parcelas
   * acumulava uma pendencia extra a cada mes que passasse sem pagamento.
   *
   * A ancora certa e o periodo em que a parcela 0 ja foi (ou seria)
   * materializada, que e FIXO por contrato -- nunca muda com o relogio.
   * Prioridade: `debt.openedOn` (gravado no cadastro, nunca recomputado
   * -- ver o comentario da coluna em schema.ts) e so cai para o menor
   * periodo entre as linhas existentes numa divida antiga, de antes desta
   * coluna passar a ser preenchida de verdade (achado de 07/09/2026:
   * ancorar nas linhas existentes tinha o MESMO bug de "recomputa a cada
   * chamada" que este comentario descreve acima, só que disparado por
   * `deletePending` apagar a parcela mais antiga em vez do relógio --
   * apagar deslocava a âncora pra frente e fabricava uma parcela extra no
   * fim do horizonte). So cai de volta em currentPeriod quando nao existe
   * nem `openedOn` nem nenhuma linha ainda.
   */
  const anchorPeriod =
    debt.openedOn?.slice(0, 7) ??
    existingRows.reduce<string | null>((min, r) => {
      const period = r.occurrencePeriod ?? r.postedOn.slice(0, 7)
      return min === null || period < min ? period : min
    }, null) ??
    currentPeriod

  // Same rationale as cashFlow.ts's materialize(): a period the user
  // explicitly deleted from a pending widget must stay gone, not come
  // back on the next load.
  const skippedPeriods = new Set(
    (
      await db.select({ period: skippedOccurrences.period }).from(skippedOccurrences).where(eq(skippedOccurrences.debtId, debtId))
    ).map((r) => r.period),
  )

  const periods: Array<{ period: string; amountCents: number }> = []
  if (debt.installmentCount === null) {
    // Revolving (cartão, cheque especial): one occurrence per month,
    // indefinitely, same as a "recorrente" cash-flow forecast — except when
    // `endPeriod` is set (decisions/0020, a "esta e as futuras" delete on a
    // revolving debt bounds it the same way a recurring forecast's
    // endPeriod does; a revolving debt has no natural end otherwise).
    for (let i = 0; i < MATERIALIZE_HORIZON_MONTHS; i++) {
      const period = addMonths(currentPeriod, i)
      if (!debt.endPeriod || period <= debt.endPeriod) periods.push({ period, amountCents: fixedAmountCents })
    }
  } else {
    for (let i = installmentsPaid; i < debt.installmentCount; i++) {
      const period = addMonths(anchorPeriod, i)
      const amountCents = scheduleAmounts ? (scheduleAmounts[i] ?? 0) : fixedAmountCents
      if (period <= horizon && amountCents > 0) periods.push({ period, amountCents })
    }
  }

  let created = 0
  for (const { period, amountCents } of periods) {
    if (existingPeriods.has(period) || skippedPeriods.has(period)) continue
    const [year, month] = period.split('-').map(Number) as [number, number]
    const day = Math.min(debt.dueDay, daysInMonth(year, month))
    const postedOn = `${period}-${String(day).padStart(2, '0')}`
    const description = debt.name
    const descriptionNorm = normalizeDescription(description)
    // onConflictDoNothing is the authoritative guard against the race two
    // concurrent materialization calls for the same debt can hit (both see
    // "period missing" before either INSERT commits) — `existingPeriods`
    // above is just a cheap pre-filter, not the real guarantee.
    const inserted = await db
      .insert(transactions)
      .values({
        accountId: debt.accountId,
        postedOn,
        description,
        descriptionNorm,
        amountCents: -Math.abs(amountCents),
        direction: directionOf(-Math.abs(amountCents)),
        source: 'manual',
        // A TAG da dívida (specs/debt-v2) põe a parcela no grupo certo do Orçamento.
        categoryId: debt.categoryId,
        categorizedBy: debt.categoryId ? 'rule' : 'none',
        dedupeHash: dedupeHash({
          accountId: debt.accountId,
          postedOn,
          amountCents: -Math.abs(amountCents),
          descriptionNorm,
        }),
        pending: true,
        debtId: debt.id,
        occurrencePeriod: period,
      })
      .onConflictDoNothing({
        target: [transactions.debtId, transactions.occurrencePeriod],
        where: sql`${transactions.debtId} is not null`,
      })
      .returning({ id: transactions.id })
    if (inserted.length > 0) created++
  }
  return { created }
}

/** Mesmo motivo de `materializeAll` em cashFlow.ts: junta só chamadas simultâneas. */
let materializeAllDebtsInFlight: Promise<{ created: number }> | null = null

export function materializeAllDebts(): Promise<{ created: number }> {
  materializeAllDebtsInFlight ??= runMaterializeAllDebts().finally(() => {
    materializeAllDebtsInFlight = null
  })
  return materializeAllDebtsInFlight
}

async function runMaterializeAllDebts(): Promise<{ created: number }> {
  const rows = await db.select({ id: debts.id }).from(debts).where(eq(debts.active, true))
  let created = 0
  for (const row of rows) created += (await materializeDebtInstallments(row.id)).created
  return { created }
}

/**
 * Same rationale as cashFlow.ts's syncMaterializedRows: editing a debt
 * (new scheduled payment, reassigned account, new due day) otherwise only
 * reached parcelas materialized AFTER the edit — every already-
 * materialized but still-unconfirmed row kept showing the stale numbers,
 * which looked exactly like the edit hadn't saved. Confirmed/settled rows
 * (pending=false) are real history by then and are left alone. A row the
 * user already edited by hand (`manuallyEdited`, see `decisions/0017`) is
 * also left alone — the template stops being authoritative over that one
 * occurrence the moment the user touches it.
 */
async function syncMaterializedRows(debt: typeof debts.$inferSelect): Promise<void> {
  // Paga na fatura do cartão: as pendências na conta saem (specs/personal-picture).
  if (debt.paidViaCardId) {
    await db.delete(transactions).where(and(eq(transactions.debtId, debt.id), eq(transactions.pending, true)))
    return
  }
  if (!debt.accountId) return
  const fixedAmountCents = debt.scheduledPaymentCents || debt.minimumPaymentCents
  const scheduleAmounts = isAmortized(debt) ? installmentsCents(contractOf(debt)) : null
  const anchor = debt.openedOn?.slice(0, 7) ?? null
  if (!scheduleAmounts && fixedAmountCents <= 0) return

  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.debtId, debt.id),
        eq(transactions.pending, true),
        eq(transactions.manuallyEdited, false),
      ),
    )

  const description = debt.name
  const descriptionNorm = normalizeDescription(description)

  for (const row of rows) {
    const period = row.occurrencePeriod ?? row.postedOn.slice(0, 7)
    const [year, month] = period.split('-').map(Number) as [number, number]
    const day = Math.min(debt.dueDay, daysInMonth(year, month))
    const postedOn = `${period}-${String(day).padStart(2, '0')}`
    // Contrato amortizado: o valor da parcela k deste período no cronograma.
    const amountCents = scheduleAmounts && anchor ? (scheduleAmounts[monthIndex(anchor, period)] ?? 0) : fixedAmountCents
    if (amountCents <= 0) continue
    await db
      .update(transactions)
      .set({
        postedOn,
        description,
        descriptionNorm,
        amountCents: -Math.abs(amountCents),
        direction: directionOf(-Math.abs(amountCents)),
        accountId: debt.accountId,
        // Pendência não editada segue a TAG da dívida (specs/debt-v2).
        ...(debt.categoryId ? { categoryId: debt.categoryId, categorizedBy: 'rule' as const } : {}),
        dedupeHash: dedupeHash({
          accountId: debt.accountId,
          postedOn,
          amountCents: -Math.abs(amountCents),
          descriptionNorm,
        }),
      })
      .where(eq(transactions.id, row.id))
  }
}

/**
 * Taxa EFETIVA anual para taxa mensal equivalente: `(1 + ia)^(1/12) - 1`.
 *
 * O adjetivo não é decorativo. Esta conversão só está correta se `aprBps`
 * for uma taxa efetiva anual. Se o valor gravado for uma taxa NOMINAL com
 * capitalização mensal, que é como o crédito ao consumidor brasileiro
 * costuma ser anunciado ("144% ao ano com capitalização mensal" significa
 * 12% ao mês, e portanto 289,6% efetivos ao ano), a fórmula devolve uma
 * taxa muito menor do que a real e a projeção de quitação passa a mentir
 * por anos.
 *
 * Por isso a entrada de dados aceita taxa ao mês e converte na hora
 * (`core/money#effectiveAnnualRateBps`), em vez de confiar que o usuário
 * fez a conversão certa de cabeça. O schema continua guardando uma única
 * unidade canônica: taxa efetiva anual em bps.
 */
export const monthlyRate = (aprBps: number) => monthlyRateOf(aprBps)

/* ------------------------------------------------------------------ *
 * Composition + exposure + debt-to-income
 * ------------------------------------------------------------------ */

/**
 * Meses fechados que compõem a renda típica usada como denominador do
 * comprometimento de renda. Seis é a borda inferior da faixa de 6 a 12
 * meses que a análise de crédito usa para renda variável: suficiente para
 * atravessar um trimestre fraco, curto o bastante para ainda descrever a
 * situação atual e não a de dois anos atrás.
 */
export const INCOME_WINDOW_MONTHS = 6

export async function debtOverview(options: { period?: string } = {}) {
  const rows = await listDebts()
  const totalCents = rows.reduce((sum, d) => sum + d.balanceCents, 0)
  const monthlyInterestCents = rows.reduce((sum, d) => sum + d.monthlyInterestCents, 0)
  const minimumCents = rows.reduce((sum, d) => sum + d.minimumPaymentCents, 0)
  const scheduledCents = rows.reduce((sum, d) => sum + d.scheduledPaymentCents, 0)

  // Balance-weighted average rate — a simple mean would understate the
  // damage a small, very expensive revolving balance does.
  const weightedAprBps =
    totalCents > 0
      ? Math.round(rows.reduce((sum, d) => sum + d.aprBps * d.balanceCents, 0) / totalCents)
      : 0

  // A single real month, not an average across several — "como estava a
  // situação em julho" is a different (and more decision-useful) question
  // than "qual foi a renda média dos últimos 3 meses", and averaging hides
  // exactly the month-to-month swings the user wants to see. Defaults to
  // the last fully closed month: the current month's income is still
  // arriving, so showing it as final would understate how comprometida a
  // renda really é.
  //
  // Este número continua sendo o do mês de referência e continua na tela.
  // O que ele deixou de ser, em 09/09/2026, é o DENOMINADOR do
  // comprometimento de renda: ver `typicalMonthlyIncomeCents` abaixo.
  const period = options.period ?? addMonths(todayIso().slice(0, 7), -1)
  const { start: from, end: to } = periodBounds(period)
  const income = await totals({ from, to })
  const monthlyIncomeCents = income.incomeCents

  /**
   * Renda TÍPICA, e não a de um único mês, como denominador do
   * comprometimento de renda.
   *
   * A persona do produto é autônomo/PJ com receita irregular por definição
   * (`PRD.md` §2). Um mês com dois projetos faturados e um mês sem nenhum
   * produzem comprometimentos que diferem por um fator de 2 ou 3 sem que
   * nada tenha mudado na dívida, e o ruído não fica contido aqui: este
   * número alimenta o indicador de endividamento da Saúde financeira (peso
   * padrão de 20% no score) e uma das cinco regras do radar de risco. O
   * score composto oscilava mês a mês por uma razão sem relação com saúde
   * financeira nenhuma.
   *
   * A prática de crédito para renda variável usa média de 6 a 12 meses
   * pelo mesmo motivo. Aqui é a MEDIANA da janela, que é robusta a um mês
   * excepcional em qualquer das duas direções sem precisar decidir o que
   * conta como excepcional.
   *
   * Só entram meses com movimento registrado no ledger. Um mês vazio é
   * ausência de dado, não um mês sem renda, e contá-lo como zero afundaria
   * o denominador de quem importou o extrato semana passada. Um mês com
   * despesa e receita zero, esse sim, entra: é um mês seco de verdade e é
   * informação real sobre renda variável.
   */
  const incomeWindow = await monthlyTotals({ endPeriod: period, months: INCOME_WINDOW_MONTHS })
  const coveredMonths = incomeWindow.filter((m) => m.transactionCount > 0)
  const typicalMonthlyIncomeCents = medianCents(coveredMonths.map((m) => m.incomeCents))

  const byKind = new Map<string, number>()
  for (const d of rows) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + d.balanceCents)

  return {
    debts: rows,
    totalCents,
    monthlyInterestCents,
    minimumCents,
    scheduledCents,
    weightedAprBps,
    /** receita realizada no mês de referência, exatamente aquele mês */
    monthlyIncomeCents,
    /** mediana da receita dos meses com movimento na janela */
    typicalMonthlyIncomeCents,
    /** tamanho da janela pedida */
    incomeWindowMonths: INCOME_WINDOW_MONTHS,
    /** quantos meses da janela realmente tinham movimento e entraram na mediana */
    incomeSampleMonths: coveredMonths.length,
    /** committed debt service as a share of the typical monthly income */
    debtToIncomeBps:
      typicalMonthlyIncomeCents > 0
        ? Math.round((scheduledCents / typicalMonthlyIncomeCents) * 10_000)
        : null,
    /** total balance as a share of annual income (typical month x12) */
    debtToAnnualIncomeBps:
      typicalMonthlyIncomeCents > 0
        ? Math.round((totalCents / (typicalMonthlyIncomeCents * 12)) * 10_000)
        : null,
    period,
    byKind: [...byKind.entries()]
      .map(([kind, amountCents]) => ({
        kind,
        amountCents,
        shareBps: totalCents > 0 ? Math.round((amountCents / totalCents) * 10_000) : 0,
      }))
      .sort((a, b) => b.amountCents - a.amountCents),
  }
}

/* ------------------------------------------------------------------ *
 * Paydown projection
 * ------------------------------------------------------------------ */
export type ProjectionPoint = { month: number; period: string; balanceCents: number }

export type Scenario = {
  label: string
  extraMonthlyCents: number
  strategy: 'avalanche' | 'snowball'
  months: number | null
  totalInterestCents: number
  payoffPeriod: string | null
  series: ProjectionPoint[]
  perDebt: Array<{ debtId: number; name: string; months: number | null; interestCents: number }>
}

type SimDebt = {
  id: number
  name: string
  balance: number
  rate: number
  minimum: number
  scheduled: number
  /** SAC: amortização fixa do mês; a parcela é ela mais os juros do mês. Nulo nos demais. */
  sacAmortization: number | null
  interestThisMonth: number
  interestPaid: number
  months: number | null
}

/**
 * Simulates month-by-month amortization.
 *
 * Each month: interest accrues, every debt gets its scheduled payment, and
 * the extra contribution plus anything freed up by a paid-off debt is thrown
 * at the single target debt (highest rate for avalanche, smallest balance for
 * snowball). This is the standard model and it is deliberately simple —
 * the point is comparing two strategies, not predicting to the centavo.
 */
export async function projectPaydown(options: {
  extraMonthlyCents?: number
  strategy?: 'avalanche' | 'snowball'
  label?: string
  startPeriod?: string
}): Promise<Scenario> {
  const extraMonthlyCents = Math.max(0, options.extraMonthlyCents ?? 0)
  const strategy = options.strategy ?? 'avalanche'
  const startPeriod = options.startPeriod ?? todayIso().slice(0, 7)

  const sim: SimDebt[] = (await listDebts()).map((d) => ({
    id: d.id,
    name: d.name,
    balance: d.balanceCents,
    rate: monthlyRate(d.aprBps),
    minimum: d.minimumPaymentCents,
    // Contrato amortizado: seguros e taxas saem do caixa mas não abatem o saldo.
    scheduled: d.amortization
      ? Math.max(0, d.scheduledPaymentCents - d.monthlyFeesCents)
      : Math.max(d.scheduledPaymentCents, d.minimumPaymentCents),
    sacAmortization: d.amortization === 'sac' && d.installmentCount ? Math.round(d.principalCents / d.installmentCount) : null,
    interestThisMonth: 0,
    interestPaid: 0,
    months: null,
  }))

  const series: ProjectionPoint[] = [
    { month: 0, period: startPeriod, balanceCents: sim.reduce((s, d) => s + d.balance, 0) },
  ]

  if (sim.length === 0) {
    return {
      label: options.label ?? 'Cenário',
      extraMonthlyCents,
      strategy,
      months: 0,
      totalInterestCents: 0,
      payoffPeriod: startPeriod,
      series,
      perDebt: [],
    }
  }

  let month = 0
  let stalled = false

  while (sim.some((d) => d.balance > 0) && month < MAX_MONTHS) {
    month++
    const startingTotal = sim.reduce((s, d) => s + d.balance, 0)

    // 1. Interest accrues on every open balance.
    for (const d of sim) {
      if (d.balance <= 0) continue
      const interest = d.balance * d.rate
      d.balance += interest
      d.interestPaid += interest
      d.interestThisMonth = interest
    }

    // 2. Scheduled payments, plus whatever closed debts freed up.
    let pool = extraMonthlyCents
    for (const d of sim) {
      if (d.balance <= 0) {
        pool += d.scheduled
        continue
      }
      // SAC: a parcela do mês é a amortização fixa mais os juros do mês.
      if (d.sacAmortization !== null) d.scheduled = d.sacAmortization + d.interestThisMonth
      const payment = Math.min(d.scheduled, d.balance)
      d.balance -= payment
      if (payment < d.scheduled) pool += d.scheduled - payment
    }

    // 3. The whole pool goes at one target until it is gone.
    const openDebts = sim.filter((d) => d.balance > 0)
    const ordered =
      strategy === 'avalanche'
        ? [...openDebts].sort((a, b) => b.rate - a.rate || a.balance - b.balance)
        : [...openDebts].sort((a, b) => a.balance - b.balance || b.rate - a.rate)

    for (const target of ordered) {
      if (pool <= 0) break
      const payment = Math.min(pool, target.balance)
      target.balance -= payment
      pool -= payment
    }

    for (const d of sim) {
      if (d.balance <= 0.5 && d.months === null) {
        d.balance = 0
        d.months = month
      }
    }

    const total = sim.reduce((s, d) => s + d.balance, 0)
    series.push({ month, period: addMonths(startPeriod, month), balanceCents: Math.round(total) })

    // Payments not even covering interest: the balance never falls. Report
    // it honestly instead of drawing a flat line for 50 years.
    if (total >= startingTotal - 0.5) {
      stalled = true
      break
    }
  }

  const cleared = sim.every((d) => d.balance <= 0)
  return {
    label: options.label ?? (extraMonthlyCents > 0 ? 'Acelerado' : 'Atual'),
    extraMonthlyCents,
    strategy,
    months: cleared ? month : null,
    totalInterestCents: Math.round(sim.reduce((s, d) => s + d.interestPaid, 0)),
    payoffPeriod: cleared ? addMonths(startPeriod, month) : null,
    series,
    perDebt: sim.map((d) => ({
      debtId: d.id,
      name: d.name,
      months: d.months,
      interestCents: Math.round(d.interestPaid),
    })),
    ...(stalled ? { stalled: true } : {}),
  } as Scenario & { stalled?: boolean }
}

/** Baseline vs accelerated, aligned on the same month axis for one chart. */
export async function paydownComparison(extraMonthlyCents: number, strategy: 'avalanche' | 'snowball' = 'avalanche') {
  const [baseline, accelerated] = await Promise.all([
    projectPaydown({ extraMonthlyCents: 0, strategy, label: 'Pagamento atual' }),
    projectPaydown({ extraMonthlyCents, strategy, label: 'Com aporte extra' }),
  ])

  const horizon = Math.max(baseline.series.length, accelerated.series.length)
  const merged = Array.from({ length: horizon }, (_, i) => ({
    month: i,
    period: baseline.series[i]?.period ?? accelerated.series[i]?.period ?? '',
    baselineCents: baseline.series[i]?.balanceCents ?? (baseline.months !== null ? 0 : null),
    acceleratedCents: accelerated.series[i]?.balanceCents ?? (accelerated.months !== null ? 0 : null),
  }))

  return {
    baseline,
    accelerated,
    merged,
    savings: {
      monthsSaved:
        baseline.months !== null && accelerated.months !== null
          ? baseline.months - accelerated.months
          : null,
      interestSavedCents: baseline.totalInterestCents - accelerated.totalInterestCents,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */
export type DebtInput = {
  name: string
  kind?: string
  institution?: string | null
  principalCents: number
  aprBps: number
  minimumPaymentCents?: number
  scheduledPaymentCents?: number
  dueDay?: number
  installmentCount?: number | null
  accountId?: number | null
  amortization?: AmortizationSystem | null
  monthlyFeesCents?: number
  /** âncora da parcela 0 (YYYY-MM-DD); padrão hoje */
  openedOn?: string
  /** TAG das parcelas; ausente = "Financeiro › Empréstimos" */
  categoryId?: number | null
  /** paga dentro da fatura deste cartão */
  paidViaCardId?: number | null
}

/**
 * TAG padrão de uma dívida nova (specs/debt-v2): "Empréstimos" sob
 * "Financeiro", achada pelo nome; sem ela, a primeira TAG de despesa de
 * "Financeiro"; sem nenhuma, sem TAG.
 */
export async function defaultDebtCategoryId(): Promise<number | null> {
  const rows = await db.execute<{ id: number; name: string }>(sql`
    select c.id, c.name
    from categories c
    join categories p on p.id = c.parent_id
    where p.name = 'Financeiro' and c.kind = 'expense'
    order by c.id`)
  const loans = rows.find((r) => r.name === 'Empréstimos')
  return Number((loans ?? rows[0])?.id ?? 0) || null
}

/** Contrato amortizado guarda a 1ª parcela (com taxas) em `scheduledPaymentCents`, para as telas que mostram "parcela". */
async function syncFirstInstallment(row: DebtRecord): Promise<DebtRecord> {
  if (!isAmortized(row)) return row
  const first = nextInstallment(row, 0)
  if (first === row.scheduledPaymentCents) return row
  return (await db.update(debts).set({ scheduledPaymentCents: first }).where(eq(debts.id, row.id)).returning())[0] ?? row
}

export async function createDebt(input: DebtInput) {
  const inserted = (
    await db
      .insert(debts)
      .values({
        ...input,
        kind: input.kind as DebtKind | undefined,
        openedOn: input.openedOn ?? todayIso(),
        categoryId: input.categoryId === undefined ? await defaultDebtCategoryId() : input.categoryId,
      })
      .returning()
  )[0]!
  const row = await syncFirstInstallment(inserted)
  // The opening principal is also the first measured point on the trend.
  await db
    .insert(debtSnapshots)
    .values({ debtId: row.id, asOf: todayIso(), balanceCents: input.principalCents })
    .onConflictDoNothing()
  return row
}

export async function updateDebt(id: number, patch: Partial<DebtInput> & { active?: boolean }) {
  // Encerrar ou reabrir à mão pela edição: o motivo acompanha (specs/debt-v2).
  const reason = patch.active === false ? { closedReason: 'manual' as const, closedOn: todayIso() } : patch.active === true ? { closedReason: null, closedOn: null } : {}
  const updated =
    (
      await db
        .update(debts)
        .set({ ...patch, ...reason, kind: patch.kind as DebtKind | undefined })
        .where(eq(debts.id, id))
        .returning()
    )[0] ?? null
  if (!updated) return null
  const synced = await syncFirstInstallment(updated)
  await syncMaterializedRows(synced)
  return synced
}

export async function deleteDebt(id: number) {
  const result = await db.delete(debts).where(eq(debts.id, id))
  return { removed: result.count }
}

/**
 * Item 1 do backlog de 07/09/2026 (docs/backlog-ideias-produto.md):
 * "Evolução da dívida" só vale a pena se o gráfico tiver mais que um
 * ponto. Antes disto, `debt_snapshots` só ganhava linha nova quando o
 * usuário clicava manualmente em "Registrar saldo de hoje" — pagar uma
 * parcela não mexia no saldo medido nenhuma vez, então a série ficava
 * presa em 1 ponto (o principal, na criação) para a maioria das dívidas.
 *
 * Chamado pelos MESMOS três lugares que já gravam um `debt_payments` de
 * pagamento/uso (`createPayment` aqui, `settlePending`/
 * `confirmReconciliation` em cashFlow.ts) — o saldo medido acompanha o
 * ledger de pagamentos automaticamente, sem exigir que o usuário digite o
 * saldo do banco de novo. Continua sendo uma MEDIÇÃO, não uma segunda
 * fonte de verdade: o próximo "Registrar saldo de hoje" manual sempre
 * pode corrigir por cima, exatamente como já podia antes.
 */
export async function recordPaymentSnapshot(debtId: number, amountCents: number, kind: string): Promise<void> {
  const debt = (await db.select().from(debts).where(eq(debts.id, debtId)))[0]
  if (!debt) return
  // Contrato amortizado: o saldo é o do cronograma depois das parcelas
  // pagas (o pagamento já está em debt_payments), então só a amortização
  // sai, nunca juros e taxas.
  if (kind === 'payment' && isAmortized(debt)) {
    await recordScheduledBalance(debt)
    return
  }
  const balance = await currentBalance(debt)
  const delta = Math.abs(amountCents)
  const newBalance = kind === 'payment' ? Math.max(0, balance - delta) : balance + delta
  await recordSnapshot(debtId, todayIso(), newBalance)
}

/** Grava o saldo do cronograma de um contrato amortizado para as parcelas pagas hoje. */
async function recordScheduledBalance(debt: DebtRecord): Promise<void> {
  const { count } = await paymentStats(debt.id)
  await recordSnapshot(debt.id, todayIso(), balanceAfter(contractOf(debt), count))
}

export async function recordSnapshot(debtId: number, asOf: string, balanceCents: number) {
  const existing = (
    await db
      .select()
      .from(debtSnapshots)
      .where(sql`${debtSnapshots.debtId} = ${debtId} and ${debtSnapshots.asOf} = ${asOf}`)
  )[0]
  if (existing) {
    return (
      await db.update(debtSnapshots).set({ balanceCents }).where(eq(debtSnapshots.id, existing.id)).returning()
    )[0]!
  }
  return (await db.insert(debtSnapshots).values({ debtId, asOf, balanceCents }).returning())[0]!
}

export type PaymentRow = {
  id: number
  debtId: number
  debtName: string
  kind: string
  paidOn: string
  amountCents: number
  notes: string | null
}

export async function listPayments(debtId?: number): Promise<PaymentRow[]> {
  const query = db
    .select({
      id: debtPayments.id,
      debtId: debtPayments.debtId,
      debtName: debts.name,
      kind: debtPayments.kind,
      paidOn: debtPayments.paidOn,
      amountCents: debtPayments.amountCents,
      notes: debtPayments.notes,
    })
    .from(debtPayments)
    .innerJoin(debts, eq(debts.id, debtPayments.debtId))
    .orderBy(desc(debtPayments.paidOn))
  return debtId ? query.where(eq(debtPayments.debtId, debtId)) : query
}

/**
 * A parcela materializada mais antiga ainda pendente desta divida, se
 * houver (ordenada por occurrencePeriod, com postedOn como desempate para
 * as poucas linhas historicas sem occurrencePeriod). E a mesma nocao de
 * "proxima parcela" que installmentsPaid usa para decidir o indice
 * seguinte em materializeDebtInstallments.
 */
async function oldestPendingInstallment(debtId: number) {
  return (
    await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.debtId, debtId), eq(transactions.pending, true)))
      .orderBy(sql`coalesce(occurrence_period, posted_on)`)
      .limit(1)
  )[0] ?? null
}

/**
 * "Registrar pagamento" em Endividamento e o settle de uma pendencia vindo
 * da Home/Lancamentos (cashFlow.ts settlePending/confirmReconciliation)
 * sao o MESMO evento visto de duas telas -- gravar so em debt_payments
 * sem tocar a linha materializada deixava a parcela pendente ali para
 * sempre: Endividamento contava "1/1 pagas" mas a Home continuava
 * cobrando a mesma parcela em "Despesas pendentes" (bug 4, achado em
 * 03/09/2026, reproduzido nos dados reais: divida id 11, "Fatura do
 * cartao de credito", tinha installmentsPaid=1 e ainda assim 1 pendencia
 * aberta em 2026-08).
 *
 * So aplica a kind 'payment' -- um 'charge' (novo uso/saque) nao quita
 * nada, e nao ha pendencia nenhuma para ele assentar.
 */
async function settleOldestPendingInstallment(debtId: number): Promise<void> {
  const row = await oldestPendingInstallment(debtId)
  if (!row) return
  await db.update(transactions).set({ pending: false }).where(eq(transactions.id, row.id))
}

/**
 * Fecha a divida (active=false, closedOn=hoje) quando o numero de
 * parcelas pagas alcanca installmentCount -- o MESMO efeito que
 * deletePending's scope='all' ja produz ao fechar manualmente uma
 * pendencia pela Home, so que aqui e automatico, disparado pelo proprio
 * evento de pagamento (createPayment, settlePending,
 * confirmReconciliation: os tres lugares que gravam um debtPayments de
 * kind 'payment'), nao por uma acao separada do usuario.
 *
 * Sem isto uma divida totalmente paga nunca saia da lista ativa de
 * Endividamento (bug 2, achado em 03/09/2026: nenhum caminho do codigo
 * jamais gravava active=false por conta propria, e a UI nao tinha nenhum
 * botao "marcar como quitada" -- confirmado nos dados reais, dividas id
 * 11 e 13 estavam com installmentsPaid === installmentCount e ainda
 * assim active=true).
 *
 * Dividas revolventes (installmentCount null -- cartao, cheque especial)
 * nunca fecham aqui: elas nao tem um total de parcelas para esgotar, so
 * fecham pelo caminho manual existente (deletePending scope='all').
 *
 * Ao fechar, tambem remove qualquer pendencia que ainda reste ligada a
 * esta divida: uma vez quitada pelo proprio contador de parcelas, nenhuma
 * pendencia futura dela deveria existir -- se existe, e sobra do bug 5
 * (a mesma duplicacao que materializeDebtInstallments corrige daqui pra
 * frente), e uma divida "quitada" que ainda cobra em Despesas pendentes
 * seria o mesmo bug 4 outra vez, so que causado por dado velho em vez de
 * um caminho de codigo novo.
 */
export async function closeDebtIfFullyPaid(debtId: number): Promise<void> {
  const debt = (await db.select().from(debts).where(eq(debts.id, debtId)))[0]
  if (!debt || !debt.active || debt.installmentCount === null) return

  const { count: installmentsPaid } = await paymentStats(debtId)
  if (installmentsPaid < debt.installmentCount) return

  await db.update(debts).set({ active: false, closedOn: todayIso(), closedReason: 'paid' }).where(eq(debts.id, debtId))
  await db
    .delete(transactions)
    .where(and(eq(transactions.debtId, debtId), eq(transactions.pending, true)))
}

export async function createPayment(input: {
  debtId: number
  kind?: string
  paidOn: string
  amountCents: number
  notes?: string | null
}) {
  const row = (
    await db
      .insert(debtPayments)
      .values({ ...input, kind: input.kind as DebtPaymentKind | undefined })
      .returning()
  )[0]!

  await recordPaymentSnapshot(input.debtId, input.amountCents, row.kind)

  if (row.kind === 'payment') {
    await settleOldestPendingInstallment(input.debtId)
    await closeDebtIfFullyPaid(input.debtId)
  }

  return row
}

/**
 * Excluir um pagamento pode desfazer exatamente a condicao que
 * closeDebtIfFullyPaid checou: se a divida ja estava fechada por conta
 * daquele pagamento (installmentsPaid alcancou installmentCount), apagar
 * o registro derruba a contagem de volta abaixo do total, e a divida
 * precisa reabrir -- senao "excluir por engano um pagamento" deixaria a
 * divida presa como quitada para sempre, com a proxima parcela sem
 * nenhuma pendencia materializada.
 */
export async function deletePayment(id: number) {
  const row = (await db.select({ debtId: debtPayments.debtId }).from(debtPayments).where(eq(debtPayments.id, id)))[0]
  const result = await db.delete(debtPayments).where(eq(debtPayments.id, id))

  if (row) {
    const debt = (await db.select().from(debts).where(eq(debts.id, row.debtId)))[0]
    // Contrato amortizado: desfazer o pagamento devolve o saldo do cronograma.
    if (debt && isAmortized(debt)) await recordScheduledBalance(debt)
    if (debt && !debt.active && debt.installmentCount !== null) {
      const { count: installmentsPaid } = await paymentStats(debt.id)
      if (installmentsPaid < debt.installmentCount) {
        await db.update(debts).set({ active: true, closedOn: null, closedReason: null }).where(eq(debts.id, debt.id))
        await materializeDebtInstallments(debt.id)
      }
    }
  }

  return { removed: result.count }
}

/** Measured total debt over time — the actual trend, not a projection. */
export async function debtTrend() {
  return db.execute<{ asOf: string; balanceCents: number }>(sql`
    with points as (
      select distinct as_of from debt_snapshots
    )
    select
      p.as_of as "asOf",
      coalesce(sum(latest.balance_cents), 0) as "balanceCents"
    from points p
    left join debts d on d.active = true
    left join (
      select s1.debt_id, s1.as_of, s1.balance_cents
      from debt_snapshots s1
    ) latest on latest.debt_id = d.id
      and latest.as_of = (
        select max(s2.as_of) from debt_snapshots s2
        where s2.debt_id = d.id and s2.as_of <= p.as_of
      )
    group by p.as_of
    order by p.as_of
  `)
}

/**
 * Marcas que um pagamento de dívida gravado por uma LIGAÇÃO com um
 * lançamento real carrega em `notes`. É por elas que desfazer uma importação
 * acha exatamente o pagamento a apagar (decisions/0039).
 */
export const linkedPaymentNote = (transactionId: number) => `lançamento #${transactionId}`
export const payoffPaymentNote = (transactionId: number) => `quitação · lançamento #${transactionId}`

/**
 * Dívidas ativas pagas por esta conta, com o saldo devedor de hoje: a base
 * da sugestão "este pagamento quita a dívida X?" na revisão da importação.
 */
export async function payoffCandidates(accountId: number): Promise<Array<{ id: number; name: string; balanceCents: number }>> {
  const rows = await db.select().from(debts).where(and(eq(debts.active, true), eq(debts.accountId, accountId)))
  const out: Array<{ id: number; name: string; balanceCents: number }> = []
  for (const debt of rows) {
    const balanceCents = await currentBalance(debt)
    if (balanceCents > 0) out.push({ id: debt.id, name: debt.name, balanceCents })
  }
  return out
}

/** Até 3% de diferença: quitação antecipada costuma vir com desconto de juros. */
export function looksLikePayoff(paymentCents: number, balanceCents: number): boolean {
  const paid = Math.abs(paymentCents)
  return balanceCents > 0 && Math.abs(paid - balanceCents) <= Math.max(100, Math.round(balanceCents * 0.03))
}

/**
 * Quita a dívida com um lançamento real que o usuário confirmou na revisão
 * (nunca automático, decisions/0039): liga o lançamento à dívida, registra o
 * pagamento, mede o saldo e fecha a dívida na data do pagamento, levando
 * junto as parcelas que ainda estavam pendentes.
 */
export async function payOffDebt(debtId: number, transactionId: number): Promise<void> {
  const txn = (
    await db
      .select({ postedOn: transactions.postedOn, amountCents: transactions.amountCents })
      .from(transactions)
      .where(eq(transactions.id, transactionId))
  )[0]
  const debt = (await db.select().from(debts).where(eq(debts.id, debtId)))[0]
  if (!txn || !debt) return

  await db.update(transactions).set({ debtId }).where(eq(transactions.id, transactionId))
  await db.insert(debtPayments).values({
    debtId,
    kind: 'payment',
    paidOn: txn.postedOn,
    amountCents: Math.abs(txn.amountCents),
    notes: payoffPaymentNote(transactionId),
  })
  await recordSnapshot(debtId, txn.postedOn, 0)
  await db.update(debts).set({ active: false, closedOn: txn.postedOn, closedReason: 'paid' }).where(eq(debts.id, debtId))
  await db.delete(transactions).where(and(eq(transactions.debtId, debtId), eq(transactions.pending, true)))
}

/**
 * Desfaz o pagamento que uma ligação (parcela ou quitação) gravou para este
 * lançamento. Uma quitação reabre a dívida e gera de novo as parcelas; uma
 * parcela usa `deletePayment`, que já reabre a dívida se ela tinha fechado
 * por causa desse pagamento.
 */
export async function undoLinkedDebtPayment(debtId: number, transactionId: number): Promise<void> {
  const payments = await db
    .select({ id: debtPayments.id, notes: debtPayments.notes })
    .from(debtPayments)
    .where(eq(debtPayments.debtId, debtId))
  for (const payment of payments) {
    if (payment.notes === payoffPaymentNote(transactionId)) {
      await db.delete(debtPayments).where(eq(debtPayments.id, payment.id))
      const reopened = (await db.update(debts).set({ active: true, closedOn: null, closedReason: null }).where(eq(debts.id, debtId)).returning())[0]
      // Contrato amortizado: a quitação desfeita volta ao saldo do cronograma.
      if (reopened && isAmortized(reopened)) await recordScheduledBalance(reopened)
      await materializeDebtInstallments(debtId)
    } else if (payment.notes === linkedPaymentNote(transactionId)) {
      await deletePayment(payment.id)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Endividamento v2 (specs/debt-v2, decisions/0044)
 * ------------------------------------------------------------------ */

/**
 * Parcelas já pagas para o calendário: o maior entre os pagamentos gravados
 * na dívida e as parcelas dela já confirmadas em Lançamentos. Uma parcela
 * confirmada sem o pagamento correspondente (caso real de 10/2026) senão
 * voltava como atrasada no mês corrente.
 */
async function settledInstallments(): Promise<Map<number, number>> {
  const rows = await db.execute<{ debtId: number; n: number }>(sql`
    select debt_id as "debtId", count(*)::int as n
    from transactions
    where debt_id is not null and pending = false and amount_cents < 0
    group by debt_id`)
  return new Map(rows.map((r) => [Number(r.debtId), Number(r.n)]))
}

const effectivePaid = (d: DebtRow, settled: Map<number, number>) =>
  d.installmentCount === null ? d.installmentsPaid : Math.min(d.installmentCount, Math.max(d.installmentsPaid, settled.get(d.id) ?? 0))

/** Entrada das contas puras de `core/debtPlan` para uma dívida ativa. */
function planInputOf(d: DebtRow, startPeriod: string, paid = d.installmentsPaid): DebtPlanInput {
  return {
    balanceCents: d.balanceCents,
    aprBps: d.aprBps,
    paymentCents: d.scheduledPaymentCents || d.minimumPaymentCents,
    installmentCount: d.installmentCount,
    installmentsPaid: paid,
    anchorPeriod: d.openedOn?.slice(0, 7) ?? null,
    amortization: d.amortization,
    principalCents: d.principalCents,
    monthlyFeesCents: d.monthlyFeesCents,
    startPeriod,
  }
}

/** Saldo medido no fim de cada um dos 12 meses antes de `startPeriod` (0 fora da vida da dívida). */
async function balancesLast12(debt: { id: number; openedOn: string | null; closedOn: string | null; principalCents: number }, startPeriod: string) {
  const snaps = await db
    .select({ asOf: debtSnapshots.asOf, balanceCents: debtSnapshots.balanceCents })
    .from(debtSnapshots)
    .where(eq(debtSnapshots.debtId, debt.id))
    .orderBy(debtSnapshots.asOf)
  const out: number[] = []
  for (let i = 12; i >= 1; i--) {
    const period = addMonths(startPeriod, -i)
    const end = periodBounds(period).end
    if (debt.openedOn && debt.openedOn.slice(0, 7) > period) continue
    if (debt.closedOn && debt.closedOn.slice(0, 7) < period) continue
    const last = snaps.filter((sn) => sn.asOf <= end).at(-1)
    out.push(last?.balanceCents ?? debt.principalCents)
  }
  return out
}

/**
 * Tudo do Endividamento v2 numa leitura: total (dívidas + cartões), cartões,
 * comprometimento sobre a renda típica pessoal, calendário de 6 meses,
 * custo do crédito, datas livres e acordos.
 */
export async function debtOverviewV2() {
  const startPeriod = todayIso().slice(0, 7)
  // Em sequência: lido por Saúde, Patrimônio e Endividamento, e o pooler das
  // Edge Functions trava com fan-out concorrente demais (goals.ts#goalHistory).
  const rows = await listDebts()
  const cards = await listCards()
  const income = await typicalPersonalIncome(startPeriod)
  const closedRecent = await db
    .select()
    .from(debts)
    .where(and(eq(debts.active, false), sql`${debts.closedOn} >= ${`${addMonths(startPeriod, -12)}-01`}`))
  const renegotiations = await db.select().from(debtRenegotiations)
  const settled = await settledInstallments()

  const plans = new Map(rows.map((d) => [d.id, debtPlan(planInputOf(d, startPeriod, effectivePaid(d, settled)))]))
  const debtItems = rows.map((d) => {
    const plan = plans.get(d.id)!
    const first = plan.rows[0]
    const remaining = d.installmentCount === null ? null : d.installmentCount - effectivePaid(d, settled)
    const implied = d.amortization === null && remaining ? impliedAnnualBps(d.balanceCents, d.scheduledPaymentCents, remaining) : null
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      balanceCents: d.balanceCents,
      aprBps: d.aprBps,
      monthlyRateBps: d.monthlyRateBps,
      paymentCents: first?.paymentCents ?? 0,
      interestThisMonthCents: first?.interestCents ?? d.monthlyInterestCents,
      principalThisMonthCents: first?.principalCents ?? 0,
      endsOn: plan.endsOn,
      monthsLeft: plan.endsOn ? plan.rows.length : null,
      /** taxa que fecha o contrato de parcela fixa; nula se não houver ou se for amortizado/rotativo */
      impliedAprBps: implied,
      categoryId: d.categoryId,
    }
  })

  // Dívida paga na fatura (specs/personal-picture): o saldo dela já está no
  // limite usado do cartão, e a parcela dela já está nas parcelas projetadas.
  const viaCard = new Map<number, typeof rows>()
  for (const d of rows) if (d.paidViaCardId) viaCard.set(d.paidViaCardId, [...(viaCard.get(d.paidViaCardId) ?? []), d])
  const cardItems = cards.map((c) => {
    const linked = viaCard.get(c.id) ?? []
    const linkedBalanceCents = linked.reduce((sum, d) => sum + d.balanceCents, 0)
    const linkedPayment = (period: string) => linked.reduce((sum, d) => sum + (plans.get(d.id)?.rows.find((r) => r.period === period)?.paymentCents ?? 0), 0)
    const projectedOf = (period: string) => c.upcoming.find((m) => m.period === period)?.projectedCents ?? 0
    // Tira das parcelas projetadas do cartão a parte que é a dívida (nunca mais que o projetado).
    const netOf = (period: string, gross: number) => Math.max(0, gross - Math.min(projectedOf(period), linkedPayment(period)))
    const future = c.upcoming.filter((m) => m.period > startPeriod)
    return {
      id: c.id,
      name: c.name,
      /** conta de pagamento do cartão (a conta PJ marca cartão da empresa) */
      accountId: c.accountId,
      source: c.source,
      limitCents: c.creditLimitCents,
      /** limite usado sem o saldo das dívidas pagas na fatura (essas já contam como dívida) */
      usedCents: Math.max(0, c.usedCents - linkedBalanceCents),
      usedBps: c.usedBps,
      grossUsedCents: c.usedCents,
      linkedDebts: linked.map((d) => ({ id: d.id, name: d.name, balanceCents: d.balanceCents })),
      /** fatura aberta (ver `openBillCents` em creditCards); à mão, sem fatura */
      openBillCents: c.openBillCents,
      dueOn: c.nextDueOn,
      lastSyncedAt: c.lastSyncedAt,
      lastChargesCents: c.lastBills[0]?.financeChargesCents ?? 0,
      charges12mCents: c.charges12mCents,
      byPeriod: Object.fromEntries([
        ...(c.openBillCents !== null ? [[startPeriod, netOf(startPeriod, c.openBillCents)] as const] : []),
        ...future.map((m) => [m.period, netOf(m.period, Math.max(0, m.postedCents + m.projectedCents))] as const),
      ]) as Record<string, number>,
    }
  })

  const sources: CalendarSource[] = [
    ...debtItems.map((d) => ({
      key: `debt:${d.id}`,
      label: d.name,
      kind: 'debt' as const,
      byPeriod: Object.fromEntries((plans.get(d.id)?.rows ?? []).map((r) => [r.period, r.paymentCents])),
      endsOn: d.endsOn,
    })),
    ...cardItems.map((c) => ({ key: `card:${c.id}`, label: c.name, kind: 'card' as const, byPeriod: c.byPeriod, endsOn: null })),
  ]
  const calendar = exitCalendar(sources, startPeriod, income.typicalCents)
  const thisMonth = calendar[0]!

  // Juros dos últimos 12 meses: contrato amortizado pelo cronograma; os
  // demais estimados por saldo medido × taxa; cartões pelos encargos das faturas.
  const raw = new Map((await db.select().from(debts).where(eq(debts.active, true))).map((d) => [d.id, d]))
  const interest12m: Array<{ key: string; label: string; cents: number; estimated: boolean }> = []
  // Encerradas no período levam a data: várias dívidas costumam ter o mesmo nome.
  const labelOf = (d: DebtRecord) => (d.active ? d.name : `${d.name} (encerrada ${d.closedOn ? `${d.closedOn.slice(8, 10)}/${d.closedOn.slice(5, 7)}` : ''})`)
  for (const d of [...raw.values(), ...closedRecent]) {
    if (d.amortization && d.installmentCount && d.openedOn) {
      const anchor = d.openedOn.slice(0, 7)
      const { count: paid } = await paymentStats(d.id)
      const fromK = Math.max(0, monthIndex(anchor, addMonths(startPeriod, -12)))
      const toK = Math.min(paid, Math.max(0, monthIndex(anchor, startPeriod)))
      const cents = toK > fromK ? scheduledInterestCents({ principalCents: d.principalCents, aprBps: d.aprBps, installmentCount: d.installmentCount, amortization: d.amortization }, fromK, toK) : 0
      if (cents > 0) interest12m.push({ key: `debt:${d.id}`, label: labelOf(d), cents, estimated: false })
    } else {
      const cents = estimatedInterestCents(await balancesLast12(d, startPeriod), d.aprBps)
      if (cents > 0) interest12m.push({ key: `debt:${d.id}`, label: labelOf(d), cents, estimated: true })
    }
  }
  for (const c of cardItems) if (c.charges12mCents > 0) interest12m.push({ key: `card:${c.id}`, label: c.name, cents: c.charges12mCents, estimated: false })

  // Acordos: um por dívida-acordo, com as origens que ele encerrou.
  const allDebts = new Map([...raw.values(), ...closedRecent].map((d) => [d.id, d]))
  for (const r of renegotiations) {
    for (const id of [r.debtId, r.originDebtId]) {
      if (!allDebts.has(id)) {
        const extra = (await db.select().from(debts).where(eq(debts.id, id)))[0]
        if (extra) allDebts.set(id, extra)
      }
    }
  }
  const byAgreement = new Map<number, typeof renegotiations>()
  for (const r of renegotiations) byAgreement.set(r.debtId, [...(byAgreement.get(r.debtId) ?? []), r])
  const agreements = [...byAgreement].map(([debtId, origins]) => {
    const agreement = allDebts.get(debtId)
    const originBalanceCents = origins.reduce((sum, o) => sum + o.originBalanceCents, 0)
    const installment = agreement
      ? agreement.amortization && agreement.installmentCount
        ? installmentsCents(contractOf(agreement)).reduce((sum, v) => sum + v, 0) / agreement.installmentCount
        : agreement.scheduledPaymentCents || agreement.minimumPaymentCents
      : 0
    return {
      debtId,
      name: agreement?.name ?? `dívida ${debtId}`,
      agreedOn: origins[0]?.agreedOn ?? null,
      origins: origins.map((o) => ({ debtId: o.originDebtId, name: allDebts.get(o.originDebtId)?.name ?? `dívida ${o.originDebtId}`, balanceCents: o.originBalanceCents })),
      originBalanceCents,
      financedCents: agreement?.principalCents ?? 0,
      installmentCents: Math.round(installment),
      installmentCount: agreement?.installmentCount ?? null,
      ...agreementTerms({
        originBalanceCents,
        financedCents: agreement?.principalCents ?? 0,
        installmentCents: Math.round(installment),
        installmentCount: agreement?.installmentCount ?? 0,
      }),
    }
  })

  const debtsTotal = debtItems.reduce((sum, d) => sum + d.balanceCents, 0)
  const cardsUsed = cardItems.reduce((sum, c) => sum + c.usedCents, 0)
  const freeOn = debtItems.length === 0 ? startPeriod : debtItems.some((d) => d.endsOn === null) ? null : debtItems.map((d) => d.endsOn!).sort().at(-1)!

  return {
    startPeriod,
    total: { cents: debtsTotal + cardsUsed, debtsCents: debtsTotal, cardsUsedCents: cardsUsed },
    debts: debtItems,
    cards: cardItems,
    income: { typicalCents: income.typicalCents, sampleMonths: income.sampleMonths },
    commitment: {
      debtCents: thisMonth.debtCents,
      cardCents: thisMonth.cardCents,
      shareBps: thisMonth.incomeShareBps,
    },
    calendar,
    cost: {
      monthCents: debtItems.reduce((sum, d) => sum + d.interestThisMonthCents, 0) + cardItems.reduce((sum, c) => sum + c.lastChargesCents, 0),
      last12m: interest12m.sort((a, b) => b.cents - a.cents),
      last12mCents: interest12m.reduce((sum, i) => sum + i.cents, 0),
    },
    freeOn,
    agreements,
    assumptions: {
      total: 'saldo das dívidas ativas + limite usado dos cartões (o limite usado já inclui as parcelas futuras do cartão); dívida paga na fatura de um cartão sai do limite usado dele, para contar uma vez',
      comprometimento: '(parcelas das dívidas do mês + fatura aberta dos cartões ligados) ÷ renda típica pessoal (mediana de 6 meses fechados, contas pessoais + repasse da PJ, a mesma do Orçamento)',
      calendario: 'dívidas pelo cronograma (parcela atrasada entra no mês corrente); cartões ligados ao Open Finance pela fatura aberta e pelas parcelas futuras; cartões medidos à mão ficam fora',
      jurosDoMes: 'saldo × taxa mensal (ou a parte de juros da parcela no contrato amortizado) + encargos da última fatura fechada de cada cartão',
      juros12m: 'contrato amortizado pelo cronograma; demais dívidas estimadas pelo saldo medido de cada mês × taxa mensal; cartões pelos encargos das faturas fechadas',
    },
  }
}

/**
 * "Usar a taxa do contrato": grava na dívida a taxa que fecha o contrato de
 * parcela fixa (saldo, parcela e parcelas que faltam). 409 quando nenhuma
 * taxa fecha ou a dívida não é de parcela fixa.
 */
export async function useImpliedRate(id: number) {
  const d = (await listDebts()).find((row) => row.id === id)
  if (!d) throw new DebtError('dívida não encontrada', 404)
  if (d.amortization !== null) throw new DebtError('contrato SAC/Price já tem a taxa do cronograma', 409)
  // Mesmas parcelas restantes do Endividamento v2 (pagas ou já confirmadas).
  const remaining = d.installmentCount === null ? null : d.installmentCount - effectivePaid(d, await settledInstallments())
  const bps = impliedAnnualBps(d.balanceCents, d.scheduledPaymentCents, remaining)
  if (bps === null) throw new DebtError('nenhuma taxa fecha esse contrato: as parcelas que faltam não cobrem o saldo, ou a dívida não tem número de parcelas', 409)
  const before = d.aprBps
  await db.update(debts).set({ aprBps: bps }).where(eq(debts.id, id))
  return { id, beforeAprBps: before, afterAprBps: bps }
}

/**
 * Registra que a dívida `debtId` (o acordo) renegociou `originDebtIds`:
 * guarda o saldo de cada origem no dia e encerra cada uma como
 * "renegociada" (não "quitada"), levando junto as pendências dela.
 */
export async function registerRenegotiation(debtId: number, originDebtIds: number[], agreedOn = todayIso()) {
  const ids = [...new Set(originDebtIds)]
  if (ids.length === 0) throw new DebtError('informe ao menos uma dívida de origem')
  if (ids.includes(debtId)) throw new DebtError('o acordo não pode renegociar a si mesmo')
  const agreement = (await db.select().from(debts).where(eq(debts.id, debtId)))[0]
  if (!agreement) throw new DebtError('acordo não encontrado', 404)
  const origins = await db.select().from(debts).where(inArray(debts.id, ids))
  if (origins.length !== ids.length) throw new DebtError('dívida de origem não encontrada', 404)
  const already = await db.select({ id: debtRenegotiations.originDebtId }).from(debtRenegotiations).where(inArray(debtRenegotiations.originDebtId, ids))
  if (already.length > 0) throw new DebtError('uma dessas dívidas já foi renegociada', 409)
  const balances = await Promise.all(origins.map(async (o) => ({ id: o.id, balanceCents: await currentBalance(o) })))
  await db.transaction(async (tx) => {
    for (const b of balances) {
      await tx.insert(debtRenegotiations).values({ debtId, originDebtId: b.id, originBalanceCents: b.balanceCents, agreedOn })
      await tx.update(debts).set({ active: false, closedOn: agreedOn, closedReason: 'renegotiated' }).where(eq(debts.id, b.id))
      await tx.delete(transactions).where(and(eq(transactions.debtId, b.id), eq(transactions.pending, true)))
    }
  })
  const originBalanceCents = balances.reduce((sum, b) => sum + b.balanceCents, 0)
  return {
    debtId,
    originBalanceCents,
    ...agreementTerms({
      originBalanceCents,
      financedCents: agreement.principalCents,
      installmentCents: agreement.scheduledPaymentCents || agreement.minimumPaymentCents,
      installmentCount: agreement.installmentCount ?? 0,
    }),
  }
}
