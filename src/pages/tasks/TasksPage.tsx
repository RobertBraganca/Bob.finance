import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { money } from '../../lib/format'
import { PageHeader } from '../../components/shell/Shell'
import { Button, Card, ConfirmDeleteModal, EmptyState, KpiTile, LoadError, Segmented, SkeletonLines, useToast } from '../../components/ui'
import { GoogleCalendarCard } from './GoogleCalendarCard'
import { TaskFormModal } from './TaskFormModal'
import { TaskList } from './TaskList'
import { BUCKET_LABEL, recurrenceLabel, type ManualTask, type TaskBucket, type TasksResponse } from './types'

type View = 'open' | 'done'
const OPEN_BUCKETS: TaskBucket[] = ['overdue', 'today', 'week', 'later']

/**
 * Tarefas financeiras (docs/specs/tarefas-comercial-contador, fase 1): o que
 * vence, de todas as telas, num lugar só. As automáticas vêm de onde o dado já
 * mora (pendências, faturas, DAS, fechamento, aportes, saques); as manuais são
 * suas, como emitir a nota de um cliente todo mês.
 */
export function TasksPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [view, setView] = useState<View>('open')
  const [editing, setEditing] = useState<ManualTask | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ManualTask | null>(null)

  const list = useQuery({ queryKey: ['tasks', 'list'], queryFn: () => api.get<TasksResponse>('/tasks') })
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
  const openTotal = s ? s.overdue + s.today + s.week + s.later : 0
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
            <KpiTile accent label="Atrasadas" value={s ? String(s.overdue) : '-'} foot={<span>venceram e ainda estão abertas</span>} />
            <KpiTile label="Hoje" value={s ? String(s.today) : '-'} />
            <KpiTile label="Próximos 7 dias" value={s ? String(s.week) : '-'} />
            <KpiTile
              label="A pagar até 7 dias"
              value={data ? money(dueSoonCents) : '-'}
              foot={<span>atrasadas, de hoje e da semana, sem as receitas</span>}
              assumptions={{ formula: 'Soma dos valores das tarefas abertas que saem dinheiro (contas, DAS, aportes e as suas com valor) atrasadas ou vencendo nos próximos 7 dias.' }}
            />
          </div>

          <Segmented
            ariaLabel="Mostrar"
            value={view}
            onChange={setView}
            options={[
              { value: 'open', label: s ? `Abertas (${openTotal})` : 'Abertas' },
              { value: 'done', label: s ? `Feitas (${s.done})` : 'Feitas' },
            ]}
          />

          {list.isError ? (
            <Card>
              <LoadError onRetry={() => list.refetch()} retrying={list.isFetching} />
            </Card>
          ) : !data ? (
            <Card>
              <SkeletonLines lines={6} />
            </Card>
          ) : view === 'done' ? (
            <Card title="Feitas" subtitle="As que venceram nos últimos dois meses e já foram resolvidas">
              {s!.done === 0 ? (
                <p className="muted" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>Nada feito na janela ainda.</p>
              ) : (
                <TaskList tasks={data.tasks.filter((t) => t.bucket === 'done')} today={data.window.today} />
              )}
            </Card>
          ) : openTotal === 0 ? (
            <Card>
              <EmptyState icon="check" title="Nada em aberto" body="Nenhuma conta, nota, DAS ou aporte vencendo nos próximos 30 dias." />
            </Card>
          ) : (
            OPEN_BUCKETS.filter((b) => s![b] > 0).map((bucket) => (
              <Card key={bucket} title={BUCKET_LABEL[bucket]} subtitle={`${s![bucket]} ${s![bucket] === 1 ? 'tarefa' : 'tarefas'}`}>
                <TaskList tasks={data.tasks.filter((t) => t.bucket === bucket)} today={data.window.today} />
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
