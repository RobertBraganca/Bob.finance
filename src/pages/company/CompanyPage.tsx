import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { bps, money, period as fmtPeriod, periodLong } from '../../lib/format'
import { currentPeriod, periodBounds } from '../../lib/period'
import { useRange } from '../../lib/store'
import { Bento, Button, Card, EmptyState, Icon, LoadError, Meter, PageSkeleton, Slab, type MeterState } from '../../components/ui'
import { PageHeader, RangeFilter } from '../../components/shell/Shell'
import { CompanySeriesChart } from '../../components/charts/CompanyCharts'
import { DreDetails } from '../Dre'
import { CompanySettingsModal } from './CompanySettingsModal'
import type { CompanyOverview } from './types'

const CEILING_STATE: Record<CompanyOverview['ceiling']['state'], MeterState> = { ok: 'on_track', attention: 'at_risk', critical: 'exceeded' }

/**
 * Minha empresa (MEI), specs/company-mei e decisions/0043: quanto dá para
 * retirar este mês sem a PJ ficar sem o colchão, a cascata do faturamento
 * até o que ficou, o teto do MEI e se as retiradas cobrem o custo de vida.
 * Simulação e observação, nunca recomendação (decisions/0010).
 */
export function CompanyPage() {
  const range = useRange()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  // O mês de referência é o do fim do período global, nunca depois do mês corrente.
  const today = currentPeriod()
  const period = range.to ? (range.to.slice(0, 7) > today ? today : range.to.slice(0, 7)) : today

  const query = useQuery({
    queryKey: ['company', period],
    queryFn: () => api.get<CompanyOverview>('/company/overview', { period }),
    enabled: range.ready,
    placeholderData: (previous) => previous,
  })
  const data = query.data

  return (
    <>
      <PageHeader
        title="Minha empresa"
        subtitle="Quanto dá para retirar, o caminho do faturamento e o teto do MEI"
        filters={<RangeFilter hideAccountFilter />}
        actions={
          <Button icon="settings" onClick={() => setSettingsOpen(true)}>
            Ajustar
          </Button>
        }
      />
      <div className="page stack stack--loose" aria-busy={query.isFetching || undefined}>
        {query.isError && !data ? (
          <Card>
            <LoadError onRetry={() => query.refetch()} retrying={query.isFetching} />
          </Card>
        ) : !data ? (
          <PageSkeleton cards={[{ span: 6, variant: 'stats', height: 220 }, { span: 6, variant: 'lines' }, { span: 12, variant: 'block', height: 260 }]} />
        ) : !data.pjAccount ? (
          <Card>
            <EmptyState
              icon="alert"
              title="Escolha a conta da empresa"
              body="Esta tela lê a conta PJ configurada no Motor financeiro. Configure qual conta é a da empresa por lá."
            />
          </Card>
        ) : (
          <>
            <Bento>
              <HighlightSlab data={data} />
              <Card span={6} title="Teto do MEI" subtitle={`Faturado em ${data.period.slice(0, 4)} até ${fmtPeriod(data.period)}`} assumptions={{ teto: data.assumptions.teto }}>
                <CeilingBody data={data} />
              </Card>
              <Card span={6} title="O mês na empresa" subtitle={`${data.pjAccount.name} · ${periodLong(data.period)}`}>
                <CascadeList data={data} />
              </Card>
              <Card span={6} title="As retiradas cobrem o custo de vida?" assumptions={{ retiradas: data.assumptions.retiradas, gastosPessoais: data.assumptions.gastosPessoais }}>
                <CoverageBody data={data} />
              </Card>
              <Card span={12} title="12 meses" subtitle="Faturamento, o que você retirou e o que gastou na vida pessoal">
                <CompanySeriesChart points={data.series} />
              </Card>
            </Bento>

            <section className="company-details">
              <button type="button" className="company-details__toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((v) => !v)}>
                <Icon name={detailsOpen ? 'chevronDown' : 'chevronRight'} size={15} />
                Detalhe por TAG e DRE contábil
                <span className="field__hint">colunas por conta, no período do filtro</span>
              </button>
              {detailsOpen && <DreDetails />}
            </section>
          </>
        )}
      </div>
      {settingsOpen && <CompanySettingsModal onClose={() => setSettingsOpen(false)} />}
    </>
  )
}

