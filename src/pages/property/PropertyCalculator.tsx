import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { centsToInput, money } from '../../lib/format'
import { invalidateInvestmentData } from '../../lib/invalidate'
import { projectPlan } from '@shared/propertyPlan'
import { Button, Card, EmptyState, Modal, TextInput, useToast } from '../../components/ui'
import { PropertyPlanFields } from './PropertyPlanFields'
import { PropertyResults } from './PropertyResults'
import { emptyForm, fieldsOf, inputsOf, type PlanDefaults, type PlanForm } from './planForm'

/**
 * Investimentos › Calculadoras › Imóvel: simulação pura, nada gravado até
 * "Criar plano de imóvel". "Usar meus dados" traz reserva, custo de vida e
 * renda típica do app (specs/property-plan).
 */
export function PropertyCalculator({ portfolioValueCents, onPlanCreated }: { portfolioValueCents: number; onPlanCreated: (goalId: number) => void }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [form, setForm] = useState<PlanForm>(emptyForm)
  const [defaults, setDefaults] = useState<PlanDefaults | null>(null)
  const [creating, setCreating] = useState(false)
  const patch = (next: Partial<PlanForm>) => setForm((current) => ({ ...current, ...next }))

  const loadMine = useMutation({
    mutationFn: () => queryClient.fetchQuery({ queryKey: ['property-plan-defaults'], queryFn: () => api.get<PlanDefaults>('/investments/property-plans/defaults') }),
    onSuccess: (d) => {
      setDefaults(d)
      patch({
        livingCost: centsToInput(d.reserve.livingCostCents),
        multiple: String(d.reserve.multiple),
        reserveCurrent: centsToInput(d.reserve.currentCents),
        income: d.typicalIncomeCents > 0 ? centsToInput(d.typicalIncomeCents) : form.income,
      })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao buscar seus dados', 'error'),
  })

  const inputs = useMemo(() => inputsOf(form), [form])
  const projection = useMemo(() => (inputs ? projectPlan(inputs) : null), [inputs])

  return (
    <div className="calc-layout">
      <Card title="Imóvel" subtitle="Quando o dinheiro cobre entrada, custos e a reserva com a parcela nova">
        <div className="stack">
          <PropertyPlanFields
            form={form}
            onChange={patch}
            mode="calculator"
            incomeHint={defaults && defaults.typicalIncomeCents > 0 ? `Renda típica no app: ${money(defaults.typicalIncomeCents)} (mediana de ${defaults.incomeSampleMonths} meses).` : undefined}
          />
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <Button size="sm" icon="user" loading={loadMine.isPending} onClick={() => loadMine.mutate()}>
              Usar meus dados
            </Button>
            <Button
              size="sm"
              icon="wallet"
              disabled={portfolioValueCents <= 0}
              title={`Preenche "Quanto já tem" com ${money(portfolioValueCents)}`}
              onClick={() => patch({ saved: centsToInput(portfolioValueCents) })}
            >
              Usar minha carteira
            </Button>
            <Button variant="quiet" size="sm" icon="x" onClick={() => setForm(emptyForm())}>
              Limpar
            </Button>
          </div>
        </div>
      </Card>

      {!projection || !inputs ? (
        <Card>
          <EmptyState icon="home" title="Preencha preço, taxa e prazo" body="O resultado aparece aqui enquanto você digita." />
        </Card>
      ) : (
        <PropertyResults
          projection={projection}
          inputs={inputs}
          actions={
            <Button variant="primary" icon="target" onClick={() => setCreating(true)}>
              Criar plano de imóvel
            </Button>
          }
        />
      )}

      {creating && (
        <CreatePlanModal
          form={form}
          appIncomeCents={defaults?.typicalIncomeCents ?? null}
          onClose={() => setCreating(false)}
          onCreated={(goalId) => {
            setCreating(false)
            invalidateInvestmentData(queryClient)
            onPlanCreated(goalId)
          }}
        />
      )}
    </div>
  )
}

/** Salva a simulação como meta `buy_property` com plano; os ativos do imóvel se escolhem depois, na própria meta. */
function CreatePlanModal({
  form,
  appIncomeCents,
  onClose,
  onCreated,
}: {
  form: PlanForm
  /** renda típica que "Usar meus dados" trouxe: se o campo ficou com ela, o plano segue a renda do app em vez de fixá-la */
  appIncomeCents: number | null
  onClose: () => void
  onCreated: (goalId: number) => void
}) {
  const toast = useToast()
  const [name, setName] = useState('Comprar imóvel')
  const save = useMutation({
    mutationFn: () => {
      const plan = fieldsOf(form)
      const inputs = inputsOf(form)
      if (!plan || !inputs) throw new Error('preencha preço, taxa e prazo')
      const followsApp = appIncomeCents !== null && plan.incomeOverrideCents === appIncomeCents
      return api.post<{ goalId: number }>('/investments/property-plans', {
        goal: { name: name.trim(), monthlyContributionCents: inputs.monthlyContributionCents, expectedReturnBps: inputs.expectedReturnBps },
        plan: { ...plan, incomeOverrideCents: followsApp ? null : plan.incomeOverrideCents },
      })
    },
    onSuccess: ({ goalId }) => {
      toast('Plano de imóvel criado')
      onCreated(goalId)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao criar o plano', 'error'),
  })
  return (
    <Modal
      title="Criar plano de imóvel"
      onClose={onClose}
      footer={
        <>
          <span />
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
              Criar plano
            </Button>
          </span>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor="plan-name">
            Nome da meta
          </label>
          <TextInput id="plan-name" value={name} onChange={setName} placeholder="ex. Apartamento em Vitória" />
        </div>
        <p className="chart__note">
          O plano guarda as premissas desta simulação e passa a medir o progresso pelos ativos que você separar para o imóvel, na
          aba Metas. A reserva e a renda continuam vindo do app e se atualizam sozinhas.
        </p>
      </div>
    </Modal>
  )
}
