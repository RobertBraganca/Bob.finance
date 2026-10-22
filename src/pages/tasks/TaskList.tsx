import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { money } from '../../lib/format'
import { Button, Field, Icon, Modal, TextInput, useToast } from '../../components/ui'
import { SOURCE_LABEL, dueLabel, type TaskOccurrence } from './types'

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
export function TaskList({ tasks, today, compact }: { tasks: TaskOccurrence[]; today: string; compact?: boolean }) {
  const navigate = useNavigate()
  const complete = useCompleteTask()
  const [askingReference, setAskingReference] = useState<TaskOccurrence | null>(null)

  const toggle = (t: TaskOccurrence) => {
    if (t.done) return complete.mutate({ key: t.key, done: false })
    if (t.source === 'nf') return setAskingReference(t)
    complete.mutate({ key: t.key, done: true })
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
                <span>{t.done ? (t.reference ? `feita · ${t.reference}` : 'feita') : dueLabel(t.dueOn, today)}</span>
                {!compact && t.detail && <span className="muted">{t.detail}</span>}
              </span>
            </span>
            <span className="task-row__end">
              {t.amountCents !== null && <strong className="tabular">{money(t.amountCents)}</strong>}
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

function CompleteWithReference({
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
