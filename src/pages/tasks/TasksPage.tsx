import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { money } from '../../lib/format'
import { todayIso } from '../../lib/period'
import { PageHeader } from '../../components/shell/Shell'
import { Button, Card, ConfirmDeleteModal, EmptyState, Icon, KpiTile, LoadError, Segmented, Select, SkeletonLines, TextInput, useToast } from '../../components/ui'
import { GoogleCalendarCard } from './GoogleCalendarCard'
import { GroupDetail } from './GroupDetail'
import { TaskFormModal } from './TaskFormModal'
import { TaskBoard } from './TaskBoard'
import { TaskDetail } from './TaskDetail'
import { TaskList } from './TaskList'
import {
  PERIOD_LABEL,
  PERIOD_MORE,
  SCOPE_OPTIONS,
  buildItems,
  groupProgress,
  inScope,
  matchesSearch,
  nextOnly,
  periodGroups,
  type PeriodKey,
  type TaskItem,
  type TaskScope,
} from './filters'
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
  const [editing, setEditing] = useState<ManualTask | 'new' | { parentId: number } | null>(null)
  const [deleting, setDeleting] = useState<ManualTask | null>(null)
  // Pela chave, não pelo objeto: o detalhe acompanha a lista quando a etapa muda.
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [openGroupKey, setOpenGroupKey] = useState<string | null>(null)
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
  const groups = data?.groups ?? []
  const progress = data ? groupProgress(data.tasks, groups) : []
  const currentGoal = goalFilter ? (progress.find((g) => g.title === goalFilter) ?? null) : null
  // Das recorrentes, só as atrasadas e a próxima: a conta de dezembro espera a de novembro.
  const { tasks: upcoming, hidden } = nextOnly(data?.tasks ?? [])
  const shown: TaskOccurrence[] = upcoming.filter(
    (t) => inScope(t, scope) && (!goalFilter || t.group?.title === goalFilter) && matchesSearch(t, search),
  )
  const filtered = scope !== 'all' || Boolean(goalFilter) || search.trim() !== ''
  const today = data?.window.today ?? todayIso()
  // Com uma principal escolhida no filtro, os passos dela aparecem soltos, um cartão cada.
  const items: TaskItem[] = goalFilter
    ? shown.map((t) => ({ kind: 'task', key: t.key, task: t, dueOn: t.dueOn, stage: t.stage }))
    : buildItems(shown, groups)
  const openedGroup = openGroupKey ? (buildItems(upcoming, groups).find((i) => i.key === openGroupKey && i.kind === 'group') ?? null) : null
  const openedGroupTask = openedGroup?.kind === 'group' && openedGroup.taskId !== null ? manualOf(openedGroup.taskId) : null
  const groupChoices = groups.map((g) => ({ id: g.taskId, title: g.title })).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'))

  const renderStageList = (stage: (typeof STAGES)[number], stageItems: TaskItem[]) => {
    const listOf = (list: TaskItem[]) => (
      <TaskList items={list} today={today} withStage onOpen={(t) => setOpenKey(t.key)} onOpenGroup={(g) => setOpenGroupKey(g.key)} />
    )
    if (stage !== 'todo') return listOf(stageItems)
    return (
      <div className="stack">
        {periodGroups(stageItems, today).map((group) => {
          const collapsed = group.key !== 'week' && !openPeriods.includes(group.key) && !filtered
          return (
            <section key={group.key} className="task-period" aria-label={PERIOD_LABEL[group.key]}>
              <h3 className="task-period__title">
                {PERIOD_LABEL[group.key]} <span className="tabular">{group.items.length}</span>
              </h3>
              {collapsed ? (
                <Button size="sm" onClick={() => setOpenPeriods((keys) => [...keys, group.key])}>
                  Mostrar {group.items.length} {PERIOD_MORE[group.key]}
                </Button>
              ) : (
                listOf(group.items)
              )}
            </section>
          )
        })}
      </div>
    )
  }

  // "Suas tarefas": cada principal com as subtarefas embaixo, e as soltas no fim.
  const manualTasks = manual.data?.tasks ?? []
  const manualGroups = manualTasks.filter(({ task }) => task.kind === 'group')
  const childrenOf = (id: number) => manualTasks.filter(({ task }) => task.parentId === id)
  const loose = manualTasks.filter(({ task }) => task.kind !== 'group' && (task.parentId === null || !manualGroups.some((g) => g.task.id === task.parentId)))
  const renderManual = ({ task, clientName }: { task: ManualTask; clientName: string | null }, nested = false) => (
    <li key={task.id} className={`row row--between manual-task${nested ? ' manual-task--sub' : ''}`} style={{ gap: 'var(--sp-2)' }}>
      <span style={{ minWidth: 0 }}>
        <strong style={{ fontWeight: task.kind === 'group' ? 700 : 600, fontSize: 'var(--text-sm)' }}>{task.title}</strong>
        {!task.active && <span className="badge" style={{ marginLeft: 6 }}>Pausada</span>}
        <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
          {task.kind === 'group' ? `${childrenOf(task.id).length} subtarefas` : recurrenceLabel(task)}
          {clientName ? ` · ${clientName}` : ''}
          {task.amountCents ? ` · ${money(task.amountCents)}` : ''}
        </span>
      </span>
      <span className="row" style={{ gap: 2 }}>
        {task.kind === 'group' && <Button variant="quiet" size="sm" icon="plus" title={`Nova subtarefa em ${task.title}`} onClick={() => setEditing({ parentId: task.id })} />}
        <Button variant="quiet" size="sm" icon="pencil" title={`Editar ${task.title}`} onClick={() => setEditing(task)} />
        <Button variant="quiet" size="sm" icon="trash" title={`Excluir ${task.title}`} onClick={() => setDeleting(task)} />
      </span>
    </li>
  )

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
            {progress.length > 0 && scope !== 'money' && (
              <div className="task-toolbar__goal">
                <Select
                  ariaLabel="Filtrar por tarefa principal"
                  value={goalFilter ?? ALL_GOALS}
                  options={[
                    { value: ALL_GOALS, label: 'Todas as principais' },
                    ...progress.map((g) => ({ value: g.title, label: `${g.level ? `N${g.level} · ` : ''}${g.title} · ${g.resolved}/${g.total}` })),
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
            <div className="goal-progress" role="group" aria-label={`Progresso de ${currentGoal.title}`}>
              <span className="goal-progress__label">
                <strong>{currentGoal.title}</strong>
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
                  Mostrando {shown.length} de {upcoming.length}.{' '}
                  <button type="button" className="link-button" onClick={clearFilters}>
                    Limpar filtros
                  </button>
                </>
              ) : (
                <>
                  Vencidas há até 60 dias e as dos próximos {AHEAD_DAYS} dias, com os passos dentro da tarefa principal.
                  {hidden > 0 && ` Das recorrentes, só a próxima de cada uma (${hidden} ${hidden === 1 ? 'futura esperando' : 'futuras esperando'} a vez).`}
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
            <TaskBoard items={items} today={today} onOpen={(t) => setOpenKey(t.key)} onOpenGroup={(g) => setOpenGroupKey(g.key)} expandAll={filtered} />
          ) : (
            STAGES.map((stage) => ({ stage, stageItems: items.filter((i) => i.stage === stage) }))
              .filter(({ stageItems }) => stageItems.length > 0)
              .map(({ stage, stageItems }) => (
                <Card
                  key={stage}
                  title={STAGE_LABEL[stage]}
                  subtitle={`${stageItems.length} ${stageItems.length === 1 ? 'item' : 'itens'} · ${STAGE_HINT[stage].toLowerCase()}`}
                >
                  {renderStageList(stage, stageItems)}
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
                {manualGroups.map((g) => (
                  <li key={`g-${g.task.id}`} className="manual-group">
                    <ul className="stack stack--tight">
                      {renderManual(g)}
                      {childrenOf(g.task.id).map((child) => renderManual(child, true))}
                    </ul>
                  </li>
                ))}
                {loose.map((t) => renderManual(t))}
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
      {/* Um modal por vez: abrir um passo ou o formulário esconde a principal, que volta ao fechar. */}
      {openedGroup?.kind === 'group' && data && !opened && !editing && !deleting && (
        <GroupDetail
          group={openedGroup}
          today={data.window.today}
          onClose={() => setOpenGroupKey(null)}
          onOpenTask={(t) => setOpenKey(t.key)}
          onAddSubtask={openedGroup.taskId !== null ? () => setEditing({ parentId: openedGroup.taskId! }) : undefined}
          onEdit={
            openedGroupTask
              ? () => {
                  setOpenGroupKey(null)
                  setEditing(openedGroupTask)
                }
              : undefined
          }
          onDelete={
            openedGroupTask
              ? () => {
                  setOpenGroupKey(null)
                  setDeleting(openedGroupTask)
                }
              : undefined
          }
        />
      )}
      {editing && (
        <TaskFormModal
          task={editing !== 'new' && 'id' in editing ? editing : undefined}
          parentId={editing !== 'new' && !('id' in editing) ? editing.parentId : undefined}
          groups={groupChoices}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDeleteModal
          title={`Excluir "${deleting.title}"?`}
          body={
            deleting.kind === 'group'
              ? `As ${childrenOf(deleting.id).length} subtarefas saem junto, com o histórico de feitas e os comentários delas.`
              : 'As próximas ocorrências deixam de aparecer, e o histórico de feitas e os comentários desta tarefa saem junto.'
          }
          confirmLabel="Excluir tarefa"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
        />
      )}
    </>
  )
}
