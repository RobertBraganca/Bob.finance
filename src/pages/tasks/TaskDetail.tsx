import { useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { date, money } from '../../lib/format'
import { Button, Field, Icon, LoadError, Modal, Select, SkeletonLines, TextArea, TextInput, useToast } from '../../components/ui'
import { useSetStage } from './TaskList'
import {
  SOURCE_LABEL,
  STAGE_ONE,
  dayLabel,
  dueLabel,
  isMovable,
  stageOptions,
  stepTitle,
  whenLabel,
  type TaskDetailResponse,
  type TaskNote,
  type TaskOccurrence,
  type TaskStage,
} from './types'

/** Mesmo tom do seletor de etapa, como selo. */
const STAGE_BADGE: Record<TaskStage, string> = {
  overdue: 'badge badge--critical',
  todo: 'badge',
  doing: 'badge badge--info',
  paused: 'badge badge--warning',
  done: 'badge badge--good',
  closed: 'badge',
}

/** Etapas que pedem um passo a mais antes de gravar: o motivo, ou o número da nota. */
const ASKS_REASON: Partial<Record<TaskStage, { label: string; action: string }>> = {
  paused: { label: 'Por que pausou?', action: 'Pausar' },
  closed: { label: 'Por que não vai ser feita?', action: 'Encerrar' },
}

/**
 * Detalhe da tarefa: o que ela é, a etapa, os comentários e o histórico de
 * etapas, para registrar como está indo e consultar depois por que pausou ou
 * encerrou. Nas recorrentes, o que foi anotado nas ocorrências anteriores.
 */
export function TaskDetail({
  task,
  today,
  onClose,
  onEdit,
  onDelete,
}: {
  task: TaskOccurrence
  today: string
  onClose: () => void
  /** só nas suas tarefas: abre o formulário da recorrente */
  onEdit?: () => void
  onDelete?: () => void
}) {
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const setStage = useSetStage()
  const [comment, setComment] = useState('')
  const [pending, setPending] = useState<TaskStage | null>(null)
  const [reason, setReason] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null)

  const detailKey = ['task-detail', task.key]
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => api.get<TaskDetailResponse>(`/tasks/detail?key=${encodeURIComponent(task.key)}`),
  })
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: detailKey })
    queryClient.invalidateQueries({ queryKey: ['tasks'] })
  }
  const addNote = useMutation({
    mutationFn: (body: string) => api.post<TaskNote>('/tasks/notes', { key: task.key, body }),
    onSuccess: () => {
      setComment('')
      refresh()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar o comentário', 'error'),
  })
  const removeNote = useMutation({
    mutationFn: (id: number) => api.del(`/tasks/notes/${id}`),
    onSuccess: () => {
      setConfirmingDelete(null)
      toast('Comentário apagado')
      refresh()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao apagar o comentário', 'error'),
  })

  const current: TaskStage = task.stage === 'overdue' ? 'todo' : task.stage
  const choose = (next: TaskStage | null) => {
    if (!next || next === current) return
    if (ASKS_REASON[next] || (next === 'done' && task.source === 'nf')) {
      setReason('')
      return setPending(next)
    }
    setStage.mutate({ task, stage: next })
  }
  const confirmPending = () => {
    if (!pending) return
    const text = reason.trim() || null
    setStage.mutate(
      pending === 'done' ? { task, stage: 'done', reference: text } : { task, stage: pending, note: text },
      { onSuccess: () => setPending(null) },
    )
  }
  const submitComment = () => {
    if (comment.trim() && !addNote.isPending) addNote.mutate(comment.trim())
  }
  const onCommentKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      submitComment()
    }
  }

  const facts: Array<[string, string | null]> = [
    ['Vencimento', `${date(task.dueOn)} · ${dueLabel(task.dueOn, today)}`],
    ['Valor', task.amountCents !== null ? money(task.amountCents) : null],
    ['Cliente', task.clientName],
    [task.status === 'skipped' ? 'Encerrada em' : 'Feita em', task.done && task.doneAt ? dayLabel(task.doneAt, today) : null],
    [task.source === 'nf' ? 'Número da nota' : 'Referência', task.reference],
  ]
  const ask = pending ? ASKS_REASON[pending] : null
  // A dica do atalho só faz sentido com teclado físico.
  const keyboard = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches

  return (
    <Modal
      title={stepTitle(task)}
      onClose={onClose}
      footer={
        <>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            {onDelete && (
              <Button variant="quiet" icon="trash" onClick={onDelete}>
                Excluir
              </Button>
            )}
          </span>
          <span className="row" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {onEdit && (
              <Button icon="pencil" onClick={onEdit}>
                Editar tarefa
              </Button>
            )}
            {task.link && (
              <Button icon="arrowRight" onClick={() => navigate(task.link!)}>
                Abrir onde se resolve
              </Button>
            )}
          </span>
        </>
      }
    >
      <div className="task-detail">
        <div className="task-detail__tags">
          {task.group ? (
            <span className="badge" title="Tarefa principal">
              <Icon name="layers" size={12} /> {task.group.title}
            </span>
          ) : (
            <span className="badge">{SOURCE_LABEL[task.source]}</span>
          )}
          <span className={STAGE_BADGE[task.stage]}>{STAGE_ONE[task.stage]}</span>
        </div>

        {task.detail && <p className="task-detail__note">{task.detail}</p>}

        <dl className="kv-list">
          {facts
            .filter(([, value]) => value !== null)
            .map(([label, value]) => (
              <div key={label} className="kv">
                <dt className="kv__k">{label}</dt>
                <dd className="kv__v" style={{ margin: 0 }}>
                  {value}
                </dd>
              </div>
            ))}
        </dl>

        <section className="task-detail__section" aria-label="Etapa">
          {isMovable(task) ? (
            <>
              <Field label="Etapa">
                {(id) => <Select id={id} value={pending ?? current} options={stageOptions(task)} onChange={choose} />}
              </Field>
              {pending && (
                <div
                  className="task-detail__confirm"
                  onKeyDown={(e) => {
                    // Só no campo: Enter num botão (Cancelar) segue fazendo o que o botão faz.
                    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && !setStage.isPending) {
                      e.preventDefault()
                      confirmPending()
                    }
                  }}
                >
                  <Field
                    label={ask ? ask.label : 'Número da nota'}
                    hint={ask ? 'Opcional. Fica no histórico da tarefa.' : 'Opcional. Fica guardado junto da tarefa.'}
                  >
                    {(id) => (
                      <TextInput id={id} value={reason} onChange={setReason} placeholder={ask ? 'ex. aguardando retorno do cliente' : 'ex. 1234'} autoFocus />
                    )}
                  </Field>
                  <span className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
                    <Button variant="quiet" onClick={() => setPending(null)} disabled={setStage.isPending}>
                      Cancelar
                    </Button>
                    <Button variant="primary" onClick={confirmPending} loading={setStage.isPending}>
                      {ask ? ask.action : 'Marcar como feita'}
                    </Button>
                  </span>
                </div>
              )}
            </>
          ) : (
            <p className="task-detail__auto">
              <Icon name={task.done ? 'check' : 'clock'} size={14} />
              {task.done ? 'Resolvida na origem.' : 'Fecha sozinha quando for resolvida na tela indicada.'}
            </p>
          )}
        </section>

        <section className="task-detail__section" aria-labelledby="task-detail-comments">
          <h3 className="h3" id="task-detail-comments">
            Comentários e histórico
          </h3>
          <div className="task-detail__composer" onKeyDown={onCommentKey}>
            <Field label="Novo comentário" hint={keyboard ? 'Ctrl + Enter também envia' : undefined}>
              {(id) => (
                <TextArea id={id} value={comment} onChange={setComment} rows={3} placeholder="O que já foi feito, o que falta, com quem falou..." />
              )}
            </Field>
            <span className="row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="primary" icon="send" onClick={submitComment} disabled={!comment.trim()} loading={addNote.isPending}>
                Comentar
              </Button>
            </span>
          </div>

          {detail.isError ? (
            <LoadError onRetry={() => detail.refetch()} retrying={detail.isFetching} />
          ) : !detail.data ? (
            <SkeletonLines lines={3} />
          ) : detail.data.notes.length === 0 ? (
            <p className="task-detail__empty">
              {isMovable(task) ? 'Nada anotado ainda. As mudanças de etapa também aparecem aqui, sozinhas.' : 'Nada anotado ainda.'}
            </p>
          ) : (
            <Timeline
              notes={detail.data.notes}
              today={today}
              confirmingDelete={confirmingDelete}
              onAskDelete={setConfirmingDelete}
              onDelete={(id) => removeNote.mutate(id)}
              deleting={removeNote.isPending}
            />
          )}
        </section>

        {detail.data && detail.data.history.length > 0 && (
          <section className="task-detail__section" aria-labelledby="task-detail-history">
            <h3 className="h3" id="task-detail-history">
              Ocorrências anteriores
            </h3>
            <ul className="task-history">
              {detail.data.history.map((h) => {
                const comments = h.notes.filter((n) => n.kind === 'comment')
                return (
                  <li key={h.key} className="task-history__item">
                    <span className="task-history__head">
                      <strong className="tabular">{date(h.dueOn)}</strong>
                      <span className={STAGE_BADGE[h.stage]}>{STAGE_ONE[h.stage]}</span>
                      {h.doneAt && <span className="muted">em {dayLabel(h.doneAt, today)}</span>}
                      {h.reference && <span className="muted">· {h.reference}</span>}
                    </span>
                    {comments.map((n) => (
                      <p key={n.id} className="task-history__note">
                        {n.body}
                        <span className="task-timeline__when"> · {whenLabel(n.createdAt, today)}</span>
                      </p>
                    ))}
                    {h.notes
                      .filter((n) => n.kind === 'stage' && n.body)
                      .map((n) => (
                        <p key={n.id} className="task-history__note">
                          {STAGE_ONE[n.toStage ?? 'todo']}: {n.body}
                        </p>
                      ))}
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  )
}

function Timeline({
  notes,
  today,
  confirmingDelete,
  onAskDelete,
  onDelete,
  deleting,
}: {
  notes: TaskNote[]
  today: string
  confirmingDelete: number | null
  onAskDelete: (id: number | null) => void
  onDelete: (id: number) => void
  deleting: boolean
}) {
  return (
    <ol className="task-timeline">
      {notes.map((n) =>
        n.kind === 'stage' ? (
          <li key={n.id} className="task-timeline__item task-timeline__item--stage">
            <span className="task-timeline__dot" aria-hidden="true" />
            <span className="task-timeline__body">
              <span>
                {n.fromStage ? `${STAGE_ONE[n.fromStage]} → ` : ''}
                <strong>{STAGE_ONE[n.toStage ?? 'todo']}</strong>
                <span className="task-timeline__when"> · {whenLabel(n.createdAt, today)}</span>
              </span>
              {n.body && <span className="task-timeline__reason">{n.body}</span>}
            </span>
          </li>
        ) : (
          <li key={n.id} className="task-timeline__item">
            <span className="task-timeline__dot task-timeline__dot--comment" aria-hidden="true">
              <Icon name="message" size={11} />
            </span>
            <span className="task-timeline__body">
              <span className="task-timeline__text">{n.body}</span>
              <span className="task-timeline__foot">
                <span className="task-timeline__when">{whenLabel(n.createdAt, today)}</span>
                {confirmingDelete === n.id ? (
                  <span className="row" style={{ gap: 4 }}>
                    <Button variant="quiet" size="sm" onClick={() => onAskDelete(null)} disabled={deleting}>
                      Manter
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => onDelete(n.id)} loading={deleting}>
                      Apagar comentário
                    </Button>
                  </span>
                ) : (
                  <Button variant="quiet" size="sm" icon="trash" title="Apagar comentário" onClick={() => onAskDelete(n.id)} />
                )}
              </span>
            </span>
          </li>
        ),
      )}
    </ol>
  )
}
