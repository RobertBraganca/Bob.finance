import { useNavigate } from 'react-router-dom'
import { money } from '../../lib/format'
import { Button, EmptyState, Modal } from '../../components/ui'
import { GroupBadge, GroupProgressBar, TaskList } from './TaskList'
import type { TaskGroupItem } from './filters'
import type { TaskOccurrence } from './types'

/**
 * Detalhe da tarefa principal: a observação, o progresso e as subtarefas, cada
 * uma com a caixa de marcar e o seletor de etapa. Clicar num passo abre o
 * detalhe dele (comentários e histórico). Nas suas, dá para acrescentar um
 * passo, editar e excluir a principal; nas automáticas (contas a pagar, a
 * receber), o atalho leva para onde elas se resolvem.
 */
export function GroupDetail({
  group,
  today,
  onClose,
  onOpenTask,
  onAddSubtask,
  onEdit,
  onDelete,
}: {
  group: TaskGroupItem
  today: string
  onClose: () => void
  onOpenTask: (task: TaskOccurrence) => void
  onAddSubtask?: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  const navigate = useNavigate()
  const link = group.taskId === null ? (group.tasks.find((t) => t.link)?.link ?? null) : null
  const open = group.tasks.filter((t) => !t.done)
  const resolved = group.tasks.filter((t) => t.done)

  return (
    <Modal
      title={group.title}
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
                Editar
              </Button>
            )}
            {onAddSubtask && (
              <Button variant="primary" icon="plus" onClick={onAddSubtask}>
                Nova subtarefa
              </Button>
            )}
            {link && (
              <Button icon="arrowRight" onClick={() => navigate(link)}>
                Abrir onde se resolve
              </Button>
            )}
          </span>
        </>
      }
    >
      <div className="task-detail">
        <div className="task-detail__tags">
          <GroupBadge group={group} />
          <GroupProgressBar group={group} />
          {group.openCents !== null && <strong className="tabular">{money(group.openCents)} em aberto</strong>}
        </div>
        {group.notes && <p className="task-detail__note">{group.notes}</p>}

        {group.tasks.length === 0 ? (
          <EmptyState icon="check" title="Sem subtarefas na janela" body="Nada vence entre os últimos 60 dias e os próximos 90." />
        ) : (
          <>
            {open.length > 0 && (
              <section className="stack stack--tight" aria-label="Abertas">
                <h3 className="task-detail__heading">Abertas · {open.length}</h3>
                <TaskList tasks={open} today={today} withStage inGroup onOpen={onOpenTask} />
              </section>
            )}
            {resolved.length > 0 && (
              <section className="stack stack--tight" aria-label="Resolvidas">
                <h3 className="task-detail__heading">Resolvidas · {resolved.length}</h3>
                <TaskList tasks={resolved} today={today} inGroup onOpen={onOpenTask} />
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
