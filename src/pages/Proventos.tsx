import { useId, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { invalidateInvestmentData } from '../lib/invalidate'
import { bps, centsToInput, money, parseMoneyInput, date as fmtDate, quantity as fmtQuantity } from '../lib/format'
import {
  Bento,
  Button,
  Card,
  EmptyState,
  FilterSelect,
  KpiTile,
  Meter,
  Modal,
  Segmented,
  SkeletonBlock,
  SkeletonLines,
  targetProgressState,
  TextInput,
  useToast,
} from '../components/ui'
import { ProventosDistributionRing, ProventosEvolutionChart, type ProventoEvolutionPoint } from '../components/charts/ProventosCharts'
import { DIVIDEND_TYPE_LABEL, TradeModal, type Position } from './Investments'

/**
 * Vira aba dentro de Investimentos (mesmo padrão de `AposentadoriaTab`),
 * pedida pelo usuário a partir de três prints de referência de um app de
 * corretora. Tudo derivado de `asset_trades` (kind='dividend') — nenhuma
 * tabela nova de proventos, só os dois campos que faltavam nela (tipo de
 * provento, Data Com) e uma meta mensal configurável opcional. Ver
 * `docs/specs/investments/spec.md` e o plano desta sessão para o desenho
 * completo (status pago/a receber sempre derivado da Data de pagamento
 * contra hoje, nunca guardado).
 */

type ProventosResumo = {
  avgMonthlyCents: number
  total12mCents: number
  totalWalletCents: number
  monthlyTargetCents: number | null
  progressBps: number | null
  distribution: Array<{ assetId: number; ticker: string | null; name: string; totalCents: number; shareBps: number }>
}

type ProventoHistoricoRow = { year: string; months: number[]; avgCents: number; totalCents: number }

type ProventoRow = {
  id: number
  assetId: number
  ticker: string | null
  assetName: string
  assetClass: string
  status: 'pago' | 'a_receber'
  dividendType: string | null
  exDate: string | null
  tradedOn: string
  quantity: number
  unitPriceCents: number
  grossCents: number
  netCents: number
}

const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

/**
 * Média mensal de um ano do histórico. O servidor divide sempre por 12, o
 * que no ano corrente diluía a média pelos meses que ainda não chegaram
 * (2026: R$ 32,93 ÷ 12 = R$ 2,74, com 9 meses passados). No ano corrente
 * divide pelos meses já fechados, ou até o último mês com pagamento, o que
 * for maior.
 */
function yearAverageCents(row: ProventoHistoricoRow): number {
  const now = new Date()
  if (Number(row.year) !== now.getFullYear()) return row.avgCents
  const lastPaidMonth = row.months.reduce((last, cents, i) => (cents > 0 ? i + 1 : last), 0)
  const months = Math.max(now.getMonth(), lastPaidMonth, 1)
  return Math.round(row.totalCents / months)
}

export function ProventosTab({ positions, classes }: { positions: Position[]; classes: Array<{ value: string; label: string }> }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const [granularity, setGranularity] = useState<'monthly' | 'annual'>('monthly')
  const [assetClassFilter, setAssetClassFilter] = useState<string | null>(null)
  const [assetIdFilter, setAssetIdFilter] = useState<number | null>(null)
  const [yearFilter, setYearFilter] = useState<string | null>(null)
  const [editingTarget, setEditingTarget] = useState(false)
  const [targetInput, setTargetInput] = useState('')
  const [registering, setRegistering] = useState(false)
  const targetInputFieldId = useId()

  const resumo = useQuery({
    queryKey: ['proventos-resumo'],
    queryFn: () => api.get<ProventosResumo>('/investments/proventos/resumo'),
  })

  const evolucao = useQuery({
    queryKey: ['proventos-evolucao', granularity, assetClassFilter, assetIdFilter],
    queryFn: () =>
      api.get<{ evolucao: ProventoEvolutionPoint[] }>('/investments/proventos/evolucao', {
        granularity,
        assetClass: assetClassFilter,
        assetId: assetIdFilter,
      }),
  })

  const historico = useQuery({
    queryKey: ['proventos-historico', assetClassFilter, assetIdFilter],
    queryFn: () =>
      api.get<{ historico: ProventoHistoricoRow[] }>('/investments/proventos/historico', {
        assetClass: assetClassFilter,
        assetId: assetIdFilter,
      }),
  })

  const lista = useQuery({
    queryKey: ['proventos-lista', yearFilter, assetClassFilter, assetIdFilter],
    queryFn: () =>
      api.get<{ proventos: ProventoRow[] }>('/investments/proventos', {
        year: yearFilter,
        assetClass: assetClassFilter,
        assetId: assetIdFilter,
      }),
  })

  const setTarget = useMutation({
    mutationFn: (monthlyTargetCents: number | null) =>
      api.put('/investments/passive-income-settings', { monthlyTargetCents }),
    onSuccess: (_, monthlyTargetCents) => {
      toast(monthlyTargetCents === null ? 'Meta removida' : 'Meta atualizada')
      invalidateInvestmentData(queryClient)
      setEditingTarget(false)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const classLabel = (value: string) => classes.find((c) => c.value === value)?.label ?? value
  const assetOptions = positions.map((p) => ({ value: p.assetId, label: p.name }))

  const data = resumo.data

  /*
   * A distribuição por ativo vem do resumo, que o servidor não filtra. O
   * filtro da página vale para ela também (no cliente, pela classe de cada
   * ativo), senão a rosca seria o único bloco abaixo do filtro a ignorá-lo.
   */
  const distribution = useMemo(() => {
    const rows = (data?.distribution ?? []).filter((d) => {
      if (assetIdFilter !== null) return d.assetId === assetIdFilter
      if (assetClassFilter !== null) return positions.find((p) => p.assetId === d.assetId)?.assetClass === assetClassFilter
      return true
    })
    const total = rows.reduce((sum, d) => sum + d.totalCents, 0)
    return rows.map((d) => ({ ...d, shareBps: total > 0 ? Math.round((d.totalCents / total) * 10_000) : 0 }))
  }, [data, assetClassFilter, assetIdFilter, positions])

  return (
    <div className="stack stack--loose">
      {/* A linha de KPIs do Painel (04/10/2026): os números da carteira inteira
          primeiro, antes de qualquer filtro. A meta mensal ganhou um tile
          próprio, com a barra, no lugar da linha "Ajustar meta" solta. */}
      {resumo.isError ? (
        <Card>
          <EmptyState
            icon="alert"
            title="Falha ao carregar"
            body="Não foi possível carregar o resumo de proventos agora. Tente novamente em instantes."
          />
        </Card>
      ) : !data ? (
        <Card>
          <SkeletonLines lines={3} />
        </Card>
      ) : (
        <div className="kpi-row">
          <KpiTile
            accent
            label="Média mensal"
            value={money(data.avgMonthlyCents)}
            foot={<span>últimos 12 meses</span>}
            assumptions={{
              formula: 'Proventos pagos nos últimos 12 meses divididos por 12. Os que ainda vão pagar não entram.',
            }}
          />
          <KpiTile label="Total de 12 meses" value={money(data.total12mCents)} tone={data.total12mCents > 0 ? 'up' : undefined} />
          <KpiTile label="Desde o início" value={money(data.totalWalletCents)} foot={<span>toda a carteira</span>} />
          <section className="card kpi">
            <div className="card__title-row">
              <span className="stat__label">Meta de renda passiva</span>
            </div>
            <span className="stat__value kpi__value">
              {data.monthlyTargetCents === null ? 'Sem meta' : `${money(data.monthlyTargetCents)}/mês`}
            </span>
            {data.monthlyTargetCents !== null && (
              <Meter usedBps={data.progressBps ?? 0} state={targetProgressState(data.progressBps)} />
            )}
            <span className="stat__foot">
              {data.monthlyTargetCents !== null && <span>{bps(data.progressBps ?? 0, 1)} alcançado</span>}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setTargetInput(data.monthlyTargetCents !== null ? centsToInput(data.monthlyTargetCents) : '')
                  setEditingTarget(true)
                }}
              >
                {data.monthlyTargetCents === null ? 'Definir meta' : 'Ajustar'}
              </button>
            </span>
          </section>
        </div>
      )}

      {/* Um filtro para os gráficos e as listas, numa linha de controle: antes
          os mesmos dois seletores se repetiam em três cards e mexiam todos
          juntos, sem dizer isso. */}
      <div className="row row--wrap row--between" style={{ gap: 'var(--sp-2)' }}>
        <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
          <FilterSelect
            icon="filter"
            value={assetClassFilter}
            placeholder="Todos os tipos"
            options={classes}
            onChange={setAssetClassFilter}
          />
          <FilterSelect
            icon="filter"
            value={assetIdFilter}
            placeholder="Todos os ativos"
            options={assetOptions}
            onChange={setAssetIdFilter}
          />
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            vale para os gráficos e as listas abaixo
          </span>
        </div>
        <Button size="sm" icon="plus" onClick={() => setRegistering(true)}>
          Registrar provento
        </Button>
      </div>

      <Bento>
        <Card span={6} title="Por ativo" subtitle="Recebidos nos últimos 12 meses">
          {!data ? <SkeletonBlock height={220} /> : <ProventosDistributionRing slices={distribution} />}
        </Card>

        <Card
          span={6}
          title="Evolução"
          subtitle="Recebidos e a receber, período a período"
          actions={
            <Segmented
              ariaLabel="Granularidade"
              value={granularity}
              onChange={setGranularity}
              options={[
                { value: 'monthly', label: 'Mensal' },
                { value: 'annual', label: 'Anual' },
              ]}
            />
          }
        >
          {evolucao.isError ? (
            <EmptyState
              icon="alert"
              title="Falha ao carregar"
              body="Não foi possível carregar a evolução de proventos agora. Tente novamente em instantes."
            />
          ) : !evolucao.data ? (
            <SkeletonBlock height={260} />
          ) : (
            <ProventosEvolutionChart data={evolucao.data.evolucao} granularity={granularity} />
          )}
        </Card>
      </Bento>

      <Card
        span={12}
        flush
        title="Histórico mensal"
        subtitle="Só o que já foi pago. No ano corrente, a média conta só os meses que já passaram"
      >
        {historico.isError ? (
          <EmptyState
            icon="alert"
            title="Falha ao carregar"
            body="Não foi possível carregar o histórico agora. Tente novamente em instantes."
          />
        ) : !historico.data ? (
          <SkeletonLines lines={4} />
        ) : historico.data.historico.length === 0 ? (
          <EmptyState icon="list" title="Nenhum provento ainda" body="O histórico aparece assim que houver um provento pago." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Ano</th>
                  {MONTH_LABELS.map((label) => (
                    <th key={label} scope="col" className="table__num table__col--secondary">
                      {label}
                    </th>
                  ))}
                  <th scope="col" className="table__num">Média</th>
                  <th scope="col" className="table__num">Total</th>
                </tr>
              </thead>
              <tbody>
                {historico.data.historico.map((row) => (
                  <tr key={row.year}>
                    <td>{row.year}</td>
                    {row.months.map((cents, i) => (
                      <td key={i} className="table__num table__col--secondary">
                        {cents === 0 ? <span className="muted">-</span> : money(cents)}
                      </td>
                    ))}
                    <td className="table__num">{money(yearAverageCents(row))}</td>
                    <td className="table__num">
                      <strong>{money(row.totalCents)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        span={12}
        flush
        title="Meus proventos"
        subtitle="Todo lançamento de dividendo ou JSCP, pago ou a receber"
        actions={
          <FilterSelect
            icon="calendar"
            value={yearFilter}
            placeholder="Todos os anos"
            options={historico.data?.historico.map((r) => ({ value: r.year, label: r.year })) ?? []}
            onChange={setYearFilter}
          />
        }
      >
        {lista.isError ? (
          <EmptyState
            icon="alert"
            title="Falha ao carregar"
            body="Não foi possível carregar os proventos agora. Tente novamente em instantes."
          />
        ) : !lista.data ? (
          <SkeletonLines lines={4} />
        ) : lista.data.proventos.length === 0 ? (
          <EmptyState
            icon="list"
            title="Nenhum provento lançado"
            body="Registre um dividendo ou JSCP pelo botão desta tela, ou por Registrar operação, no topo da página."
          />
        ) : (
          <ProventosTable rows={lista.data.proventos} classLabel={classLabel} />
        )}
      </Card>

      {registering && (
        <TradeModal classes={classes} positions={positions} initialKind="dividend" onClose={() => setRegistering(false)} />
      )}
      {editingTarget && data && (
        <Modal
          title="Meta de renda passiva"
          onClose={() => setEditingTarget(false)}
          footer={
            <>
              {data.monthlyTargetCents !== null ? (
                <Button variant="quiet" onClick={() => setTarget.mutate(null)} disabled={setTarget.isPending}>
                  Remover meta
                </Button>
              ) : (
                <span />
              )}
              <span className="row" style={{ gap: 'var(--sp-2)' }}>
                <Button variant="quiet" onClick={() => setEditingTarget(false)}>
                  Cancelar
                </Button>
                <Button
                  variant="primary"
                  icon="check"
                  onClick={() => setTarget.mutate(Math.abs(parseMoneyInput(targetInput) ?? 0))}
                  loading={setTarget.isPending}
                >
                  Salvar
                </Button>
              </span>
            </>
          }
        >
          <div className="field">
            <label className="field__label" htmlFor={targetInputFieldId}>
              Quanto você quer receber de proventos por mês (R$)
            </label>
            <TextInput id={targetInputFieldId} value={targetInput} onChange={setTargetInput} placeholder="0,00" numeral />
            <span className="field__hint">Comparada com a média mensal dos últimos 12 meses.</span>
          </div>
        </Modal>
      )}
    </div>
  )
}

/**
 * Coluna que não diz nada em nenhuma linha some: "Tipo de pagamento" era
 * "Não informado" e "Data Com" era "-" em todas, e com quantidade 1 o valor
 * por cota, o total e o líquido eram três cópias do mesmo número (revisão
 * de 03/10/2026). Quando um lançamento traz o dado, a coluna volta.
 */
function ProventosTable({ rows, classLabel }: { rows: ProventoRow[]; classLabel: (value: string) => string }) {
  const showType = rows.some((p) => p.dividendType)
  const showExDate = rows.some((p) => p.exDate)
  const showPerUnit = rows.some((p) => p.quantity !== 1)
  const showNet = rows.some((p) => p.netCents !== p.grossCents)

  return (
    <div className="table-wrap">
      <table className="table table--stack-mobile table--stack-compact">
        <thead>
          <tr>
            <th scope="col">Ativo</th>
            <th scope="col">Tipo de ativo</th>
            <th scope="col">Status</th>
            {showType && <th scope="col">Tipo de pagamento</th>}
            {showExDate && <th scope="col">Data Com</th>}
            <th scope="col">Data de pagamento</th>
            {showPerUnit && <th scope="col" className="table__num">Quantidade</th>}
            {showPerUnit && <th scope="col" className="table__num">Por cota</th>}
            <th scope="col" className="table__num">{showNet ? 'Bruto' : 'Valor'}</th>
            {showNet && <th scope="col" className="table__num">Líquido</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td data-label="__lead">
                <strong style={{ fontWeight: 500 }}>{p.ticker ?? p.assetName}</strong>
              </td>
              <td className="muted" data-label="Tipo de ativo">{classLabel(p.assetClass)}</td>
              <td data-label="__trail">
                <span className={`badge ${p.status === 'a_receber' ? '' : 'badge--good'}`}>
                  {p.status === 'a_receber' ? 'A receber' : 'Pago'}
                </span>
              </td>
              {showType && (
                <td className="muted" data-label="Tipo de pagamento">
                  {p.dividendType ? (DIVIDEND_TYPE_LABEL[p.dividendType] ?? p.dividendType) : 'Não informado'}
                </td>
              )}
              {showExDate && <td className="muted" data-label="Data Com">{p.exDate ? fmtDate(p.exDate) : '-'}</td>}
              <td data-label="Pagamento">{fmtDate(p.tradedOn)}</td>
              {showPerUnit && <td className="table__num" data-label="Quantidade">{fmtQuantity(p.quantity)}</td>}
              {showPerUnit && <td className="table__num" data-label="Por cota">{money(p.unitPriceCents)}</td>}
              <td className="table__num" data-label={showNet ? 'Bruto' : 'Valor'}>
                {showNet ? money(p.grossCents) : <strong>{money(p.grossCents)}</strong>}
              </td>
              {showNet && (
                <td className="table__num" data-label="Líquido">
                  <strong>{money(p.netCents)}</strong>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
