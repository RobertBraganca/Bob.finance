import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { currentPeriod, shiftPeriod } from '../lib/period'
import { telemetry } from '../lib/telemetry'
import { useMeta } from '../lib/store'
import {
  bps,
  bpsToInput,
  centsToInput,
  money,
  moneyCompact,
  parseMoneyInput,
  parsePercentInput,
  period as fmtPeriod,
  periodLong,
} from '../lib/format'
import {
  Bento,
  Button,
  Card,
  EmptyState,
  HeroFigure,
  Icon,
  Meter,
  Select,
  SkeletonLines,
  Slab,
  StatTile,
  StatusBadge,
  useToast,
  type MeterState,
  PeriodNav,
} from '../components/ui'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { PageHeader } from '../components/shell/Shell'

type CapProgress = {
  categoryId: number
  name: string
  color: string
  capCents: number
  spentCents: number
  remainingCents: number
  usedBps: number
  paceCents: number
  state: MeterState
}

type PeriodProgress = {
  period: string
  isCurrent: boolean
  daysElapsed: number
  daysTotal: number
  goal: {
    incomeTargetCents: number | null
    spendCapCents: number | null
    savingsRateTargetBps: number | null
    note: string | null
  }
  actual: {
    incomeCents: number
    expenseCents: number
    netCents: number
    savingsRateBps: number
    investedCents: number
  }
  progress: {
    income: { targetCents: number | null; actualCents: number; achievedBps: number | null; state: MeterState }
    spend: { capCents: number | null; spentCents: number; usedBps: number | null; paceCents: number | null; state: MeterState }
    savings: { targetBps: number | null; actualBps: number; state: MeterState }
  }
  caps: CapProgress[]
}

type GapInProjects = {
  gapCents: number | null
  averageQuoteCents: number | null
  projectsNeeded: number | null
  sampleSize: number
}

type History = {
  outcomes: Array<{
    period: string
    incomeCents: number
    expenseCents: number
    savingsRateBps: number
    targets: number
    hits: number
    allHit: boolean
    hasTargets: boolean
  }>
  streak: number
  hitRateBps: number | null
}

