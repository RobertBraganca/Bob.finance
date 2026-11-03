import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { money } from '../../lib/format'
import { Button, Field, Icon, Modal, Select, TextInput, useToast } from '../../components/ui'
import { SOURCE_LABEL, STAGE_LABEL, STAGE_TONE, dueLabel, isMovable, stageOptions, type TaskOccurrence, type TaskStage, type TasksResponse } from './types'

const RESOLVED: Record<TaskStage, boolean> = { overdue: false, todo: false, doing: false, paused: false, done: true, closed: true }
const STATUS_OF: Record<TaskStage, TaskOccurrence['status']> = { overdue: null, todo: null, doing: 'doing', paused: 'paused', done: 'done', closed: 'skipped' }

/**
 * Move a ocorrência de etapa (Kanban ou seletor da lista). Muda a tela na hora e
 * desfaz se o servidor recusar; "A fazer" numa vencida cai em Atrasadas sozinha.
 */
export function useSetStage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { task: TaskOccurrence; stage: TaskStage; reference?: string | null }) =>
      api.post('/tasks/stage', { key: input.task.key, stage: input.stage, reference: input.reference ?? null }),
    onMutate: async ({ task, stage, reference }) => {
      await queryClient.cancelQueries({ queryKey: ['tasks'] })
      const previous = queryClient.getQueriesData<TasksResponse>({ queryKey: ['tasks'] })
      const today = previous.find(([, d]) => d?.window)?.[1]?.window.today ?? ''
      const nextStage: TaskStage = stage === 'todo' || stage === 'overdue' ? (task.dueOn < today ? 'overdue' : 'todo') : stage
      for (const [key, data] of previous) {
        if (!data?.tasks) continue
        queryClient.setQueryData<TasksResponse>(key, {
          ...data,
          tasks: data.tasks.map((t) =>
            t.key === task.key
              ? { ...t, stage: nextStage, status: STATUS_OF[nextStage], done: RESOLVED[nextStage], reference: reference ?? (RESOLVED[nextStage] ? t.reference : null) }
              : t,
          ),
        })
      }
      return { previous }
    },
    onSuccess: (_, input) => {
      toast(`Movida para ${STAGE_LABEL[input.stage === 'overdue' ? 'todo' : input.stage]}`)
      if (input.task.key.startsWith('closing:')) queryClient.invalidateQueries({ queryKey: ['dashboard-closing-checklist'] })
    },
    onError: (error, _, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data)
      toast(error instanceof Error ? error.message : 'falha ao mover a tarefa', 'error')
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  })
}

/** Seletor de etapa: o caminho de teclado e de toque para o que o Kanban faz arrastando. */
export function StageSelect({ task, onChange, disabled }: { task: TaskOccurrence; onChange: (stage: TaskStage) => void; disabled?: boolean }) {
  if (!isMovable(task)) return null
  const value: TaskStage = task.stage === 'overdue' ? 'todo' : task.stage
  return (
    <span onPointerDown={(e) => e.stopPropagation()} aria-disabled={disabled || undefined}>
      <Select
        value={value}
        options={stageOptions(task)}
        onChange={(next) => next && next !== value && onChange(next)}
        className={`select--pill ${STAGE_TONE[task.stage]}`.trim()}
        ariaLabel={`Etapa de ${task.title}`}
      />
    </span>
  )
}

