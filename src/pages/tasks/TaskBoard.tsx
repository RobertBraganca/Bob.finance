import { useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { money } from '../../lib/format'
import { Button, Icon } from '../../components/ui'
import { CompleteWithReference, StageSelect, doneLabel, useSetStage } from './TaskList'
import { SOURCE_LABEL, STAGES, STAGE_HINT, STAGE_LABEL, dueLabel, isMovable, stageOptions, type TaskOccurrence, type TaskStage } from './types'

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

/** "Atrasadas" recebe como "A fazer": a data decide em qual das duas o cartão fica. */
const target = (stage: TaskStage): TaskStage => (stage === 'overdue' ? 'todo' : stage)

/**
 * Kanban das tarefas: uma coluna por etapa, arrastando o cartão (mouse) ou pelo
 * seletor de etapa dele (toque e teclado, já que o arrastar nativo não existe no
 * celular). As que a própria tela resolve (pendência a baixar, DAS pago) não se
 * movem: ficam onde a fonte manda.
 */
export function TaskBoard({ tasks, today }: { tasks: TaskOccurrence[]; today: string }) {
  const navigate = useNavigate()
  const setStage = useSetStage()
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [over, setOver] = useState<TaskStage | null>(null)
  const [askingReference, setAskingReference] = useState<TaskOccurrence | null>(null)

  const dragged = dragKey ? (tasks.find((t) => t.key === dragKey) ?? null) : null
  const canDrop = (stage: TaskStage) =>
    !!dragged && target(stage) !== target(dragged.stage) && stageOptions(dragged).some((o) => o.value === target(stage))

  const move = (t: TaskOccurrence, stage: TaskStage) => {
    if (stage === 'done' && t.source === 'nf') return setAskingReference(t)
    setStage.mutate({ task: t, stage })
  }
  const endDrag = () => {
    setDragKey(null)
    setOver(null)
  }
  const onDrop = (stage: TaskStage) => (e: DragEvent) => {
    e.preventDefault()
    if (dragged && canDrop(stage)) move(dragged, target(stage))
    endDrag()
  }

  return (
    <>
      <div className="kanban">
        {STAGES.map((stage) => {
          const items = tasks.filter((t) => t.stage === stage)
          return (
            <section
              key={stage}
              className={cx('kanban__col', `kanban__col--${stage}`, over === stage && 'kanban__col--over', dragged && !canDrop(stage) && 'kanban__col--locked')}
              aria-label={`${STAGE_LABEL[stage]}: ${items.length}`}
              onDragOver={(e) => {
                if (!canDrop(stage)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (over !== stage) setOver(stage)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
              }}
              onDrop={onDrop(stage)}
            >
              <header className="kanban__head">
                <span className="kanban__title">{STAGE_LABEL[stage]}</span>
                <span className="kanban__count tabular">{items.length}</span>
              </header>
              <p className="kanban__hint">{STAGE_HINT[stage]}</p>
              <ul className="kanban__list">
                {items.map((t) => {
                  const movable = isMovable(t)
                  return (
                    <li
                      key={t.key}
                      className={cx('kanban-card', movable && 'kanban-card--movable', dragKey === t.key && 'kanban-card--dragging', t.done && 'kanban-card--done')}
                      draggable={movable}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', t.key)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragKey(t.key)
                      }}
                      onDragEnd={endDrag}
                    >
                      <span className="kanban-card__title">{t.title}</span>
                      <span className="kanban-card__meta">
                        <span className="badge">{SOURCE_LABEL[t.source]}</span>
                        <span className={cx(t.stage === 'overdue' && 'kanban-card__late')}>{doneLabel(t) ?? dueLabel(t.dueOn, today)}</span>
                        {t.amountCents !== null && <strong className="tabular">{money(t.amountCents)}</strong>}
                      </span>
                      <span className="kanban-card__foot">
                        {movable ? (
                          <StageSelect task={t} onChange={(next) => move(t, next)} />
                        ) : (
                          <span className="kanban-card__auto" title="Fecha sozinha quando a pendência é resolvida na tela indicada">
                            <Icon name={t.done ? 'check' : 'clock'} size={14} />
                            {t.done ? 'resolvida na origem' : 'fecha sozinha'}
                          </span>
                        )}
                        {t.link && <Button variant="quiet" size="sm" icon="arrowRight" title="Abrir onde se resolve" onClick={() => navigate(t.link!)} />}
                      </span>
                    </li>
                  )
                })}
                {items.length === 0 && <li className="kanban__empty">{dragged && canDrop(stage) ? 'Solte aqui' : 'Nada aqui'}</li>}
              </ul>
            </section>
          )
        })}
      </div>
      {askingReference && (
        <CompleteWithReference
          task={askingReference}
          pending={setStage.isPending}
          onClose={() => setAskingReference(null)}
          onConfirm={(reference) => setStage.mutate({ task: askingReference, stage: 'done', reference }, { onSuccess: () => setAskingReference(null) })}
        />
      )}
    </>
  )
}
