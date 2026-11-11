import { bps, money, monthsLabel, periodLong as fmtPeriodLong } from '../../lib/format'
import { Button, Card, Icon } from '../../components/ui'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import type { PayoffStrategy, StrategyRecommendation } from '@shared/debt'

export type PayoffRecommendationData = StrategyRecommendation & { extraMonthlyCents: number }

const STRATEGY_LABEL: Record<PayoffStrategy, string> = { avalanche: 'avalanche', snowball: 'bola de neve' }

/**
 * Qual estratégia seguir e por qual dívida começar (decisions/0047). Os
 * números vêm de `services/debt#paydownComparison`, que simula as duas
 * estratégias com o mesmo aporte extra; aqui só se escreve a frase.
 */
export function PayoffRecommendationCard({
  data,
  selected,
  onSelect,
}: {
  data: PayoffRecommendationData
  /** estratégia escolhida no gráfico de trajetória */
  selected: PayoffStrategy
  onSelect: (strategy: PayoffStrategy) => void
}) {
  const { strategy, reason, attackFirst } = data
  const other: PayoffStrategy | null = strategy === null ? null : strategy === 'avalanche' ? 'snowball' : 'avalanche'
  const extra = data.extraMonthlyCents > 0 ? ` com ${money(data.extraMonthlyCents)} de aporte extra por mês` : ' com os pagamentos atuais'
  const payoff = data.payoffPeriod ? ` (${fmtPeriodLong(data.payoffPeriod)})` : ''

  let title: string
  let body: string
  if (reason === 'never_ends') {
    title = 'Aumente o pagamento: assim a dívida não acaba'
    body = 'Com os pagamentos atuais o saldo não cai em nenhuma das duas estratégias, porque as parcelas não cobrem os juros.'
  } else if (reason === 'single_debt') {
    title = attackFirst ? `Todo valor extra vai para ${attackFirst.name}` : 'Uma dívida aberta'
    body = `Com uma dívida só, avalanche e bola de neve são a mesma coisa. Ela quita em ${monthsLabel(data.months)}${payoff}${extra}, com ${money(data.totalInterestCents)} de juros no caminho.`
  } else if (reason === 'tie_first_sooner') {
    const diff = data.interestSavedCents
    title = 'Recomendado: bola de neve'
    body =
      `Os juros praticamente empatam (${diff >= 0 ? `${money(diff)} a menos` : `${money(-diff)} a mais`} que a avalanche, abaixo de ${money(data.tieThresholdCents)}), ` +
      `e a primeira dívida acaba em ${monthsLabel(data.firstClearedMonths.snowball)}, contra ${monthsLabel(data.firstClearedMonths.avalanche)} na avalanche: ` +
      `uma parcela some mais cedo e passa a reforçar a próxima. Quita tudo em ${monthsLabel(data.months)}${payoff}${extra}.`
  } else if (reason === 'same') {
    title = 'Recomendado: avalanche'
    body = `Com as suas dívidas as duas estratégias chegam no mesmo resultado: quita em ${monthsLabel(data.months)}${payoff}${extra}, com ${money(data.totalInterestCents)} de juros. A avalanche fica por nunca custar mais.`
  } else {
    title = `Recomendado: ${STRATEGY_LABEL[strategy!]}`
    const faster = data.monthsSaved !== null && data.monthsSaved > 0 ? ` e termina ${monthsLabel(data.monthsSaved)} antes` : ''
    body = `Quita em ${monthsLabel(data.months)}${payoff}${extra} e paga ${money(data.interestSavedCents)} a menos de juros que a ${STRATEGY_LABEL[other!]}${faster}.`
  }

  const attackLine = attackFirst
    ? attackFirst.why === 'highest_rate'
      ? `É a de maior taxa (${bps(attackFirst.aprBps)} ao ano): cada real a mais nela evita mais juros.`
      : attackFirst.why === 'smallest_balance'
        ? `É a de menor saldo (${money(attackFirst.balanceCents)}): acaba primeiro e libera a parcela dela para a próxima.`
        : null
    : null

  return (
    <Card span={12} title="O que fazer" subtitle="Avalanche e bola de neve simuladas com o mesmo aporte extra">
      <div className="stack">
        <Alert variant={reason === 'never_ends' ? 'warning' : 'good'}>
          <Icon name={reason === 'never_ends' ? 'alert' : 'target'} size={16} />
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{body}</AlertDescription>
        </Alert>

        {attackFirst && reason !== 'single_debt' && (
          <div className="stack stack--tight">
            <span className="label">Ataque primeiro</span>
            <span style={{ fontSize: 'var(--text-base)' }}>
              <strong>{attackFirst.name}</strong>
              {attackFirst.months !== null && (
                <span className="muted"> · quita em {monthsLabel(attackFirst.months)} no plano recomendado</span>
              )}
            </span>
            <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
              Todo valor extra vai para ela até zerar. {attackLine}
            </span>
          </div>
        )}

        {strategy !== null && strategy !== selected && (
          <div className="row">
            <Button variant="ghost" icon="arrowRight" onClick={() => onSelect(strategy)}>
              Ver a {STRATEGY_LABEL[strategy]} no gráfico
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}