function HighlightSlab({ data }: { data: CompanyOverview }) {
  const w = data.withdrawable
  if (!w) {
    const kept = data.cascade.keptCents
    return (
      <Slab span={6} accent title="Ficou na empresa" subtitle={periodLong(data.period)}>
        <span className="display numeral" style={{ fontSize: 'var(--text-hero, 2.5rem)' }}>{money(kept)}</span>
        <p className="company-foot">
          {kept < 0
            ? `As retiradas passaram do lucro do mês em ${money(-kept)}: saiu dinheiro de meses anteriores.`
            : `Lucro de ${money(data.cascade.profitCents)} menos ${money(data.cascade.withdrawalsCents)} retirados.`}
        </p>
      </Slab>
    )
  }
  return (
    <Slab span={6} accent title="Retirada possível este mês" assumptions={{ retiradaPossivel: data.assumptions.retiradaPossivel, colchao: data.assumptions.colchao, das: data.assumptions.das }}>
      <span className="display numeral" style={{ fontSize: 'var(--text-hero, 2.5rem)' }}>{money(w.withdrawableCents)}</span>
      <p className="company-foot">
        {w.shortfallCents > 0
          ? `A PJ já está ${money(w.shortfallCents)} abaixo do colchão de ${w.cushionMonths} ${w.cushionMonths === 1 ? 'mês' : 'meses'}.`
          : `Se você retirar até ${money(w.withdrawableCents)}, a PJ fica com o colchão de ${w.cushionMonths} ${w.cushionMonths === 1 ? 'mês' : 'meses'}.`}
      </p>
      <dl className="company-lines company-lines--slab">
        <Line label="Caixa da PJ hoje" value={w.cashCents} />
        <Line label={`DAS do mês ${w.dasDueCents > 0 ? 'a pagar' : 'já pago'}`} value={-w.dasDueCents} />
        <Line label="Contas da PJ a pagar no mês" value={-w.pendingCents} />
        <Line label={`Colchão: ${w.cushionMonths} × ${money(w.fixedMonthlyCents)} de custo fixo`} value={-w.cushionCents} />
        <Line label="Retirada possível" value={w.withdrawableCents} total />
      </dl>
      {w.withdrawnThisMonthCents > 0 && <p className="company-foot">Você já retirou {money(w.withdrawnThisMonthCents)} este mês; o caixa acima é depois disso.</p>}
    </Slab>
  )
}

function Line({ label, value, total }: { label: string; value: number; total?: boolean }) {
  return (
    <div className={`company-line${total ? ' company-line--total' : ''}`}>
      <dt>{label}</dt>
      {/* `|| 0` tira o −0 (DAS e custos zerados chegam como −0 e virariam "-R$ 0,00"). */}
      <dd className="numeral">{value < 0 ? `− ${money(-value)}` : money(value || 0)}</dd>
    </div>
  )
}

function CeilingBody({ data }: { data: CompanyOverview }) {
  const c = data.ceiling
  return (
    <div className="stack">
      <div className="row row--between" style={{ alignItems: 'baseline' }}>
        <span className="numeral" style={{ fontSize: 'var(--text-xl)', fontWeight: 700 }}>{money(c.yearRevenueCents)}</span>
        <span className="field__hint">de {money(c.limitCents)} · {bps(c.usedBps, 0)}</span>
      </div>
      <Meter usedBps={c.usedBps} paceBps={c.projectedShareBps} state={CEILING_STATE[c.state]} />
      <p className="plan-evidence">
        {c.paceCents > 0
          ? `No ritmo dos últimos 3 meses (${money(c.paceCents)} por mês), o ano fecha em ${money(c.projectedYearCents)}, ${bps(c.projectedShareBps, 0)} do teto.`
          : 'Sem faturamento nos últimos 3 meses para projetar o ano.'}
        {c.reachesInPeriod && ` Nesse ritmo o teto seria alcançado em ${periodLong(c.reachesInPeriod)}.`}
      </p>
    </div>
  )
}

function CascadeList({ data }: { data: CompanyOverview }) {
  const navigate = useNavigate()
  const range = useRange()
  const c = data.cascade
  const open = () => {
    const { from, to } = periodBounds(data.period)
    range.setCustom(from, to)
    range.setAccountId(data.pjAccount!.id)
    navigate('/lancamentos')
  }
  return (
    <div className="stack">
      <dl className="company-lines">
        <Line label="Faturamento" value={c.revenueCents} />
        <Line label={data.dasPending && c.dasCents === 0 ? `DAS (não apareceu no extrato; previsto ${money(data.dasMonthlyCents)})` : 'DAS'} value={-c.dasCents} />
        <Line label="Custos da empresa" value={-c.costsCents} />
        <Line label="Lucro do mês" value={c.profitCents} total />
        <Line label="Retiradas para a pessoa física" value={-c.withdrawalsCents} />
        <Line label="Ficou na empresa" value={c.keptCents} total />
      </dl>
      <div>
        <Button size="sm" variant="quiet" icon="arrowRight" onClick={open}>
          Ver os lançamentos da PJ no mês
        </Button>
      </div>
    </div>
  )
}

function CoverageBody({ data }: { data: CompanyOverview }) {
  const c = data.coverage
  return (
    <div className="stack">
      <span className="numeral" style={{ fontSize: 'var(--text-xl)', fontWeight: 700 }}>
        {c.coverageBps === null ? '-' : bps(c.coverageBps, 0)}
      </span>
      <p className="plan-evidence">
        {c.coverageBps === null
          ? 'Sem gastos pessoais registrados no mês para comparar.'
          : `As retiradas de ${money(c.withdrawalsCents)} ${c.coverageBps >= 10_000 ? 'cobriram' : 'cobriram só parte de'} os ${money(c.personalSpentCents)} de gastos pessoais do mês.`}
        {c.livingCostCents > 0 && ` O custo de vida típico (o da reserva) é ${money(c.livingCostCents)} por mês.`}
      </p>
    </div>
  )
}
