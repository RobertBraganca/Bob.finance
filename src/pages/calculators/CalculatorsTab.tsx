import { useId, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { centsToInput, money, parseMoneyInput, parsePercentInput, period as fmtPeriod } from '../../lib/format'
import { currentPeriod, shiftPeriod } from '../../lib/period'
import {
  chartPoints,
  compoundGrowth,
  durationLabel,
  incomeDrawdown,
  monthlyRate,
  monthsToTarget,
  requiredMonthly,
  toMonths,
  type PeriodUnit,
  type RateUnit,
} from '@shared/calculators'
import { Button, Card, EmptyState, KpiTile, Segmented } from '../../components/ui'
import { PropertyCalculator } from '../property/PropertyCalculator'
import { InputCard, MoneyField, PeriodField, RateField, annualBps, cents, decimal, dueDate } from './fields'
import { GoalModal, type Goal } from '../../components/ui/GoalModal'
import { BalanceChart, GrowthChart } from '../../components/charts/CalculatorCharts'

type CalculatorKey = 'juros' | 'renda' | 'milhao' | 'imovel'
const CALCULATORS: Array<{ value: CalculatorKey; label: string }> = [
  { value: 'juros', label: 'Juros compostos' },
  { value: 'renda', label: 'Renda' },
  { value: 'milhao', label: 'Primeiro milhão' },
  { value: 'imovel', label: 'Imóvel' },
]

/** O que passa de uma calculadora para outra ("Simular retiradas desse montante"): o montante e a mesma taxa. */
type Seed = { initialCents: number; rate: string; rateUnit: RateUnit }

type Props = {
  portfolioValueCents: number
  goalPurposes: Array<{ value: string; label: string }>
}

/**
 * Investimentos › Calculadoras: juros compostos, renda e primeiro milhão.
 * Simulação pura (decisions/0010): taxa constante, nada é gravado, e o texto
 * nunca diz o que fazer. As contas moram em `shared/calculators.ts`. A
 * calculadora escolhida fica no endereço (`&calc=renda`).
 */
export function CalculatorsTab({ portfolioValueCents, goalPurposes }: Props) {
  const [params, setParams] = useSearchParams()
  const calc = (CALCULATORS.find((c) => c.value === params.get('calc'))?.value ?? 'juros') as CalculatorKey
  const [seed, setSeed] = useState<Seed | null>(null)
  // Remonta a calculadora a cada passagem, para os campos nascerem do valor recebido.
  const [handoff, setHandoff] = useState(0)
  const [draft, setDraft] = useState<Partial<Omit<Goal, 'id'>> | null>(null)

  const open = (next: CalculatorKey, nextSeed: Seed | null = null) => {
    setSeed(nextSeed)
    setHandoff((n) => n + 1)
    setParams(
      (current) => {
        const fresh = new URLSearchParams(current)
        fresh.set('calc', next)
        return fresh
      },
      { replace: true },
    )
  }

  const shared = { portfolioValueCents, onCreateGoal: setDraft }

  return (
    <div className="stack stack--loose">
      <Segmented ariaLabel="Calculadora" className="segmented--nav" value={calc} onChange={(next) => open(next)} options={CALCULATORS} />
      {/* `key`: trocar de calculadora (ou chegar com um valor de outra) começa os campos do zero. */}
      {calc === 'juros' && (
        <CompoundCalculator key={`juros-${handoff}`} seed={seed} {...shared} onWithdraw={(next) => open('renda', next)} />
      )}
      {calc === 'renda' && (
        <IncomeCalculator key={`renda-${handoff}`} seed={seed} {...shared} onContribute={(next) => open('juros', next)} />
      )}
      {calc === 'milhao' && <MillionCalculator key="milhao" {...shared} />}
      {calc === 'imovel' && (
        <PropertyCalculator
          portfolioValueCents={portfolioValueCents}
          onPlanCreated={(goalId) =>
            setParams(
              (current) => {
                // Leva para a meta nova na aba Metas, já selecionada.
                const fresh = new URLSearchParams(current)
                fresh.delete('calc')
                fresh.set('aba', 'metas')
                fresh.set('meta', String(goalId))
                return fresh
              },
              { replace: false },
            )
          }
        />
      )}

      {draft && <GoalModal goal={null} goalPurposes={goalPurposes} draft={draft} onClose={() => setDraft(null)} />}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Juros compostos
 * ------------------------------------------------------------------ */
function CompoundCalculator({
  seed,
  portfolioValueCents,
  onCreateGoal,
  onWithdraw,
}: {
  seed: Seed | null
  portfolioValueCents: number
  onCreateGoal: (draft: Partial<Omit<Goal, 'id'>>) => void
  onWithdraw: (seed: Seed) => void
}) {
  const [initial, setInitial] = useState(seed ? centsToInput(seed.initialCents) : '')
  const [monthly, setMonthly] = useState('')
  const [rate, setRate] = useState(seed?.rate ?? '')
  const [rateUnit, setRateUnit] = useState<RateUnit>(seed?.rateUnit ?? 'year')
  const [period, setPeriod] = useState('')
  const [periodUnit, setPeriodUnit] = useState<PeriodUnit>('year')

  const ratePct = parsePercentInput(rate)
  const periodValue = decimal(period)
  const ready = ratePct !== null && periodValue !== null && periodValue > 0 && (cents(initial) > 0 || cents(monthly) > 0)
  const months = periodValue === null ? 0 : toMonths(periodValue, periodUnit)
  const points = useMemo(
    () => (ready ? compoundGrowth({ initialCents: cents(initial), monthlyCents: cents(monthly), rate: monthlyRate(ratePct! / 100, rateUnit), months }) : []),
    [ready, initial, monthly, ratePct, rateUnit, months],
  )
  const last = points.at(-1)

  return (
    <div className="calc-layout">
      <InputCard
        title="Juros compostos"
        subtitle="Quanto um valor inicial mais aportes mensais viram com o tempo"
        portfolioValueCents={portfolioValueCents}
        onUsePortfolio={() => setInitial(centsToInput(portfolioValueCents))}
        onClear={() => {
          setInitial('')
          setMonthly('')
          setRate('')
          setPeriod('')
        }}
      >
        <MoneyField label="Valor inicial (R$)" value={initial} onChange={setInitial} hint="Quanto você já tem. Pode ficar vazio." />
        <MoneyField label="Aporte mensal (R$)" value={monthly} onChange={setMonthly} />
        <RateField value={rate} unit={rateUnit} onChange={setRate} onUnit={setRateUnit} />
        <PeriodField label="Período" value={period} unit={periodUnit} onChange={setPeriod} onUnit={setPeriodUnit} />
      </InputCard>

      <div className="stack stack--loose" style={{ minWidth: 0 }}>
        {!last || points.length < 2 ? (
          <Card>
            <EmptyState icon="calculator" title="Preencha valor, taxa e período" body="O resultado aparece aqui enquanto você digita." />
          </Card>
        ) : (
          <>
            <div className="kpi-row kpi-row--3">
              <KpiTile
                accent
                label={`Valor em ${durationLabel(months)}`}
                value={money(last.valueCents)}
                foot={<span>em {fmtPeriod(shiftPeriod(currentPeriod(), months))}</span>}
                assumptions={{ formula: 'Cada mês: saldo × (1 + taxa mensal) + aporte. Taxa anual convertida pela equivalência (1 + a)^(1/12) − 1.' }}
              />
              <KpiTile label="Total investido" value={money(last.investedCents)} foot={<span>valor inicial + aportes</span>} />
              <KpiTile label="Juros ganhos" value={money(last.interestCents)} tone="up" foot={<span>{last.valueCents > 0 ? `${Math.round((last.interestCents / last.valueCents) * 100)}% do valor final` : ''}</span>} />
            </div>
            <Card title="Evolução" subtitle="O que foi investido e o que os juros somaram">
              <GrowthChart points={chartPoints(points)} />
            </Card>
            <div className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
              <Button icon="arrowRight" onClick={() => onWithdraw({ initialCents: last.valueCents, rate, rateUnit })}>
                Simular retiradas desse montante
              </Button>
              <Button
                icon="target"
                onClick={() =>
                  onCreateGoal({
                    name: 'Plano de juros compostos',
                    targetValueCents: last.valueCents,
                    targetDate: dueDate(months),
                    monthlyContributionCents: cents(monthly),
                    expectedReturnBps: annualBps(ratePct! / 100, rateUnit),
                  })
                }
              >
                Criar meta com este plano
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Renda
 * ------------------------------------------------------------------ */
function IncomeCalculator({
  seed,
  portfolioValueCents,
  onContribute,
}: {
  seed: Seed | null
  portfolioValueCents: number
  onCreateGoal: (draft: Partial<Omit<Goal, 'id'>>) => void
  onContribute: (seed: Seed) => void
}) {
  const [initial, setInitial] = useState(seed ? centsToInput(seed.initialCents) : '')
  const [withdrawal, setWithdrawal] = useState('')
  const [rate, setRate] = useState(seed?.rate ?? '')
  const [rateUnit, setRateUnit] = useState<RateUnit>(seed?.rateUnit ?? 'year')
  const [period, setPeriod] = useState('')
  const [periodUnit, setPeriodUnit] = useState<PeriodUnit>('year')

  const ratePct = parsePercentInput(rate)
  const periodValue = decimal(period)
  const ready = ratePct !== null && periodValue !== null && periodValue > 0 && cents(initial) > 0
  const months = periodValue === null ? 0 : toMonths(periodValue, periodUnit)
  const result = useMemo(
    () =>
      ready
        ? incomeDrawdown({ initialCents: cents(initial), withdrawalCents: cents(withdrawal), rate: monthlyRate(ratePct! / 100, rateUnit), months })
        : null,
    [ready, initial, withdrawal, ratePct, rateUnit, months],
  )
  const last = result?.points.at(-1)

  return (
    <div className="calc-layout">
      <InputCard
        title="Renda"
        subtitle="Quanto dura um valor com uma retirada mensal, rendendo enquanto isso"
        portfolioValueCents={portfolioValueCents}
        onUsePortfolio={() => setInitial(centsToInput(portfolioValueCents))}
        onClear={() => {
          setInitial('')
          setWithdrawal('')
          setRate('')
          setPeriod('')
        }}
      >
        <MoneyField label="Valor inicial (R$)" value={initial} onChange={setInitial} />
        <MoneyField label="Retirada mensal (R$)" value={withdrawal} onChange={setWithdrawal} />
        <RateField value={rate} unit={rateUnit} onChange={setRate} onUnit={setRateUnit} />
        <PeriodField label="Tempo de retirada" value={period} unit={periodUnit} onChange={setPeriod} onUnit={setPeriodUnit} />
      </InputCard>

      <div className="stack stack--loose" style={{ minWidth: 0 }}>
        {!result || !last ? (
          <Card>
            <EmptyState icon="calculator" title="Preencha valor, retirada, taxa e tempo" body="O resultado aparece aqui enquanto você digita." />
          </Card>
        ) : (
          <>
            <div className="kpi-row kpi-row--3">
              {result.depletedMonth !== null ? (
                <KpiTile
                  accent
                  label="O dinheiro acaba em"
                  value={durationLabel(result.depletedMonth)}
                  foot={<span>em {fmtPeriod(shiftPeriod(currentPeriod(), result.depletedMonth))}, antes do prazo</span>}
                  assumptions={{ formula: 'Cada mês: saldo × (1 + taxa mensal) − retirada. A última retirada pode ser parcial.' }}
                />
              ) : (
                <KpiTile
                  accent
                  label={`Sobra em ${durationLabel(months)}`}
                  value={money(last.balanceCents)}
                  foot={<span>depois de todas as retiradas</span>}
                  assumptions={{ formula: 'Cada mês: saldo × (1 + taxa mensal) − retirada. Taxa anual convertida pela equivalência (1 + a)^(1/12) − 1.' }}
                />
              )}
              <KpiTile label="Total retirado" value={money(last.withdrawnCents)} />
              <KpiTile label="Juros no período" value={money(last.interestCents)} tone="up" />
            </div>
            <Card title="Saldo mês a mês" subtitle="O que resta depois de cada retirada">
              <BalanceChart points={chartPoints(result.points)} />
            </Card>
            <div className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
              <Button icon="arrowLeft" onClick={() => onContribute({ initialCents: cents(initial), rate, rateUnit })}>
                Simular aportes
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Primeiro milhão
 * ------------------------------------------------------------------ */
function MillionCalculator({
  portfolioValueCents,
  onCreateGoal,
}: {
  portfolioValueCents: number
  onCreateGoal: (draft: Partial<Omit<Goal, 'id'>>) => void
}) {
  const [mode, setMode] = useState<'time' | 'amount'>('time')
  const [target, setTarget] = useState('1.000.000,00')
  const [initial, setInitial] = useState('')
  const [monthly, setMonthly] = useState('')
  const [rate, setRate] = useState('')
  const [rateUnit, setRateUnit] = useState<RateUnit>('year')
  const [period, setPeriod] = useState('')
  const [periodUnit, setPeriodUnit] = useState<PeriodUnit>('year')

  const targetCents = cents(target)
  const ratePct = parsePercentInput(rate)
  const rateMonthly = ratePct === null ? null : monthlyRate(ratePct / 100, rateUnit)
  const periodValue = decimal(period)
  const chosenMonths = periodValue === null ? 0 : toMonths(periodValue, periodUnit)

  const result = useMemo(() => {
    if (targetCents <= 0 || rateMonthly === null) return null
    if (mode === 'time') {
      if (cents(initial) <= 0 && cents(monthly) <= 0) return null
      const months = monthsToTarget({ initialCents: cents(initial), monthlyCents: cents(monthly), rate: rateMonthly, targetCents })
      if (months === null) return { kind: 'unreachable' as const }
      return { kind: 'time' as const, months, monthlyCents: cents(monthly), points: compoundGrowth({ initialCents: cents(initial), monthlyCents: cents(monthly), rate: rateMonthly, months }) }
    }
    if (chosenMonths <= 0) return null
    const monthlyCents = requiredMonthly({ initialCents: cents(initial), rate: rateMonthly, months: chosenMonths, targetCents })
    return {
      kind: 'amount' as const,
      months: chosenMonths,
      monthlyCents,
      points: compoundGrowth({ initialCents: cents(initial), monthlyCents, rate: rateMonthly, months: chosenMonths }),
    }
  }, [mode, targetCents, rateMonthly, initial, monthly, chosenMonths])

  const last = result && result.kind !== 'unreachable' ? result.points.at(-1) : undefined

  return (
    <div className="calc-layout">
      <InputCard
        title="Primeiro milhão"
        subtitle="Quanto tempo até o alvo, ou quanto aportar por mês para chegar numa data"
        portfolioValueCents={portfolioValueCents}
        onUsePortfolio={() => setInitial(centsToInput(portfolioValueCents))}
        onClear={() => {
          setTarget('1.000.000,00')
          setInitial('')
          setMonthly('')
          setRate('')
          setPeriod('')
        }}
      >
        <Segmented
          ariaLabel="O que calcular"
          className="segmented--nav"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'time', label: 'Quanto tempo' },
            { value: 'amount', label: 'Quanto por mês' },
          ]}
        />
        <MoneyField label="Alvo (R$)" value={target} onChange={setTarget} hint="R$ 1 milhão por padrão; troque para qualquer meta." />
        <MoneyField label="Valor inicial (R$)" value={initial} onChange={setInitial} />
        {mode === 'time' ? (
          <MoneyField label="Aporte mensal (R$)" value={monthly} onChange={setMonthly} />
        ) : (
          <PeriodField label="Em quanto tempo" value={period} unit={periodUnit} onChange={setPeriod} onUnit={setPeriodUnit} />
        )}
        <RateField value={rate} unit={rateUnit} onChange={setRate} onUnit={setRateUnit} />
      </InputCard>

      <div className="stack stack--loose" style={{ minWidth: 0 }}>
        {result?.kind === 'unreachable' ? (
          <Card>
            <EmptyState
              icon="alert"
              title="Não alcança com esses números"
              body="Mesmo em 100 anos, esse valor inicial, aporte e taxa não chegam ao alvo. Mude algum deles para ver o prazo."
            />
          </Card>
        ) : !result || !last ? (
          <Card>
            <EmptyState icon="calculator" title="Preencha alvo, valores e taxa" body="O resultado aparece aqui enquanto você digita." />
          </Card>
        ) : (
          <>
            <div className="kpi-row kpi-row--3">
              {result.kind === 'time' ? (
                <KpiTile
                  accent
                  label="Alcança o alvo em"
                  value={result.months === 0 ? 'já alcançou' : durationLabel(result.months)}
                  foot={result.months === 0 ? undefined : <span>em {fmtPeriod(shiftPeriod(currentPeriod(), result.months))}</span>}
                  assumptions={{ formula: 'Primeiro mês em que saldo × (1 + taxa mensal) + aporte passa do alvo. Até 100 anos.' }}
                />
              ) : (
                <KpiTile
                  accent
                  label="Aporte mensal necessário"
                  value={money(result.monthlyCents)}
                  foot={<span>por {durationLabel(result.months)}, até {fmtPeriod(shiftPeriod(currentPeriod(), result.months))}</span>}
                  assumptions={{ formula: 'Aporte = (alvo − inicial × (1 + i)^n) × i ÷ ((1 + i)^n − 1), com i a taxa mensal e n os meses.' }}
                />
              )}
              <KpiTile label="Total investido" value={money(last.investedCents)} />
              <KpiTile label="Juros ganhos" value={money(last.interestCents)} tone="up" />
            </div>
            <Card title="Caminho até o alvo" subtitle="O que foi investido e o que os juros somaram">
              <GrowthChart points={chartPoints(result.points)} targetCents={targetCents} />
            </Card>
            <div className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
              <Button
                icon="target"
                onClick={() =>
                  onCreateGoal({
                    name: targetCents === 100_000_000 ? 'Primeiro milhão' : `Chegar a ${money(targetCents)}`,
                    targetValueCents: targetCents,
                    targetDate: dueDate(result.months),
                    monthlyContributionCents: result.monthlyCents,
                    expectedReturnBps: annualBps(ratePct! / 100, rateUnit),
                  })
                }
              >
                Criar meta com este plano
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
