import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Card, EmptyState, Icon, LoadError, SkeletonLines } from '../../components/ui'
import { RiskRow, type RiskRadar } from './healthParts'

/** O radar de risco do mês, mostrado no Orçamento; os limites se ajustam em `/saude`. */
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
