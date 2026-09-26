import { useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useMeta } from '../lib/store'
import {
  bps,
  date as fmtDate,
  money,
  parseMoneyInput,
  parsePercentInput,
  period as fmtPeriod,
} from '../lib/format'
import {
  Assumptions,
  Bento,
  Button,
  Card,
  EmptyState,
  HeroFigure,
  Meter,
  Segmented,
  Slab,
  StatTile,
  StatusBadge,
  SkeletonBlock,
  SkeletonLines,
  type AssumptionBag,
} from '../components/ui'
import { GoalModal, type Goal, type Projection } from '../components/ui/GoalModal'
import { Input } from '../components/ui/input'
import { DecumulationChart, type DecumulationPoint } from '../components/charts/DecumulationChart'
import { GoalProjectionChart } from '../components/charts/InvestmentCharts'

/**
 * Aposentadoria / decumulação: a fase em que o patrimônio para de crescer
 * por aporte e passa a ser consumido por retirada.
 *
 * `decisions/0035` governa a tela inteira: o sistema NUNCA calcula "quanto
 * você pode retirar". Todo número de entrada (retirada mensal, retorno
 * esperado, idade, horizonte) é do usuário, e toda saída é a consequência
 * aritmética dessas premissas — Simulação pura, mesma classificação do
 * Simulador de decisões, do qual esta tela é só uma porta de entrada
 * dedicada. Nada aqui é gravado.
 */

type DecumulationResult = {
  series: DecumulationPoint[]
  startingValueCents: number
  monthlyWithdrawalCents: number
  expectedReturnBps: number
  depletionMonth: number | null
  depletionPeriod: string | null
  assumptions: AssumptionBag
}

type Committed = {
  monthlyWithdrawalCents: number
  expectedReturnBps: number
  horizonMonths: number
  /** Aposentadoria: patrimônio PROJETADO de uma meta de investimento, no lugar da carteira de hoje. */
  startingValueCentsOverride?: number
}

/**
 * Só os campos deste subconjunto de `GET /investments` que esta página lê
 * (`goals`/`goalPurposes`) — o mesmo tipo completo é local a
 * `Investments.tsx` e não vale exportar só por isto; a rota já existe e é
 * a mesma que Investimentos > Metas chama, então nenhuma rota nova nasce
 * aqui.
 */
type PortfolioGoals = {
  goals: Goal[]
  goalPurposes: Array<{ value: string; label: string }>
}

/** Idades de referência do recorte "como fica o patrimônio aos ...". */
const MILESTONE_AGES = [60, 70, 80, 90]

const DEFAULTS = { withdrawal: '', expectedReturn: '5', horizonYears: '40', age: '' }

/**
 * Virou aba dentro de Investimentos na revisão de sidebar de 07/09/2026
 * (as duas fases já compartilhavam `GoalModal`/cache de meta — ver
 * comentários abaixo). Sem `PageHeader` próprio: quem hospeda o título é
 * `Investments.tsx`.
 */
