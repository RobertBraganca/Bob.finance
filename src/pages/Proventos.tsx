import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { bps, centsToInput, money, parseMoneyInput, date as fmtDate, quantity as fmtQuantity } from '../lib/format'
import {
  Bento,
  Button,
  Card,
  EmptyState,
  FilterSelect,
  Meter,
  Segmented,
  SkeletonLines,
  StatTile,
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
      queryClient.invalidateQueries()
      setEditingTarget(false)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const classLabel = (value: string) => classes.find((c) => c.value === value)?.label ?? value
  const assetOptions = positions.map((p) => ({ value: p.assetId, label: p.name }))

  const data = resumo.data

  return (
    <Bento>
      <Card
        span={5}
        title="Resumo"
        actions={
          <Button variant="primary" size="sm" icon="plus" onClick={() => setRegistering(true)}>
            Registrar provento
          </Button>
        }
      >
        {resumo.isError ? (
          <EmptyState
            icon="alert"
            title="Falha ao carregar"
            body="Não foi possível carregar o resumo de proventos agora. Tente novamente em instantes."
          />
        ) : !data ? (
          <SkeletonLines lines={5} />
        ) : (
          <div className="stack">
            <div className="row row--between row--wrap">
              <StatTile label="Média mensal (últ. 12 meses)" value={money(data.avgMonthlyCents)} large />
              <StatTile label="Total de 12 meses" value={money(data.total12mCents)} />
              <StatTile label="Total da carteira" value={money(data.totalWalletCents)} />
            </div>

            {!editingTarget ? (
              <div className="row row--between" style={{ fontSize: 'var(--text-xs)' }}>
                <span className="muted">
                  {data.monthlyTargetCents !== null
                    ? `Meta mensal: ${money(data.monthlyTargetCents)}`
                    : 'Nenhuma meta mensal configurada'}
                </span>
                <Button
                  variant="quiet"
                  size="sm"
                  icon="pencil"
                  onClick={() => {
                    setTargetInput(data.monthlyTargetCents !== null ? centsToInput(data.monthlyTargetCents) : '')
                    setEditingTarget(true)
                  }}
                >
                  Ajustar meta
                </Button>
              </div>
            ) : (
              <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
                <div className="field" style={{ width: 180 }}>
                  <label className="field__label" htmlFor={targetInputFieldId}>Meta mensal de proventos (R$)</label>
                  <TextInput id={targetInputFieldId} value={targetInput} onChange={setTargetInput} placeholder="0,00" numeral />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  icon="check"
                  onClick={() => setTarget.mutate(Math.abs(parseMoneyInput(targetInput) ?? 0))}
                  disabled={setTarget.isPending}
                >
                  Salvar
                </Button>
                {data.monthlyTargetCents !== null && (
                  <Button variant="ghost" size="sm" onClick={() => setTarget.mutate(null)} disabled={setTarget.isPending}>
                    Remover meta
                  </Button>
                )}
                <Button variant="quiet" size="sm" onClick={() => setEditingTarget(false)}>
                  Cancelar
                </Button>
              </div>
            )}

            {data.monthlyTargetCents !== null && (
              <>
                <Meter usedBps={data.progressBps ?? 0} state={targetProgressState(data.progressBps)} />
                <p className="chart__note">
                  {money(data.avgMonthlyCents)} de {money(data.monthlyTargetCents)} · {bps(data.progressBps ?? 0, 1)}
                </p>
              </>
            )}

            <hr className="divider" />

            <div className="stack stack--tight">
              <span className="stat__label">Distribuição de proventos em 12 meses</span>
              <ProventosDistributionRing slices={data.distribution} />
            </div>
          </div>
        )}
      </Card>

      <Card
        span={6}
        title="Evolução de Proventos"
        subtitle="Recebidos x a receber, mês a mês"
        actions={
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <Segmented
              ariaLabel="Granularidade"
              value={granularity}
              onChange={setGranularity}
              options={[
                { value: 'monthly', label: 'Mensal' },
                { value: 'annual', label: 'Anual' },
              ]}
            />
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
          </div>
        }
      >
        {evolucao.isError ? (
          <EmptyState
            icon="alert"
            title="Falha ao carregar"
            body="Não foi possível carregar a evolução de proventos agora. Tente novamente em instantes."
          />
        ) : !evolucao.data ? (
          <SkeletonLines lines={4} />
        ) : (
          <ProventosEvolutionChart data={evolucao.data.evolucao} granularity={granularity} />
        )}
      </Card>

      <Card
        span={12}
        flush
        title="Histórico mensal"
        subtitle="Só o que já foi pago: o que ainda está a receber não entra nesta soma"
        actions={
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
          </div>
        }
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
                    <th key={label} scope="col" className="table__num">
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
                      <td key={i} className="table__num">
                        {cents === 0 ? <span className="muted">-</span> : money(cents)}
                      </td>
                    ))}
                    <td className="table__num">{money(row.avgCents)}</td>
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
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <FilterSelect
              icon="filter"
              value={yearFilter}
              placeholder="Todos os anos"
              options={historico.data?.historico.map((r) => ({ value: r.year, label: r.year })) ?? []}
              onChange={setYearFilter}
            />
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
          </div>
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
            body="Registre um dividendo ou JSCP pelo botão desta tela, ou pela aba Lançamentos."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Ativo</th>
                  <th scope="col">Tipo de ativo</th>
                  <th scope="col">Status</th>
                  <th scope="col">Tipo de pagamento</th>
                  <th scope="col">Data Com</th>
                  <th scope="col">Data Pagamento</th>
                  <th scope="col" className="table__num">Quantidade</th>
                  <th scope="col" className="table__num">Valor do div.</th>
                  <th scope="col" className="table__num">Valor total</th>
                  <th scope="col" className="table__num">Total líquido</th>
                </tr>
              </thead>
              <tbody>
                {lista.data.proventos.map((p) => (
                  <tr key={p.id}>
                    <td>{p.ticker ?? p.assetName}</td>
                    <td className="muted">{classLabel(p.assetClass)}</td>
                    <td>
                      <span className={`badge ${p.status === 'a_receber' ? '' : 'badge--good'}`}>
                        {p.status === 'a_receber' ? 'A Receber' : 'Pago'}
                      </span>
                    </td>
                    <td className="muted">{p.dividendType ? (DIVIDEND_TYPE_LABEL[p.dividendType] ?? p.dividendType) : 'Não informado'}</td>
                    <td className="muted">{p.exDate ? fmtDate(p.exDate) : '-'}</td>
                    <td>{fmtDate(p.tradedOn)}</td>
                    <td className="table__num">{fmtQuantity(p.quantity)}</td>
                    <td className="table__num">{money(p.unitPriceCents)}</td>
                    <td className="table__num">{money(p.grossCents)}</td>
                    <td className="table__num">
                      <strong>{money(p.netCents)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {registering && (
        <TradeModal classes={classes} positions={positions} initialKind="dividend" onClose={() => setRegistering(false)} />
      )}
    </Bento>
  )
}
