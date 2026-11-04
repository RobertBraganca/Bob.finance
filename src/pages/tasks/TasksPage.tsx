import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { money } from '../../lib/format'
import { todayIso } from '../../lib/period'
import { PageHeader } from '../../components/shell/Shell'
import { Button, Card, ConfirmDeleteModal, EmptyState, Icon, KpiTile, LoadError, Segmented, Select, SkeletonLines, TextInput, useToast } from '../../components/ui'
import { GoogleCalendarCard } from './GoogleCalendarCard'
import { TaskFormModal } from './TaskFormModal'
import { TaskBoard } from './TaskBoard'
import { TaskDetail } from './TaskDetail'
import { TaskList } from './TaskList'
import { PERIOD_LABEL, PERIOD_MORE, SCOPE_OPTIONS, goalOf, goalProgress, inScope, matchesSearch, periodGroups, type PeriodKey, type TaskScope } from './filters'
import { STAGES, STAGE_HINT, STAGE_LABEL, recurrenceLabel, type ManualTask, type TaskOccurrence, type TasksResponse } from './types'

type View = 'list' | 'board'
const VIEW_KEY = 'bob-finance:tasks-view'
/** Até onde a tela olha: 90 dias à frente, para o cronograma das metas aparecer inteiro em "A fazer". */
const AHEAD_DAYS = 90
const ALL_GOALS = '__todas__'

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'
  } catch {
    return 'board'
  }
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Tarefas financeiras (docs/specs/tarefas-comercial-contador, fase 1): o que
 * vence, de todas as telas, num lugar só. As automáticas vêm de onde o dado já
 * mora (pendências, faturas, DAS, fechamento, aportes, saques); as manuais são
 * suas, como emitir a nota de um cliente todo mês. Filtro, meta e busca ficam
 * no endereço (?escopo=, ?meta=, ?q=), para voltar ao mesmo recorte.
 */
