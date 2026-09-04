import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { partnerCommissions, partnerPlatforms } from '../db/schema.ts'
import { addMonths, periodBounds, periodOf, periodRange, todayIso } from '../core/dates.ts'
import { createTransaction } from './transactions.ts'
import { totals, type Range } from './analytics.ts'

/**
 * Receita de parceiros: comissões de plataformas (Wbuy, Hostinger,
 * Nuvemshop, Adobe) que acumulam saldo DENTRO da plataforma até bater um
 * mínimo de saque, e só então viram dinheiro numa conta real.
 *
 * O desenho responde a uma pergunta que aparece antes de qualquer tela:
 * onde mora esse dinheiro enquanto está na plataforma? Três respostas
 * foram consideradas e a escolhida é a terceira (ver `decisions/0037`):
 *
 *  1. A plataforma é uma `accounts`. Elegante no papel — saldo derivado
 *     pela máquina que já existe, comissão e saque viram linhas normais
 *     do ledger. Medido, custa caro: NENHUMA das cinco agregações que
 *     somam saldo (`accountBalances` -> Painel, `availableForAllocation`,
 *     `runway`, `snapshot`, `cashFlowProjection`) filtra por `kind`, então
 *     R$ 900 parados na Wbuy entrariam como caixa disponível em Saúde
 *     financeira e no Motor, e `runway()` ainda criaria um escopo "Wbuy"
 *     próprio na tela de Saúde. Consertar isso é mexer em três serviços e
 *     três telas que ninguém pediu para mudar.
 *
 *  2. A comissão é uma pendência (`pending = true`, decisions/0003).
 *     Semanticamente perto — dinheiro confirmado que o banco ainda não
 *     postou — mas a conciliação de pendência é 1:1 e um saque cobre N
 *     comissões de uma vez; e uma pendência exige `accountId`, que no
 *     momento da comissão ainda não existe.
 *
 *  3. Escolhida: a comissão acumula numa tabela de domínio e a
 *     REALIZAÇÃO escreve o ledger. É exatamente a relação que
 *     `projectQuotes` já tem com `transactions` — a cotação guarda o
 *     valor, e aprovar é que gera a linha real (`approveQuote`). O saque
 *     gera a entrada na conta de destino com `partnerPlatformId`
 *     preenchido, do mesmo jeito que a aprovação preenche
 *     `sourceQuoteId`.
 *
 * Consequência que vale dizer em voz alta: a receita é reconhecida no
 * SAQUE, não na competência da comissão. Uma comissão ainda não sacada
 * não aparece em Receitas nem no DRE — ela aparece aqui, no saldo
 * acumulado, que é o número que esta tela existe para mostrar. Sem isso o
 * dinheiro seria contado duas vezes: uma ao ser ganho e outra ao chegar.
 *
 * Nenhum saldo é gravado em coluna nenhuma. Tudo abaixo é `SELECT` sobre
 * o histórico ("Derivação em vez de saldo guardado", `architecture.md`).
 */

export class PartnerError extends Error {}

/** Categoria padrão da entrada gerada por um saque: "Comissões", que já existe sob "Receitas de Trabalho". */
const DEFAULT_COMMISSION_CATEGORY = 'Comissões'

export type PlatformRow = {
  id: number
  name: string
  minWithdrawalCents: number
  notes: string | null
  active: boolean
  /** Comissões lançadas menos o que já foi sacado. Sempre derivado. */
  balanceCents: number
  /** Tudo que a plataforma já gerou, desde o primeiro lançamento. */
  earnedCents: number
  /** Tudo que já saiu da plataforma para uma conta real. */
  withdrawnCents: number
  commissionCount: number
  lastCommissionOn: string | null
  lastWithdrawalOn: string | null
  /**
   * Saldo contra o mínimo, em basis points. `null` quando a plataforma não
   * tem mínimo configurado: não existe progresso até um alvo que ninguém
   * definiu, e 0/0 desenharia uma barra cheia ou vazia por acidente.
   */
  progressBps: number | null
  /** Quanto falta para bater o mínimo. Zero quando já dá para sacar. */
  missingCents: number
  readyToWithdraw: boolean
}

