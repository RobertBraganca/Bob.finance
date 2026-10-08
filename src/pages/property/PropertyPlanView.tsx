import { useId, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { bpsToInput, centsToInput, money, parseMoneyInput, parsePercentInput, monthlyRateBpsFromAnnual } from '../../lib/format'
import { invalidateInvestmentData } from '../../lib/invalidate'
import { todayIso } from '../../lib/period'
import { useAccounts } from '../../lib/store'
import { installmentsCents, needAt, priceAt, type AmortizationSystem, type PlanInputs, type PlanProjection } from '@shared/propertyPlan'
import { Button, Card, EmptyState, Meter, Modal, PageSkeleton, Segmented, Select, TextInput, useToast } from '../../components/ui'
import { PropertyPlanFields } from './PropertyPlanFields'
import { PropertyResults } from './PropertyResults'
import { fieldsOf, formFromPlan, inputsOf, termMonthsOf, type PlanDefaults, type PlanFields, type PlanForm } from './planForm'

type PlanAsset = {
  assetId: number
  name: string
  assetClassLabel: string
  marketValueCents: number
  linked: boolean
  blockedReason: string | null
}

type PlanResponse = {
  goal: { id: number; name: string; monthlyContributionCents: number; expectedReturnBps: number }
  plan: PlanFields & { id: number; status: 'planning' | 'purchased'; debtId: number | null; assetId: number | null; purchasedOn: string | null }
  defaults: PlanDefaults
  assets: PlanAsset[]
  savedCents: number
  inputs: PlanInputs
  projection: PlanProjection
}

/**
 * A meta de imóvel na aba Metas (specs/property-plan): o mesmo resultado da
 * calculadora, agora com o dinheiro real dos ativos separados, o que falta
 * hoje e a passagem para Dívidas e Patrimônio quando a compra acontece.
 */
export function PropertyPlanView({ goalId }: { goalId: number }) {
  const [modal, setModal] = useState<'assets' | 'edit' | 'purchase' | null>(null)
  const query = useQuery({
    queryKey: ['property-plan', goalId],
    queryFn: () => api.get<PlanResponse>(`/investments/property-plans/${goalId}`),
  })

  if (query.isError) {
    return (
      <Card>
        <EmptyState icon="alert" title="Não foi possível carregar o plano" body={query.error instanceof Error ? query.error.message : 'Tente de novo.'} />
      </Card>
    )
  }
  if (!query.data) {
    return <PageSkeleton cards={[{ span: 12, variant: 'stats', height: 120 }, { span: 12, variant: 'block', height: 280 }]} />
  }

  const data = query.data
  const linked = data.assets.filter((a) => a.linked)

  return (
    <div className="stack stack--loose">
      <div className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
        <Button variant="quiet" size="sm" icon="pencil" onClick={() => setModal('edit')}>
          Editar premissas
        </Button>
        <Button size="sm" icon="wallet" onClick={() => setModal('assets')}>
          Escolher ativos
        </Button>
        <Button variant="primary" size="sm" icon="home" onClick={() => setModal('purchase')}>
          Concretizar compra
        </Button>
      </div>

      <PropertyResults projection={data.projection} inputs={data.inputs} />

      <div className="plan-side">
        <Card title="Dinheiro do imóvel" subtitle={linked.length ? `${linked.length} ${linked.length === 1 ? 'ativo separado' : 'ativos separados'}` : 'Nenhum ativo separado ainda'}>
          {linked.length === 0 ? (
            <EmptyState
              icon="wallet"
              title="Separe os ativos do imóvel"
              body="O progresso do plano conta só os ativos que você escolher, sem disputar com a reserva nem com outras metas."
              action={
                <Button size="sm" icon="plus" onClick={() => setModal('assets')}>
                  Escolher ativos
                </Button>
              }
            />
          ) : (
            <dl className="plan-breakdown">
              {linked.map((asset) => (
                <div key={asset.assetId} className="plan-breakdown__row">
                  <dt>
                    {asset.name}
                    <span className="plan-breakdown__hint">{asset.assetClassLabel}</span>
                  </dt>
                  <dd className="numeral">{money(asset.marketValueCents)}</dd>
                </div>
              ))}
              <div className="plan-breakdown__row plan-breakdown__row--total">
                <dt>Juntado hoje</dt>
                <dd className="numeral">{money(data.savedCents)}</dd>
              </div>
            </dl>
          )}
        </Card>
        <TodayCoverage inputs={data.inputs} />
      </div>

      {modal === 'assets' && <PlanAssetsModal goalId={goalId} assets={data.assets} onClose={() => setModal(null)} />}
      {modal === 'edit' && <EditPlanModal data={data} onClose={() => setModal(null)} />}
      {modal === 'purchase' && <PurchaseModal data={data} onClose={() => setModal(null)} />}
    </div>
  )
}

/**
 * O que falta hoje, na ordem em que o dinheiro é consumido: custos (não se
 * financiam), depois a entrada, depois a reserva.
 */
function TodayCoverage({ inputs }: { inputs: PlanInputs }) {
  const need = needAt(inputs, 0)
  let available = inputs.savedCents + need.otherResourcesCents
  const rows = [
    { label: 'Custos da compra', needCents: need.costsCents },
    { label: 'Entrada', needCents: need.downPaymentCents },
    { label: 'Reserva com a parcela', needCents: need.reserveGapCents },
  ].map((row) => {
    const covered = Math.min(Math.max(0, available), row.needCents)
    available -= covered
    return { ...row, coveredCents: covered }
  })
  return (
    <Card title="O que falta hoje" subtitle="Com o preço de hoje; o dinheiro cobre primeiro os custos, depois a entrada, depois a reserva">
      <div className="stack">
        {rows.map((row) => {
          const progressBps = row.needCents > 0 ? Math.round((row.coveredCents / row.needCents) * 10_000) : 10_000
          return (
            <div key={row.label} className="stack" style={{ gap: 'var(--sp-1)' }}>
              <div className="row row--between">
                <span>{row.label}</span>
                <span className="numeral">
                  {row.needCents === 0 ? 'nada a cobrir' : `${money(row.coveredCents)} de ${money(row.needCents)}`}
                </span>
              </div>
              <Meter usedBps={progressBps} state={progressBps >= 10_000 ? 'met' : 'no_target'} />
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function PlanAssetsModal({ goalId, assets, onClose }: { goalId: number; assets: PlanAsset[]; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState(() => new Set(assets.filter((a) => a.linked).map((a) => a.assetId)))
  const toggle = (id: number) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const total = assets.filter((a) => selected.has(a.assetId)).reduce((sum, a) => sum + a.marketValueCents, 0)
  const save = useMutation({
    mutationFn: () => api.put(`/investments/property-plans/${goalId}/assets`, { assetIds: [...selected] }),
    onSuccess: () => {
      toast('Ativos do imóvel atualizados')
      invalidateInvestmentData(queryClient)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })
  return (
    <Modal
      title="Ativos do imóvel"
      onClose={onClose}
      footer={
        <>
          <span className="numeral">{money(total)}</span>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate()}>
              Salvar
            </Button>
          </span>
        </>
      }
    >
      {assets.length === 0 ? (
        <EmptyState icon="wallet" title="Nenhum ativo na carteira" body="Cadastre um ativo em Carteira para separá-lo para o imóvel." />
      ) : (
        <ul className="asset-pick">
          {assets.map((asset) => (
            <li key={asset.assetId}>
              <label className={`asset-pick__row${asset.blockedReason ? ' asset-pick__row--blocked' : ''}`}>
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={selected.has(asset.assetId)}
                  disabled={asset.blockedReason !== null}
                  onChange={() => toggle(asset.assetId)}
                />
                <span className="asset-pick__name">
                  {asset.name}
                  <span className="asset-pick__meta">{asset.blockedReason ?? asset.assetClassLabel}</span>
                </span>
                <span className="numeral">{money(asset.marketValueCents)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

function EditPlanModal({ data, onClose }: { data: PlanResponse; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [name, setName] = useState(data.goal.name)
  const [form, setForm] = useState<PlanForm>(() => formFromPlan(data.plan, data.goal, data.defaults, data.savedCents))
  const patch = (next: Partial<PlanForm>) => setForm((current) => ({ ...current, ...next }))
  const appIncome = data.defaults.typicalIncomeCents > 0 ? data.defaults.typicalIncomeCents : null
  const save = useMutation({
    mutationFn: () => {
      const plan = fieldsOf(form)
      const inputs = inputsOf(form, appIncome)
      if (!plan || !inputs) throw new Error('preencha preço, taxa e prazo')
      return api.patch(`/investments/property-plans/${data.goal.id}`, {
        goal: { name: name.trim(), monthlyContributionCents: inputs.monthlyContributionCents, expectedReturnBps: inputs.expectedReturnBps },
        plan,
      })
    },
    onSuccess: () => {
      toast('Plano atualizado')
      invalidateInvestmentData(queryClient)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })
  return (
    <Modal
      title={`Editar ${data.goal.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <span />
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
              Salvar
            </Button>
          </span>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor="plan-edit-name">
            Nome da meta
          </label>
          <TextInput id="plan-edit-name" value={name} onChange={setName} />
        </div>
        <PropertyPlanFields
          form={form}
          onChange={patch}
          mode="plan"
          incomeHint={appIncome ? `Vazio usa a renda típica do app: ${money(appIncome)}.` : 'Sem renda no app; informe para ver o peso da parcela.'}
        />
      </div>
    </Modal>
  )
}

function PurchaseModal({ data, onClose }: { data: PlanResponse; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()
  const today = todayIso()
  const plan = data.plan
  const priceToday = priceAt(plan.priceCents, plan.appreciationBps, 0)
  const [price, setPrice] = useState(centsToInput(priceToday))
  const [purchasedOn, setPurchasedOn] = useState(today)
  const [financed, setFinanced] = useState(centsToInput(Math.round(priceToday * (1 - plan.downPaymentBps / 10_000))))
  const [rate, setRate] = useState(bpsToInput(plan.financingRateBps))
  const [termYears, setTermYears] = useState(String(Math.round(plan.termMonths / 12)))
  const [system, setSystem] = useState<AmortizationSystem>(plan.system)
  const [fees, setFees] = useState(centsToInput(plan.monthlyFeesCents || null))
  const [firstDueOn, setFirstDueOn] = useState('')
  const [accountId, setAccountId] = useState<number | null>(null)
  const [institution, setInstitution] = useState('')
  const [registerAsset, setRegisterAsset] = useState(true)
  const [assetName, setAssetName] = useState(`Imóvel: ${data.goal.name}`)
  const [done, setDone] = useState<{ debtId: number | null; assetId: number | null } | null>(null)

  const rateBps = parsePercentInput(rate)
  const termMonths = termMonthsOf(termYears)
  const financedCents = Math.abs(parseMoneyInput(financed) ?? 0)
  const contract = useMemo(() => {
    if (rateBps === null || !termMonths || financedCents <= 0) return null
    const all = installmentsCents({ principalCents: financedCents, aprBps: Math.abs(rateBps), installmentCount: termMonths, amortization: system, monthlyFeesCents: Math.abs(parseMoneyInput(fees) ?? 0) })
    return all.length ? { first: all[0]!, last: all.at(-1)! } : null
  }, [rateBps, termMonths, financedCents, system, fees])

  const save = useMutation({
    mutationFn: () => {
      const purchasePriceCents = Math.abs(parseMoneyInput(price) ?? 0)
      if (purchasePriceCents <= 0) throw new Error('informe o valor de compra')
      if (financedCents > purchasePriceCents) throw new Error('o valor financiado não pode passar do valor de compra')
      if (financedCents > 0 && (rateBps === null || !termMonths)) throw new Error('informe taxa e prazo do contrato')
      if (financedCents > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(firstDueOn)) throw new Error('informe a data da 1ª parcela')
      if (financedCents > 0 && accountId === null) throw new Error('escolha a conta de débito das parcelas')
      return api.post<{ debtId: number | null; assetId: number | null }>(`/investments/property-plans/${data.goal.id}/purchase`, {
        purchasePriceCents,
        purchasedOn,
        financedCents,
        rateBps: Math.abs(rateBps ?? 0),
        termMonths: termMonths ?? 12,
        system,
        monthlyFeesCents: Math.abs(parseMoneyInput(fees) ?? 0),
        firstDueOn: firstDueOn || purchasedOn,
        accountId: accountId ?? accounts.data?.accounts[0]?.id,
        institution: institution.trim() || null,
        registerAsset,
        assetName: assetName.trim() || null,
      })
    },
    onSuccess: (result) => {
      toast('Compra registrada')
      setDone(result)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao registrar a compra', 'error'),
  })

  const close = () => {
    if (done) invalidateInvestmentData(queryClient)
    if (done) queryClient.invalidateQueries()
    onClose()
  }

  if (done) {
    return (
      <Modal
        title="Compra registrada"
        onClose={close}
        footer={
          <>
            <span />
            <Button variant="primary" onClick={close}>
              Fechar
            </Button>
          </>
        }
      >
        <div className="stack">
          <p>
            {done.debtId ? 'O financiamento está em Dívidas, com as parcelas no fluxo de caixa. ' : ''}
            {done.assetId ? 'O imóvel entrou no Imobilizado de Patrimônio. ' : ''}A meta saiu das metas ativas e os ativos ficaram livres.
          </p>
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            {done.debtId && (
              <Link className="btn btn--ghost btn--sm" to="/dividas" onClick={close}>
                Ver em Dívidas
              </Link>
            )}
            {done.assetId && (
              <Link className="btn btn--ghost btn--sm" to="/patrimonio" onClick={close}>
                Ver em Patrimônio
              </Link>
            )}
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title="Concretizar compra"
      onClose={onClose}
      wide
      footer={
        <>
          <span />
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate()}>
              Registrar compra
            </Button>
          </span>
        </>
      }
    >
      <div className="stack">
        <p className="chart__note">
          Use os números do contrato. O resgate dos ativos para pagar entrada e custos continua sendo registrado por você, como
          qualquer venda.
        </p>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <Labeled label="Valor de compra do imóvel (R$)" grow>
            {(id) => <TextInput id={id} value={price} onChange={setPrice} numeral />}
          </Labeled>
          <Labeled label="Data da compra">{(id) => <TextInput id={id} value={purchasedOn} onChange={setPurchasedOn} type="date" />}</Labeled>
        </div>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <Labeled label="Valor financiado (R$)" grow>
            {(id) => <TextInput id={id} value={financed} onChange={setFinanced} numeral />}
          </Labeled>
          <Labeled
            label="Taxa (% ao ano)"
            hint={rateBps === null ? undefined : `${bpsToInput(monthlyRateBpsFromAnnual(Math.abs(rateBps)))}% ao mês`}
          >
            {(id) => <TextInput id={id} value={rate} onChange={setRate} numeral />}
          </Labeled>
          <Labeled label="Prazo (anos)">{(id) => <TextInput id={id} value={termYears} onChange={setTermYears} numeral />}</Labeled>
        </div>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
          <div className="field">
            <span className="field__label">Sistema</span>
            <Segmented
              ariaLabel="Sistema de amortização do contrato"
              value={system}
              onChange={setSystem}
              options={[
                { value: 'sac', label: 'SAC' },
                { value: 'price', label: 'Price' },
              ]}
            />
          </div>
          <Labeled label="Seguros e taxas por mês (R$)" grow>
            {(id) => <TextInput id={id} value={fees} onChange={setFees} numeral placeholder="0,00" />}
          </Labeled>
        </div>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <Labeled label="1ª parcela vence em">{(id) => <TextInput id={id} value={firstDueOn} onChange={setFirstDueOn} type="date" min={purchasedOn} />}</Labeled>
          <Labeled label="Conta de débito" grow>
            {(id) => (
              <Select
                id={id}
                value={accountId}
                placeholder="Escolha a conta"
                options={(accounts.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
                onChange={setAccountId}
              />
            )}
          </Labeled>
          <Labeled label="Banco" grow>
            {(id) => <TextInput id={id} value={institution} onChange={setInstitution} placeholder="opcional" />}
          </Labeled>
        </div>
        {contract && (
          <p className="plan-evidence">
            {system === 'sac'
              ? `Parcelas de ${money(contract.first)} (1ª) a ${money(contract.last)} (última), caindo todo mês.`
              : `Parcelas fixas de ${money(contract.first)}.`}
          </p>
        )}
        <label className="check-row">
          <input type="checkbox" className="checkbox" checked={registerAsset} onChange={(event) => setRegisterAsset(event.target.checked)} />
          <span>Registrar o imóvel no Patrimônio (Imobilizado)</span>
        </label>
        {registerAsset && (
          <Labeled label="Nome do bem" hint="Entra pelo valor de compra; reavaliar depois é manual, como os outros bens.">
            {(id) => <TextInput id={id} value={assetName} onChange={setAssetName} />}
          </Labeled>
        )}
      </div>
    </Modal>
  )
}

function Labeled({ label, hint, grow, children }: { label: string; hint?: string; grow?: boolean; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="field" style={grow ? { flex: 1, minWidth: 160 } : { minWidth: 130 }}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  )
}