export function TasksPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [view, setViewState] = useState<View>(readView)
  const setView = (next: View) => {
    setViewState(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // sem armazenamento: a escolha vale só nesta visita
    }
  }
  const [editing, setEditing] = useState<ManualTask | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ManualTask | null>(null)
  // Pela chave, não pelo objeto: o detalhe acompanha a lista quando a etapa muda.
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [openPeriods, setOpenPeriods] = useState<PeriodKey[]>([])
  // Editar e excluir moram no detalhe do cartão; a lista completa fica recolhida.
  const [showManual, setShowManual] = useState(false)

  const scopeParam = params.get('escopo')
  const scope: TaskScope = scopeParam === 'suas' ? 'mine' : scopeParam === 'financeiro' ? 'money' : 'all'
  const goalFilter = params.get('meta')
  const search = params.get('q') ?? ''
  const setParam = (name: string, value: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(name, value)
        else next.delete(name)
        return next
      },
      { replace: true },
    )
  const setScope = (next: TaskScope) =>
    setParams(
      (current) => {
        const out = new URLSearchParams(current)
        if (next === 'all') out.delete('escopo')
        else out.set('escopo', next === 'mine' ? 'suas' : 'financeiro')
        // Meta só existe nas suas tarefas.
        if (next === 'money') out.delete('meta')
        return out
      },
      { replace: true },
    )
  const clearFilters = () => setParams(new URLSearchParams(), { replace: true })

  const to = addDaysIso(todayIso(), AHEAD_DAYS)
  const list = useQuery({ queryKey: ['tasks', 'board', to], queryFn: () => api.get<TasksResponse>(`/tasks?to=${to}`) })
  const manual = useQuery({
    queryKey: ['tasks', 'manual'],
    queryFn: () => api.get<{ tasks: Array<{ task: ManualTask; clientName: string | null }> }>('/tasks/manual'),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/tasks/${id}`),
    onSuccess: () => {
      toast('Tarefa excluída')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      setDeleting(null)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  const data = list.data
  const opened = openKey ? (data?.tasks.find((t) => t.key === openKey) ?? null) : null
  const manualOf = (taskId: number | null) => manual.data?.tasks.find(({ task }) => task.id === taskId)?.task ?? null
  const openedManual = opened ? manualOf(opened.taskId) : null
  const s = data?.summary
  const st = data?.stages
  const weekOpen = (data?.tasks ?? []).filter((t) => !t.done && (t.bucket === 'today' || t.bucket === 'week')).length
  const dueSoonCents = (data?.tasks ?? [])
    .filter((t) => !t.done && (t.bucket === 'overdue' || t.bucket === 'today' || t.bucket === 'week') && t.source !== 'pending_income' && t.amountCents !== null)
    .reduce((sum, t) => sum + (t.amountCents ?? 0), 0)

  // Os indicadores acima contam tudo; o filtro só recorta o quadro e a lista.
  const goals = data ? goalProgress(data.tasks) : []
  const currentGoal = goalFilter ? (goals.find((g) => g.name === goalFilter) ?? null) : null
  const shown: TaskOccurrence[] = (data?.tasks ?? []).filter(
    (t) => inScope(t, scope) && (!goalFilter || goalOf(t)?.name === goalFilter) && matchesSearch(t, search),
  )
  const filtered = scope !== 'all' || Boolean(goalFilter) || search.trim() !== ''
  const today = data?.window.today ?? todayIso()

  const renderStageList = (stage: (typeof STAGES)[number], items: TaskOccurrence[]) => {
    const listOf = (tasks: TaskOccurrence[]) => <TaskList tasks={tasks} today={today} withStage onOpen={(t) => setOpenKey(t.key)} />
    if (stage !== 'todo') return listOf(items)
    return (
      <div className="stack">
        {periodGroups(items, today).map((group) => {
          const collapsed = group.key !== 'week' && !openPeriods.includes(group.key) && !filtered
          return (
            <section key={group.key} className="task-period" aria-label={PERIOD_LABEL[group.key]}>
              <h3 className="task-period__title">
                {PERIOD_LABEL[group.key]} <span className="tabular">{group.tasks.length}</span>
              </h3>
              {collapsed ? (
                <Button size="sm" onClick={() => setOpenPeriods((keys) => [...keys, group.key])}>
                  Mostrar {group.tasks.length} {PERIOD_MORE[group.key]}
                </Button>
              ) : (
                listOf(group.tasks)
              )}
            </section>
          )
        })}
      </div>
    )
  }

  return (
    <>
      <PageHeader
        title="Tarefas"
        subtitle="O que vence: contas, notas fiscais, DAS, faturas e aportes, num lugar só"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            Nova tarefa
          </Button>
        }
      />
      <div className="page">
        <div className="stack stack--loose">
          <div className="kpi-row">
            <KpiTile accent label="Atrasadas" value={st ? String(st.overdue) : '-'} foot={<span>venceram e ainda não começaram</span>} />
            <KpiTile label="Fazendo" value={st ? String(st.doing) : '-'} foot={<span>em andamento</span>} />
            <KpiTile label="Hoje e próximos 7 dias" value={s ? String(weekOpen) : '-'} foot={<span>abertas, inclusive as em andamento</span>} />
            <KpiTile
              label="A pagar até 7 dias"
              value={data ? money(dueSoonCents) : '-'}
              foot={<span>atrasadas, de hoje e da semana, sem as receitas</span>}
              assumptions={{ formula: 'Soma dos valores das tarefas abertas que saem dinheiro (contas, DAS, aportes e as suas com valor) atrasadas ou vencendo nos próximos 7 dias.' }}
            />
          </div>

          <div className="task-toolbar">
            <div className="search-field task-toolbar__search">
              <Icon name="search" size={15} />
              <TextInput value={search} onChange={(next) => setParam('q', next)} placeholder="Buscar por título, cliente ou nota" ariaLabel="Buscar tarefas" />
            </div>
            <Segmented ariaLabel="Quais tarefas" value={scope} onChange={setScope} options={SCOPE_OPTIONS} />
            {goals.length > 0 && scope !== 'money' && (
              <div className="task-toolbar__goal">
                <Select
                  ariaLabel="Filtrar por meta"
                  value={goalFilter ?? ALL_GOALS}
                  options={[
                    { value: ALL_GOALS, label: 'Todas as metas' },
                    ...goals.map((g) => ({ value: g.name, label: `${g.level ? `N${g.level} · ` : ''}${g.name} · ${g.resolved}/${g.total}` })),
                  ]}
                  onChange={(next) => setParam('meta', !next || next === ALL_GOALS ? null : next)}
                />
              </div>
            )}
            <span className="task-toolbar__spacer" />
            <Segmented
              ariaLabel="Visualização"
              value={view}
              onChange={setView}
              options={[
                { value: 'board', label: 'Kanban' },
                { value: 'list', label: 'Lista' },
              ]}
            />
          </div>

          {currentGoal && (
            <div className="goal-progress" role="group" aria-label={`Progresso de ${currentGoal.name}`}>
              <span className="goal-progress__label">
                <strong>{currentGoal.name}</strong>
                {currentGoal.level && <span className="muted"> · Nível {currentGoal.level}</span>}
              </span>
              <span className="goal-progress__bar" aria-hidden="true">
                <span style={{ width: `${currentGoal.total ? (currentGoal.resolved / currentGoal.total) * 100 : 0}%` }} />
              </span>
              <span className="goal-progress__count tabular">
                {currentGoal.resolved} de {currentGoal.total} {currentGoal.total === 1 ? 'passo resolvido' : 'passos resolvidos'}
              </span>
            </div>
          )}

          {data && (
            <p className="task-toolbar__note">
              {filtered ? (
                <>
                  Mostrando {shown.length} de {data.tasks.length}.{' '}
                  <button type="button" className="link-button" onClick={clearFilters}>
                    Limpar filtros
                  </button>
                </>
              ) : (
                <>
                  Vencidas há até 60 dias e as dos próximos {AHEAD_DAYS} dias.
                  {view === 'board' ? ' Clique no cartão para ver o detalhe; arraste ou use a etapa dele para mover.' : ' Clique no título para ver o detalhe.'}
                </>
              )}
            </p>
          )}

          {list.isError ? (
            <Card>
              <LoadError onRetry={() => list.refetch()} retrying={list.isFetching} />
            </Card>
          ) : !data ? (
            <Card>
              <SkeletonLines lines={6} />
            </Card>
          ) : data.tasks.length === 0 ? (
            <Card>
              <EmptyState icon="check" title="Nada por aqui" body={`Nenhuma conta, nota, DAS ou aporte entre os últimos 60 dias e os próximos ${AHEAD_DAYS}.`} />
            </Card>
          ) : shown.length === 0 ? (
            <Card>
              <EmptyState
                icon="search"
                title="Nada com esse filtro"
                body="Nenhuma tarefa combina com a busca ou o filtro. Limpe para ver todas."
                action={<Button onClick={clearFilters}>Limpar filtros</Button>}
              />
            </Card>
          ) : view === 'board' ? (
            <TaskBoard tasks={shown} today={today} onOpen={(t) => setOpenKey(t.key)} expandAll={filtered} />
          ) : (
            STAGES.map((stage) => ({ stage, items: shown.filter((t) => t.stage === stage) }))
              .filter(({ items }) => items.length > 0)
              .map(({ stage, items }) => (
                <Card key={stage} title={STAGE_LABEL[stage]} subtitle={`${items.length} ${items.length === 1 ? 'tarefa' : 'tarefas'} · ${STAGE_HINT[stage].toLowerCase()}`}>
                  {renderStageList(stage, items)}
                </Card>
              ))
          )}

          <GoogleCalendarCard />

          <Card
            title="Suas tarefas"
            subtitle={
              manual.data && manual.data.tasks.length > 0
                ? `${manual.data.tasks.length} criadas por você. Para editar uma, abra o cartão dela no quadro; aqui ficam todas, inclusive as pausadas.`
                : 'As que você criou: notas fiscais por cliente e o que o sistema não enxerga sozinho'
            }
            actions={
              <span className="row" style={{ gap: 'var(--sp-2)' }}>
                {manual.data && manual.data.tasks.length > 0 && (
                  <Button size="sm" variant="quiet" onClick={() => setShowManual((v) => !v)}>
                    {showManual ? 'Recolher' : 'Mostrar todas'}
                  </Button>
                )}
                <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
                  Nova
                </Button>
              </span>
            }
          >
            {manual.data && manual.data.tasks.length > 0 && !showManual ? null : manual.isError ? (
              <LoadError onRetry={() => manual.refetch()} retrying={manual.isFetching} />
            ) : !manual.data ? (
              <SkeletonLines lines={3} />
            ) : manual.data.tasks.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
                Nenhuma ainda. Ex.: "Emitir NF da VIO FILMES todo dia 5", "Enviar o extrato ao contador todo dia 10".
              </p>
            ) : (
              <ul className="stack stack--tight">
                {manual.data.tasks.map(({ task, clientName }) => (
                  <li key={task.id} className="row row--between" style={{ gap: 'var(--sp-2)' }}>
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{task.title}</strong>
                      {!task.active && <span className="badge" style={{ marginLeft: 6 }}>Pausada</span>}
                      <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                        {recurrenceLabel(task)}
                        {clientName ? ` · ${clientName}` : ''}
                        {task.amountCents ? ` · ${money(task.amountCents)}` : ''}
                      </span>
                    </span>
                    <span className="row" style={{ gap: 2 }}>
                      <Button variant="quiet" size="sm" icon="pencil" title={`Editar ${task.title}`} onClick={() => setEditing(task)} />
                      <Button variant="quiet" size="sm" icon="trash" title={`Excluir ${task.title}`} onClick={() => setDeleting(task)} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {opened && data && (
        <TaskDetail
          task={opened}
          today={data.window.today}
          onClose={() => setOpenKey(null)}
          onEdit={
            openedManual
              ? () => {
                  setOpenKey(null)
                  setEditing(openedManual)
                }
              : undefined
          }
          onDelete={
            openedManual
              ? () => {
                  setOpenKey(null)
                  setDeleting(openedManual)
                }
              : undefined
          }
        />
      )}
      {editing && <TaskFormModal task={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDeleteModal
          title={`Excluir "${deleting.title}"?`}
          body="As próximas ocorrências deixam de aparecer, e o histórico de feitas e os comentários desta tarefa saem junto."
          confirmLabel="Excluir tarefa"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
        />
      )}
    </>
  )
}
