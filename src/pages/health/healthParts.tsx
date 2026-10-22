import { Assumptions, Icon, Meter, scoreIndicatorState, type AssumptionBag } from '../../components/ui'
import { bps, points } from '../../lib/format'

/**
 * Peças da Saúde financeira usadas fora da página (docs/specs/tarefas-comercial-contador,
 * dissolver a Saúde financeira): score e runway na Visão geral, radar no Orçamento.
 * A página continua usando as mesmas, para os números lerem igual nos dois lugares.
 */

export type IndicatorKey = 'liquidity' | 'debt' | 'spending' | 'reserve' | 'allocation'

export type ScoredIndicator = {
  key: IndicatorKey
  label: string
  scoreBps: number | null
  weight: number
  appliedWeightBps: number | null
  assumptions: AssumptionBag
}

export type HealthScore = {
  period: string
  scoreBps: number | null
  indicators: ScoredIndicator[]
  assumptions: AssumptionBag
}

export type RunwayScope = {
  accountId: number | null
  label: string
  months: number | null
  netWorthCents: number
  monthlyCostCents: number
  assumptions: AssumptionBag
}

export type Runway = { scopes: RunwayScope[]; consolidated: RunwayScope }

export type RiskRule = {
  key: string
  label: string
  valueBps: number
  thresholdBps: number
  /** 'share' is a percentage of something; 'points' is a gap between two percentages. */
  unit: 'share' | 'points'
  direction: 'above' | 'below'
  outsideRange: boolean
  /** Do lado bom por uma folga configurada. Independente de outsideRange, não o oposto dele. */
  exceedsPositively: boolean
  assumptions: AssumptionBag
}

export type RiskRadar = { period: string; rules: RiskRule[]; assumptions: AssumptionBag }

/** "4,2 meses" / "sem despesa para calcular" — never "infinito" and never 0. */
// Meses negativos não têm leitura ("−9 meses" de runway): com recurso zero
// ou negativo, o que existe para dizer é que não há o que cobrir o custo.
export const monthsLabel = (months: number | null) =>
  months === null
    ? 'sem base de cálculo'
    : months <= 0
      ? 'sem saldo positivo'
      : `${months.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${months === 1 ? 'mês' : 'meses'}`

export function IndicatorRow({ indicator }: { indicator: ScoredIndicator }) {
  const missing = indicator.scoreBps === null
  return (
    <div className="stack stack--tight">
      <div className="row row--between">
        <span className="row" style={{ gap: 'var(--sp-2)', minWidth: 0 }}>
          <strong style={{ fontSize: 'var(--text-sm)' }}>{indicator.label}</strong>
          {missing && <span className="badge">sem dado</span>}
        </span>
        <span className="row" style={{ gap: 'var(--sp-3)' }}>
          <span className="indicator__weight">
            {indicator.appliedWeightBps === null
              ? `peso ${indicator.weight}, fora da média`
              : `${bps(indicator.appliedWeightBps, 0)} do score`}
          </span>
          <span className="indicator__score">{missing ? '-' : bps(indicator.scoreBps!, 0)}</span>
        </span>
      </div>
      <Meter label={`Nota de ${indicator.label}`} usedBps={indicator.scoreBps ?? 0} state={scoreIndicatorState(indicator.scoreBps)} />
      <Assumptions data={indicator.assumptions} compact />
    </div>
  )
}

export function RunwayRow({ scope }: { scope: RunwayScope }) {
  return (
    <>
      <span className="kv__k truncate">{scope.label}</span>
      <span className="kv__v">{monthsLabel(scope.months)}</span>
    </>
  )
}

/**
 * "Dentro da faixa" / "Fora da faixa" instead of the ledger's own
 * met/exceeded vocabulary: a radar rule is a comparison against a limit the
 * user chose, not a goal they hit or missed.
 */
/** "30,0 p.p. acima" / "12,5% abaixo": a distância medida, sem adjetivo. */
function distanceLabel(rule: RiskRule): string {
  const format = rule.unit === 'points' ? points : bps
  const gap = Math.abs(rule.valueBps - rule.thresholdBps)
  return `${format(gap)} ${rule.direction === 'below' ? 'acima' : 'abaixo'}`
}

export function RiskRow({ rule }: { rule: RiskRule }) {
  const comparison = rule.direction === 'above' ? 'acima de' : 'abaixo de'
  // A drift is a gap between two percentages, not a share of anything.
  const format = rule.unit === 'points' ? points : bps
  return (
    <div className="stack stack--tight">
      <div className="row row--between" style={{ alignItems: 'flex-start' }}>
        {/* Sem truncate (revisão de responsividade de 26/09/2026): rótulos
            longos ("Maior desvio entre carteira e política de alocação")
            cortavam num telefone — quebra em vez de esconder o fim da frase. */}
        <strong style={{ fontSize: 'var(--text-sm)', minWidth: 0 }}>
          {rule.label}
        </strong>
        {/*
          Três estados, não dois. "Acima da folga" é o sinal positivo do
          ADR: um indicador pode estar dentro da faixa sem ter folga
          suficiente para merecer o selo verde, e aí fica no estado neutro.
        */}
        {rule.exceedsPositively ? (
          <span className="badge badge--good">
            <Icon name="check" size={11} strokeWidth={2.4} />
            Acima da folga
          </span>
        ) : (
          <span className={`badge ${rule.outsideRange ? 'badge--warning' : ''}`}>
            <Icon name={rule.outsideRange ? 'alert' : 'info'} size={11} strokeWidth={2.4} />
            {rule.outsideRange ? 'Fora da faixa' : 'Dentro da faixa'}
          </span>
        )}
      </div>
      <div className="row row--between">
        <span className="tabular" style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>
          {format(rule.valueBps)}
        </span>
        <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
          seu limite: {comparison} {format(rule.thresholdBps)}
        </span>
      </div>
      {/*
        Observação, nunca comemoração: a frase declara a distância medida e
        para por aí. Nada de "parabéns" ou "continue assim" (ADR 0010).
      */}
      {rule.exceedsPositively && (
        <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
          {distanceLabel(rule)} do limite configurado, para o lado favorável.
        </span>
      )}
      <Assumptions data={rule.assumptions} compact />
    </div>
  )
}