const platformBalanceQuery = sql`
  select
    p.id,
    p.name,
    p.min_withdrawal_cents as "minWithdrawalCents",
    p.notes,
    p.active,
    coalesce(c.earned, 0) as "earnedCents",
    coalesce(w.withdrawn, 0) as "withdrawnCents",
    coalesce(c.count, 0) as "commissionCount",
    c.last_on as "lastCommissionOn",
    w.last_on as "lastWithdrawalOn"
  from partner_platforms p
  left join (
    select platform_id, sum(amount_cents) as earned, count(*) as count, max(earned_on) as last_on
    from partner_commissions
    group by platform_id
  ) c on c.platform_id = p.id
  left join (
    -- Só linhas confirmadas: um saque lançado como pendência ainda não
    -- saiu da plataforma, e abatê-lo do saldo mostraria menos dinheiro
    -- disponível do que a plataforma realmente tem (mesmo filtro que toda
    -- agregação do app aplica, decisions/0003).
    select partner_platform_id, sum(amount_cents) as withdrawn, max(posted_on) as last_on
    from transactions
    where partner_platform_id is not null and pending = false
    group by partner_platform_id
  ) w on w.partner_platform_id = p.id
  order by p.name`

type PlatformQueryRow = Omit<
  PlatformRow,
  'balanceCents' | 'progressBps' | 'missingCents' | 'readyToWithdraw'
>

/** Derives the four computed fields the same way for every caller. */
function withProgress(row: PlatformQueryRow): PlatformRow {
  const balanceCents = row.earnedCents - row.withdrawnCents
  const hasMinimum = row.minWithdrawalCents > 0
  return {
    ...row,
    balanceCents,
    progressBps: hasMinimum
      ? Math.round((balanceCents / row.minWithdrawalCents) * 10_000)
      : null,
    missingCents: hasMinimum ? Math.max(0, row.minWithdrawalCents - balanceCents) : 0,
    // Sem mínimo, qualquer saldo positivo já pode ser sacado — é o que
    // "sem mínimo" significa, não "nunca pronto".
    readyToWithdraw: balanceCents > 0 && (!hasMinimum || balanceCents >= row.minWithdrawalCents),
  }
}

export async function listPlatforms(): Promise<PlatformRow[]> {
  const rows = await db.execute<PlatformQueryRow>(platformBalanceQuery)
  return rows.map(withProgress)
}

/* ------------------------------------------------------------------ *
 * Cadastro
 * ------------------------------------------------------------------ */
export async function createPlatform(input: {
  name: string
  minWithdrawalCents?: number
  notes?: string | null
}) {
  const name = input.name.trim()
  if (!name) throw new PartnerError('informe o nome da plataforma')

  const clash = await db.execute<{ id: number }>(sql`
    select id from partner_platforms where lower(name) = lower(${name}) limit 1`)
  if (clash.length > 0) throw new PartnerError(`"${name}" já está cadastrada`)

  return (
    await db
      .insert(partnerPlatforms)
      .values({
        name,
        minWithdrawalCents: input.minWithdrawalCents ?? 0,
        notes: input.notes ?? null,
      })
      .returning()
  )[0]!
}

export async function updatePlatform(
  id: number,
  patch: { name?: string; minWithdrawalCents?: number; notes?: string | null; active?: boolean },
) {
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new PartnerError('informe o nome da plataforma')
    const clash = await db.execute<{ id: number }>(sql`
      select id from partner_platforms where lower(name) = lower(${name}) and id <> ${id} limit 1`)
    if (clash.length > 0) throw new PartnerError(`"${name}" já está cadastrada`)
  }

  const rows = await db
    .update(partnerPlatforms)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.minWithdrawalCents !== undefined
        ? { minWithdrawalCents: patch.minWithdrawalCents }
        : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    })
    .where(eq(partnerPlatforms.id, id))
    .returning()
  return rows[0] ?? null
}

/**
 * Apagar a plataforma leva as comissões com ela (cascade) — elas não
 * significam nada sozinhas. As linhas de SAQUE ficam: aquele dinheiro
 * entrou na conta de verdade, e apagar um lançamento real porque o
 * cadastro do parceiro saiu seria perder extrato (`on delete set null`
 * na FK, por isso).
 */
