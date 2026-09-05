import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bpsToInput, centsToInput, parseMoneyInput, parsePercentInput } from '../../lib/format'
// Importa do barrel uma vez só. NÃO é reexportado por ele: o barrel
// importando este arquivo, que importa o barrel de volta, fecharia um ciclo
// (mesmo motivo do comentário em SimulatorModal.tsx).
import { Button, Modal, TextInput, useToast, type MeterState } from './index'

/**
 * Uma meta de investimento (`investmentGoals`, `purpose` opcional —
 * `retirement` | `buy_property` | `financial_independence` |
 * `children_education` | `travel`). Extraído de `src/pages/Investments.tsx`
 * (onde nasceu) para `src/components/ui/`, mesmo destino de
 * `SimulatorModal.tsx`, porque `GoalModal` passou a ter um segundo chamador
 * (a página Aposentadoria, que cria/edita a meta de propósito `retirement`
 * sem duplicar este formulário).
 */
export type Goal = {
  id: number
  name: string
  targetValueCents: number
  targetDate: string | null
  monthlyContributionCents: number
  expectedReturnBps: number
  purpose: string | null
}

export type Projection = {
  goal: Goal
  series: Array<{ month: number; period: string; baselineCents: number; projectedCents: number; contributedCents: number }>
  currentValueCents: number
  progressBps: number | null
  reachedMonth: number | null
  reachedPeriod: string | null
  onTrack: boolean | null
  state: MeterState
  requiredMonthlyCents: number | null
  projectedAtTargetCents: number | null
  contributionShareOfGapBps: number | null
}

export function GoalModal({
  goal,
  goalPurposes,
  defaultPurpose,
  onClose,
}: {
  goal: Goal | null
  goalPurposes: Array<{ value: string; label: string }>
  /**
   * Propósito pré-selecionado ao CRIAR uma meta nova (`goal === null`) —
   * a página Aposentadoria abre este modal já com `retirement` marcado,
   * sem exigir um clique extra. Ignorado ao editar uma meta existente
   * (`goal.purpose` sempre manda). Investimentos > Metas não passa esta
   * prop, então seu comportamento de "nenhum propósito pré-selecionado"
   * continua idêntico.
   */
  defaultPurpose?: string
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [name, setName] = useState(goal?.name ?? '')
  const [target, setTarget] = useState(centsToInput(goal?.targetValueCents ?? null))
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '')
  const [monthly, setMonthly] = useState(centsToInput(goal?.monthlyContributionCents ?? null))
  const [expected, setExpected] = useState(bpsToInput(goal?.expectedReturnBps ?? 800))
  const [purpose, setPurpose] = useState<string | null>(goal?.purpose ?? defaultPurpose ?? null)

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        targetValueCents: Math.abs(parseMoneyInput(target) ?? 0),
        targetDate: targetDate || null,
        monthlyContributionCents: Math.abs(parseMoneyInput(monthly) ?? 0),
        expectedReturnBps: parsePercentInput(expected) ?? 800,
        purpose,
      }
      return goal ? api.patch(`/investments/goals/${goal.id}`, body) : api.post('/investments/goals', body)
    },
    onSuccess: () => {
      toast(goal ? 'Meta atualizada' : 'Meta criada')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const remove = useMutation({
    mutationFn: () => api.del(`/investments/goals/${goal!.id}`),
    onSuccess: () => {
      toast('Meta removida')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  return (
    <Modal
      title={goal ? `Editar ${goal.name}` : 'Nova meta de investimento'}
      onClose={onClose}
      footer={
        <>
          {goal ? (
            <Button variant="danger" icon="trash" onClick={() => remove.mutate()}>
              Remover
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" icon="check" disabled={!name.trim()} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label">Nome da meta</label>
          <TextInput value={name} onChange={setName} placeholder="ex. Reserva de oportunidade" />
        </div>
        <div className="field">
          <label className="field__label">Propósito (opcional)</label>
          <div className="row row--wrap" style={{ gap: 6 }}>
            {goalPurposes.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`btn btn--sm ${purpose === option.value ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => setPurpose(purpose === option.value ? null : option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="field__hint">
            Só organiza e identifica a meta, nunca influencia o cálculo de aporte.
          </span>
        </div>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Valor-alvo (R$)</label>
            <TextInput value={target} onChange={setTarget} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Data-alvo</label>
            <TextInput value={targetDate} onChange={setTargetDate} type="date" />
          </div>
        </div>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Aporte mensal (R$)</label>
            <TextInput value={monthly} onChange={setMonthly} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Retorno esperado a.a. (%)</label>
            <TextInput value={expected} onChange={setExpected} placeholder="8" numeral />
          </div>
        </div>
        <p className="chart__note">
          A projeção usa retorno constante: serve para dimensionar o aporte, não para prever
          mercado.
        </p>
      </div>
    </Modal>
  )
}
