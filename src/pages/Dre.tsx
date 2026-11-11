import type { CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { money, periodLong } from '../lib/format'
import { Card, EmptyState, SkeletonLines } from '../components/ui'

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
  /** repasse líquido da PJ para as contas pessoais no período */
  withdrawnToPfCents: number | null
  keptCents: number | null
}

const SECTION: CSSProperties = { gridColumn: '1 / -1', textTransform: 'uppercase', fontSize: 'var(--text-2xs)', letterSpacing: '0.03em', marginTop: 'var(--sp-2)' }
const tone = (cents: number) => (cents < 0 ? 'neg' : 'pos')

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

  return (
    <Card span={12} flush title={title} subtitle={`${accountLabel} · ${periodLong(period)} · Receita Bruta → Lucro Líquido`}>
      <div className="kv" style={{ padding: '0 var(--sp-5)', fontSize: 'var(--text-base)' }}>
        <span className="kv__k" style={{ ...SECTION, marginTop: 0 }}>
          Receita
        </span>
        <span className="kv__k">Receita Bruta</span>
        <span className="kv__v pos">{money(data.receitaBrutaCents)}</span>
        <span className="kv__k">(−) Deduções da Receita</span>
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
        <span className={`kv__v ${tone(data.lucroBrutoCents)}`} style={{ fontWeight: 600 }}>
          {money(data.lucroBrutoCents)}
        </span>

        <span className="kv__k" style={SECTION}>
          Despesas Operacionais
        </span>
        <span className="kv__k">(−) Despesas Operacionais</span>
        <span className="kv__v neg">{money(data.despesasOperacionaisCents)}</span>
        <span className="kv__k" style={{ fontWeight: 600 }}>(=) Resultado Operacional (EBIT)</span>
        <span className={`kv__v ${tone(data.resultadoOperacionalCents)}`} style={{ fontWeight: 600 }}>
          {money(data.resultadoOperacionalCents)}
        </span>

        <span className="kv__k" style={SECTION}>
          Resultado Final
        </span>
        <span className="kv__k">(+/−) Resultado Financeiro</span>
        <span className={`kv__v ${tone(data.resultadoFinanceiroCents)}`}>{money(data.resultadoFinanceiroCents)}</span>
        <span className="kv__k">(−) Impostos sobre o Lucro</span>
        <span className="kv__v neg">{money(data.impostosCents)}</span>
        <span className="kv__k" style={{ fontWeight: 700 }}>(=) Lucro Líquido</span>
        <span className={`kv__v ${tone(data.lucroLiquidoCents)}`} style={{ fontWeight: 700 }}>
          {money(data.lucroLiquidoCents)}
        </span>

        {data.withdrawnToPfCents !== null && data.withdrawnToPfCents !== 0 && data.keptCents !== null && (
          <>
            <span className="kv__k" style={SECTION}>
              Depois das retiradas
            </span>
            <span className="kv__k">(−) Retiradas para a pessoa física</span>
            <span className="kv__v neg">{money(data.withdrawnToPfCents)}</span>
            <span className="kv__k" style={{ fontWeight: 700 }}>(=) Ficou na empresa</span>
            <span className={`kv__v ${tone(data.keptCents)}`} style={{ fontWeight: 700 }}>
              {money(data.keptCents)}
            </span>
          </>
        )}
      </div>
      <p className="chart__note" style={{ padding: '0 var(--sp-5) var(--sp-5)' }}>
        Categoria sem grupo do DRE entra como Receita Bruta ou Despesa Operacional. O grupo de cada categoria se ajusta em Categorias.
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