/** Marcar e desmarcar uma tarefa; invalida o que a tarefa toca (fechamento, Visão geral). */
export function useCompleteTask() {
  const toast = useToast()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { key: string; done: boolean; reference?: string | null }) => api.post('/tasks/complete', input),
    onSuccess: (_, input) => {
      toast(input.done ? 'Tarefa feita' : 'Tarefa reaberta')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      if (input.key.startsWith('closing:')) queryClient.invalidateQueries({ queryKey: ['dashboard-closing-checklist'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao atualizar a tarefa', 'error'),
  })
}

/**
 * Linhas de tarefa: caixa para marcar quando dá para resolver aqui; quando a
 * tarefa se resolve na tela dona (pendência a baixar, saque a fazer), em vez da
 * caixa vem o atalho para lá, e ela some ou fecha sozinha.
 */
export function TaskList({ tasks, today, compact, withStage }: { tasks: TaskOccurrence[]; today: string; compact?: boolean; withStage?: boolean }) {
  const navigate = useNavigate()
  const complete = useCompleteTask()
  const setStage = useSetStage()
  const [askingReference, setAskingReference] = useState<TaskOccurrence | null>(null)

  const toggle = (t: TaskOccurrence) => {
    if (t.done) return complete.mutate({ key: t.key, done: false })
    if (t.source === 'nf') return setAskingReference(t)
    complete.mutate({ key: t.key, done: true })
  }
  // Feita pelo seletor numa nota fiscal: pede o número, como a caixa de marcar.
  const move = (t: TaskOccurrence, stage: TaskStage) => {
    if (stage === 'done' && t.source === 'nf') return setAskingReference(t)
    setStage.mutate({ task: t, stage })
  }

  return (
    <>
      <ul className="task-list">
        {tasks.map((t) => (
          <li key={t.key} className={`task-row${t.done ? ' task-row--done' : ''}${t.bucket === 'overdue' ? ' task-row--overdue' : ''}`}>
            {t.completable || (t.done && t.status) ? (
              <input
                type="checkbox"
                className="checkbox"
                checked={t.done}
                disabled={complete.isPending || (t.done && !t.completable && t.auto)}
                onChange={() => toggle(t)}
                aria-label={t.done ? `Reabrir: ${t.title}` : `Marcar como feita: ${t.title}`}
              />
            ) : (
              <span className="task-row__auto" title="Fecha sozinha quando a pendência é resolvida na tela indicada" aria-hidden="true">
                <Icon name={t.done ? 'check' : 'clock'} size={14} />
              </span>
            )}
            <span className="task-row__body">
              <span className="task-row__title">{t.title}</span>
              <span className="task-row__meta">
                <span className="badge">{SOURCE_LABEL[t.source]}</span>
                <span>{doneLabel(t) ?? dueLabel(t.dueOn, today)}</span>
                {!withStage && (t.stage === 'doing' || t.stage === 'paused') && <span className="badge">{STAGE_LABEL[t.stage]}</span>}
                {!compact && t.detail && <span className="muted">{t.detail}</span>}
              </span>
            </span>
            <span className="task-row__end">
              {t.amountCents !== null && <strong className="tabular">{money(t.amountCents)}</strong>}
              {withStage && <StageSelect task={t} onChange={(stage) => move(t, stage)} />}
              {t.link && (
                <Button variant="quiet" size="sm" icon="arrowRight" title="Abrir onde se resolve" onClick={() => navigate(t.link!)} />
              )}
            </span>
          </li>
        ))}
      </ul>
      {askingReference && (
        <CompleteWithReference
          task={askingReference}
          pending={complete.isPending}
          onClose={() => setAskingReference(null)}
          onConfirm={(reference) => complete.mutate({ key: askingReference.key, done: true, reference }, { onSuccess: () => setAskingReference(null) })}
        />
      )}
    </>
  )
}

/** "feita · NF 12", "encerrada", ou null quando ainda está aberta. */
export function doneLabel(t: TaskOccurrence): string | null {
  if (!t.done) return null
  if (t.status === 'skipped') return 'encerrada'
  return t.reference ? `feita · ${t.reference}` : 'feita'
}

export function CompleteWithReference({
  task,
  pending,
  onClose,
  onConfirm,
}: {
  task: TaskOccurrence
  pending: boolean
  onClose: () => void
  onConfirm: (reference: string | null) => void
}) {
  const [reference, setReference] = useState('')
  return (
    <Modal
      title="Nota emitida"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => onConfirm(reference.trim() || null)} loading={pending}>
            Marcar como feita
          </Button>
        </>
      }
    >
      <div className="stack">
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{task.title}</p>
        <Field label="Número da nota" hint="Opcional. Fica guardado junto da tarefa.">
          {(id) => <TextInput id={id} value={reference} onChange={setReference} placeholder="ex. 1234" autoFocus />}
        </Field>
      </div>
    </Modal>
  )
}
