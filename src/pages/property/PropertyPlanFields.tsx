import { useId, type ReactNode } from 'react'
import { money, monthlyRateBpsFromAnnual, parseMoneyInput, parsePercentInput, bpsToInput } from '../../lib/format'
import { Button, Segmented, TextInput } from '../../components/ui'
import { MoneyField } from '../calculators/fields'
import type { CostDraft, PlanForm } from './planForm'

/**
 * Os campos do plano de imóvel, em grupos curtos. `mode="calculator"` deixa
 * tudo editável; `mode="plan"` mostra o dinheiro juntado e a reserva como
 * leitura (vêm dos ativos ligados e de Investimentos › reserva).
 */
export function PropertyPlanFields({
  form,
  onChange,
  mode,
  incomeHint,
}: {
  form: PlanForm
  onChange: (patch: Partial<PlanForm>) => void
  mode: 'calculator' | 'plan'
  /** Ex.: "Renda típica do app: R$ 5.800,05 (6 meses)". */
  incomeHint?: string
}) {
  const set = <K extends keyof PlanForm>(key: K) => (value: PlanForm[K]) => onChange({ [key]: value } as Partial<PlanForm>)
  const rateBps = parsePercentInput(form.rate)

  return (
    <div className="stack">
      <Group title="Imóvel">
        <MoneyField label="Preço do imóvel (R$)" value={form.price} onChange={set('price')} />
        <PercentField
          label="Valorização ao ano (%)"
          value={form.appreciation}
          onChange={set('appreciation')}
          hint="Quanto o preço sobe enquanto você junta. Perto do IPCA é uma referência comum."
        />
      </Group>

      <Group title="Entrada e custos">
        <PercentField
          label="Entrada (%)"
          value={form.downPayment}
          onChange={set('downPayment')}
          hint="Bancos costumam financiar até 80% do valor, então a entrada mínima comum é 20%."
        />
        <CostList costs={form.costs} onChange={set('costs')} />
      </Group>

      <Group title="Financiamento">
        <PercentField
          label="Taxa do financiamento (% ao ano)"
          value={form.rate}
          onChange={set('rate')}
          hint={rateBps === null ? 'Taxa efetiva ao ano, como o banco informa no CET.' : `Equivale a ${bpsToInput(monthlyRateBpsFromAnnual(Math.abs(rateBps)))}% ao mês.`}
        />
        <div className="field">
          <span className="field__label">Prazo e sistema</span>
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <div style={{ flex: 1, minWidth: 110 }}>
              <TextInput value={form.termYears} onChange={set('termYears')} placeholder="30" numeral ariaLabel="Prazo em anos" />
            </div>
            <Segmented
              ariaLabel="Sistema de amortização"
              value={form.system}
              onChange={set('system')}
              options={[
                { value: 'sac', label: 'SAC' },
                { value: 'price', label: 'Price' },
              ]}
            />
          </div>
          <span className="field__hint">Prazo em anos. SAC: a parcela cai todo mês. Price: parcela fixa.</span>
        </div>
        <MoneyField label="Seguros e taxas por mês (R$)" value={form.fees} onChange={set('fees')} hint="MIP, DFI e taxa de administração. Somam na parcela." />
        <MoneyField label="FGTS e outros recursos (R$)" value={form.otherResources} onChange={set('otherResources')} hint="Dinheiro fora da carteira que entra na compra." />
      </Group>

      <Group title="Seu dinheiro">
        {mode === 'calculator' ? (
          <MoneyField label="Quanto já tem (R$)" value={form.saved} onChange={set('saved')} />
        ) : (
          <ReadOnly label="Juntado hoje" value={money(Math.abs(parseMoneyInput(form.saved) ?? 0))} hint="Soma dos ativos separados para o imóvel." />
        )}
        <MoneyField label="Aporte mensal (R$)" value={form.monthly} onChange={set('monthly')} />
        <PercentField label="Rendimento ao ano (%)" value={form.expectedReturn} onChange={set('expectedReturn')} />
      </Group>

      <Group title="Segurança">
        {mode === 'calculator' ? (
          <>
            <MoneyField label="Custo de vida mensal (R$)" value={form.livingCost} onChange={set('livingCost')} />
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <PercentField label="Reserva (meses)" value={form.multiple} onChange={set('multiple')} />
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <MoneyField label="Reserva atual (R$)" value={form.reserveCurrent} onChange={set('reserveCurrent')} />
              </div>
            </div>
          </>
        ) : (
          <ReadOnly
            label="Reserva de emergência"
            value={`${money(Math.abs(parseMoneyInput(form.reserveCurrent) ?? 0))} de ${form.multiple} meses de custo de vida (${money(Math.abs(parseMoneyInput(form.livingCost) ?? 0))})`}
            hint="Configurada em Investimentos › reserva. O plano soma a parcela ao custo de vida."
          />
        )}
        <MoneyField
          label="Gasto que some depois da compra (R$)"
          value={form.relief}
          onChange={set('relief')}
          hint="Ex.: o aluguel. Sai do custo de vida no cálculo da reserva."
        />
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div style={{ flex: 2, minWidth: 160 }}>
            <MoneyField label="Renda mensal (R$)" value={form.income} onChange={set('income')} hint={incomeHint} />
          </div>
          <div style={{ flex: 1, minWidth: 120 }}>
            <PercentField label="Limite da renda (%)" value={form.incomeLimit} onChange={set('incomeLimit')} />
          </div>
        </div>
      </Group>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="plan-group">
      <legend className="plan-group__title">{title}</legend>
      <div className="stack">{children}</div>
    </fieldset>
  )
}

function PercentField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  const id = useId()
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <TextInput id={id} value={value} onChange={onChange} placeholder="0" numeral />
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  )
}

function ReadOnly({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span className="numeral plan-readonly">{value}</span>
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  )
}

/** Custos da compra: rótulo, % do preço ou valor fixo, e remover. */
function CostList({ costs, onChange }: { costs: CostDraft[]; onChange: (next: CostDraft[]) => void }) {
  const update = (index: number, patch: Partial<CostDraft>) => onChange(costs.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  return (
    <div className="field">
      <span className="field__label">Custos da compra</span>
      <ul className="cost-list">
        {costs.map((cost, index) => (
          <li key={index} className="cost-list__row">
            <div className="cost-list__label">
              <TextInput value={cost.label} onChange={(label) => update(index, { label })} placeholder="ex. Mudança" ariaLabel={`Nome do custo ${index + 1}`} />
            </div>
            <Segmented
              ariaLabel={`Unidade de ${cost.label || 'custo'}`}
              value={cost.kind}
              onChange={(kind) => update(index, { kind })}
              options={[
                { value: 'pct', label: '%' },
                { value: 'fixed', label: 'R$' },
              ]}
            />
            <div className="cost-list__value">
              <TextInput
                value={cost.value}
                onChange={(value) => update(index, { value })}
                placeholder={cost.kind === 'pct' ? '0' : '0,00'}
                numeral
                ariaLabel={`Valor de ${cost.label || 'custo'}`}
              />
            </div>
            <Button size="sm" variant="quiet" icon="x" title={`Remover ${cost.label || 'custo'}`} onClick={() => onChange(costs.filter((_, i) => i !== index))} />
          </li>
        ))}
      </ul>
      <div>
        <Button size="sm" icon="plus" onClick={() => onChange([...costs, { label: '', kind: 'fixed', value: '' }])}>
          Adicionar custo
        </Button>
      </div>
      <span className="field__hint">Percentuais sobre o preço na data da compra; valores fixos não corrigem.</span>
    </div>
  )
}
