import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { currentPeriod } from '../../lib/period'
import { money } from '../../lib/format'
import { Card, EmptyState, Icon, LoadError, SkeletonLines, StatTile } from '../../components/ui'
import { RiskRow, monthsLabel, type HealthScore, type RiskRadar, type Runway } from './healthParts'

/**
 * A Saúde financeira dissolvida (docs/specs/tarefas-comercial-contador): o score
 * e o runway viram um card da Visão geral; o radar de risco, um card do
 * Orçamento. A página continua no endereço `/saude`, com a composição, o
 * histórico e os ajustes, e é para lá que o "ver detalhes" leva.
 */
export function HealthSummaryCard({ span = 6 }: { span?: 6 | 12 }) {
  const period = currentPeriod()
  const score = useQuery({
    queryKey: ['financial-health-score', period],
    queryFn: () => api.get<HealthScore>('/financial-health/score', { period }),
  })
  const runway = useQuery({ queryKey: ['financial-health-runway'], queryFn: () => api.get<Runway>('/financial-health/runway') })
  const s = score.data
  const r = runway.data?.consolidated

  return (
    <Card
      span={span}
      title="Saúde financeira"
      subtitle="O score do mês e quantos meses o dinheiro pessoal cobre"
      assumptions={s?.assumptions}
      actions={
        <Link to="/saude" className="row" style={{ gap: 'var(--sp-1)', fontSize: 'var(--text-sm)' }}>
          Ver detalhes <Icon name="arrowRight" size={14} />
        </Link>
      }
    >
      {score.isError || runway.isError ? (
        <LoadError
          onRetry={() => {
            score.refetch()
            runway.refetch()
          }}
          retrying={score.isFetching || runway.isFetching}
        />
      ) : !s || !r ? (
        <SkeletonLines lines={3} />
      ) : (
        <div className="form-grid">
          <StatTile
            label="Health Score do mês"
            large
            value={s.scoreBps === null ? 'sem dado' : `${Math.round(s.scoreBps / 100)} de 100`}
            foot={
              <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                {s.scoreBps === null
                  ? 'Nenhum indicador com dado suficiente'
                  : `${s.indicators.filter((i) => i.scoreBps !== null).length} de ${s.indicators.length} indicadores`}
              </span>
            }
          />
          <StatTile
            label="Runway pessoal"
            large
            value={monthsLabel(r.months)}
            foot={
              <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                {money(r.netWorthCents)} considerados, {money(r.monthlyCostCents)} por mês
              </span>
            }
          />
        </div>
      )}
    </Card>
  )
}

export function RiskRadarCard({ span = 12, period }: { span?: 6 | 12; period: string }) {
  const radar = useQuery({
    queryKey: ['financial-health-radar', period],
    queryFn: () => api.get<RiskRadar>('/financial-health/risk-radar', { period }),
  })
  return (
    <Card
      span={span}
      title="Radar de risco"
      assumptions={radar.data?.assumptions}
      subtitle="Cada indicador comparado com o limite que você configurou"
      actions={
        <Link to="/saude" className="row" style={{ gap: 'var(--sp-1)', fontSize: 'var(--text-sm)' }}>
          Ajustar limites <Icon name="arrowRight" size={14} />
        </Link>
      }
    >
      {radar.isError ? (
        <LoadError onRetry={() => radar.refetch()} retrying={radar.isFetching} />
      ) : !radar.data ? (
        <SkeletonLines lines={5} />
      ) : radar.data.rules.length === 0 ? (
        <EmptyState
          icon="info"
          title="Nenhuma regra aplicável neste período"
          body="Uma regra sem dado suficiente fica de fora do radar, em vez de aparecer como se estivesse dentro da faixa."
        />
      ) : (
        <div className="stack stack--loose">
          {radar.data.rules.map((rule) => (
            <RiskRow key={rule.key} rule={rule} />
          ))}
        </div>
      )}
    </Card>
  )
}
