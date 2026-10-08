import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bps, bpsToInput, centsToInput, money, parsePercentInput } from '../../lib/format'
import { toMonths, durationLabel, type PeriodUnit } from '@shared/calculators'
import { FULL_WEIGHT, simulateScenario, trailingReturnBps, weightTotal } from '@shared/allocations'
import { normalizeTo10000 } from '@shared/budget'
import { Button, Card, EmptyState, TextInput, useToast } from '../../components/ui'
import { ScenarioChart } from '../../components/charts/CalculatorCharts'
import { MoneyField, PeriodField, cents, decimal } from './fields'

export type AllocationClass = { value: string; label: string }
export type AllocationSliceLite = { assetClass: string; actualBps: number; targetBps: number | null }

type Scenario = { id: number; name: string; weights: Record<string, string> }

const SCENARIO_COLORS = ['#007bff', '#ff2ea6', '#1e8e3c']
/** Classes que andam com o CDI: as únicas com 12 meses de histórico de índice no app. */
const CDI_CLASSES = ['fixed_income', 'treasury', 'cash']

const pctOf = (raw: string) => {
  const v = parsePercentInput(raw)
  return v === null ? 0 : Math.max(0, v)
}

/**
 * Investimentos › Calculadoras › Comparar alocações: até três divisões por
 * classe, com a mesma taxa por classe para todas, lado a lado. Nada é
 * gravado e nenhum cenário é apontado como melhor (decisions/0010).
 */
