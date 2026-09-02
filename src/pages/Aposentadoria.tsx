import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useMeta } from '../lib/store'
import { bps, money, moneyCompact, parseMoneyInput, parsePercentInput, period as fmtPeriod } from '../lib/format'
import {
  Assumptions,
  Bento,
  Button,
  Card,
  EmptyState,
  HeroFigure,
  Slab,
  StatTile,
  SkeletonLines,
  type AssumptionBag,
} from '../components/ui'
import { Input } from '../components/ui/input'
import { PageHeader } from '../components/shell/Shell'
import { DecumulationChart, type DecumulationPoint } from '../components/charts/DecumulationChart'

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
}

/** Idades de referência do recorte "como fica o patrimônio aos ...". */
const MILESTONE_AGES = [60, 70, 80, 90]

const DEFAULTS = { withdrawal: '', expectedReturn: '5', horizonYears: '40', age: '' }

export function AposentadoriaPage() {
  const meta = useMeta()
  const [withdrawal, setWithdrawal] = useState(DEFAULTS.withdrawal)
  const [expectedReturn, setExpectedReturn] = useState(DEFAULTS.expectedReturn)
  const [horizonYears, setHorizonYears] = useState(DEFAULTS.horizonYears)
  const [age, setAge] = useState(DEFAULTS.age)
  const [committed, setCommitted] = useState<Committed | null>(null)

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
      <PageHeader
        title="Aposentadoria"
        subtitle="Quanto tempo o patrimônio dura sob uma retirada mensal que você define"
      />

      <div className="page">
        <Bento>
          <Card span={12} title="Premissas" subtitle="Todos os números abaixo são seus; o sistema só calcula a consequência">
            <div className="row row--wrap" style={{ gap: 'var(--sp-4)', alignItems: 'flex-end' }}>
              <div className="field" style={{ minWidth: 160, flex: '1 1 160px' }}>
                <label className="field__label">Retirada mensal</label>
                <Input
                  value={withdrawal}
                  onChange={(e) => setWithdrawal(e.target.value)}
                  placeholder="12.000,00"
                  className="text-right tabular-nums"
                />
              </div>
              <div className="field" style={{ minWidth: 130, flex: '1 1 130px' }}>
                <label className="field__label">Retorno real (a.a.)</label>
                <Input
                  value={expectedReturn}
                  onChange={(e) => setExpectedReturn(e.target.value)}
                  placeholder="5"
                  className="text-right tabular-nums"
                />
              </div>
              <div className="field" style={{ minWidth: 130, flex: '1 1 130px' }}>
                <label className="field__label">Sua idade hoje</label>
                <Input
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="opcional"
                  className="text-right tabular-nums"
                />
              </div>
              <div className="field" style={{ minWidth: 130, flex: '1 1 130px' }}>
                <label className="field__label">Horizonte (anos)</label>
                <Input
                  value={horizonYears}
                  onChange={(e) => setHorizonYears(e.target.value)}
                  placeholder="40"
                  className="text-right tabular-nums"
                />
              </div>
              <Button
                variant="primary"
                icon="sparkle"
                disabled={!canRun || sim.isFetching}
                onClick={() =>
                  setCommitted({
                    monthlyWithdrawalCents: withdrawalCents,
                    expectedReturnBps: parsePercentInput(expectedReturn) ?? 0,
                    horizonMonths: Math.round((Number(horizonYears) || 40) * 12),
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
                    foot={`${money(result.monthlyWithdrawalCents)} por mês sobre ${moneyCompact(result.startingValueCents)}`}
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
                          value={m.valueCents === null ? 'além do horizonte' : moneyCompact(m.valueCents)}
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
    </>
  )
}
