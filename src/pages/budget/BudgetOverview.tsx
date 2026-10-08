import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { bps, money } from '../../lib/format'
import { periodBounds } from '../../lib/period'
import { useRange } from '../../lib/store'
import { Card, KpiTile, LoadError, SkeletonStats } from '../../components/ui'
import type { BudgetLine, MonthBudget } from './types'

/**
 * O topo da tela Orçamento (specs/budget-groups): renda, gastos e saldo do
 * mês, e um card por grupo com previsto, realizado e o que resta.
 * Observação, nunca recomendação (decisions/0010).
 */
export function BudgetOverview({ period }: { period: string }) {
  const query = useQuery({
    queryKey: ['budget', period],
    queryFn: () => api.get<MonthBudget>(`/budget/${period}`),
    placeholderData: (previous) => previous,
  })

  if (query.isError && !query.data) {
    return (
      <Card>
        <LoadError onRetry={() => query.refetch()} retrying={query.isFetching} />
      </Card>
    )
  }
  if (!query.data) {
    return (
      <div className="stack stack--loose">
        <SkeletonStats items={3} />
        <SkeletonStats items={3} />
      </div>
    )
  }

  const data = query.data
  const income = data.income
  const ungrouped = data.ungrouped

  return (
    <section className="stack stack--loose" aria-label="Orçamento por grupos" aria-busy={query.isFetching || undefined}>
      <div className="kpi-row kpi-row--3">
        <KpiTile
          accent
          label="Sua renda"
          value={money(income.cents)}
          foot={
            <span>
              {income.estimated
                ? `estimada pela renda típica; entrou ${money(income.receivedCents)} até agora`
                : 'soma do que entrou no mês'}
            </span>
          }
          assumptions={data.assumptions}
        />
        <KpiTile
          label="Gastos do mês"
          value={money(data.totals.spentCents)}
          foot={<span>{data.totals.spentShareBps === null ? 'sem renda no mês' : `${bps(data.totals.spentShareBps, 1)} da renda`}</span>}
        />
        <KpiTile
          label="Saldo restante"
          value={money(data.totals.remainingCents)}
          tone={data.totals.remainingCents >= 0 ? 'up' : 'down'}
          foot={<span>renda − gastos − aportes de {money(data.totals.contributedCents)}</span>}
        />
      </div>

      <div className="row row--between row--wrap" style={{ gap: 'var(--sp-2)', alignItems: 'baseline' }}>
        <div className="stack stack--tight">
          <h2 className="h3">Grupos do orçamento</h2>
          <span className="field__hint">A renda do mês dividida pelos percentuais de cada grupo</span>
        </div>
        <Link to="/metas/ajustar" className="btn btn--quiet btn--sm">
          Ajustar orçamento
        </Link>
      </div>

      <div className="budget-grid">
        {data.groups.map((line) => (
          <BudgetGroupCard key={line.id} line={line} period={period} />
        ))}
        {(ungrouped.actualCents !== 0 || ungrouped.pendingCents > 0) && <UngroupedCard ungrouped={ungrouped} incomeCents={income.cents} period={period} />}
      </div>
    </section>
  )
}

/** Abre Lançamentos no mês do card, filtrado pelo grupo. */
function useOpenTransactions(period: string) {
  const range = useRange()
  const navigate = useNavigate()
  return (group: string, name: string) => {
    const { from, to } = periodBounds(period)
    range.setCustom(from, to)
    navigate(`/lancamentos?grupo=${encodeURIComponent(group)}&grupoNome=${encodeURIComponent(name)}`)
  }
}

function BudgetGroupCard({ line, period }: { line: BudgetLine; period: string }) {
  const openTransactions = useOpenTransactions(period)
  const isContribution = line.source !== 'categories'
  const over = line.remainingCents < 0
  const fill = line.usedBps === null ? 0 : Math.min(100, line.usedBps / 100)
  return (
    <article className="card budget-card" style={{ ['--group-color' as string]: line.color }}>
      <header className="budget-card__head">
        <span className="budget-card__dot" aria-hidden="true" />
        <h3 className="budget-card__name">{line.name}</h3>
        <span className="badge">
          {line.actualCents === 0 ? (isContribution ? 'Sem aportes' : 'Sem gastos') : line.shareBps === null ? '-' : bps(line.shareBps, 2)}
        </span>
      </header>
      <div
        className={`budget-bar${over ? ' budget-bar--over' : ''}`}
        role="img"
        aria-label={line.usedBps === null ? 'sem previsto' : `${bps(line.usedBps, 0)} do previsto`}
      >
        <span className="budget-bar__fill" style={{ clipPath: `inset(0 ${100 - fill}% 0 0 round 9999px)` }} />
      </div>
      <dl className="budget-card__figures">
        <div>
          <dt>{isContribution ? 'Aportado' : 'Gasto'}</dt>
          <dd className="numeral">{money(line.actualCents)}</dd>
        </div>
        <div>
          <dt>Previsto · {bps(line.targetBps, 0)}</dt>
          <dd className="numeral">{money(line.plannedCents)}</dd>
        </div>
      </dl>
      <footer className="budget-card__foot">
        <span className={over ? 'budget-card__over' : 'budget-card__left'}>
          {line.plannedCents === 0 && line.actualCents === 0
            ? 'sem previsto'
            : over
              ? `passou ${money(-line.remainingCents)} do previsto`
              : `${money(line.remainingCents)} restante`}
          {line.pendingCents > 0 && <span className="budget-card__pending"> · a pagar {money(line.pendingCents)}</span>}
        </span>
        {isContribution ? (
          <Link to="/investimentos?aba=movimentacoes" className="budget-card__link">
            {line.count} {line.count === 1 ? 'aporte' : 'aportes'}
          </Link>
        ) : (
          <button type="button" className="budget-card__link" onClick={() => openTransactions(String(line.id), line.name)}>
            {line.count} {line.count === 1 ? 'transação' : 'transações'}
          </button>
        )}
      </footer>
    </article>
  )
}

function UngroupedCard({
  ungrouped,
  incomeCents,
  period,
}: {
  ungrouped: MonthBudget['ungrouped']
  incomeCents: number
  period: string
}) {
  const openTransactions = useOpenTransactions(period)
  return (
    <article className="card budget-card budget-card--ungrouped">
      <header className="budget-card__head">
        <span className="budget-card__dot" aria-hidden="true" />
        <h3 className="budget-card__name">Sem grupo</h3>
        <span className="badge badge--warning">{incomeCents > 0 ? bps(Math.round((ungrouped.actualCents / incomeCents) * 10_000), 2) : '-'}</span>
      </header>
      <p className="field__hint">Despesas de TAGs que ainda não pertencem a nenhum grupo. Elas contam nos gastos do mês, mas não em um previsto.</p>
      <dl className="budget-card__figures">
        <div>
          <dt>Gasto</dt>
          <dd className="numeral">{money(ungrouped.actualCents)}</dd>
        </div>
        {ungrouped.pendingCents > 0 && (
          <div>
            <dt>A pagar</dt>
            <dd className="numeral">{money(ungrouped.pendingCents)}</dd>
          </div>
        )}
      </dl>
      <footer className="budget-card__foot">
        <Link to="/metas/ajustar?aba=tags" className="budget-card__link">
          Escolher grupos
        </Link>
        <button type="button" className="budget-card__link" onClick={() => openTransactions('none', 'Sem grupo')}>
          {ungrouped.count} {ungrouped.count === 1 ? 'transação' : 'transações'}
        </button>
      </footer>
    </article>
  )
}
