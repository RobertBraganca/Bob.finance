import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useMeta } from '../lib/store'
import { bps, bpsToInput, money, parsePercentInput, periodLong, points } from '../lib/format'
import {
  Assumptions,
  Button,
  Card,
  EmptyState,
  HeroFigure,
  Icon,
  Meter,
  Modal,
  scoreIndicatorState,
  Slab,
  StatTile,
  TextInput,
  useToast,
  type AssumptionBag,
} from '../components/ui'
import { SimulatorModal } from '../components/ui/SimulatorModal'
import { PageHeader } from '../components/shell/Shell'

/**
 * Saúde financeira: Health Score, Runway, Radar de risco.
 *
 * Two copy rules from `decisions/0010` are visible in every string on this
 * page. Nothing is phrased as an instruction ("invista", "corte"), only as a
 * description of what the data shows; and every number is followed by its
 * `assumptions`, rendered by the shared `Assumptions` disclosure, because a
 * metric without an auditable calculation does not satisfy the ADR.
 *
 * As of 2026-08-25, os indicadores DA Composição do score usam a mesma
 * régua amarelo/vermelho/verde de todo o resto do app
 * (`scoreIndicatorState`, `src/components/ui/index.tsx`), a pedido direto
 * do usuário. Nunca foi uma questão de decisions/0010 proibir cor aqui —
 * a nota de 0 a 100 já É uma nota, "maior é melhor" universalmente entre
 * os 5 indicadores; colorir é só visualizar o número que a barra já
 * mostra, não inventar uma meta que ninguém configurou. O que decisions/
 * 0010 continua proibindo é o TEXTO: nenhuma destas cores vem com
 * "invista"/"corte" ao lado, só a barra e o rótulo "Como calculamos".
 * O Radar de risco continua sendo o único lugar em que a cor viaja junto
 * com ícone E texto escrito, porque lá o limite é explicitamente
 * configurado pelo usuário.
 */

type IndicatorKey = 'liquidity' | 'debt' | 'spending' | 'reserve' | 'allocation'

type ScoredIndicator = {
  key: IndicatorKey
  label: string
  scoreBps: number | null
  weight: number
  appliedWeightBps: number | null
  assumptions: AssumptionBag
}

type HealthScore = {
  period: string
  accountId: number | null
  scoreBps: number | null
  indicators: ScoredIndicator[]
  assumptions: AssumptionBag
}

type RunwayScope = {
  accountId: number | null
  label: string
  months: number | null
  netWorthCents: number
  monthlyCostCents: number
  assumptions: AssumptionBag
}

type Runway = { scopes: RunwayScope[]; consolidated: RunwayScope }

type NetWorth = {
  balanceCents: number
  investmentsCents: number
  debtCents: number
  liquidityCents: number
  assumptions: AssumptionBag
}

