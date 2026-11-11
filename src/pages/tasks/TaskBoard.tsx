import { useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { money } from '../../lib/format'
import { Button, Icon } from '../../components/ui'
import { CompleteWithReference, GroupBadge, GroupProgressBar, NoteCount, StageSelect, doneLabel, useSetStage } from './TaskList'
import { PERIOD_LABEL, PERIOD_MORE, periodGroups, type PeriodKey, type TaskGroupItem, type TaskItem } from './filters'
import { SOURCE_LABEL, STAGES, STAGE_HINT, STAGE_LABEL, dueLabel, isMovable, stageOptions, stepTitle, type TaskOccurrence, type TaskStage } from './types'

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

/** "Atrasadas" recebe como "A fazer": a data decide em qual das duas o cartão fica. */
const target = (stage: TaskStage): TaskStage => (stage === 'overdue' ? 'todo' : stage)

/**
 * Kanban das tarefas: uma coluna por etapa, arrastando o cartão (mouse) ou pelo
 * seletor de etapa dele (toque e teclado, já que o arrastar nativo não existe no
 * celular). As que a própria tela resolve (pendência a baixar, DAS pago) não se
 * movem: ficam onde a fonte manda. Clicar no cartão abre o detalhe. "A fazer"
 * vem partido por distância, com o que está longe recolhido.
 *
 * A tarefa principal é um cartão só, com o progresso e o próximo passo; a
 * coluna dela sai das subtarefas, e ela não se arrasta: os passos se movem no
 * detalhe dela, cada um na sua etapa.
 */
export function TaskBoard({
  items,
  today,
  onOpen,
  onOpenGroup,
  expandAll,
}: {
  items: TaskItem[]
  today: string
  onOpen: (task: TaskOccurrence) => void
  onOpenGroup: (group: TaskGroupItem) => void
  /** com busca ou filtro, "Mais adiante" já vem aberto: o que sobrou é o que se procurou */
  expandAll?: boolean
}) {
  const navigate = useNavigate()
  const setStage = useSetStage()
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [over, setOver] = useState<TaskStage | null>(null)
  const [askingReference, setAskingReference] = useState<TaskOccurrence | null>(null)
  const [opened, setOpened] = useState<PeriodKey[]>([])

  const draggedItem = dragKey ? items.find((i) => i.kind === 'task' && i.key === dragKey) : undefined
  const dragged = draggedItem?.kind === 'task' ? draggedItem.task : null
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

  const renderTask = (t: TaskOccurrence) => {
    const movable = isMovable(t)
    const mine = t.group?.taskId ? t.group : null
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
        {mine && <span className="kanban-card__goal">{mine.title}</span>}
        {/* O botão cobre o cartão todo (::after); o seletor e o atalho ficam por cima. */}
        <button type="button" className="kanban-card__title kanban-card__open" onClick={() => onOpen(t)} aria-label={mine ? `${mine.title}: ${t.title}` : undefined}>
          {mine ? stepTitle(t) : t.title}
        </button>
        <span className="kanban-card__meta">
          {!mine && <span className="badge">{SOURCE_LABEL[t.source]}</span>}
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

  const renderGroup = (g: TaskGroupItem) => {
    const late = g.tasks.filter((t) => t.stage === 'overdue').length
    return (
      <li key={g.key} className={cx('kanban-card', 'kanban-card--group', g.next === null && 'kanban-card--done')}>
        <span className="kanban-card__meta">
          <GroupBadge group={g} />
          {late > 0 && g.stage === 'overdue' && <span className="kanban-card__late">{late === 1 ? '1 atrasada' : `${late} atrasadas`}</span>}
          {g.openCents !== null && <strong className="tabular">{money(g.openCents)}</strong>}
        </span>
        <button type="button" className="kanban-card__title kanban-card__open kanban-card__group-title" onClick={() => onOpenGroup(g)}>
          {g.title}
        </button>
        <GroupProgressBar group={g} />
        {g.next ? (
          <span className="kanban-card__next">
            <span className="kanban-card__next-label">Próximo</span>
            <span className="kanban-card__next-step">{stepTitle(g.next)}</span>
            <span className={cx(g.next.stage === 'overdue' && 'kanban-card__late')}>{dueLabel(g.next.dueOn, today)}</span>
          </span>
        ) : (
          <span className="kanban-card__auto">
            <Icon name="check" size={14} /> tudo resolvido
          </span>
        )}
      </li>
    )
  }

  const renderItem = (item: TaskItem) => (item.kind === 'group' ? renderGroup(item) : renderTask(item.task))

  /** "A fazer" por distância: os próximos 7 dias abertos, o resto recolhido até pedir. */
  const renderTodo = (list: TaskItem[]) =>
    periodGroups(list, today).flatMap((group) => {
      const collapsible = group.key !== 'week' && !expandAll
      const open = opened.includes(group.key)
      const head = (
        <li key={`group-${group.key}`} className="kanban__group">
          <span>{PERIOD_LABEL[group.key]}</span>
          <span className="tabular">{group.items.length}</span>
        </li>
      )
      if (collapsible && !open)
        return [
          head,
          <li key={`more-${group.key}`} className="kanban__more">
            <Button size="sm" onClick={() => setOpened((keys) => [...keys, group.key])}>
              Mostrar {group.items.length} {PERIOD_MORE[group.key]}
            </Button>
          </li>,
        ]
      return [
        head,
        ...group.items.map(renderItem),
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
          const list = items.filter((i) => i.stage === stage)
          return (
            <section
              key={stage}
              className={cx('kanban__col', `kanban__col--${stage}`, over === stage && 'kanban__col--over', dragged && !canDrop(stage) && 'kanban__col--locked')}
              aria-label={`${STAGE_LABEL[stage]}: ${list.length}`}
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
                <span className="kanban__count tabular">{list.length}</span>
              </header>
              <p className="kanban__hint">{STAGE_HINT[stage]}</p>
              <ul className="kanban__list">
                {stage === 'todo' ? renderTodo(list) : list.map(renderItem)}
                {list.length === 0 && <li className="kanban__empty">{dragged && canDrop(stage) ? 'Solte aqui' : 'Nada aqui'}</li>}
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
