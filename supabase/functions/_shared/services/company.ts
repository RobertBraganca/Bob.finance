import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { categories, financialEngineSettings } from '../db/schema.ts'
import { addMonths, periodBounds, todayIso } from '../core/dates.ts'
import {
  DEFAULT_CUSHION_MONTHS,
  DEFAULT_MEI_LIMIT_CENTS,
  cascade,
  ceilingProjection,
  fixedMonthlyCost,
  isDasCategory,
  withdrawable,
} from '../core/company.ts'
import { accountBalances } from './analytics.ts'
import { monthlySpending } from './budget.ts'
import { listPending } from './cashFlow.ts'
import { reserveStatus } from './investments.ts'
import { accountScope, pjWithdrawals } from './withdrawals.ts'

/**
 * "Minha empresa" para o MEI (specs/company-mei, decisions/0043): retirada
 * possível do mês, cascata do faturamento até o que ficou na PJ, teto do
 * MEI e se as retiradas cobrem o custo de vida. Leitura sobre o extrato; só
 * as quatro configurações são gravadas.
 */

export class CompanyError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

const currentPeriod = () => todayIso().slice(0, 7)

type SettingsRow = typeof financialEngineSettings.$inferSelect

async function settingsRow(): Promise<SettingsRow | null> {
  return (await db.select().from(financialEngineSettings).limit(1))[0] ?? null
}

/** TAGs de DAS: as configuradas, senão as de despesa com nome de imposto/DAS ou grupo de imposto no DRE. */
async function dasCategoryIds(row: SettingsRow | null): Promise<{ ids: Set<number>; configured: boolean; all: Array<{ id: number; name: string; parentId: number | null; detected: boolean }> }> {
  const rows = await db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId, kind: categories.kind, dreGroup: categories.dreGroup })
    .from(categories)
  const expense = rows.filter((c) => c.kind === 'expense')
  const detected = new Set(expense.filter((c) => isDasCategory(c.name, c.dreGroup)).map((c) => c.id))
  const configured = Array.isArray(row?.dasCategoryIds)
  const ids = configured ? new Set((row!.dasCategoryIds as number[]).map(Number)) : detected
  return { ids, configured, all: expense.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, detected: detected.has(c.id) })) }
}

type PjMonth = { revenueCents: number; dasCents: number; costsCents: number; hasMovement: boolean }

/** Faturamento, DAS e custos da conta PJ por mês (confirmados, não ignorados). */
async function pjMonths(pjAccountId: number, fromPeriod: string, toPeriod: string, das: Set<number>): Promise<Map<string, PjMonth>> {
  const rows = await db.execute<{ period: string; categoryId: number | null; kind: string | null; cents: number }>(sql`
    select substr(t.posted_on, 1, 7) as period, t.category_id as "categoryId", c.kind::text as kind, coalesce(sum(t.amount_cents), 0) as cents
    from transactions t
    left join categories c on c.id = t.category_id
    where t.account_id = ${pjAccountId} and t.pending = false and t.ignored = false
      and t.posted_on between ${periodBounds(fromPeriod).start} and ${periodBounds(toPeriod).end}
    group by 1, 2, 3`)
  const out = new Map<string, PjMonth>()
  for (const row of rows) {
    let m = out.get(row.period)
    if (!m) out.set(row.period, (m = { revenueCents: 0, dasCents: 0, costsCents: 0, hasMovement: false }))
    m.hasMovement = true
    const cents = Number(row.cents)
    if (row.kind === 'income') m.revenueCents += cents
    else if (row.kind === 'expense') {
      if (row.categoryId !== null && das.has(Number(row.categoryId))) m.dasCents += -cents
      else m.costsCents += -cents
    }
  }
  return out
}

/** Último DAS pago na PJ (valor absoluto), a sugestão do DAS mensal. */
async function lastDasPaid(pjAccountId: number, das: Set<number>): Promise<{ cents: number; postedOn: string } | null> {
  if (das.size === 0) return null
  const ids = sql.join([...das].map((id) => sql`${id}`), sql`, `)
  const row = (
    await db.execute<{ cents: number; postedOn: string }>(sql`
      select -t.amount_cents as cents, t.posted_on as "postedOn"
      from transactions t
      where t.account_id = ${pjAccountId} and t.pending = false and t.ignored = false
        and t.amount_cents < 0 and t.category_id in (${ids})
      order by t.posted_on desc, t.id desc limit 1`)
  )[0]
  return row ? { cents: Number(row.cents), postedOn: row.postedOn } : null
}

export async function companySettings() {
  const row = await settingsRow()
  const das = await dasCategoryIds(row)
  const last = row?.pjAccountId ? await lastDasPaid(row.pjAccountId, das.ids) : null
  return {
    pjAccountId: row?.pjAccountId ?? null,
    dasMonthlyCents: row?.dasMonthlyCents ?? null,
    lastDasPaid: last,
    pjCushionMonths: row?.pjCushionMonths ?? DEFAULT_CUSHION_MONTHS,
    meiAnnualLimitCents: row?.meiAnnualLimitCents ?? DEFAULT_MEI_LIMIT_CENTS,
    dasCategoryIds: das.configured ? [...das.ids] : null,
    effectiveDasCategoryIds: [...das.ids],
    categories: das.all.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
  }
}

