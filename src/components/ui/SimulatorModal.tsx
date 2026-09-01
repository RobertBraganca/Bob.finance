import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bps, money, parseMoneyInput, parsePercentInput, period as fmtPeriod } from '../../lib/format'
// Importa do barrel uma vez só. NÃO é reexportado por ele: o barrel
// importando este arquivo, que importa o barrel de volta, fecharia um ciclo.
import { Assumptions, type AssumptionBag } from './Assumptions'
import { Button, EmptyState, Select } from './index'
import { DecumulationChart } from '../charts/DecumulationChart'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from './dialog'
import { Input } from './input'
import { Tabs, TabsList, TabsTrigger } from './tabs'

/**
 * Simulador de decisões: "e se eu fizesse X?".
 *
 * Mostra a consequência calculada e para aí. Nenhum selo de "bom" ou
 * "ruim", nenhuma cor de veredito própria: o Health Score e o Radar já têm
 * os deles, e um terceiro sistema de cor aqui viraria opinião sobre a
 * hipótese, que é exatamente o que `decisions/0010` mantém fora do produto.
 *
 * Nada do que acontece aqui é gravado (`decisions/0016`).
 */

type Metric<T> = { before: T; after: T; delta: T }

type SimulationResult = {
  healthScoreBps: Metric<number | null>
  runwayMonths: Metric<number | null>
  availableCents: Metric<number>
  assumptions: AssumptionBag
  debtName?: string
  payoffCents?: number
  savedInterestCents?: number
}

type DebtRow = { id: number; name: string; balanceCents: number }

const SOURCES = [
  { value: 'balance', label: 'Saldo em conta' },
  { value: 'reserve', label: 'Reserva' },
  { value: 'investment', label: 'Investimentos' },
] as const

type Source = (typeof SOURCES)[number]['value']

type DecumulationPoint = { month: number; period: string; valueCents: number }

type DecumulationResult = {
  series: DecumulationPoint[]
  startingValueCents: number
  monthlyWithdrawalCents: number
  expectedReturnBps: number
  depletionMonth: number | null
  depletionPeriod: string | null
  assumptions: AssumptionBag
}

type SimKind = 'expense' | 'payoff' | 'decumulation'

