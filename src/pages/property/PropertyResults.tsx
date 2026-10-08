import type { ReactNode } from 'react'
import { bps, money, period as fmtPeriod } from '../../lib/format'
import { currentPeriod, shiftPeriod } from '../../lib/period'
import { durationLabel } from '@shared/calculators'
import { thinSeries, type PlanInputs, type PlanProjection, type ScheduleSummary } from '@shared/propertyPlan'
import { Card, KpiTile } from '../../components/ui'
import { AccumulationChart, DebtBalanceChart } from '../../components/charts/PropertyCharts'

const SYSTEM_LABEL = { sac: 'SAC', price: 'Price' } as const

/**
 * O que o plano responde: quando a compra fica possível, quanto dinheiro
 * ela pede no dia, a parcela e o peso dela na renda, e SAC × Price.
 * Evidência, nunca recomendação (decisions/0010): os números mostram, a
 * decisão é de quem lê.
 */
export function PropertyResults({ projection, inputs, actions }: { projection: PlanProjection; inputs: PlanInputs; actions?: ReactNode }) {
  const { need, purchaseMonth } = projection
  const chosen = inputs.system === 'sac' ? projection.sac : projection.price
  const when = purchaseMonth === null ? null : fmtPeriod(shiftPeriod(currentPeriod(), purchaseMonth))
  const income = projection.incomeTest

  return (
    <div className="stack stack--loose" style={{ minWidth: 0 }}>
      <div className="kpi-row kpi-row--3">
        <KpiTile
          accent
          label="Compra possível em"
          value={purchaseMonth === null ? 'mais de 50 anos' : purchaseMonth === 0 ? 'agora' : durationLabel(purchaseMonth)}
          foot={
            purchaseMonth === null ? (
              <span>faltariam {money(projection.shortfallCents)} no fim do horizonte</span>
            ) : purchaseMonth > 0 ? (
              <span>em {when}</span>
            ) : (
              <span>o dinheiro separado já cobre tudo</span>
            )
          }
          assumptions={{
            formula: 'Primeiro mês em que o juntado (rendendo e com o aporte) cobre entrada + custos + o que falta na reserva − outros recursos.',
            horizonteMeses: 600,
          }}
        />
        <KpiTile
          label={purchaseMonth === null ? 'Dinheiro necessário hoje' : 'Dinheiro no dia da compra'}
          value={money(need.totalCents)}
          foot={<span>imóvel a {money(need.priceCents)}</span>}
        />
        <KpiTile
          label={`1ª parcela (${SYSTEM_LABEL[inputs.system]})`}
          value={need.firstInstallmentCents > 0 ? money(need.firstInstallmentCents) : 'sem parcela'}
          foot={
            income ? (
              <span>
                {bps(income.shareBps, 0)} da renda · limite {bps(income.limitBps, 0)}
              </span>
            ) : need.firstInstallmentCents > 0 ? (
              <span>informe a renda para ver o peso da parcela</span>
            ) : undefined
          }
        />
      </div>

      <Card title="O dinheiro do dia da compra" subtitle={purchaseMonth === null ? 'Com o preço de hoje' : `Com o preço corrigido até ${when}`}>
        <dl className="plan-breakdown">
          <BreakdownRow label={`Entrada (${bps(inputs.downPaymentBps, 0)})`} value={need.downPaymentCents} />
          <BreakdownRow label="Custos da compra" value={need.costsCents} />
          <BreakdownRow
            label="Falta na reserva"
            value={need.reserveGapCents}
            hint={`alvo ${money(need.reserveTargetCents)}: custo de vida${inputs.expenseReliefCents ? ' sem o gasto que some' : ''} + parcela, × ${inputs.reserveMultiple}`}
          />
          {need.otherResourcesCents > 0 && <BreakdownRow label="FGTS e outros recursos" value={-need.otherResourcesCents} />}
          <BreakdownRow label="Total" value={need.totalCents} total />
        </dl>
        {need.financedCents > 0 && <p className="chart__note">Financiado: {money(need.financedCents)}.</p>}
      </Card>

      <Card title="Até a compra" subtitle="O dinheiro juntado e o necessário, que sobe com o imóvel">
        <AccumulationChart points={thinSeries(projection.series)} />
      </Card>

      {projection.sac && projection.price && (
        <Card title="SAC ou Price" subtitle={`${money(need.financedCents)} em ${Math.round(inputs.termMonths / 12)} anos a ${bps(inputs.financingRateBps, 2)} ao ano`}>
          <div className="stack">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col" />
                    <th scope="col" className="table__num">SAC</th>
                    <th scope="col" className="table__num">Price</th>
                  </tr>
                </thead>
                <tbody>
                  <CompareRow label="1ª parcela" pick={(s) => s.firstPaymentCents} sac={projection.sac} price={projection.price} />
                  <CompareRow label="Última parcela" pick={(s) => s.lastPaymentCents} sac={projection.sac} price={projection.price} />
                  <CompareRow label="Juros totais" pick={(s) => s.totalInterestCents} sac={projection.sac} price={projection.price} />
                  <CompareRow label="Total pago" pick={(s) => s.totalPaidCents} sac={projection.sac} price={projection.price} />
                </tbody>
              </table>
            </div>
            <DebtBalanceChart points={projection.balanceSeries} />
          </div>
        </Card>
      )}

      {(income || projection.maxPriceCents !== null) && chosen && (
        <p className="plan-evidence">
          {income && (
            <>
              A 1ª parcela levaria {bps(income.shareBps, 0)} da renda de {money(income.incomeCents)}; o limite definido é {bps(income.limitBps, 0)}.{' '}
            </>
          )}
          {projection.maxPriceCents !== null && (
            <>
              Com essa renda, entrada e taxa, o maior imóvel cuja 1ª parcela ({SYSTEM_LABEL[inputs.system]}) cabe no limite seria de{' '}
              {money(projection.maxPriceCents)}.
            </>
          )}
        </p>
      )}

      {actions && (
        <div className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
          {actions}
        </div>
      )}
    </div>
  )
}

function BreakdownRow({ label, value, hint, total }: { label: string; value: number; hint?: string; total?: boolean }) {
  return (
    <div className={`plan-breakdown__row${total ? ' plan-breakdown__row--total' : ''}`}>
      <dt>
        {label}
        {hint && <span className="plan-breakdown__hint">{hint}</span>}
      </dt>
      <dd className="numeral">{money(value)}</dd>
    </div>
  )
}

function CompareRow({ label, pick, sac, price }: { label: string; pick: (s: ScheduleSummary) => number; sac: ScheduleSummary; price: ScheduleSummary }) {
  return (
    <tr>
      <th scope="row" className="plan-compare__label">{label}</th>
      <td className="table__num numeral">{money(pick(sac))}</td>
      <td className="table__num numeral">{money(pick(price))}</td>
    </tr>
  )
}