export async function saveCompanySettings(input: {
  dasMonthlyCents: number | null
  pjCushionMonths: number
  meiAnnualLimitCents: number
  dasCategoryIds: number[] | null
}) {
  const row = await settingsRow()
  if (!row) throw new CompanyError('configure a conta da empresa no Motor financeiro antes', 409)
  await db
    .update(financialEngineSettings)
    .set({
      dasMonthlyCents: input.dasMonthlyCents,
      pjCushionMonths: input.pjCushionMonths,
      meiAnnualLimitCents: input.meiAnnualLimitCents,
      dasCategoryIds: input.dasCategoryIds,
    })
    .where(eq(financialEngineSettings.id, row.id))
  return companySettings()
}

export async function companyOverview(period: string) {
  const row = await settingsRow()
  const scope = await accountScope()
  const pjAccountId = scope.pjAccountId
  if (pjAccountId === null) return { period, pjAccount: null }

  const das = await dasCategoryIds(row)
  const first = addMonths(period, -11)
  const isCurrent = period === currentPeriod()
  const [months, transfers, spending, balances, reserve, last] = await Promise.all([
    pjMonths(pjAccountId, first, period, das.ids),
    pjWithdrawals(first, period, scope),
    monthlySpending(first, period),
    accountBalances(),
    reserveStatus(),
    lastDasPaid(pjAccountId, das.ids),
  ])
  const monthOf = (p: string): PjMonth => months.get(p) ?? { revenueCents: 0, dasCents: 0, costsCents: 0, hasMovement: false }
  const withdrawalsOf = (p: string) => {
    const t = transfers.get(p)
    return t ? t.toPersonalCents - t.fromPersonalCents : 0
  }
  const dasMonthlyCents = row?.dasMonthlyCents ?? last?.cents ?? 0
  const cushionMonths = row?.pjCushionMonths ?? DEFAULT_CUSHION_MONTHS
  const limitCents = row?.meiAnnualLimitCents ?? DEFAULT_MEI_LIMIT_CENTS

  const current = monthOf(period)
  const dasPending = current.dasCents === 0 && dasMonthlyCents > 0
  const flow = cascade({
    revenueCents: current.revenueCents,
    dasCents: current.dasCents,
    costsCents: current.costsCents,
    withdrawalsCents: withdrawalsOf(period),
  })

  let withdrawableInfo: (ReturnType<typeof withdrawable> & { withdrawnThisMonthCents: number }) | null = null
  if (isCurrent) {
    const { start, end } = periodBounds(period)
    const pending = (await listPending('expense', { from: start, to: end }))
      .filter((p) => p.accountId === pjAccountId)
      .reduce((sum, p) => sum + Math.abs(p.amountCents), 0)
    const history = Array.from({ length: 6 }, (_, i) => monthOf(addMonths(period, -6 + i)))
    const cash = Number(balances.find((b) => Number(b.id) === pjAccountId)?.balanceCents ?? 0)
    withdrawableInfo = {
      ...withdrawable({
        cashCents: cash,
        dasDueCents: dasPending ? dasMonthlyCents : 0,
        pendingCents: pending,
        fixedMonthlyCents: fixedMonthlyCost(history, dasMonthlyCents),
        cushionMonths,
      }),
      withdrawnThisMonthCents: withdrawalsOf(period),
    }
  }

  const year = period.slice(0, 4)
  let yearRevenueCents = 0
  for (let p = `${year}-01`; p <= period; p = addMonths(p, 1)) yearRevenueCents += monthOf(p).revenueCents
  const ceiling = ceilingProjection({
    period,
    yearRevenueCents,
    closedPace: [1, 2, 3].map((i) => monthOf(addMonths(period, -i)).revenueCents),
    limitCents,
  })

  const personalSpentCents = spending.get(period) ?? 0
  const withdrawalsCents = withdrawalsOf(period)
  const series = Array.from({ length: 12 }, (_, i) => addMonths(first, i)).map((p) => ({
    period: p,
    revenueCents: monthOf(p).revenueCents,
    withdrawalsCents: withdrawalsOf(p),
    personalSpentCents: spending.get(p) ?? 0,
  }))

  return {
    period,
    isCurrent,
    pjAccount: { id: pjAccountId, name: balances.find((b) => Number(b.id) === pjAccountId)?.name ?? 'Conta PJ' },
    dasMonthlyCents,
    dasPending,
    withdrawable: withdrawableInfo,
    cascade: flow,
    ceiling,
    coverage: {
      withdrawalsCents,
      personalSpentCents,
      coverageBps: personalSpentCents > 0 ? Math.round((withdrawalsCents / personalSpentCents) * 10_000) : null,
      livingCostCents: reserve.monthlyLivingCostCents,
    },
    series,
    assumptions: {
      retiradaPossivel: 'caixa da PJ hoje − DAS do mês ainda não pago − contas da PJ a pagar no mês − colchão',
      colchao: `${cushionMonths} ${cushionMonths === 1 ? 'mês' : 'meses'} do custo fixo da PJ (mediana de custos + DAS dos 6 meses fechados com movimento)`,
      das: row?.dasMonthlyCents
        ? 'DAS mensal informado na configuração'
        : last
          ? `último DAS encontrado na PJ (${last.postedOn})`
          : 'nenhum DAS encontrado na PJ nem informado',
      retiradas: 'saídas da PJ que pareiam (mesmo valor, até 1 dia) com entrada numa conta pessoal não lançada como receita, menos o caminho inverso',
      teto: `faturado no ano civil contra R$ ${(limitCents / 100).toLocaleString('pt-BR')}; projeção pelo ritmo dos 3 meses fechados anteriores`,
      gastosPessoais: 'gastos do Orçamento: despesas confirmadas das contas pessoais, sem as TAGs fora do orçamento',
    },
  }
}
