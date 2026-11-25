import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/shell/Shell'
import { Card, LoadError, Segmented, SkeletonLines } from '../../components/ui'
import { AnalysisTab } from './AnalysisTab'
import { LinkModal } from './LinkModal'
import { ListTab } from './ListTab'
import { ShoppingTab } from './ShoppingTab'
import { useActiveTrip, useBudget, useProducts, useTripItems } from './useGrocery'
import './grocery.css'

type Tab = 'lista' | 'mercado' | 'analise'
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'lista', label: 'Lista' },
  { value: 'mercado', label: 'No mercado' },
  { value: 'analise', label: 'Análise' },
]

/**
 * Mercado (docs/specs/lista-de-compras): a lista montada em casa, o total em
 * tempo real no supermercado contra o teto do mês e, com o histórico, quanto
 * a mesma cesta encareceu. A compra nunca cria lançamento: o gasto real vem do
 * Open Finance e a compra só se vincula a ele. Sem `?aba=`, abre em "No
 * mercado" se houver compra em andamento, senão em "Lista".
 */
export function GroceryPage() {
  const [params, setParams] = useSearchParams()
  const active = useActiveTrip()
  const products = useProducts()
  const budget = useBudget()
  const trip = active.data ?? null
  const tripItems = useTripItems(trip)
  const [linking, setLinking] = useState<number | null>(null)

  const requested = params.get('aba') as Tab | null
  const tab: Tab = requested && TABS.some((t) => t.value === requested) ? requested : trip?.status === 'shopping' ? 'mercado' : 'lista'
  const go = (next: Tab) => setParams((p) => {
    const copy = new URLSearchParams(p)
    copy.set('aba', next)
    return copy
  }, { replace: true })

  return (
    <>
      <PageHeader title="Mercado" subtitle="Lista de compras com o total na hora e o preço de cada produto ao longo do tempo" />
      <div className="page">
        <div className="stack">
          <Segmented<Tab> ariaLabel="Seções do Mercado" value={tab} onChange={go} options={TABS} />
          {tab === 'analise' ? (
            <AnalysisTab />
          ) : active.isError ? (
            <LoadError onRetry={() => void active.refetch()} retrying={active.isFetching} />
          ) : active.isLoading ? (
            <Card>
              <SkeletonLines lines={6} />
            </Card>
          ) : tab === 'lista' ? (
            <ListTab trip={trip} tripItems={tripItems} products={products.data ?? []} budget={budget.data} onStarted={() => go('mercado')} />
          ) : (
            <ShoppingTab trip={trip} tripItems={tripItems} products={products.data ?? []} budget={budget.data} onGoToList={() => go('lista')} onFinished={setLinking} />
          )}
        </div>
      </div>
      {linking !== null && (
        <LinkModal tripId={linking} title="Compra concluída. Vincular ao lançamento?" onClose={() => setLinking(null)} onDone={() => setLinking(null)} />
      )}
    </>
  )
}
