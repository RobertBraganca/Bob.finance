import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bps, money, parseMoneyInput } from '../../lib/format'
// Importa do barrel uma vez só. NÃO é reexportado por ele: o barrel
// importando este arquivo, que importa o barrel de volta, fecharia um ciclo.
import { Assumptions, type AssumptionBag } from './Assumptions'
import { Button, EmptyState, Modal, Segmented, Select, TextInput } from './index'

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

export function SimulatorModal({
  onClose,
  initialKind = 'expense',
  initialDebtId = null,
}: {
  onClose: () => void
  initialKind?: 'expense' | 'payoff'
  initialDebtId?: number | null
}) {
  const [kind, setKind] = useState<'expense' | 'payoff'>(initialKind)
  const [amount, setAmount] = useState('')
  const [source, setSource] = useState<Source>('balance')
  const [debtId, setDebtId] = useState<number | null>(initialDebtId)
  const [result, setResult] = useState<SimulationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const debts = useQuery({
    queryKey: ['debts-for-simulator'],
    queryFn: () => api.get<{ debts: DebtRow[] }>('/debts'),
    enabled: kind === 'payoff',
  })

  const run = useMutation({
    mutationFn: () =>
      kind === 'expense'
        ? api.post<SimulationResult>('/simulate/one-time-expense', {
            amountCents: Math.abs(parseMoneyInput(amount) ?? 0),
            source,
          })
        : api.post<SimulationResult>('/simulate/debt-payoff', { debtId, source }),
    onSuccess: (data) => {
      setError(null)
      setResult(data)
    },
    onError: (e) => {
      setResult(null)
      setError(e instanceof Error ? e.message : 'não foi possível simular')
    },
  })

  const canRun =
    kind === 'expense' ? (parseMoneyInput(amount) ?? 0) > 0 : debtId !== null

  return (
    <Modal
      title="Simular uma decisão"
      onClose={onClose}
      wide
      footer={
        <>
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
        </>
      }
    >
      <div className="stack stack--loose">
        <Segmented
          ariaLabel="Tipo de simulação"
          value={kind}
          onChange={(next) => {
            setKind(next)
            setResult(null)
            setError(null)
          }}
          options={[
            { value: 'expense', label: 'Gasto único' },
            { value: 'payoff', label: 'Quitar dívida' },
          ]}
        />

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
          {kind === 'expense' ? (
            <div className="field" style={{ width: 180 }}>
              <label className="field__label">Valor</label>
              <TextInput value={amount} onChange={setAmount} placeholder="0,00" numeral />
            </div>
          ) : (
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
        </div>

        {error && (
          <EmptyState icon="info" title="Não dá para simular isso" body={error} />
        )}

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
    </Modal>
  )
}

const fmtScore = (v: number | null) => (v === null ? 'sem dado' : bps(v, 0))
const fmtScoreDelta = (v: number | null) => (v === null ? '-' : `${v > 0 ? '+' : ''}${bps(v, 0)}`)
const fmtMonths = (v: number | null) =>
  v === null ? 'sem base' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} meses`
const fmtMonthsDelta = (v: number | null) =>
  v === null ? '-' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}`
