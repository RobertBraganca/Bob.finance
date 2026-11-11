import { sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { todayIso } from '../core/dates.ts'
import { EDUCATION_CAP_CENTS, effectiveIrpfGroup, IRPF_GROUP_LABEL, IRPF_GROUPS, PENSION_CAP_BPS, type IrpfGroup } from '../core/irpf.ts'
import { accountScope, idList } from './withdrawals.ts'

/**
 * O que do gasto pessoal abate no Imposto de Renda (decisions/0047). Lê só as
 * contas pessoais (a PJ fica de fora: despesa da empresa não deduz no IRPF) e
 * soma as despesas do ano por grupo de dedução da categoria (core/irpf.ts).
 * Devolve também o que parece dedutível e não é (farmácia, academia) e
 * recomendações diretas.
 */
export type IrpfCategoryLine = { id: number; path: string; totalCents: number; count: number; source: 'manual' | 'auto' }
export type IrpfGroupLine = {
  group: IrpfGroup
  label: string
  totalCents: number
  count: number
  /** teto anual quando existe em valor fixo (educação, por pessoa) */
  capCents: number | null
  categories: IrpfCategoryLine[]
}
export type IrpfSummary = {
  year: number
  /** até quando o ano foi lido (o ano corrente para hoje) */
  through: string
  totalCents: number
  groups: IrpfGroupLine[]
  /** gasto em categorias de saúde/educação que não deduz */
  notDeductible: Array<{ path: string; totalCents: number }>
  recommendations: string[]
}

const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export async function irpfSummary(year: number): Promise<IrpfSummary> {
  const today = todayIso()
  const from = `${year}-01-01`
  const yearEnd = `${year}-12-31`
  const through = yearEnd < today ? yearEnd : today
  const scope = await accountScope()

  const cats = await db.execute<{ id: number; parentId: number | null; name: string; irpfGroup: string | null; kind: string }>(sql`
    select id, parent_id as "parentId", name, irpf_group as "irpfGroup", kind from categories
  `)
  const byId = new Map(cats.map((c) => [c.id, c]))

  const spent = scope.personal.length
    ? await db.execute<{ categoryId: number; totalCents: number; count: number }>(sql`
        select t.category_id as "categoryId", coalesce(sum(-t.amount_cents), 0) as "totalCents", count(*) as count
        from transactions t
        where t.amount_cents < 0 and t.pending = false and t.ignored = false
          and t.category_id is not null
          and t.account_id in (${idList(scope.personal)})
          and t.posted_on between ${from} and ${through}
        group by t.category_id
      `)
    : []

  const groups = new Map<IrpfGroup, IrpfGroupLine>(
    IRPF_GROUPS.map((group) => [
      group,
      { group, label: IRPF_GROUP_LABEL[group], totalCents: 0, count: 0, capCents: group === 'education' ? EDUCATION_CAP_CENTS : null, categories: [] },
    ]),
  )
  const notDeductible: IrpfSummary['notDeductible'] = []

  for (const row of spent) {
    const cat = byId.get(row.categoryId)
    // Aporte de PGBL costuma morar numa categoria de investimento: entra também.
    if (!cat || (cat.kind !== 'expense' && cat.kind !== 'investment')) continue
    const parent = cat.parentId === null ? null : (byId.get(cat.parentId) ?? null)
    const path = parent ? `${parent.name} > ${cat.name}` : cat.name
    const { group, source } = effectiveIrpfGroup(cat, parent)
    if (!group) {
      if (/sa[uú]de|educa/i.test(parent?.name ?? cat.name)) notDeductible.push({ path, totalCents: row.totalCents })
      continue
    }
    const line = groups.get(group)!
    line.totalCents += row.totalCents
    line.count += row.count
    line.categories.push({ id: cat.id, path, totalCents: row.totalCents, count: row.count, source })
  }
  for (const line of groups.values()) line.categories.sort((a, b) => b.totalCents - a.totalCents)
  notDeductible.sort((a, b) => b.totalCents - a.totalCents)

  const g = (k: IrpfGroup) => groups.get(k)!
  const recommendations: string[] = []
  if (g('health').totalCents === 0) {
    recommendations.push(
      `Nenhuma despesa de saúde dedutível lançada em ${year}. Consulta, exame, dentista, psicólogo e plano de saúde deduzem sem limite: lance numa categoria de saúde e peça recibo ou nota com o seu CPF.`,
    )
  } else {
    recommendations.push(`Guarde os recibos de saúde (${brl(g('health').totalCents)} no ano) com nome e CPF do profissional; a Receita cruza com a declaração deles.`)
  }
  if (g('education').totalCents > EDUCATION_CAP_CENTS) {
    recommendations.push(`Educação passou do limite de ${brl(EDUCATION_CAP_CENTS)} por pessoa: só esse valor deduz, o resto (${brl(g('education').totalCents - EDUCATION_CAP_CENTS)}) não.`)
  }
  const notDeductibleTotal = notDeductible.reduce((sum, item) => sum + item.totalCents, 0)
  if (notDeductibleTotal > 0) {
    recommendations.push(`${brl(notDeductibleTotal)} em ${notDeductible.map((n) => n.path).join(', ')} não deduz (remédio de farmácia, academia, curso livre). Não lance esses valores como despesa médica ou de instrução.`)
  }
  if (g('pension').totalCents === 0) {
    recommendations.push(
      `PGBL deduz até ${PENSION_CAP_BPS / 100}% da renda tributável, só na declaração completa. Como MEI, o lucro isento e a retirada não contam como renda tributável: só vale se você tiver salário, pró-labore com INSS ou aluguel recebido.`,
    )
  }
  const lines = [...groups.values()]
  if (lines.some((line) => line.categories.some((c) => c.source === 'auto'))) {
    recommendations.push('Categorias marcadas como "pelo nome" foram classificadas automaticamente; ajuste em Categorias se alguma estiver errada.')
  }
  const totalCents = lines.reduce((sum, line) => sum + (line.capCents !== null ? Math.min(line.totalCents, line.capCents) : line.totalCents), 0)
  return { year, through, totalCents, groups: lines, notDeductible, recommendations }
}
