import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { date, money } from '../../lib/format'
import { todayIso } from '../../lib/period'
import { Button, Card, EmptyState, KpiTile, LoadError, Segmented, Select, SkeletonStats } from '../../components/ui'
import { AnnualPaceChart } from '../../components/charts/AnnualPaceChart'
import { BasketIndexChart } from '../../components/charts/GroceryCharts'
import { LinkModal } from './LinkModal'
import { groceryKeys } from './useGrocery'
import { fmtChange, fmtIndex, type GroceryAnalytics, type ProductTrend, type TripSummary } from './types'

type Sort = 'up' | 'down' | 'name'

/**
 * Quanto se gasta com mercado no ano (o real, do ledger) e quanto a mesma
 * cesta de produtos encareceu (índice de cesta fixa, a partir das listas).
 */
export function AnalysisTab() {
  const thisYear = todayIso().slice(0, 4)
  const [year, setYear] = useState(thisYear)
  const [sort, setSort] = useState<Sort>('up')
  const [linking, setLinking] = useState<number | null>(null)
  const analytics = useQuery({
    queryKey: groceryKeys.analytics(year),
    queryFn: () => api.get<GroceryAnalytics>('/grocery-insights/analytics', { year }),
  })
  const trips = useQuery({
    queryKey: groceryKeys.trips('all'),
    queryFn: () => api.get<{ trips: TripSummary[] }>('/grocery/trips').then((r) => r.trips),
  })

  const years = Array.from({ length: 4 }, (_, i) => String(Number(thisYear) - i))
  const data = analytics.data
  const unlinked = (trips.data ?? []).filter((t) => t.transactionId === null)

  if (analytics.isError) return <LoadError onRetry={() => void analytics.refetch()} retrying={analytics.isFetching} />

  const products = sortProducts(data?.products ?? [], sort)

  return (
    <div className="stack stack--loose">
      <div className="row row--between row--wrap">
        <span className="muted">Gasto real vem dos lançamentos; preços e índice vêm das listas concluídas.</span>
        <Select<string> value={year} onChange={(v) => v && setYear(v)} options={years.map((y) => ({ value: y, label: y }))} toolbar ariaLabel="Ano" />
      </div>

      {!data ? (
        <SkeletonStats items={4} />
      ) : (
        <div className="kpi-row">
          <KpiTile
            accent
            label="Cesta desde a primeira compra"
            value={fmtIndex(data.kpis.basketSinceStart?.index ?? null)}
            foot={
              <span>
                {data.kpis.basketSinceStart
                  ? `mesmos produtos, ${data.kpis.basketSinceStart.matched} de ${data.kpis.basketSinceStart.total} comparados`
                  : 'precisa de duas compras com preço'}
              </span>
            }
          />
          <KpiTile
            label="Cesta nos últimos 12 meses"
            value={fmtIndex(data.kpis.basket12m?.index ?? null)}
            foot={<span>{data.kpis.basket12m ? `${data.kpis.basket12m.matched} de ${data.kpis.basket12m.total} produtos comparados` : 'sem duas compras na janela'}</span>}
          />
          <KpiTile
            label={`Gasto com mercado em ${year}`}
            value={data.kpis.spentYearCents === null ? '-' : money(data.kpis.spentYearCents)}
            foot={<span>{data.kpis.spentYearCents === null ? 'sem categoria Supermercado' : 'lançamentos da categoria'}</span>}
          />
          <KpiTile
            label="Ticket médio"
            value={data.kpis.avgTicketCents === null ? '-' : money(data.kpis.avgTicketCents)}
            foot={
              <span>
                {data.kpis.tripsCount} {data.kpis.tripsCount === 1 ? 'compra' : 'compras'} em {year}
                {data.kpis.tripsCount > 0 && data.kpis.plannedVsRealCents !== 0
                  ? ` · ${money(Math.abs(data.kpis.plannedVsRealCents))} ${data.kpis.plannedVsRealCents > 0 ? 'acima' : 'abaixo'} do previsto`
                  : ''}
              </span>
            }
          />
        </div>
      )}

      {unlinked.length > 0 && (
        <Card muted title={`${unlinked.length} ${unlinked.length === 1 ? 'compra sem lançamento vinculado' : 'compras sem lançamento vinculado'}`}>
          <ul className="grocery-list">
            {unlinked.slice(0, 5).map((t) => (
              <li key={t.id} className="grocery-row">
                <span style={{ flex: 1 }}>
                  {date(t.purchasedOn)} · {money(t.realCents)}
                </span>
                <Button size="sm" icon="link" onClick={() => setLinking(t.id)}>
                  Vincular
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid-2" style={{ gap: 'var(--sp-4)' }}>
        <Card title="Índice da cesta" subtitle="Primeira compra = 100. Só o preço move a linha.">
          <BasketIndexChart points={data?.series ?? []} />
        </Card>
        <Card title="Gasto mensal com mercado" subtitle={`${year} contra ${Number(year) - 1}, pelos lançamentos`}>
          <AnnualPaceChart
            currentLabel={year}
            previousLabel={String(Number(year) - 1)}
            points={(data?.monthly ?? []).map((m) => ({
              monthIndex: Number(m.month),
              currentCents: year === thisYear && m.month > todayIso().slice(5, 7) ? null : m.currentCents,
              previousCents: m.previousCents,
            }))}
          />
        </Card>
      </div>

      <Card
        flush
        title="Preço por produto"
        subtitle="Primeiro e último preço pagos, por unidade"
        actions={
          <Segmented<Sort>
            ariaLabel="Ordenar produtos"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'up', label: 'Mais subiram' },
              { value: 'down', label: 'Mais caíram' },
              { value: 'name', label: 'Nome' },
            ]}
          />
        }
      >
        {products.length === 0 ? (
          <EmptyState icon="cart" title="Nenhum preço registrado" body="Os preços aparecem aqui depois da primeira compra concluída." />
        ) : (
          <div className="table-wrap">
            <table className="table table--stack-mobile">
              <thead>
                <tr>
                  <th scope="col">Produto</th>
                  <th scope="col" className="table__num">Primeiro</th>
                  <th scope="col" className="table__num">Último</th>
                  <th scope="col" className="table__num">Variação</th>
                  <th scope="col" className="table__num">Compras</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.productId}>
                    <td data-label="Produto">{p.name}</td>
                    <td data-label="Primeiro" className="table__num">
                      {money(p.firstUnitPriceCents)}/{p.unit}
                    </td>
                    <td data-label="Último" className="table__num">
                      {money(p.lastUnitPriceCents)}/{p.unit}
                    </td>
                    <td
                      data-label="Variação"
                      className="table__num"
                      style={{ color: p.change && p.change > 0 ? 'var(--delta-down)' : p.change && p.change < 0 ? 'var(--delta-up)' : undefined, fontWeight: 600 }}
                    >
                      {fmtChange(p.change)}
                    </td>
                    <td data-label="Compras" className="table__num">
                      {p.history.length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card flush title="Compras">
        {!trips.data || trips.data.length === 0 ? (
          <EmptyState icon="clock" title="Nenhuma compra concluída" body="Cada compra concluída na aba No mercado entra aqui." />
        ) : (
          <div className="table-wrap">
            <table className="table table--stack-mobile">
              <thead>
                <tr>
                  <th scope="col">Data</th>
                  <th scope="col" className="table__num">Itens</th>
                  <th scope="col" className="table__num">Lista</th>
                  <th scope="col" className="table__num">Cobrado</th>
                  <th scope="col">Vínculo</th>
                </tr>
              </thead>
              <tbody>
                {trips.data.map((t) => (
                  <tr key={t.id}>
                    <td data-label="Data">{date(t.purchasedOn)}</td>
                    <td data-label="Itens" className="table__num">
                      {t.itemCount}
                    </td>
                    <td data-label="Lista" className="table__num">
                      {money(t.realCents)}
                    </td>
                    <td data-label="Cobrado" className="table__num">
                      {t.transactionAmountCents === null ? '-' : money(Math.abs(t.transactionAmountCents))}
                    </td>
                    <td data-label="Vínculo">
                      {t.transactionId === null ? (
                        <Button size="sm" variant="quiet" icon="link" onClick={() => setLinking(t.id)}>
                          Vincular
                        </Button>
                      ) : (
                        <span className="badge badge--good">vinculada</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {linking !== null && <LinkModal tripId={linking} onClose={() => setLinking(null)} onDone={() => setLinking(null)} />}
    </div>
  )
}

function sortProducts(list: ProductTrend[], sort: Sort): ProductTrend[] {
  const copy = [...list]
  if (sort === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  const dir = sort === 'up' ? -1 : 1
  return copy.sort((a, b) => dir * ((a.change ?? 0) - (b.change ?? 0)) || a.name.localeCompare(b.name, 'pt-BR'))
}