type RiskRule = {
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

type RiskRadar = { period: string; rules: RiskRule[]; assumptions: AssumptionBag }

type HealthSettings = {
  weightLiquidity: number
  weightDebt: number
  weightSpending: number
  weightReserve: number
  weightAllocation: number
  costLookbackMonths: number
  riskCardShareBps: number
  riskReserveCoverageBps: number
  riskAllocationDriftBps: number
  riskSpendingCapBps: number
  riskDebtToIncomeBps: number
  riskPositiveMarginBps: number
}

function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + months
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** "4,2 meses" / "sem despesa para calcular" — never "infinito" and never 0. */
const monthsLabel = (months: number | null) =>
  months === null
    ? 'sem base de cálculo'
    : `${months.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${months === 1 ? 'mês' : 'meses'}`

export function FinancialHealthPage() {
  const meta = useMeta()
  const [period, setPeriod] = useState<string | null>(null)
  const [tuning, setTuning] = useState(false)
  const [simulating, setSimulating] = useState(false)

  // The ledger's most recent month, same fallback the API uses, so the page
  // does not open empty for someone whose statements end in the past.
  const resolvedPeriod = period ?? meta.data?.ledger.max?.slice(0, 7) ?? meta.data?.today?.slice(0, 7) ?? null

  const score = useQuery({
    queryKey: ['financial-health-score', resolvedPeriod],
    queryFn: () => api.get<HealthScore>('/financial-health/score', { period: resolvedPeriod }),
    enabled: resolvedPeriod !== null,
    placeholderData: (previous) => previous,
  })

  const runway = useQuery({
    queryKey: ['financial-health-runway'],
    queryFn: () => api.get<Runway>('/financial-health/runway'),
    enabled: meta.isSuccess,
  })

  const radar = useQuery({
    queryKey: ['financial-health-radar', resolvedPeriod],
    queryFn: () => api.get<RiskRadar>('/financial-health/risk-radar', { period: resolvedPeriod }),
    enabled: resolvedPeriod !== null,
    placeholderData: (previous) => previous,
  })

  const netWorth = useQuery({
    queryKey: ['financial-health-net-worth'],
    queryFn: () => api.get<NetWorth>('/financial-health/net-worth'),
    enabled: meta.isSuccess,
  })

  const data = score.data
  const hasLedger = (meta.data?.ledger.count ?? 0) > 0

  return (
    <>
      <PageHeader
        title="Saúde financeira"
        subtitle={resolvedPeriod ? periodLong(resolvedPeriod) : undefined}
        actions={
          <div className="row">
            <Button size="sm" onClick={() => setPeriod(shiftPeriod(resolvedPeriod ?? '2026-01', -1))}>
              Anterior
            </Button>
            <Button size="sm" onClick={() => setPeriod(shiftPeriod(resolvedPeriod ?? '2026-01', 1))}>
              Seguinte
            </Button>
            <Button size="sm" icon="sparkle" onClick={() => setSimulating(true)}>
              Simular
            </Button>
            <Button variant="primary" icon="settings" onClick={() => setTuning(true)}>
              Pesos e limites
            </Button>
          </div>
        }
      />

      <div className="page">
        {!hasLedger ? (
          <Card>
            <EmptyState
              icon="sparkle"
              title="Nenhum dado importado ainda"
              body="A saúde financeira é derivada dos lançamentos, das dívidas, dos cartões e da carteira. Ela aparece assim que houver histórico para ler."
            />
          </Card>
        ) : !data ? (
          <Card>
            <EmptyState title="Carregando indicadores…" />
          </Card>
        ) : (
          <div className="bento">
            <Slab span={4} accent>
              <HeroFigure
                label="Health Score do mês"
                value={data.scoreBps === null ? 'sem dado' : bps(data.scoreBps, 0)}
              >
                <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-xs)', marginTop: 'var(--sp-3)' }}>
                  {data.scoreBps === null
                    ? 'Nenhum dos cinco indicadores tem dado suficiente neste período.'
                    : `Média de ${data.indicators.filter((i) => i.scoreBps !== null).length} de 5 indicadores, ponderada pelos pesos configurados.`}
                </p>
              </HeroFigure>
            </Slab>

            <Card
              span={8}
              title="Composição do score"
              subtitle="Cada indicador vale de 0 a 100. Um indicador sem dado sai da média, e seu peso é redistribuído entre os demais"
            >
              <div className="stack stack--loose">
                {data.indicators.map((indicator) => (
                  <IndicatorRow key={indicator.key} indicator={indicator} />
                ))}
              </div>
              <Assumptions data={data.assumptions} label="Como compomos o score" />
            </Card>

            {/*
              Vizinho do Runway de propósito: os dois somam patrimônio, com
              recortes diferentes, e ver os números lado a lado é o que deixa
              a diferença explícita em vez de parecer inconsistência.
            */}
            <Card
              span={12}
              title="Patrimônio consolidado"
              subtitle="Quanto existe hoje contra quanto se deve, somando conta, carteira e dívida"
            >
              {!netWorth.data ? (
                <EmptyState title="Calculando…" />
              ) : (
                <>
                  <div className="bento" style={{ gap: 'var(--sp-4)' }}>
                    <div className="col-3">
                      <StatTile label="Saldo em conta" value={money(netWorth.data.balanceCents)} />
                    </div>
                    <div className="col-3">
                      <StatTile label="Investimentos" value={money(netWorth.data.investmentsCents)} />
                    </div>
                    <div className="col-3">
                      <StatTile label="Dívida total" value={money(netWorth.data.debtCents)} />
                    </div>
                    <div className="col-3">
                      <StatTile label="Liquidez" value={money(netWorth.data.liquidityCents)} large />
                    </div>
                  </div>
                  <p className="chart__note">
                    A dívida aqui é a total, e os investimentos são todos, diferente do Runway ao
                    lado, que usa só a dívida dos próximos 30 dias e só os investimentos líquidos.
                    As duas perguntas são diferentes, então os dois números também são.
                  </p>
                  <Assumptions data={netWorth.data.assumptions} />
                </>
              )}
            </Card>

            <Card
              span={5}
              title="Runway"
              subtitle="Quantos meses os recursos atuais cobrem o custo mensal médio"
            >
              {!runway.data ? (
                <EmptyState title="Calculando…" />
              ) : (
                <div className="stack stack--loose">
                  <StatTile
                    label="Consolidado"
                    large
                    value={monthsLabel(runway.data.consolidated.months)}
                    foot={
                      <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                        {money(runway.data.consolidated.netWorthCents)} considerados,{' '}
                        {money(runway.data.consolidated.monthlyCostCents)} por mês
                      </span>
                    }
                  />
                  <Assumptions data={runway.data.consolidated.assumptions} />
                  <hr className="divider" />
                  <div className="kv">
                    {runway.data.scopes
                      .filter((scope) => scope.accountId !== null)
                      .map((scope) => (
                        <RunwayRow key={scope.accountId} scope={scope} />
                      ))}
                  </div>
                  <p className="chart__note">
                    Investimentos entram apenas na linha consolidada, porque um ativo não pertence a
                    uma conta corrente específica.
                  </p>
                </div>
              )}
            </Card>

            <Card
              span={7}
              title="Radar de risco"
              subtitle="Cada indicador comparado com o limite que você configurou"
            >
              {!radar.data ? (
                <EmptyState title="Calculando…" />
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
                  <Assumptions data={radar.data.assumptions} label="Como avaliamos o radar" />
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      {tuning && <SettingsEditor onClose={() => setTuning(false)} />}
      {simulating && <SimulatorModal onClose={() => setSimulating(false)} />}
    </>
  )
}

function IndicatorRow({ indicator }: { indicator: ScoredIndicator }) {
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
      <Meter usedBps={indicator.scoreBps ?? 0} state={scoreIndicatorState(indicator.scoreBps)} />
      <Assumptions data={indicator.assumptions} />
    </div>
  )
}

function RunwayRow({ scope }: { scope: RunwayScope }) {
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

function RiskRow({ rule }: { rule: RiskRule }) {
  const comparison = rule.direction === 'above' ? 'acima de' : 'abaixo de'
  // A drift is a gap between two percentages, not a share of anything.
  const format = rule.unit === 'points' ? points : bps
  return (
    <div className="stack stack--tight">
      <div className="row row--between">
        <strong className="truncate" style={{ fontSize: 'var(--text-sm)' }}>
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
      <Assumptions data={rule.assumptions} />
    </div>
  )
}

function SettingsEditor({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: ['financial-health-settings'],
    queryFn: () => api.get<{ settings: HealthSettings; defaults: HealthSettings }>('/financial-health/settings'),
  })

  const [draft, setDraft] = useState<Partial<Record<keyof HealthSettings, string>>>({})
  const current = settings.data?.settings
  const defaults = settings.data?.defaults

  const value = (key: keyof HealthSettings, format: 'int' | 'bps') =>
    draft[key] ??
    (current === undefined
      ? ''
      : format === 'bps'
        ? bpsToInput(current[key])
        : String(current[key]))

  const set = (key: keyof HealthSettings) => (raw: string) =>
    setDraft((previous) => ({ ...previous, [key]: raw }))

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, number> = {}
      const ints: Array<keyof HealthSettings> = [
        'weightLiquidity',
        'weightDebt',
        'weightSpending',
        'weightReserve',
        'weightAllocation',
        'costLookbackMonths',
      ]
      const bpsKeys: Array<keyof HealthSettings> = [
        'riskCardShareBps',
        'riskReserveCoverageBps',
        'riskAllocationDriftBps',
        'riskSpendingCapBps',
        'riskDebtToIncomeBps',
        'riskPositiveMarginBps',
      ]
      for (const key of ints) {
        const raw = draft[key]
        if (raw === undefined || raw.trim() === '') continue
        const parsed = Number(raw.replace(',', '.'))
        if (Number.isFinite(parsed)) body[key] = Math.round(parsed)
      }
      for (const key of bpsKeys) {
        const raw = draft[key]
        if (raw === undefined || raw.trim() === '') continue
        const parsed = parsePercentInput(raw)
        if (parsed !== null) body[key] = parsed
      }
      return api.put('/financial-health/settings', body)
    },
    onSuccess: () => {
      toast('Pesos e limites salvos')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const restore = () => {
    if (!defaults) return
    setDraft({
      weightLiquidity: String(defaults.weightLiquidity),
      weightDebt: String(defaults.weightDebt),
      weightSpending: String(defaults.weightSpending),
      weightReserve: String(defaults.weightReserve),
      weightAllocation: String(defaults.weightAllocation),
      costLookbackMonths: String(defaults.costLookbackMonths),
      riskCardShareBps: bpsToInput(defaults.riskCardShareBps),
      riskReserveCoverageBps: bpsToInput(defaults.riskReserveCoverageBps),
      riskAllocationDriftBps: bpsToInput(defaults.riskAllocationDriftBps),
      riskSpendingCapBps: bpsToInput(defaults.riskSpendingCapBps),
      riskDebtToIncomeBps: bpsToInput(defaults.riskDebtToIncomeBps),
      riskPositiveMarginBps: bpsToInput(defaults.riskPositiveMarginBps),
    })
  }

  return (
    <Modal
      title="Pesos do score e limites do radar"
      onClose={onClose}
      wide
      footer={
        <>
          <Button icon="refresh" onClick={restore} disabled={!defaults}>
            Voltar aos valores sugeridos
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      {!current ? (
        <EmptyState title="Carregando…" />
      ) : (
        <div className="stack stack--loose">
          <div className="stack stack--tight">
            <span className="label">Pesos do Health Score</span>
            <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Os pesos são relativos: não precisam somar 100. Um indicador sem dado no mês sai da
              média, e o peso dele é redistribuído entre os que sobraram.
            </p>
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
              <NumberField label="Liquidez" value={value('weightLiquidity', 'int')} onChange={set('weightLiquidity')} />
              <NumberField label="Endividamento" value={value('weightDebt', 'int')} onChange={set('weightDebt')} />
              <NumberField label="Controle de gastos" value={value('weightSpending', 'int')} onChange={set('weightSpending')} />
              <NumberField label="Reserva" value={value('weightReserve', 'int')} onChange={set('weightReserve')} />
              <NumberField label="Metas de alocação" value={value('weightAllocation', 'int')} onChange={set('weightAllocation')} />
            </div>
          </div>

          <div className="stack stack--tight">
            <span className="label">Janela de cálculo</span>
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
              <NumberField
                label="Meses de custo médio"
                hint="Usada na liquidez e no runway"
                value={value('costLookbackMonths', 'int')}
                onChange={set('costLookbackMonths')}
              />
            </div>
          </div>

          <div className="stack stack--tight">
            <span className="label">Limites do radar de risco</span>
            <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Um indicador só aparece como fora da faixa quando cruza o limite definido aqui.
              Enquanto nenhum limite for alterado, valem os valores sugeridos.
            </p>
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
              <NumberField
                label="Limite de cartão sobre receita (%)"
                hint="acima disso, fora da faixa"
                value={value('riskCardShareBps', 'bps')}
                onChange={set('riskCardShareBps')}
              />
              <NumberField
                label="Cobertura da reserva (%)"
                hint="abaixo disso, fora da faixa"
                value={value('riskReserveCoverageBps', 'bps')}
                onChange={set('riskReserveCoverageBps')}
              />
              <NumberField
                label="Desvio de alocação (p.p.)"
                hint="acima disso, fora da faixa"
                value={value('riskAllocationDriftBps', 'bps')}
                onChange={set('riskAllocationDriftBps')}
              />
              <NumberField
                label="Uso do teto de gasto (%)"
                hint="acima disso, fora da faixa"
                value={value('riskSpendingCapBps', 'bps')}
                onChange={set('riskSpendingCapBps')}
              />
              <NumberField
                label="Renda comprometida (%)"
                hint="acima disso, fora da faixa"
                value={value('riskDebtToIncomeBps', 'bps')}
                onChange={set('riskDebtToIncomeBps')}
              />
            </div>
          </div>

          <div className="stack stack--tight">
            <span className="label">Folga para sinal positivo</span>
            <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Um indicador só é marcado como acima da folga quando passa do limite configurado por
              esta margem, para o lado favorável. Estar dentro da faixa não basta: com folga de 20
              p.p., uma cobertura de reserva de 105% contra um limite de 100% continua sendo apenas
              "dentro da faixa".
            </p>
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
              <NumberField
                label="Margem de folga (p.p.)"
                hint="quanto além do limite conta como sinal positivo"
                value={value('riskPositiveMarginBps', 'bps')}
                onChange={set('riskPositiveMarginBps')}
              />
            </div>
          </div>

          <p className="chart__note">
            Estes números são seus, não do app. Eles aparecem ao lado de cada indicador na tela e
            dentro da memória de cálculo de cada resposta, para que o resultado sempre possa ser
            conferido contra o limite que o produziu.
          </p>
        </div>
      )}
    </Modal>
  )
}

function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="field" style={{ width: 168 }}>
      <label className="field__label">{label}</label>
      <TextInput value={value} onChange={onChange} numeral />
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  )
}
