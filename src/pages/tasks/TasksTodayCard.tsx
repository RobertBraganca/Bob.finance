import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Card, Icon, LoadError, SkeletonLines } from '../../components/ui'
import { TaskList } from './TaskList'
import type { TasksResponse } from './types'

/** Card da Visão geral: as atrasadas e as de hoje primeiro, até cinco, com o atalho para Tarefas. */
export function TasksTodayCard({ span = 6 }: { span?: 6 | 12 }) {
  const list = useQuery({ queryKey: ['tasks', 'list'], queryFn: () => api.get<TasksResponse>('/tasks') })
  const data = list.data
  const open = (data?.tasks ?? []).filter((t) => !t.done)
  const s = data?.summary

  return (
    <Card
      span={span}
      title="Tarefas"
      subtitle={
        s
          ? [s.overdue > 0 ? `${s.overdue} atrasada${s.overdue === 1 ? '' : 's'}` : null, `${s.today} para hoje`, `${s.week} nos próximos 7 dias`]
              .filter(Boolean)
              .join(' · ')
          : 'O que vence: contas, notas, DAS, faturas e aportes'
      }
      actions={
        <Link to="/tarefas" className="row" style={{ gap: 'var(--sp-1)', fontSize: 'var(--text-sm)' }}>
          Ver todas <Icon name="arrowRight" size={14} />
        </Link>
      }
    >
      {list.isError ? (
        <LoadError onRetry={() => list.refetch()} retrying={list.isFetching} />
      ) : !data ? (
        <SkeletonLines lines={4} />
      ) : open.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>Nada vencendo nos próximos 30 dias.</p>
      ) : (
        <TaskList tasks={open.slice(0, 5)} today={data.window.today} compact />
      )}
    </Card>
  )
}