export async function deletePlatform(id: number) {
  const withdrawals = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from transactions where partner_platform_id = ${id}`)
  const rows = await db
    .delete(partnerPlatforms)
    .where(eq(partnerPlatforms.id, id))
    .returning({ id: partnerPlatforms.id })
  return { removed: rows.length, keptTransactions: withdrawals[0]?.count ?? 0 }
}

/* ------------------------------------------------------------------ *
 * Comissões — o log de competência
 * ------------------------------------------------------------------ */
export type CommissionRow = {
  id: number
  platformId: number
  platformName: string
  earnedOn: string
  amountCents: number
  notes: string | null
}

export async function listCommissions(platformId?: number): Promise<CommissionRow[]> {
  const filter = platformId ? sql`where c.platform_id = ${platformId}` : sql``
  return db.execute<CommissionRow>(sql`
    select
      c.id,
      c.platform_id as "platformId",
      p.name as "platformName",
      c.earned_on as "earnedOn",
      c.amount_cents as "amountCents",
      c.notes
    from partner_commissions c
    join partner_platforms p on p.id = c.platform_id
    ${filter}
    order by c.earned_on desc, c.id desc
    limit 500`)
}

export async function addCommission(input: {
  platformId: number
  earnedOn: string
  amountCents: number
  notes?: string | null
}) {
  if (input.amountCents <= 0) throw new PartnerError('o valor da comissão precisa ser maior que zero')

  const platform = await db
    .select()
    .from(partnerPlatforms)
    .where(eq(partnerPlatforms.id, input.platformId))
  if (platform.length === 0) throw new PartnerError('plataforma não encontrada')

  return (
    await db
      .insert(partnerCommissions)
      .values({
        platformId: input.platformId,
        earnedOn: input.earnedOn,
        amountCents: Math.abs(input.amountCents),
        notes: input.notes ?? null,
      })
      .returning()
  )[0]!
}

export async function deleteCommission(id: number) {
  const rows = await db
    .delete(partnerCommissions)
    .where(eq(partnerCommissions.id, id))
    .returning({ id: partnerCommissions.id })
  return { removed: rows.length }
}

/* ------------------------------------------------------------------ *
 * Saque — a única operação que escreve no ledger
 * ------------------------------------------------------------------ */

/**
 * Registra um saque: abate o saldo da plataforma (por derivação, não por
 * update) e gera UMA entrada normal em `transactions`, na conta que o
 * usuário escolheu.
 *
 * É uma ENTRADA (`income`), não uma transferência: a comissão nunca
 * passou pelo ledger, então este é o momento em que a receita é
 * reconhecida. Tratá-la como transferência entre contas próprias faria a
 * receita de parceiros nunca aparecer em Receitas, no DRE ou no % de
 * representatividade desta própria tela.
 *
 * O saque é barrado quando passa do saldo. Não por rigor contábil: o
 * saldo é derivado, então um saque maior que o acumulado deixaria a
 * plataforma com saldo negativo permanente, e nenhuma tela do app sabe
 * desenhar uma barra de progresso negativa.
 */
export async function withdraw(input: {
  platformId: number
  accountId: number
  amountCents: number
  postedOn: string
  categoryId?: number | null
  notes?: string | null
}) {
  if (input.amountCents <= 0) throw new PartnerError('o valor do saque precisa ser maior que zero')

  const platforms = await listPlatforms()
  const platform = platforms.find((p) => p.id === input.platformId)
  if (!platform) throw new PartnerError('plataforma não encontrada')

  const amountCents = Math.abs(input.amountCents)
  if (amountCents > platform.balanceCents) {
    throw new PartnerError(
      `${platform.name} tem ${brl(platform.balanceCents)} acumulado: um saque de ${brl(amountCents)} deixaria o saldo negativo`,
    )
  }

  const categoryId = input.categoryId ?? (await defaultCommissionCategoryId())

  const row = await createTransaction({
    accountId: input.accountId,
    postedOn: input.postedOn,
    description: `Saque ${platform.name}`,
    amountCents,
    categoryId,
    source: 'manual',
    notes: input.notes ?? null,
    partnerPlatformId: input.platformId,
  })

  return { transaction: row, platform: (await listPlatforms()).find((p) => p.id === input.platformId)! }
}

/**
 * "Comissões" (sob "Receitas de Trabalho") é a categoria natural, e já
 * existe no cadastro padrão. Se alguém a renomeou ou apagou, o saque
 * entra sem categoria em vez de falhar — uma linha sem categoria aparece
 * na fila de "não categorizados" de Lançamentos, que é o caminho normal
 * do app para isso, e cai no `income` pelo sinal (ver FLOW_KIND em
 * analytics.ts).
 */
async function defaultCommissionCategoryId(): Promise<number | null> {
  const rows = await db.execute<{ id: number }>(sql`
    select id from categories
    where lower(name) = lower(${DEFAULT_COMMISSION_CATEGORY}) and kind = 'income' and archived = false
    order by parent_id nulls last
    limit 1`)
  return rows[0]?.id ?? null
}

const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/* ------------------------------------------------------------------ *
 * Visão consolidada
 * ------------------------------------------------------------------ */
export type PartnerOverview = {
  range: Range
  /** Soma do saldo acumulado de todas as plataformas, hoje. */
  totalBalanceCents: number
  /** Comissões com competência DENTRO do período. */
  earnedInRangeCents: number
  /** Saques confirmados dentro do período: o que virou receita de verdade. */
  withdrawnInRangeCents: number
  platforms: PlatformRow[]
  representativeness: {
    partnerIncomeCents: number
    totalIncomeCents: number
    /** Participação no período, em bps. `null` quando não houve receita nenhuma. */
    shareBps: number | null
    previousPartnerIncomeCents: number
    previousTotalIncomeCents: number
    previousShareBps: number | null
    /** Diferença de participação, em PONTOS percentuais (não em %). */
    deltaPoints: number | null
    /** Variação relativa do valor sacado contra o período anterior, em bps. */
    valueDeltaBps: number | null
  }
  assumptions: Record<string, unknown>
}

/** Mesma janela, deslocada para trás — o período anterior de comparação. */
function previousRange(range: Range): Range {
  const fromPeriod = periodOf(range.from)
  const toPeriod = periodOf(range.to)
  const months = Math.max(1, monthSpan(fromPeriod, toPeriod))
  return {
    from: periodBounds(addMonths(fromPeriod, -months)).start,
    to: periodBounds(addMonths(toPeriod, -months)).end,
    accountId: range.accountId,
  }
}

const monthSpan = (from: string, to: string) => {
  const [fy, fm] = from.split('-').map(Number) as [number, number]
  const [ty, tm] = to.split('-').map(Number) as [number, number]
  return (ty - fy) * 12 + (tm - fm) + 1
}

async function partnerIncomeIn(range: Range): Promise<number> {
  const rows = await db.execute<{ total: number }>(sql`
    select coalesce(sum(amount_cents), 0) as total
    from transactions
    where partner_platform_id is not null
      and pending = false
      and posted_on between ${range.from} and ${range.to}`)
  return rows[0]?.total ?? 0
}

export async function partnerOverview(range: Range): Promise<PartnerOverview> {
  const prev = previousRange(range)
  const [platforms, rangeTotals, prevTotals, partnerIncomeCents, previousPartnerIncomeCents, earned] =
    await Promise.all([
      listPlatforms(),
      totals(range),
      totals(prev),
      partnerIncomeIn(range),
      partnerIncomeIn(prev),
      db.execute<{ total: number }>(sql`
        select coalesce(sum(amount_cents), 0) as total
        from partner_commissions
        where earned_on between ${range.from} and ${range.to}`),
    ])

  const totalBalanceCents = platforms.reduce((sum, p) => sum + p.balanceCents, 0)
  const totalIncomeCents = rangeTotals.incomeCents
  const previousTotalIncomeCents = prevTotals.incomeCents

  const shareBps =
    totalIncomeCents > 0 ? Math.round((partnerIncomeCents / totalIncomeCents) * 10_000) : null
  const previousShareBps =
    previousTotalIncomeCents > 0
      ? Math.round((previousPartnerIncomeCents / previousTotalIncomeCents) * 10_000)
      : null

  return {
    range,
    totalBalanceCents,
    earnedInRangeCents: earned[0]?.total ?? 0,
    withdrawnInRangeCents: partnerIncomeCents,
    platforms,
    representativeness: {
      partnerIncomeCents,
      totalIncomeCents,
      shareBps,
      previousPartnerIncomeCents,
      previousTotalIncomeCents,
      previousShareBps,
      deltaPoints: shareBps !== null && previousShareBps !== null ? shareBps - previousShareBps : null,
      valueDeltaBps:
        previousPartnerIncomeCents > 0
          ? Math.round(
              ((partnerIncomeCents - previousPartnerIncomeCents) / previousPartnerIncomeCents) * 10_000,
            )
          : null,
    },
    assumptions: {
      formula: 'Participação = saques de parceiros confirmados no período ÷ receita total do período',
      intervalo: `${range.from} a ${range.to}`,
      periodoAnterior: `${prev.from} a ${prev.to}`,
      receitaDeParceirosCents: partnerIncomeCents,
      receitaTotalCents: totalIncomeCents,
      reconhecimentoDeReceita:
        'no saque, não na competência da comissão: enquanto o dinheiro está na plataforma ele não passou por conta nenhuma',
      saldoAcumuladoNaoSacadoCents: totalBalanceCents,
      plataformasAtivas: platforms.filter((p) => p.active).length,
      origemDaReceitaTotal: 'totals() de analytics.ts, a mesma função que alimenta o Painel e o DRE',
    },
  }
}

/* ------------------------------------------------------------------ *
 * Evolução — saldo acumulado por plataforma, mês a mês
 * ------------------------------------------------------------------ */
export type PartnerEvolutionPoint = {
  period: string
  totalCents: number
  /** saldo acumulado ao FIM do mês, por id de plataforma */
  byPlatform: Record<string, number>
}

export type PartnerEvolution = {
  points: PartnerEvolutionPoint[]
  platforms: Array<{ id: number; name: string }>
  assumptions: Record<string, unknown>
}

/**
 * Saldo ACUMULADO ao fim de cada mês, não o ganho do mês: é a leitura que
 * responde "quanto estava parado lá" em qualquer ponto do passado, e é o
 * mesmo desenho de "Evolução do patrimônio" (uma linha por série,
 * recomposta em cada mês, nada persistido).
 *
 * O acumulado é construído em JS a partir dos deltas mensais em vez de
 * uma window function por mês: são 12 a 24 pontos por plataforma, e o
 * `SELECT` por mês custaria uma varredura por ponto.
 */
export async function partnerEvolution(monthsBack = 12): Promise<PartnerEvolution> {
  const platforms = await db.execute<{ id: number; name: string }>(sql`
    select id, name from partner_platforms order by name`)

  if (platforms.length === 0) {
    return {
      points: [],
      platforms: [],
      assumptions: { formula: 'Nenhuma plataforma cadastrada ainda' },
    }
  }

  const current = periodOf(todayIso())
  const first = addMonths(current, -(monthsBack - 1))

  const [earned, withdrawn] = await Promise.all([
    db.execute<{ platformId: number; period: string; total: number }>(sql`
      select platform_id as "platformId", substr(earned_on, 1, 7) as period, sum(amount_cents) as total
      from partner_commissions
      group by 1, 2`),
    db.execute<{ platformId: number; period: string; total: number }>(sql`
      select partner_platform_id as "platformId", substr(posted_on, 1, 7) as period, sum(amount_cents) as total
      from transactions
      where partner_platform_id is not null and pending = false
      group by 1, 2`),
  ])

  // Delta por plataforma e mês, incluindo o que aconteceu ANTES da janela:
  // o primeiro ponto tem que começar do saldo real daquele mês, não de zero.
  const delta = new Map<string, number>()
  const bump = (platformId: number, period: string, cents: number) => {
    const key = `${platformId}|${period}`
    delta.set(key, (delta.get(key) ?? 0) + cents)
  }
  for (const row of earned) bump(row.platformId, row.period, row.total)
  for (const row of withdrawn) bump(row.platformId, row.period, -row.total)

  const running = new Map<number, number>()
  for (const p of platforms) running.set(p.id, 0)

  // Tudo antes da janela colapsa no saldo de abertura.
  for (const [key, cents] of delta) {
    const [platformId, period] = key.split('|') as [string, string]
    if (period < first) running.set(Number(platformId), (running.get(Number(platformId)) ?? 0) + cents)
  }

  const points: PartnerEvolutionPoint[] = []
  for (const period of periodRange(first, current)) {
    for (const p of platforms) {
      const cents = delta.get(`${p.id}|${period}`) ?? 0
      if (cents !== 0) running.set(p.id, (running.get(p.id) ?? 0) + cents)
    }
    const byPlatform: Record<string, number> = {}
    let totalCents = 0
    for (const p of platforms) {
      const value = running.get(p.id) ?? 0
      byPlatform[String(p.id)] = value
      totalCents += value
    }
    points.push({ period, totalCents, byPlatform })
  }

  return {
    points,
    platforms,
    assumptions: {
      formula: 'Saldo ao fim do mês = comissões lançadas até o mês menos saques confirmados até o mês',
      intervalo: `${first} a ${current}`,
      mesesNaJanela: points.length,
      saldoDeAbertura: 'o que aconteceu antes da janela entra no primeiro ponto, não é descartado',
      plataformas: platforms.map((p) => p.name),
    },
  }
}

/** Kept for the route's 404: does this platform exist at all? */
export async function getPlatform(id: number): Promise<PlatformRow | null> {
  const rows = await db.execute<PlatformQueryRow>(sql`
    with p as (select * from partner_platforms where id = ${id})
    select
      p.id, p.name, p.min_withdrawal_cents as "minWithdrawalCents", p.notes, p.active,
      coalesce((select sum(amount_cents) from partner_commissions where platform_id = p.id), 0) as "earnedCents",
      coalesce((select sum(amount_cents) from transactions where partner_platform_id = p.id and pending = false), 0) as "withdrawnCents",
      coalesce((select count(*) from partner_commissions where platform_id = p.id), 0) as "commissionCount",
      (select max(earned_on) from partner_commissions where platform_id = p.id) as "lastCommissionOn",
      (select max(posted_on) from transactions where partner_platform_id = p.id and pending = false) as "lastWithdrawalOn"
    from p`)
  return rows[0] ? withProgress(rows[0]) : null
}