export function SimulatorModal({
  onClose,
  initialKind = 'expense',
  initialDebtId = null,
}: {
  onClose: () => void
  initialKind?: SimKind
  initialDebtId?: number | null
}) {
  const [kind, setKind] = useState<SimKind>(initialKind)
  const [amount, setAmount] = useState('')
  const [source, setSource] = useState<Source>('balance')
  const [debtId, setDebtId] = useState<number | null>(initialDebtId)
  const [withdrawal, setWithdrawal] = useState('')
  const [expectedReturn, setExpectedReturn] = useState('8')
  const [horizonYears, setHorizonYears] = useState('30')
  const [result, setResult] = useState<SimulationResult | null>(null)
  const [decumulation, setDecumulation] = useState<DecumulationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const debts = useQuery({
    queryKey: ['debts-for-simulator'],
    queryFn: () => api.get<{ debts: DebtRow[] }>('/debts'),
    enabled: kind === 'payoff',
  })

  const run = useMutation<SimulationResult | DecumulationResult>({
    mutationFn: (): Promise<SimulationResult | DecumulationResult> => {
      if (kind === 'expense') {
        return api.post<SimulationResult>('/simulate/one-time-expense', {
          amountCents: Math.abs(parseMoneyInput(amount) ?? 0),
          source,
        })
      }
      if (kind === 'payoff') {
        return api.post<SimulationResult>('/simulate/debt-payoff', { debtId, source })
      }
      return api.post<DecumulationResult>('/simulate/decumulation', {
        monthlyWithdrawalCents: Math.abs(parseMoneyInput(withdrawal) ?? 0),
        expectedReturnBps: parsePercentInput(expectedReturn) ?? 0,
        horizonMonths: Math.round((Number(horizonYears) || 30) * 12),
      })
    },
    onSuccess: (data) => {
      setError(null)
      if (kind === 'decumulation') {
        setResult(null)
        setDecumulation(data as DecumulationResult)
      } else {
        setDecumulation(null)
        setResult(data as SimulationResult)
      }
    },
    onError: (e) => {
      setResult(null)
      setDecumulation(null)
      setError(e instanceof Error ? e.message : 'não foi possível simular')
    },
  })

  const canRun =
    kind === 'expense'
      ? (parseMoneyInput(amount) ?? 0) > 0
      : kind === 'payoff'
        ? debtId !== null
        : (parseMoneyInput(withdrawal) ?? 0) > 0

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[880px]">
        <DialogTitle>Simular uma decisão</DialogTitle>
      <div className="stack stack--loose">
        <Tabs
          value={kind}
          onValueChange={(next) => {
            setKind(next as SimKind)
            setResult(null)
            setDecumulation(null)
            setError(null)
          }}
        >
          <TabsList aria-label="Tipo de simulação">
            <TabsTrigger value="expense">Gasto único</TabsTrigger>
            <TabsTrigger value="payoff">Quitar dívida</TabsTrigger>
            <TabsTrigger value="decumulation">Decumulação</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
          {kind === 'expense' && (
            <div className="field" style={{ width: 180 }}>
              <label className="field__label">Valor</label>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0,00"
                className="text-right tabular-nums"
              />
            </div>
          )}
          {kind === 'payoff' && (
            <div className="field" style={{ minWidth: 240, flex: 1 }}>
              <label className="field__label">Dívida a quitar</label>
              <Select
                value={debtId}
                placeholder="Escolha uma dívida"
                options={(debts.data?.debts ?? []).map((d) => ({
                  value: d.id,
                  label: `${d.name} (${money(d.balanceCents)})`,
                }))}
                onChange={setDebtId}
              />
            </div>
          )}
          {kind === 'decumulation' && (
            <>
              <div className="field" style={{ width: 180 }}>
                <label className="field__label">Retirada mensal</label>
                <Input
                  value={withdrawal}
                  onChange={(e) => setWithdrawal(e.target.value)}
                  placeholder="0,00"
                  className="text-right tabular-nums"
                />
              </div>
              <div className="field" style={{ width: 140 }}>
                <label className="field__label">Retorno esperado (a.a.)</label>
                <Input
                  value={expectedReturn}
                  onChange={(e) => setExpectedReturn(e.target.value)}
                  placeholder="8"
                  className="text-right tabular-nums"
                />
              </div>
              <div className="field" style={{ width: 140 }}>
                <label className="field__label">Horizonte (anos)</label>
                <Input
                  value={horizonYears}
                  onChange={(e) => setHorizonYears(e.target.value)}
                  placeholder="30"
                  className="text-right tabular-nums"
                />
              </div>
            </>
          )}
          {kind !== 'decumulation' && (
            <div className="field" style={{ minWidth: 200 }}>
              <label className="field__label">De onde sai o dinheiro</label>
              <Select
                value={source}
                options={SOURCES.map((s) => ({ value: s.value, label: s.label }))}
                onChange={(v) => setSource((v ?? 'balance') as Source)}
              />
              <span className="field__hint">
                O impacto em reserva e runway depende de qual saldo diminui
              </span>
            </div>
          )}
        </div>

        {kind === 'decumulation' && (
          <p className="chart__note">
            O retorno esperado é um parâmetro que você escolhe, não um cálculo do sistema. O
            resultado é sempre a consequência de retirar esse valor todo mês, nunca uma taxa de
            retirada recomendada.
          </p>
        )}

        {error && (
          <EmptyState icon="info" title="Não dá para simular isso" body={error} />
        )}

        {decumulation && <DecumulationResultView result={decumulation} />}

        {result && (
          <div className="stack stack--loose">
            <hr className="divider" />

            {result.savedInterestCents !== undefined && (
              <div className="kv">
                <span className="kv__k">Valor a quitar</span>
                <span className="kv__v">{money(result.payoffCents ?? 0)}</span>
                <span className="kv__k">Juro futuro que deixaria de ser pago</span>
                <span className="kv__v">{money(result.savedInterestCents)}</span>
              </div>
            )}

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Indicador</th>
                    <th className="table__num">Agora</th>
                    <th className="table__num">Depois</th>
                    <th className="table__num">Diferença</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Health Score</td>
                    <td className="table__num">{fmtScore(result.healthScoreBps.before)}</td>
                    <td className="table__num">{fmtScore(result.healthScoreBps.after)}</td>
                    <td className="table__num">{fmtScoreDelta(result.healthScoreBps.delta)}</td>
                  </tr>
                  <tr>
                    <td>Runway</td>
                    <td className="table__num">{fmtMonths(result.runwayMonths.before)}</td>
                    <td className="table__num">{fmtMonths(result.runwayMonths.after)}</td>
                    <td className="table__num">{fmtMonthsDelta(result.runwayMonths.delta)}</td>
                  </tr>
                  <tr>
                    <td>Disponível para alocação</td>
                    <td className="table__num">{money(result.availableCents.before)}</td>
                    <td className="table__num">{money(result.availableCents.after)}</td>
                    <td className="table__num">{money(result.availableCents.delta)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <Assumptions data={result.assumptions} />
          </div>
        )}
      </div>
        <DialogFooter>
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            Nada aqui é gravado. É uma pergunta e uma resposta.
          </span>
          <Button
            variant="primary"
            icon="sparkle"
            disabled={!canRun || run.isPending}
            onClick={() => run.mutate()}
          >
            Simular
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Resumo + gráfico da simulação de decumulação. O gráfico em si é o
 * componente compartilhado `charts/DecumulationChart`, o mesmo que a tela
 * de Aposentadoria usa — uma fórmula, um desenho, dois lugares. */
function DecumulationResultView({ result }: { result: DecumulationResult }) {
  return (
    <div className="stack stack--loose">
      <hr className="divider" />
      <div className="kv">
        <span className="kv__k">Patrimônio inicial</span>
        <span className="kv__v">{money(result.startingValueCents)}</span>
        <span className="kv__k">Retirada mensal simulada</span>
        <span className="kv__v">{money(result.monthlyWithdrawalCents)}</span>
        <span className="kv__k">Retorno esperado (a.a.)</span>
        <span className="kv__v">{bps(result.expectedReturnBps, 2)}</span>
        <span className="kv__k">Esgotamento</span>
        <span className="kv__v">
          {result.depletionPeriod === null
            ? 'não se esgota no horizonte simulado'
            : `${fmtPeriod(result.depletionPeriod)} (mês ${result.depletionMonth})`}
        </span>
      </div>

      <DecumulationChart series={result.series} depletionPeriod={result.depletionPeriod} surface="paper" />

      <Assumptions data={result.assumptions} />
    </div>
  )
}

const fmtScore = (v: number | null) => (v === null ? 'sem dado' : bps(v, 0))
const fmtScoreDelta = (v: number | null) => (v === null ? '-' : `${v > 0 ? '+' : ''}${bps(v, 0)}`)
const fmtMonths = (v: number | null) =>
  v === null ? 'sem base' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} meses`
const fmtMonthsDelta = (v: number | null) =>
  v === null ? '-' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}`