export function AposentadoriaTab() {
  const meta = useMeta()
  const [withdrawal, setWithdrawal] = useState(DEFAULTS.withdrawal)
  const [expectedReturn, setExpectedReturn] = useState(DEFAULTS.expectedReturn)
  const [horizonYears, setHorizonYears] = useState(DEFAULTS.horizonYears)
  const [age, setAge] = useState(DEFAULTS.age)
  const [committed, setCommitted] = useState<Committed | null>(null)
  const [goalEditing, setGoalEditing] = useState<Goal | 'new' | null>(null)
  const [selectedGoalId, setSelectedGoalId] = useState<number | null>(null)
  /** 'today' (padrão, comportamento inalterado) ou 'projected' — ver a seção "Simular a partir de". */
  const [startingPoint, setStartingPoint] = useState<'today' | 'projected'>('today')

  const withdrawalFieldId = useId()
  const expectedReturnFieldId = useId()
  const ageFieldId = useId()
  const horizonYearsFieldId = useId()

  // Acumulação: a mesma rota que Investimentos > Metas já chama — nenhuma
  // rota nova. Só filtra por `purpose === 'retirement'` no cliente, porque
  // essa filtragem não existe em lugar nenhum do servidor hoje (achado da
  // exploração, 04/09/2026).
  const portfolio = useQuery({
    queryKey: ['investments'],
    queryFn: () => api.get<PortfolioGoals>('/investments'),
  })
  const retirementGoals = portfolio.data?.goals.filter((g) => g.purpose === 'retirement') ?? []
  const activeGoalId = selectedGoalId ?? retirementGoals[0]?.id ?? null

  // Mesma chave de query que `GoalsEnvironment` (Investments.tsx) usa para
  // a mesma meta — abrir a mesma meta de aposentadoria nas duas telas
  // reaproveita o cache em vez de refazer a chamada.
  const accumulation = useQuery({
    queryKey: ['investment-goal', activeGoalId],
    queryFn: () => api.get<Projection>(`/investments/goals/${activeGoalId}/projection`),
    enabled: activeGoalId !== null,
  })
  const accumData = accumulation.data
  const accumGoal = accumData?.goal

  /**
   * Handoff acumulação -> decumulação (`decisions/0037`... não, é o plano
   * desta feature): as duas fases nunca se falavam — decumulação sempre
   * partia do saldo de HOJE, mesmo simulando "quando eu me aposentar
   * daqui a 29 anos". `projectedAtTargetCents` só existe quando a meta tem
   * `targetDate` válida (futura) — sem isso, a opção "patrimônio
   * projetado" simplesmente não aparece, e a simulação usa a carteira de
   * hoje como sempre usou.
   */
  const projectedRetirementCents = accumData?.projectedAtTargetCents ?? null

  const sim = useQuery({
    queryKey: ['decumulation', committed],
    queryFn: () => api.post<DecumulationResult>('/simulate/decumulation', committed),
    enabled: committed !== null,
  })

  const withdrawalCents = Math.abs(parseMoneyInput(withdrawal) ?? 0)
  const canRun = withdrawalCents > 0

  const result = sim.data
  const currentAge = Number(age) > 0 ? Number(age) : null

  /** Valor projetado em cada idade de referência — leitura direta da série já devolvida, sem recálculo. */
  const milestones = useMemo(() => {
    if (!result || currentAge === null) return []
    return MILESTONE_AGES.filter((a) => a > currentAge).map((a) => {
      const month = Math.round((a - currentAge) * 12)
      const point = result.series[Math.min(month, result.series.length - 1)]
      const beyondSeries = month > result.series.length - 1
      return {
        age: a,
        // Fora da série só existem dois casos: o dinheiro acabou antes (o
        // último ponto é zero) ou o horizonte simulado é curto demais.
        valueCents: beyondSeries && result.depletionMonth === null ? null : (point?.valueCents ?? 0),
      }
    })
  }, [result, currentAge])

  /**
   * Margem de segurança sem veredito: a taxa de retirada anual e o retorno
   * esperado, lado a lado, exatamente o padrão de `decisions/0036` (dois
   * números relacionados, sem hierarquia visual, sem frase dizendo qual
   * "deveria" ser maior). Quem lê tira a conclusão; o produto não tira por
   * ele.
   */
  const withdrawalRateBps =
    result && result.startingValueCents > 0
      ? Math.round(((result.monthlyWithdrawalCents * 12) / result.startingValueCents) * 10_000)
      : null

  const legacyPoint = result?.series[result.series.length - 1] ?? null

  return (
    <>
      <div className="page">
        <Bento>
          {portfolio.isLoading ? (
            <Card span={12}>
              <SkeletonBlock height={220} />
            </Card>
          ) : retirementGoals.length === 0 ? (
            <Slab span={12} accent>
              <div className="stack" style={{ maxWidth: '60ch' }}>
                <span className="stat__label">Nenhuma meta de aposentadoria</span>
                <h2 className="display" style={{ fontSize: 'var(--text-xl)' }}>
                  Defina com quanto patrimônio você quer se aposentar
                </h2>
                <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-base)' }}>
                  Com valor-alvo, data e aporte mensal, o app projeta a trajetória a partir da sua
                  carteira real e calcula o aporte necessário para chegar exatamente na data, sem
                  exigir nenhum valor inicial digitado: ele já vem do que você tem investido hoje.
                </p>
                <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
                  <Button variant="primary" icon="plus" onClick={() => setGoalEditing('new')}>
                    Criar meta de aposentadoria
                  </Button>
                </div>
              </div>
            </Slab>
          ) : (
            <>
              {retirementGoals.length > 1 && (
                <Card span={12} muted>
                  <div className="row row--wrap">
                    {retirementGoals.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        className={`btn ${g.id === activeGoalId ? 'btn--primary' : 'btn--ghost'}`}
                        onClick={() => setSelectedGoalId(g.id)}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                </Card>
              )}

              {!accumData || !accumGoal ? (
                <Card span={12}>
                  <SkeletonBlock height={260} />
                </Card>
              ) : (
                <>
                  <Slab span={5} accent>
                    <HeroFigure label={accumGoal.name} value={money(accumData.currentValueCents)}>
                      <div className="stack stack--tight" style={{ marginTop: 'var(--sp-3)' }}>
                        <div className="row row--between">
                          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-2)' }}>
                            meta {money(accumGoal.targetValueCents)}
                          </span>
                          <StatusBadge state={accumData.state} />
                        </div>
                        <Meter usedBps={accumData.progressBps ?? 0} state={accumData.state} />
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-2)' }}>
                          Valor inicial: {money(accumData.currentValueCents)}, patrimônio negociável
                          de hoje, nunca digitado.
                        </span>
                      </div>
                    </HeroFigure>
                  </Slab>

                  <Card span={7} title="Trajetória até a meta" subtitle="Projeção a partir do que você tem investido hoje">
                    <GoalProjectionChart
                      data={accumData.series}
                      targetCents={accumGoal.targetValueCents}
                      surface="paper"
                      height={250}
                    />
                  </Card>

                  <Card span={6}>
                    <StatTile
                      label="Aporte mensal planejado"
                      value={money(accumGoal.monthlyContributionCents)}
                      foot={`retorno esperado ${bps(accumGoal.expectedReturnBps)} a.a.`}
                    />
                  </Card>
                  <Card span={6}>
                    <StatTile
                      label="No ritmo atual, alcança a meta em"
                      value={accumData.reachedMonth === null ? 'além do horizonte' : fmtPeriod(accumData.reachedPeriod ?? '')}
                      foot={
                        accumData.reachedMonth === null
                          ? 'aumente o aporte para chegar antes'
                          : currentAge !== null
                            ? `você teria ${currentAge + Math.floor(accumData.reachedMonth / 12)} anos`
                            : 'informe sua idade nas Premissas abaixo para ver com quantos anos'
                      }
                    />
                  </Card>
                  <Card span={6}>
                    <StatTile
                      label="Aporte necessário na data-alvo"
                      value={accumData.requiredMonthlyCents === null ? '-' : money(accumData.requiredMonthlyCents)}
                      foot={accumGoal.targetDate ? `para chegar em ${fmtDate(accumGoal.targetDate)}` : 'defina uma data-alvo'}
                    />
                  </Card>
                  <Card span={6}>
                    <StatTile
                      label="Projetado na data-alvo"
                      value={accumData.projectedAtTargetCents === null ? '-' : money(accumData.projectedAtTargetCents)}
                      foot={
                        accumData.projectedAtTargetCents !== null
                          ? accumData.projectedAtTargetCents >= accumGoal.targetValueCents
                            ? 'acima do alvo'
                            : `${money(accumGoal.targetValueCents - accumData.projectedAtTargetCents)} de diferença`
                          : ''
                      }
                    />
                  </Card>

                  <Card span={12} flush>
                    <div className="row row--between" style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
                      <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                        Quer ajustar valor-alvo, data ou aporte desta meta?
                      </span>
                      <Button icon="pencil" onClick={() => setGoalEditing(accumGoal)}>
                        Editar meta
                      </Button>
                    </div>
                  </Card>
                </>
              )}
            </>
          )}

          <Card span={12} title="Premissas" subtitle="Todos os números abaixo são seus; o sistema só calcula a consequência">
            {projectedRetirementCents !== null && (
              <div className="field" style={{ marginBottom: 'var(--sp-4)' }}>
                <label className="field__label">Simular a partir de</label>
                <Segmented
                  ariaLabel="Ponto de partida da simulação"
                  value={startingPoint}
                  onChange={setStartingPoint}
                  options={[
                    { value: 'today', label: 'Carteira hoje' },
                    { value: 'projected', label: 'Patrimônio projetado na aposentadoria' },
                  ]}
                />
                <span className="field__hint">
                  {startingPoint === 'projected'
                    ? `Usa ${money(projectedRetirementCents)}, o patrimônio que "${accumGoal?.name}" projeta na data-alvo, não a carteira de hoje.`
                    : 'Usa a carteira negociável de hoje, como se você já estivesse se aposentando.'}
                </span>
              </div>
            )}
            <div className="row row--wrap" style={{ gap: 'var(--sp-4)', alignItems: 'flex-end' }}>
              <div className="field" style={{ minWidth: 160, flex: '1 1 160px' }}>
                <label className="field__label" htmlFor={withdrawalFieldId}>Retirada mensal</label>
                <Input
                  id={withdrawalFieldId}
                  value={withdrawal}
                  onChange={(e) => setWithdrawal(e.target.value)}
                  placeholder="12.000,00"
                  className="text-right tabular-nums"
                />
              </div>
              <div className="field" style={{ minWidth: 130, flex: '1 1 130px' }}>
                <label className="field__label" htmlFor={expectedReturnFieldId}>Retorno real (a.a.)</label>
                <Input
                  id={expectedReturnFieldId}
                  value={expectedReturn}
                  onChange={(e) => setExpectedReturn(e.target.value)}
                  placeholder="5"
                  className="text-right tabular-nums"
                />
              </div>
              <div className="field" style={{ minWidth: 130, flex: '1 1 130px' }}>
                <label className="field__label" htmlFor={ageFieldId}>Sua idade hoje</label>
                <Input
                  id={ageFieldId}
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="opcional"
                  className="text-right tabular-nums"
                />
              </div>
              <div className="field" style={{ minWidth: 130, flex: '1 1 130px' }}>
                <label className="field__label" htmlFor={horizonYearsFieldId}>Horizonte (anos)</label>
                <Input
                  id={horizonYearsFieldId}
                  value={horizonYears}
                  onChange={(e) => setHorizonYears(e.target.value)}
                  placeholder="40"
                  className="text-right tabular-nums"
                />
                <span className="field__hint">Até 100 anos.</span>
              </div>
              <Button
                variant="primary"
                icon="sparkle"
                disabled={!canRun || sim.isFetching}
                onClick={() =>
                  setCommitted({
                    monthlyWithdrawalCents: withdrawalCents,
                    expectedReturnBps: parsePercentInput(expectedReturn) ?? 0,
                    // Clampado a 100 anos (1200 meses): o mesmo teto que
                    // `simulate.ts`'s zod já aplica no servidor — sem isto,
                    // um horizonte maior falhava a validação e o usuário só
                    // via "Falha ao simular, tente novamente", que não
                    // ajuda quando o problema é o valor digitado, não uma
                    // falha passageira (achado da auditoria de 07/09/2026).
                    horizonMonths: Math.min(1200, Math.max(1, Math.round((Number(horizonYears) || 40) * 12))),
                    startingValueCentsOverride:
                      startingPoint === 'projected' && projectedRetirementCents !== null
                        ? projectedRetirementCents
                        : undefined,
                  })
                }
              >
                Simular
              </Button>
            </div>
            <p className="chart__note">
              Use o retorno REAL (já descontada a inflação) para ler os valores em poder de compra de
              hoje. A simulação sai da sua carteira negociável; o imobilizado fica de fora, porque
              não se saca uma retirada mensal de um bem físico.
            </p>
          </Card>

          {committed === null ? (
            <Card span={12}>
              <EmptyState
                icon="sparkle"
                title="Informe uma retirada mensal"
                body="Preencha quanto você pretende retirar por mês e simule para ver até quando o patrimônio dura, quanto sobra em cada idade e qual a margem entre a retirada e o retorno."
              />
            </Card>
          ) : sim.isError ? (
            <Card span={12}>
              <EmptyState
                icon="alert"
                title="Falha ao simular"
                body="Não foi possível rodar a simulação agora. Tente novamente em instantes."
              />
            </Card>
          ) : !result ? (
            <Card span={12}>
              <SkeletonLines lines={5} />
            </Card>
          ) : (
            <>
              <Slab span={5} accent>
                <HeroFigure
                  label="Duração do patrimônio"
                  value={
                    result.depletionMonth === null
                      ? 'não se esgota'
                      : `${Math.floor(result.depletionMonth / 12)} anos`
                  }
                >
                  <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-xs)', marginTop: 'var(--sp-3)' }}>
                    {result.depletionPeriod === null
                      ? `Retirando ${money(result.monthlyWithdrawalCents)} por mês, o patrimônio não se esgota dentro dos ${Math.round(committed.horizonMonths / 12)} anos simulados, nestas premissas.`
                      : `Retirando ${money(result.monthlyWithdrawalCents)} por mês, o patrimônio projetado chega a zero em ${fmtPeriod(result.depletionPeriod)}${currentAge !== null ? `, quando você teria ${currentAge + Math.floor(result.depletionMonth! / 12)} anos` : ''}.`}
                    {' '}
                    Partindo de {money(result.startingValueCents)}
                    {committed.startingValueCentsOverride !== undefined
                      ? `, o patrimônio projetado na aposentadoria, não a carteira de hoje`
                      : ', a carteira negociável de hoje'}
                    .
                  </p>
                </HeroFigure>
              </Slab>

              <Card span={7} title="Trajetória do patrimônio" subtitle="Mês a mês, sob a retirada informada">
                <DecumulationChart
                  series={result.series}
                  depletionPeriod={result.depletionPeriod}
                  surface="paper"
                  height={240}
                />
              </Card>

              <Card
                span={5}
                title="Retirada e retorno"
                subtitle="Os dois números que decidem se o patrimônio cresce, se mantém ou encolhe"
              >
                <div className="stack stack--loose">
                  <StatTile
                    label="Sua retirada, ao ano"
                    value={withdrawalRateBps === null ? '-' : bps(withdrawalRateBps, 2)}
                    foot={`${money(result.monthlyWithdrawalCents)} por mês sobre ${money(result.startingValueCents)}`}
                  />
                  <StatTile
                    label="Retorno real que você assumiu"
                    value={bps(result.expectedReturnBps, 2)}
                    foot="ao ano, já descontada a inflação"
                  />
                </div>
                <p className="chart__note">
                  Os dois números estão lado a lado de propósito, sem indicar qual deveria ser maior.
                  A diferença entre eles é o que faz o patrimônio subir ou descer ao longo do
                  gráfico, e a leitura é sua.
                </p>
              </Card>

              <Card
                span={7}
                title="Patrimônio ao longo da vida"
                subtitle={
                  currentAge === null
                    ? 'Informe sua idade nas premissas para ver o valor projetado em cada faixa'
                    : 'Valor projetado em cada idade de referência, nestas premissas'
                }
              >
                {currentAge === null ? (
                  <EmptyState
                    icon="info"
                    title="Sem idade informada"
                    body="Preencha o campo Sua idade hoje acima para ver quanto o patrimônio projetado teria aos 60, 70, 80 e 90 anos."
                  />
                ) : milestones.length === 0 ? (
                  <EmptyState
                    icon="info"
                    title="Nenhuma faixa à frente"
                    body="As idades de referência desta visão são 60, 70, 80 e 90 anos, todas anteriores à idade informada."
                  />
                ) : (
                  <div className="bento" style={{ gap: 'var(--sp-4)' }}>
                    {milestones.map((m) => (
                      <div key={m.age} className="col-3">
                        <StatTile
                          label={`Aos ${m.age} anos`}
                          value={m.valueCents === null ? 'além do horizonte' : money(m.valueCents)}
                          foot={
                            m.valueCents === null
                              ? 'aumente o horizonte simulado'
                              : m.valueCents === 0
                                ? 'patrimônio já esgotado'
                                : `em ${m.age - currentAge} anos`
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card
                span={5}
                title="Ao fim do horizonte"
                subtitle="O que restaria depois de todas as retiradas simuladas"
                assumptions={result.assumptions}
              >
                <StatTile
                  label={`Patrimônio em ${legacyPoint ? fmtPeriod(legacyPoint.period) : '-'}`}
                  large
                  value={legacyPoint ? money(legacyPoint.valueCents) : '-'}
                  foot={
                    result.depletionMonth === null
                      ? 'nada foi esgotado no período simulado'
                      : 'o patrimônio chegou a zero antes do fim do horizonte'
                  }
                />
              </Card>
            </>
          )}
        </Bento>
      </div>

      {goalEditing !== null && (
        <GoalModal
          goal={goalEditing === 'new' ? null : goalEditing}
          goalPurposes={portfolio.data?.goalPurposes ?? []}
          defaultPurpose="retirement"
          onClose={() => setGoalEditing(null)}
        />
      )}
    </>
  )
}
