import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { money } from '../../lib/format'
import { todayIso } from '../../lib/period'
import { PageHeader } from '../../components/shell/Shell'
import { Button, Card, ConfirmDeleteModal, EmptyState, KpiTile, LoadError, Segmented, SkeletonLines, useToast } from '../../components/ui'
import { GoogleCalendarCard } from './GoogleCalendarCard'
import { TaskFormModal } from './TaskFormModal'
import { TaskBoard } from './TaskBoard'
import { TaskList } from './TaskList'
import { STAGES, STAGE_HINT, STAGE_LABEL, recurrenceLabel, type ManualTask, type TasksResponse } from './types'

type View = 'list' | 'board'
const VIEW_KEY = 'bob-finance:tasks-view'
/** Até onde a tela olha: 90 dias à frente, para o cronograma das metas aparecer inteiro em "A fazer". */
const AHEAD_DAYS = 90

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
 * suas, como emitir a nota de um cliente todo mês.
 */
export function TasksPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
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
  const s = data?.summary
  const st = data?.stages
  const weekOpen = (data?.tasks ?? []).filter((t) => !t.done && (t.bucket === 'today' || t.bucket === 'week')).length
  const dueSoonCents = (data?.tasks ?? [])
    .filter((t) => !t.done && (t.bucket === 'overdue' || t.bucket === 'today' || t.bucket === 'week') && t.source !== 'pending_income' && t.amountCents !== null)
    .reduce((sum, t) => sum + (t.amountCents ?? 0), 0)

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

          <div className="row row--between" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
            <Segmented
              ariaLabel="Visualização"
              value={view}
              onChange={setView}
              options={[
                { value: 'board', label: 'Kanban' },
                { value: 'list', label: 'Lista' },
              ]}
            />
            {data && (
              <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                Vencidas há até 60 dias e as dos próximos {AHEAD_DAYS} dias
                {view === 'board' ? '. Arraste o cartão ou use a etapa dele.' : '.'}
              </span>
            )}
          </div>

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
          ) : view === 'board' ? (
            <TaskBoard tasks={data.tasks} today={data.window.today} />
          ) : (
            STAGES.filter((stage) => st![stage] > 0).map((stage) => (
              <Card key={stage} title={STAGE_LABEL[stage]} subtitle={`${st![stage]} ${st![stage] === 1 ? 'tarefa' : 'tarefas'} · ${STAGE_HINT[stage].toLowerCase()}`}>
                <TaskList tasks={data.tasks.filter((t) => t.stage === stage)} today={data.window.today} withStage />
              </Card>
            ))
          )}

          <GoogleCalendarCard />

          <Card
            title="Suas tarefas"
            subtitle="As que você criou: notas fiscais por cliente e o que o sistema não enxerga sozinho"
            actions={
              <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
                Nova
              </Button>
            }
          >
            {manual.isError ? (
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

      {editing && <TaskFormModal task={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDeleteModal
          title={`Excluir "${deleting.title}"?`}
          body="As próximas ocorrências deixam de aparecer, e o histórico de feitas desta tarefa sai junto."
          confirmLabel="Excluir tarefa"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
        />
      )}
    </>
  )
}