export function AllocationCompare({
  classes,
  allocation,
  portfolioValueCents,
}: {
  classes: AllocationClass[]
  allocation: AllocationSliceLite[]
  portfolioValueCents: number
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [initial, setInitial] = useState('')
  const [monthly, setMonthly] = useState('')
  const [period, setPeriod] = useState('10')
  const [periodUnit, setPeriodUnit] = useState<PeriodUnit>('year')
  const [rates, setRates] = useState<Record<string, string>>({})
  const [rateNote, setRateNote] = useState<string | null>(null)
  const [reserveFirst, setReserveFirst] = useState(false)
  const [reserveGap, setReserveGap] = useState<number | null>(null)
  const [reserveRate, setReserveRate] = useState('')
  const [nextId, setNextId] = useState(3)
  const [scenarios, setScenarios] = useState<Scenario[]>([
    { id: 1, name: 'Cenário A', weights: {} },
    { id: 2, name: 'Cenário B', weights: {} },
  ])

  // A divisão real vem arredondada por classe e pode somar 100,01%: normaliza para fechar exatamente 100%.
  const actualEntries = allocation.filter((a) => a.actualBps > 0)
  const actualNormalized = normalizeTo10000(actualEntries.map((a) => a.actualBps))
  const actual = Object.fromEntries(actualEntries.map((a, i) => [a.assetClass, actualNormalized[i]!]))
  const target = Object.fromEntries(allocation.filter((a) => a.targetBps !== null).map((a) => [a.assetClass, a.targetBps!]))
  const targetTotal = Object.values(target).reduce((s, v) => s + v, 0)

  const fillScenario = (id: number, name: string, weights: Record<string, number>) =>
    setScenarios((list) => list.map((s) => (s.id === id ? { ...s, name, weights: Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, bpsToInput(v)])) } : s)))

  const history = useMutation({
    mutationFn: () =>
      queryClient.fetchQuery({
        queryKey: ['profitability-benchmarks'],
        queryFn: () => api.get<{ benchmarks: Record<string, Array<{ period: string; returnBps: number }>> }>('/investments/profitability'),
      }),
    onSuccess: (data) => {
      const cdi = trailingReturnBps((data.benchmarks.CDI ?? []).map((p) => p.returnBps))
      if (cdi === null) {
        setRateNote('O app ainda não tem 12 meses de CDI para preencher.')
        return
      }
      setRates((current) => ({ ...current, ...Object.fromEntries(CDI_CLASSES.map((c) => [c, bpsToInput(cdi)])) }))
      if (!reserveRate) setReserveRate(bpsToInput(cdi))
      const short = ['IBOV', 'IFIX', 'IVVB11'].filter((code) => trailingReturnBps((data.benchmarks[code] ?? []).map((p) => p.returnBps)) === null)
      setRateNote(
        `Renda fixa, Tesouro e Caixa receberam o CDI dos últimos 12 meses (${bps(cdi, 1)}).${short.length ? ` ${short.join(', ')} ainda não têm 12 meses no app, então as outras classes ficam com a taxa que você informar.` : ''} O passado não se repete.`,
      )
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao buscar os índices', 'error'),
  })

  const loadReserve = useMutation({
    mutationFn: () => api.get<{ gapCents: number }>('/investments/reserve'),
    onSuccess: (r) => setReserveGap(r.gapCents),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao ler a reserva', 'error'),
  })

  const months = (() => {
    const v = decimal(period)
    return v === null ? 0 : Math.min(1200, toMonths(v, periodUnit))
  })()
  const rateBps = Object.fromEntries(classes.map((c) => [c.value, parsePercentInput(rates[c.value] ?? '') ?? 0]))
  const missingRates = classes.filter((c) => scenarios.some((s) => pctOf(s.weights[c.value] ?? '') > 0) && !(rates[c.value] ?? '').trim())

  const results = useMemo(
    () =>
      scenarios.map((s) => {
        const weights = Object.fromEntries(classes.map((c) => [c.value, pctOf(s.weights[c.value] ?? '')]))
        const total = weightTotal(weights)
        if (total !== FULL_WEIGHT || months <= 0) return { scenario: s, total, result: null }
        return {
          scenario: s,
          total,
          result: simulateScenario(
            { weights },
            {
              rates: rateBps,
              initialCents: cents(initial),
              monthlyCents: cents(monthly),
              months,
              reserveFirst: reserveFirst && reserveGap !== null ? { gapCents: reserveGap, rateBps: parsePercentInput(reserveRate) ?? 0 } : null,
            },
          ),
        }
      }),
    [scenarios, classes, months, rateBps, initial, monthly, reserveFirst, reserveGap, reserveRate],
  )
  const ready = results.filter((r) => r.result)
  const checkpoints = [12, 60, 120].filter((m) => m < months).concat(months)

  return (
    <div className="stack stack--loose">
      <div className="calc-layout">
        <Card title="Comparar alocações" subtitle="Até três divisões por classe, com a mesma taxa por classe para todas">
          <div className="stack">
            <MoneyField label="Valor inicial (R$)" value={initial} onChange={setInitial} hint="Entra dividido pelos pesos de cada cenário." />
            <MoneyField label="Aporte mensal (R$)" value={monthly} onChange={setMonthly} />
            <PeriodField label="Prazo" value={period} unit={periodUnit} onChange={setPeriod} onUnit={setPeriodUnit} />
            <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
              <Button size="sm" icon="wallet" disabled={portfolioValueCents <= 0} onClick={() => setInitial(centsToInput(portfolioValueCents))}>
                Usar minha carteira
              </Button>
            </div>

            <fieldset className="plan-group">
              <legend className="plan-group__title">Taxa esperada por classe (% ao ano)</legend>
              <div className="stack">
                <ul className="alloc-rates">
                  {classes.map((c) => (
                    <li key={c.value}>
                      <span>{c.label}</span>
                      <TextInput
                        value={rates[c.value] ?? ''}
                        onChange={(v) => setRates((current) => ({ ...current, [c.value]: v }))}
                        placeholder="0"
                        numeral
                        ariaLabel={`Taxa ao ano de ${c.label}`}
                      />
                    </li>
                  ))}
                </ul>
                <div>
                  <Button size="sm" icon="clock" loading={history.isPending} onClick={() => history.mutate()}>
                    Usar o histórico dos índices
                  </Button>
                </div>
                {rateNote && <p className="field__hint">{rateNote}</p>}
              </div>
            </fieldset>

            <fieldset className="plan-group">
              <legend className="plan-group__title">Reserva primeiro</legend>
              <div className="stack">
                <label className="check-row">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={reserveFirst}
                    onChange={(e) => {
                      setReserveFirst(e.target.checked)
                      if (e.target.checked && reserveGap === null) loadReserve.mutate()
                    }}
                  />
                  <span>O aporte enche a falta da reserva de emergência antes de ir para as classes</span>
                </label>
                {reserveFirst && (
                  <>
                    <span className="field__hint">
                      {reserveGap === null ? 'Lendo a reserva…' : reserveGap === 0 ? 'A reserva já está completa.' : `Falta ${money(reserveGap)} para a meta da reserva.`}
                    </span>
                    <div className="field">
                      <label className="field__label" htmlFor="alloc-reserve-rate">
                        Taxa da reserva (% ao ano)
                      </label>
                      <TextInput id="alloc-reserve-rate" value={reserveRate} onChange={setReserveRate} numeral placeholder="0" />
                    </div>
                  </>
                )}
              </div>
            </fieldset>
          </div>
        </Card>

        <div className="stack stack--loose" style={{ minWidth: 0 }}>
          <div className="alloc-scenarios">
            {scenarios.map((s, index) => {
              const total = weightTotal(Object.fromEntries(classes.map((c) => [c.value, pctOf(s.weights[c.value] ?? '')])))
              return (
                <Card key={s.id}>
                  <div className="stack">
                    <div className="row row--between" style={{ gap: 'var(--sp-2)' }}>
                      <span className="budget-card__dot" style={{ background: SCENARIO_COLORS[index] }} aria-hidden="true" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <TextInput
                          value={s.name}
                          onChange={(name) => setScenarios((list) => list.map((x) => (x.id === s.id ? { ...x, name } : x)))}
                          ariaLabel={`Nome do cenário ${index + 1}`}
                        />
                      </div>
                      {scenarios.length > 1 && (
                        <Button size="sm" variant="quiet" icon="x" title={`Remover ${s.name}`} onClick={() => setScenarios((list) => list.filter((x) => x.id !== s.id))} />
                      )}
                    </div>
                    <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                      <Button size="sm" variant="quiet" onClick={() => fillScenario(s.id, 'Minha carteira hoje', actual)}>
                        Minha carteira hoje
                      </Button>
                      <Button
                        size="sm"
                        variant="quiet"
                        disabled={targetTotal !== FULL_WEIGHT}
                        title={targetTotal === FULL_WEIGHT ? undefined : 'A alocação-alvo salva não soma 100%'}
                        onClick={() => fillScenario(s.id, 'Minha alocação-alvo', target)}
                      >
                        Minha alocação-alvo
                      </Button>
                    </div>
                    <ul className="alloc-rates">
                      {classes.map((c) => (
                        <li key={c.value}>
                          <span>{c.label}</span>
                          <TextInput
                            value={s.weights[c.value] ?? ''}
                            onChange={(v) =>
                              setScenarios((list) => list.map((x) => (x.id === s.id ? { ...x, weights: { ...x.weights, [c.value]: v } } : x)))
                            }
                            placeholder="0"
                            numeral
                            ariaLabel={`${s.name}: % em ${c.label}`}
                          />
                        </li>
                      ))}
                    </ul>
                    <span className={`numeral ${total === FULL_WEIGHT ? 'allocation-total--ok' : 'allocation-total--off'}`}>Soma: {bps(total, 0)} / 100%</span>
                  </div>
                </Card>
              )
            })}
          </div>
          {scenarios.length < 3 && (
            <div>
              <Button
                size="sm"
                icon="plus"
                onClick={() => {
                  setScenarios((list) => [...list, { id: nextId, name: `Cenário ${String.fromCharCode(64 + list.length + 1)}`, weights: {} }])
                  setNextId((n) => n + 1)
                }}
              >
                Adicionar cenário
              </Button>
            </div>
          )}
        </div>
      </div>

      {ready.length === 0 ? (
        <Card>
          <EmptyState
            icon="calculator"
            title="Feche pelo menos um cenário em 100%"
            body="Com os pesos somando 100%, as taxas por classe e um prazo, a comparação aparece aqui."
          />
        </Card>
      ) : (
        <>
          {missingRates.length > 0 && (
            <p className="field__hint">Sem taxa informada (conta como 0%): {missingRates.map((c) => c.label).join(', ')}.</p>
          )}
          <div className="alloc-scenarios">
            {results.map(({ scenario, total, result }) => (
              <Card key={scenario.id} title={scenario.name}>
                {!result ? (
                  <p className="field__hint">Soma em {bps(total, 0)}: feche em 100% para projetar.</p>
                ) : (
                  <dl className="plan-breakdown">
                    <div className="plan-breakdown__row">
                      <dt>Taxa média ponderada</dt>
                      <dd className="numeral">{bps(result.blendedRateBps, 1)} a.a.</dd>
                    </div>
                    {checkpoints.map((m) => (
                      <div key={m} className={`plan-breakdown__row${m === months ? ' plan-breakdown__row--total' : ''}`}>
                        <dt>Em {durationLabel(m)}</dt>
                        <dd className="numeral">{money(result.series[m] ?? 0)}</dd>
                      </div>
                    ))}
                    {result.reserveCompleteMonth !== null && (
                      <div className="plan-breakdown__row">
                        <dt>Reserva completa em</dt>
                        <dd className="numeral">{result.reserveCompleteMonth === 0 ? 'já está' : durationLabel(result.reserveCompleteMonth)}</dd>
                      </div>
                    )}
                    <div className="plan-breakdown__row">
                      <dt>
                        Aporte por classe
                        <span className="plan-breakdown__hint">
                          {Object.entries(result.monthlySplit)
                            .filter(([, v]) => v > 0)
                            .map(([k, v]) => `${classes.find((c) => c.value === k)?.label ?? k} ${money(v)}`)
                            .join(' · ') || 'sem aporte mensal'}
                        </span>
                      </dt>
                      <dd />
                    </div>
                  </dl>
                )}
              </Card>
            ))}
          </div>
          <Card title="Evolução dos cenários" subtitle="Valor total no tempo, com a taxa de cada classe constante">
            <ScenarioChart
              months={months}
              scenarios={ready.map(({ scenario, result }) => ({
                name: scenario.name,
                color: SCENARIO_COLORS[results.findIndex((r) => r.scenario.id === scenario.id)]!,
                series: result!.series,
              }))}
            />
          </Card>
        </>
      )}
    </div>
  )
}
