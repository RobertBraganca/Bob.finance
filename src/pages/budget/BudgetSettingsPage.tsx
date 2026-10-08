import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { Button, Card, LoadError, PageSkeleton, Segmented } from '../../components/ui'
import { PageHeader } from '../../components/shell/Shell'
import { AllocationPanel } from './AllocationPanel'
import { CategoryGroupsPanel } from './CategoryGroupsPanel'
import type { BudgetSettings } from './types'

type Tab = 'percentuais' | 'tags'

/** Orçamento › Ajustar: os % de cada grupo e a ligação TAG → grupo (specs/budget-groups). */
export function BudgetSettingsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('aba') === 'tags' ? 'tags' : 'percentuais'
  const query = useQuery({
    queryKey: ['budget-settings'],
    queryFn: () => api.get<BudgetSettings>('/budget/settings'),
  })

  return (
    <>
      <PageHeader
        title="Ajustar orçamento"
        subtitle="Quanto da renda vai para cada grupo, e a qual grupo cada TAG pertence"
        actions={
          <Button variant="quiet" icon="arrowLeft" onClick={() => navigate('/metas')}>
            Orçamento
          </Button>
        }
        filters={
          <Segmented
            ariaLabel="Seção"
            className="segmented--nav"
            value={tab}
            onChange={(next) =>
              setParams(
                (current) => {
                  const fresh = new URLSearchParams(current)
                  if (next === 'tags') fresh.set('aba', 'tags')
                  else fresh.delete('aba')
                  return fresh
                },
                { replace: true },
              )
            }
            options={[
              { value: 'percentuais', label: 'Percentuais' },
              { value: 'tags', label: 'TAGs dos grupos' },
            ]}
          />
        }
      />
      <div className="page tab-panel" key={tab}>
        {query.isError && !query.data ? (
          <Card>
            <LoadError onRetry={() => query.refetch()} retrying={query.isFetching} />
          </Card>
        ) : !query.data ? (
          <PageSkeleton cards={[{ span: 6, variant: 'block', height: 320 }, { span: 6, variant: 'lines' }]} />
        ) : tab === 'tags' ? (
          <CategoryGroupsPanel key={query.dataUpdatedAt} settings={query.data} />
        ) : (
          <AllocationPanel key={query.dataUpdatedAt} settings={query.data} />
        )}
      </div>
    </>
  )
}
