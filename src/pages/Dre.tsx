import type { CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { bps, money, periodLong } from '../lib/format'
import { Card, EmptyState, Icon, SkeletonLines } from '../components/ui'

type Margins = { brutaBps: number | null; operacionalBps: number | null; liquidaBps: number | null }

type FormalDreResponse = {
  receitaBrutaCents: number
  deducoesCents: number
  receitaLiquidaCents: number
  custosCents: number
  lucroBrutoCents: number
  despesasOperacionaisCents: number
  resultadoOperacionalCents: number
  resultadoFinanceiroCents: number
  impostosCents: number
  lucroLiquidoCents: number
  margins: Margins
  /** as mesmas margens nos 6 meses anteriores (só os com receita) */
  previous: Margins & { months: number }
  /** repasse líquido da PJ para as contas pessoais no período */
  withdrawnToPfCents: number | null
  /** gasto de categoria pessoal pago pela conta PJ */
  personalPaidByPjCents: number | null
  keptCents: number | null
  /** entradas em categoria de despesa sem grupo, fora de todas as linhas */
  uncountedInflow: { cents: number; count: number }
}

const SECTION: CSSProperties = { gridColumn: '1 / -1', textTransform: 'uppercase', fontSize: 'var(--text-2xs)', letterSpacing: '0.03em', marginTop: 'var(--sp-2)' }
const tone = (cents: number) => (cents < 0 ? 'neg' : 'pos')
const pct = (value: number | null) => (value === null ? '-' : bps(value, 1))

/** O valor da linha com a margem (sobre a receita líquida) ao lado. */
function WithMargin({ cents, marginBps, weight }: { cents: number; marginBps: number | null; weight: number }) {
  return (
    <span className={`kv__v ${tone(cents)}`} style={{ fontWeight: weight }}>
      {money(cents)}
      {marginBps !== null && (
        <span className="muted" style={{ fontWeight: 400, fontSize: 'var(--text-xs)' }}>
          {' '}
          · {pct(marginBps)}
        </span>
      )}
    </span>
  )
}

/**
 * Margem = lucro ÷ receita líquida: quanto sobra até aquela linha a cada R$ 100
 * que entram. Ao lado, a mesma conta somando os 6 meses anteriores.
 */
function MarginTiles({ margins, previous }: { margins: Margins; previous: Margins & { months: number } }) {
  const tiles: Array<{ label: string; key: keyof Margins }> = [
    { label: 'Margem bruta', key: 'brutaBps' },
    { label: 'Margem operacional (EBIT)', key: 'operacionalBps' },
    { label: 'Margem líquida', key: 'liquidaBps' },
  ]
  return (
    <div className="row row--wrap" style={{ gap: 'var(--sp-5)', padding: '0 var(--sp-5)' }}>
      {tiles.map((t) => {
        const now = margins[t.key]
        const before = previous[t.key]
        const delta = now !== null && before !== null ? now - before : null
        return (
          <div key={t.key} className="stat" style={{ flex: 1, minWidth: 150 }}>
            <span className="stat__label">{t.label}</span>
            <span className="numeral" style={{ fontSize: 'var(--text-xl)' }}>{pct(now)}</span>
            <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
              {previous.months > 0 && before !== null
                ? `${pct(before)} nos ${previous.months} meses anteriores${delta !== null && Math.abs(delta) >= 10 ? ` (${delta > 0 ? '+' : '−'}${bps(Math.abs(delta), 1).replace('%', '')} p.p.)` : ''}`
                : 'sem meses anteriores com receita'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * DRE formal (PJ), specs/dre "DRE PJ formal": Receita Bruta → Lucro Líquido
 * da conta PJ do Motor financeiro, e o que ficou na empresa depois das
 * retiradas. É o fim da tela Minha empresa (11/11/2026): as colunas por
 * conta, a reconciliação PJ ↔ PF e o painel de sem categoria saíram — o
 * servidor já entrega a retirada (`withdrawnToPfCents`).
 *
 * Cada categoria-mãe cai num grupo do DRE pelo `dreGroup` (Categorias);
 * sem grupo, receita vira Receita Bruta e despesa vira Despesa Operacional.
 */
export function FormalDreCard({ period, accountLabel }: { period: string; accountLabel: string }) {
  const [year, month] = period.split('-').map(Number)
  const from = `${period}-01`
  const to = `${period}-${String(new Date(year!, month!, 0).getDate()).padStart(2, '0')}`
  const query = useQuery({
    queryKey: ['dre-formal', from, to],
    queryFn: () => api.get<FormalDreResponse>('/analytics/dre/formal', { from, to }),
    placeholderData: (previous) => previous,
  })
  const data = query.data
  const title = 'DRE formal (PJ)'

  if (query.isError && !data) {
    return (
      <Card span={12} flush title={title}>
        <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar o DRE formal agora. Tente novamente em instantes." />
      </Card>
    )
  }
  if (!data) {
    return (
      <Card span={12} flush title={title}>
        <SkeletonLines lines={6} />
      </Card>
    )
  }

  const { margins } = data
  const showAfter =
    data.keptCents !== null && ((data.withdrawnToPfCents ?? 0) !== 0 || (data.personalPaidByPjCents ?? 0) !== 0)

  return (
    <Card span={12} flush title={title} subtitle={`${accountLabel} · ${periodLong(period)} · Receita Bruta → Lucro Líquido`}>
      <MarginTiles margins={margins} previous={data.previous} />
      <hr className="divider" style={{ margin: 'var(--sp-4) var(--sp-5)' }} />
      <div className="kv" style={{ padding: '0 var(--sp-5)', fontSize: 'var(--text-base)' }}>
        <span className="kv__k" style={{ ...SECTION, marginTop: 0 }}>
          Receita
        </span>
        <span className="kv__k">Receita Bruta</span>
        <span className="kv__v pos">{money(data.receitaBrutaCents)}</span>
        <span className="kv__k">(−) Deduções da Receita (DAS, ISS, devoluções)</span>
        <span className="kv__v neg">{money(data.deducoesCents)}</span>
        <span className="kv__k" style={{ fontWeight: 600 }}>(=) Receita Líquida</span>
        <span className={`kv__v ${tone(data.receitaLiquidaCents)}`} style={{ fontWeight: 600 }}>
          {money(data.receitaLiquidaCents)}
        </span>

        <span className="kv__k" style={SECTION}>
          Custos e Lucro Bruto
        </span>
        <span className="kv__k">(−) Custos dos Serviços Prestados (CSP)</span>
        <span className="kv__v neg">{money(data.custosCents)}</span>
        <span className="kv__k" style={{ fontWeight: 600 }}>(=) Lucro Bruto</span>
        <WithMargin cents={data.lucroBrutoCents} marginBps={margins.brutaBps} weight={600} />

        <span className="kv__k" style={SECTION}>
          Despesas Operacionais
        </span>
        <span className="kv__k">(−) Despesas Operacionais</span>
        <span className="kv__v neg">{money(data.despesasOperacionaisCents)}</span>
        <span className="kv__k" style={{ fontWeight: 600 }}>(=) Resultado Operacional (EBIT)</span>
        <WithMargin cents={data.resultadoOperacionalCents} marginBps={margins.operacionalBps} weight={600} />

        <span className="kv__k" style={SECTION}>
          Resultado Final
        </span>
        <span className="kv__k">(+/−) Resultado Financeiro</span>
        <span className={`kv__v ${tone(data.resultadoFinanceiroCents)}`}>{money(data.resultadoFinanceiroCents)}</span>
        <span className="kv__k">(−) Impostos sobre o Lucro (IRPJ e CSLL; o MEI não tem)</span>
        <span className="kv__v neg">{money(data.impostosCents)}</span>
        <span className="kv__k" style={{ fontWeight: 700 }}>(=) Lucro Líquido</span>
        <WithMargin cents={data.lucroLiquidoCents} marginBps={margins.liquidaBps} weight={700} />

        {showAfter && (
          <>
            <span className="kv__k" style={SECTION}>
              Depois das retiradas
            </span>
            {(data.withdrawnToPfCents ?? 0) !== 0 && (
              <>
                <span className="kv__k">(−) Retiradas para a pessoa física</span>
                <span className="kv__v neg">{money(data.withdrawnToPfCents ?? 0)}</span>
              </>
            )}
            {(data.personalPaidByPjCents ?? 0) !== 0 && (
              <>
                <span className="kv__k">(−) Gastos pessoais pagos pela conta PJ</span>
                <span className="kv__v neg">{money(data.personalPaidByPjCents ?? 0)}</span>
              </>
            )}
            <span className="kv__k" style={{ fontWeight: 700 }}>(=) Ficou na empresa</span>
            <span className={`kv__v ${tone(data.keptCents!)}`} style={{ fontWeight: 700 }}>
              {money(data.keptCents!)}
            </span>
          </>
        )}
      </div>
      {data.uncountedInflow.count > 0 && (
        <p className="chart__note" style={{ padding: 'var(--sp-3) var(--sp-5) 0', color: 'var(--status-warning)' }}>
          <Icon name="alert" size={12} /> {data.uncountedInflow.count}{' '}
          {data.uncountedInflow.count === 1 ? 'entrada ficou' : 'entradas ficaram'} fora do DRE ({money(data.uncountedInflow.cents)}): estão numa
          categoria de despesa. Se for pagamento de cliente, mude para uma categoria de receita em Transações.
        </p>
      )}
      <p className="chart__note" style={{ padding: '0 var(--sp-5) var(--sp-5)' }}>
        Margem é o lucro dividido pela receita líquida. Categoria sem grupo do DRE entra como Receita Bruta ou Despesa Operacional; gasto de
        categoria pessoal pago pela conta PJ conta como retirada, não como despesa da empresa. O grupo de cada categoria se ajusta em Categorias.
      </p>
    </Card>
  )
}

type IrpfSummary = {
  year: number
  through: string
  totalCents: number
  groups: Array<{
    group: string
    label: string
    totalCents: number
    count: number
    capCents: number | null
    categories: Array<{ id: number; path: string; totalCents: number; count: number; source: 'manual' | 'auto' }>
  }>
  notDeductible: Array<{ path: string; totalCents: number }>
  recommendations: string[]
}

/**
 * O que do gasto pessoal deduz no IRPF no ano (decisions/0047,
 * services/irpf.ts): total por grupo, as categorias que entraram (marcadas
 * quando o app classificou pelo nome) e recomendações diretas.
 */
export function IrpfCard({ year }: { year: number }) {
  const query = useQuery({
    queryKey: ['irpf', year],
    queryFn: () => api.get<IrpfSummary>('/analytics/irpf', { year }),
  })
  const data = query.data
  const title = `Imposto de Renda: o que deduz em ${year}`

  if (query.isError && !data) {
    return (
      <Card span={12} title={title}>
        <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível ler as deduções agora. Tente novamente em instantes." />
      </Card>
    )
  }
  if (!data) {
    return (
      <Card span={12} title={title}>
        <SkeletonLines lines={4} />
      </Card>
    )
  }

  // Grupo sem gasto no ano não ocupa espaço: o que falta aparece nas recomendações.
  const groups = data.groups.filter((g) => g.totalCents > 0)
  return (
    <Card span={12} title={title} subtitle={`Ano-base ${year}, declarado em ${year + 1}. Contas pessoais, de janeiro até ${periodLong(data.through.slice(0, 7))}; a PJ fica de fora, gasto da empresa não deduz na pessoa física.`}>
      <div className="irpf">
        <div className="irpf__total">
          <span className="muted">Dedutível no ano</span>
          <strong className="tabular">{money(data.totalCents)}</strong>
        </div>
        {groups.length > 0 && (
          <ul className="irpf__groups">
            {groups.map((g) => (
              <li key={g.group} className="irpf__group">
                <div className="irpf__group-head">
                  <span>{g.label}</span>
                  <span className="tabular">{money(g.totalCents)}</span>
                </div>
                {g.capCents !== null && <span className="irpf__note">limite de {money(g.capCents)} por pessoa</span>}
                {g.categories.map((c) => (
                  <span key={c.id} className="irpf__note">
                    {c.path} · {money(c.totalCents)}
                    {c.source === 'auto' ? ' · pelo nome' : ''}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
        {data.recommendations.length > 0 && (
          <div className="irpf__recs">
            <span className="irpf__recs-title">Recomendações</span>
            <ul>
              {data.recommendations.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}
