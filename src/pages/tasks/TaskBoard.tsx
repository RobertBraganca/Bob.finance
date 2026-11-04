import { useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { money } from '../../lib/format'
import { Button, Icon } from '../../components/ui'
import { CompleteWithReference, NoteCount, StageSelect, doneLabel, useSetStage } from './TaskList'
import { PERIOD_LABEL, PERIOD_MORE, goalOf, periodGroups, type PeriodKey } from './filters'
import { SOURCE_LABEL, STAGES, STAGE_HINT, STAGE_LABEL, dueLabel, isMovable, stageOptions, type TaskOccurrence, type TaskStage } from './types'

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

/** "Atrasadas" recebe como "A fazer": a data decide em qual das duas o cartão fica. */
const target = (stage: TaskStage): TaskStage => (stage === 'overdue' ? 'todo' : stage)

/**
 * Kanban das tarefas: uma coluna por etapa, arrastando o cartão (mouse) ou pelo
 * seletor de etapa dele (toque e teclado, já que o arrastar nativo não existe no
 * celular). As que a própria tela resolve (pendência a baixar, DAS pago) não se
 * movem: ficam onde a fonte manda. Clicar no cartão abre o detalhe. "A fazer"
 * vem partido por distância, com o que está longe recolhido.
 */
export function TaskBoard({
  tasks,
  today,
  onOpen,
  expandAll,
}: {
  tasks: TaskOccurrence[]
  today: string
  onOpen: (task: TaskOccurrence) => void
  /** com busca ou filtro, "Mais adiante" já vem aberto: o que sobrou é o que se procurou */
  expandAll?: boolean
}) {
  const navigate = useNavigate()
  const setStage = useSetStage()
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [over, setOver] = useState<TaskStage | null>(null)
  const [askingReference, setAskingReference] = useState<TaskOccurrence | null>(null)
  const [opened, setOpened] = useState<PeriodKey[]>([])

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

  const renderCard = (t: TaskOccurrence) => {
    const movable = isMovable(t)
    const goal = goalOf(t)
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
        {goal && (
          <span className="kanban-card__goal">
            {goal.name}
            {goal.level && <span className="kanban-card__level"> · Nível {goal.level}</span>}
          </span>
        )}
        {/* O botão cobre o cartão todo (::after); o seletor e o atalho ficam por cima. */}
        <button type="button" className="kanban-card__title kanban-card__open" onClick={() => onOpen(t)} aria-label={goal ? t.title : undefined}>
          {goal ? goal.step : t.title}
        </button>
        <span className="kanban-card__meta">
          {!goal && <span className="badge">{SOURCE_LABEL[t.source]}</span>}
          <span className={cx(t.stage === 'overdue' && 'kanban-card__late')}>{doneLabel(t, today) ?? dueLabel(t.dueOn, today)}</span>
          {t.noteCount > 0 && <NoteCount count={t.noteCount} />}
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
  }

  /** "A fazer" por distância: os próximos 7 dias abertos, o resto recolhido até pedir. */
  const renderTodo = (items: TaskOccurrence[]) =>
    periodGroups(items, today).flatMap((group) => {
      const collapsible = group.key !== 'week' && !expandAll
      const open = opened.includes(group.key)
      const head = (
        <li key={`group-${group.key}`} className="kanban__group">
          <span>{PERIOD_LABEL[group.key]}</span>
          <span className="tabular">{group.tasks.length}</span>
        </li>
      )
      if (collapsible && !open)
        return [
          head,
          <li key={`more-${group.key}`} className="kanban__more">
            <Button size="sm" onClick={() => setOpened((keys) => [...keys, group.key])}>
              Mostrar {group.tasks.length} {PERIOD_MORE[group.key]}
            </Button>
          </li>,
        ]
      return [
        head,
        ...group.tasks.map(renderCard),
        ...(collapsible
          ? [
              <li key={`less-${group.key}`} className="kanban__more">
                <Button variant="quiet" size="sm" onClick={() => setOpened((keys) => keys.filter((k) => k !== group.key))}>
                  Recolher
                </Button>
              </li>,
            ]
          : []),
      ]
    })

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
                {stage === 'todo' ? renderTodo(items) : items.map(renderCard)}
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