export function GoalsPage() {
  const meta = useMeta()
  const today = meta.data?.today ?? '2026-08-19'
  const [period, setPeriod] = useState(() => today.slice(0, 7))
  const [editing, setEditing] = useState(false)
  const [capModal, setCapModal] = useState(false)

  const progress = useQuery({
    queryKey: ['goals', period],
    queryFn: () => api.get<PeriodProgress>(`/goals/${period}`),
    enabled: meta.isSuccess,
    placeholderData: (previous) => previous,
  })

  const history = useQuery({
    queryKey: ['goals-history'],
    queryFn: () => api.get<History>('/goals-history', { months: 12 }),
  })

  const gapInProjects = useQuery({
    queryKey: ['goals-gap-in-projects', period],
    queryFn: () => api.get<GapInProjects>(`/goals/${period}/gap-in-projects`),
    enabled: meta.isSuccess,
    placeholderData: (previous) => previous,
  })

  const data = progress.data
  const hasAnyTarget =
    data?.goal.incomeTargetCents !== null ||
    data?.goal.spendCapCents !== null ||
    data?.goal.savingsRateTargetBps !== null ||
    (data?.caps.length ?? 0) > 0

  return (
    <>
      <PageHeader
        title="Metas do mês"
        subtitle={periodLong(period)}
        actions={
          <div className="row">
            {/* Sem teto no mês corrente: definir a meta do mês que vem É o
                caso de uso da tela. O limite é o horizonte de materialização
                de pendências (decisions/0028), porque além dele não há o que
                comparar a meta com. */}
            <PeriodNav period={period} onChange={setPeriod} max={shiftPeriod(currentPeriod(), 12)} />
            <Button variant="primary" icon="target" onClick={() => setEditing(true)}>
              Definir metas
            </Button>
          </div>
        }
      />

      <div className="page">
        {!data ? (
          <Card>
            <SkeletonLines lines={3} />
          </Card>
        ) : !hasAnyTarget ? (
          <Bento>
            <Slab span={12} accent>
              <div className="stack" style={{ maxWidth: '60ch' }}>
                <span className="stat__label">Nenhuma meta para {periodLong(period)}</span>
                <h2 className="display" style={{ fontSize: 'var(--text-xl)' }}>
                  Defina o alvo antes de medir o desempenho
                </h2>
                <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-base)' }}>
                  Uma meta de receita, um teto de gastos e uma taxa de poupança-alvo já são
                  suficientes para o mês virar um placar. Tetos por categoria podem ser sugeridos a
                  partir da sua média real dos últimos três meses.
                </p>
                <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
                  <Button variant="primary" icon="target" onClick={() => setEditing(true)}>
                    Definir metas do mês
                  </Button>
                  <Button variant="slab" icon="plus" onClick={() => setCapModal(true)}>
                    Tetos por categoria
                  </Button>
                </div>
              </div>
            </Slab>
            <Card span={12}>
              <StatTile
                label="Realizado neste mês (sem meta definida)"
                value={`${money(data.actual.incomeCents)} entrou · ${money(data.actual.expenseCents)} saiu`}
                foot={`taxa de poupança ${bps(data.actual.savingsRateBps)}`}
              />
            </Card>
          </Bento>
        ) : (
          <Bento>
            <Slab span={4} accent>
              <HeroFigure
                label="Sobrou no mês"
                value={moneyCompact(data.actual.netCents)}
                delta={null}
              >
                <div className="row row--between" style={{ marginTop: 'var(--sp-3)' }}>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-2)' }}>
                    {data.isCurrent ? `dia ${data.daysElapsed} de ${data.daysTotal}` : 'mês fechado'}
                  </span>
                  <StatusBadge state={data.progress.savings.state} />
                </div>
              </HeroFigure>
            </Slab>

            <Card span={4} title="Receita">
              <GoalRow
                label="Meta de receita"
                actual={data.progress.income.actualCents}
                target={data.progress.income.targetCents}
                usedBps={data.progress.income.achievedBps ?? 0}
                state={data.progress.income.state}
              />
              {/*
                Só aparece quando há cotação salva suficiente para uma média:
                sem isso o número de projetos seria inventado, e a tela mostra
                apenas o gap em reais (ver `specs/monthly-goals`).
              */}
              {gapInProjects.data?.projectsNeeded !== null &&
                gapInProjects.data?.projectsNeeded !== undefined && (
                  <p className="chart__note">
                    Faltam {money(gapInProjects.data.gapCents ?? 0)}, aproximadamente{' '}
                    <strong>
                      {gapInProjects.data.projectsNeeded}{' '}
                      {gapInProjects.data.projectsNeeded === 1 ? 'projeto' : 'projetos'}
                    </strong>{' '}
                    de {money(gapInProjects.data.averageQuoteCents ?? 0)} (média das últimas{' '}
                    {gapInProjects.data.sampleSize}{' '}
                    {gapInProjects.data.sampleSize === 1 ? 'cotação' : 'cotações'}).
                  </p>
                )}
            </Card>

            <Card span={4} title="Teto de gastos">
              <GoalRow
                label="Limite total do mês"
                actual={data.progress.spend.spentCents}
                target={data.progress.spend.capCents}
                usedBps={data.progress.spend.usedBps ?? 0}
                paceBps={
                  data.progress.spend.capCents && data.progress.spend.paceCents !== null
                    ? Math.round((data.progress.spend.paceCents / data.progress.spend.capCents) * 10_000)
                    : null
                }
                state={data.progress.spend.state}
                invert
              />
            </Card>

            <Card
              span={7}
              title="Tetos por categoria"
              subtitle="A marca escura em cada barra é o ritmo esperado para hoje"
              actions={
                <Button size="sm" icon="plus" onClick={() => setCapModal(true)}>
                  Gerenciar
                </Button>
              }
            >
              {progress.isError ? (
                <EmptyState
                  icon="alert"
                  title="Falha ao carregar tetos"
                  body="Não foi possível carregar os tetos por categoria agora. Tente novamente em instantes."
                />
              ) : data.caps.length === 0 ? (
                <EmptyState
                  icon="target"
                  title="Nenhum teto por categoria"
                  body="Defina limites nas categorias que mais pesam para acompanhar cada uma."
                  action={
                    <Button variant="primary" size="sm" onClick={() => setCapModal(true)}>
                      Sugerir a partir do histórico
                    </Button>
                  }
                />
              ) : (
                <div className="stack stack--loose">
                  {data.caps.map((cap) => (
                    <div key={cap.categoryId} className="stack stack--tight">
                      <div className="row row--between">
                        <span className="row" style={{ gap: 'var(--sp-2)', minWidth: 0 }}>
                          <span className="swatch" style={{ background: cap.color }} />
                          <strong className="truncate" style={{ fontSize: 'var(--text-sm)' }}>
                            {cap.name}
                          </strong>
                          <StatusBadge state={cap.state} />
                        </span>
                        <span className="tabular" style={{ fontSize: 'var(--text-sm)' }}>
                          {money(cap.spentCents)}{' '}
                          <span className="muted">de {money(cap.capCents)}</span>
                        </span>
                      </div>
                      <Meter
                        usedBps={cap.usedBps}
                        paceBps={
                          cap.capCents > 0 ? Math.round((cap.paceCents / cap.capCents) * 10_000) : null
                        }
                        state={cap.state}
                      />
                      <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                        {cap.remainingCents >= 0
                          ? `${money(cap.remainingCents)} disponível`
                          : `${money(-cap.remainingCents)} acima do teto`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card span={5} title="Histórico de metas" subtitle="Meses que bateram todos os alvos definidos">
              <div className="bento" style={{ gap: 'var(--sp-3)' }}>
                <div className="col-6">
                  <StatTile
                    label="Sequência atual"
                    value={`${history.data?.streak ?? 0} ${history.data?.streak === 1 ? 'mês' : 'meses'}`}
                  />
                </div>
                <div className="col-6">
                  <StatTile
                    label="Taxa de acerto"
                    value={history.data?.hitRateBps === null || history.data?.hitRateBps === undefined ? '-' : bps(history.data.hitRateBps, 0)}
                  />
                </div>
              </div>
              <hr className="divider" />
              <div className="stack stack--tight">
                {(history.data?.outcomes ?? []).map((outcome) => (
                  <button
                    key={outcome.period}
                    type="button"
                    className="row row--between"
                    style={{
                      padding: '5px 6px',
                      borderRadius: 'var(--r-xs)',
                      background: outcome.period === period ? 'var(--brand-wash)' : 'transparent',
                      textAlign: 'left',
                      width: '100%',
                    }}
                    onClick={() => setPeriod(outcome.period)}
                  >
                    <span style={{ fontSize: 'var(--text-sm)', minWidth: 62 }}>{fmtPeriod(outcome.period)}</span>
                    <span className="grow muted tabular" style={{ fontSize: 'var(--text-xs)' }}>
                      {money(outcome.expenseCents)}
                    </span>
                    {outcome.hasTargets ? (
                      <span className={`badge ${outcome.allHit ? 'badge--good' : 'badge--critical'}`}>
                        <Icon name={outcome.allHit ? 'check' : 'x'} size={10} strokeWidth={2.6} />
                        {outcome.hits}/{outcome.targets}
                      </span>
                    ) : (
                      <span className="badge">sem meta</span>
                    )}
                  </button>
                ))}
              </div>
            </Card>
          </Bento>
        )}
      </div>

      {editing && data && (
        <GoalEditor period={period} current={data.goal} onClose={() => setEditing(false)} />
      )}
      {capModal && <CapEditor period={period} caps={data?.caps ?? []} onClose={() => setCapModal(false)} />}
    </>
  )
}

function GoalRow({
  label,
  actual,
  target,
  usedBps,
  paceBps,
  state,
  invert,
}: {
  label: string
  actual: number
  target: number | null
  usedBps: number
  paceBps?: number | null
  state: MeterState
  invert?: boolean
}) {
  return (
    <div className="stack stack--tight">
      <div className="row row--between">
        <span className="stat__label">{label}</span>
        <StatusBadge state={state} />
      </div>
      <span className="stat__value">{money(actual)}</span>
      <Meter usedBps={usedBps} paceBps={paceBps} state={state} />
      <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
        {target === null
          ? 'sem meta definida'
          : invert
            ? `${bps(usedBps, 0)} do teto de ${money(target)}`
            : `${bps(usedBps, 0)} da meta de ${money(target)}`}
      </span>
    </div>
  )
}

function GoalEditor({
  period,
  current,
  onClose,
}: {
  period: string
  current: PeriodProgress['goal']
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [income, setIncome] = useState(centsToInput(current.incomeTargetCents))
  const [cap, setCap] = useState(centsToInput(current.spendCapCents))
  const [savings, setSavings] = useState(bpsToInput(current.savingsRateTargetBps))

  const save = useMutation({
    mutationFn: () =>
      api.put(`/goals/${period}`, {
        incomeTargetCents: income.trim() === '' ? null : parseMoneyInput(income),
        spendCapCents: cap.trim() === '' ? null : parseMoneyInput(cap),
        savingsRateTargetBps: savings.trim() === '' ? null : parsePercentInput(savings),
      }),
    onSuccess: async () => {
      telemetry.action('goals', 'goal_saved')
      toast('Metas salvas')
      // Awaited: reabrir antes do refetch reidrataria do cache pré-edição.
      await queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const copy = useMutation({
    mutationFn: () => api.post(`/goals/${period}/copy-from/${shiftPeriod(period, -1)}`),
    onSuccess: async () => {
      toast('Metas copiadas do mês anterior')
      await queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao copiar', 'error'),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[560px]">
        <DialogTitle>{`Metas de ${periodLong(period)}`}</DialogTitle>
        <div className="stack">
          <div className="field">
            <label className="field__label">Meta de receita (R$)</label>
            <Input
              value={income}
              onChange={(e) => setIncome(e.target.value)}
              placeholder="ex. 15.000,00"
              className="text-right tabular-nums"
            />
          </div>
          <div className="field">
            <label className="field__label">Teto de gastos (R$)</label>
            <Input
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="ex. 9.500,00"
              className="text-right tabular-nums"
            />
          </div>
          <div className="field">
            <label className="field__label">Taxa de poupança-alvo (%)</label>
            <Input
              value={savings}
              onChange={(e) => setSavings(e.target.value)}
              placeholder="ex. 20"
              className="text-right tabular-nums"
            />
            <span className="field__hint">
              Percentual da receita que não é consumido. Aportes em investimentos contam como poupado.
            </span>
          </div>
          <p className="chart__note">
            Metas são guardadas por mês, então mudar o alvo de agosto não reescreve o histórico de
            julho, e é isso que faz a sequência de acertos significar algo.
          </p>
        </div>
        <DialogFooter>
          <Button icon="refresh" onClick={() => copy.mutate()} disabled={copy.isPending}>
            Copiar do mês anterior
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CapEditor({
  period,
  caps,
  onClose,
}: {
  period: string
  caps: CapProgress[]
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [amount, setAmount] = useState('')

  const suggestions = useQuery({
    queryKey: ['cap-suggestions', period],
    queryFn: () =>
      api.get<{
        suggestions: Array<{ categoryId: number; name: string; color: string; suggestedCapCents: number; basedOnMonths: number }>
      }>(`/goals/${period}/suggestions`),
  })

  const setCap = useMutation({
    mutationFn: (input: { categoryId: number; capCents: number }) =>
      api.put(`/goals/${period}/caps/${input.categoryId}`, { capCents: input.capCents }),
    onSuccess: () => {
      toast('Teto salvo')
      queryClient.invalidateQueries()
      setAmount('')
      setCategoryId(null)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const removeCap = useMutation({
    mutationFn: (id: number) => api.del(`/goals/${period}/caps/${id}`),
    onSuccess: () => {
      toast('Teto removido')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  const existing = new Set(caps.map((cap) => cap.categoryId))
  const available = (suggestions.data?.suggestions ?? []).filter((s) => !existing.has(s.categoryId))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[880px]">
        <DialogTitle>{`Tetos por categoria de ${periodLong(period)}`}</DialogTitle>
        <div className="stack stack--loose">
        {caps.length > 0 && (
          <div className="stack stack--tight">
            <span className="label">Tetos definidos</span>
            {caps.map((cap) => (
              <div key={cap.categoryId} className="row row--between">
                <span className="row" style={{ gap: 'var(--sp-2)' }}>
                  <span className="swatch" style={{ background: cap.color }} />
                  {cap.name}
                </span>
                <span className="row">
                  <span className="tabular">{money(cap.capCents)}</span>
                  <Button
                    variant="quiet"
                    size="sm"
                    icon="trash"
                    onClick={() => removeCap.mutate(cap.categoryId)}
                    title="Remover teto"
                  />
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="stack stack--tight">
          <span className="label">Adicionar teto</span>
          <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
            <div className="field" style={{ minWidth: 240, flex: 1 }}>
              <label className="field__label">Categoria</label>
              <Select
                value={categoryId}
                placeholder="Escolha"
                options={(suggestions.data?.suggestions ?? [])
                  .filter((s) => !existing.has(s.categoryId))
                  .map((s) => ({ value: s.categoryId, label: s.name }))}
                onChange={(value) => {
                  setCategoryId(value)
                  const match = available.find((s) => s.categoryId === value)
                  if (match) setAmount(centsToInput(match.suggestedCapCents))
                }}
              />
            </div>
            <div className="field" style={{ width: 160 }}>
              <label className="field__label">Teto (R$)</label>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0,00"
                className="text-right tabular-nums"
              />
            </div>
            <Button
              variant="primary"
              icon="plus"
              disabled={categoryId === null || parseMoneyInput(amount) === null}
              onClick={() =>
                setCap.mutate({ categoryId: categoryId!, capCents: Math.abs(parseMoneyInput(amount)!) })
              }
            >
              Adicionar
            </Button>
          </div>
        </div>

        {available.length > 0 && (
          <div className="stack stack--tight">
            <span className="label">Sugestões pelo seu histórico</span>
            <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Média real dos últimos {available[0]!.basedOnMonths} meses, arredondada.
            </p>
            <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
              {available.slice(0, 8).map((suggestion) => (
                <Button
                  key={suggestion.categoryId}
                  size="sm"
                  icon="plus"
                  onClick={() =>
                    setCap.mutate({
                      categoryId: suggestion.categoryId,
                      capCents: suggestion.suggestedCapCents,
                    })
                  }
                >
                  {suggestion.name} · {money(suggestion.suggestedCapCents)}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
      </DialogContent>
    </Dialog>
  )
}
