import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button, Card, Select, useToast } from '../../components/ui'
import type { BudgetCategory, BudgetSettings } from './types'

/** Escolha de uma TAG: herdar (nulo), um grupo, ou fora do orçamento. */
type Choice = 'inherit' | 'excluded' | number

const choiceOf = (c: { budgetGroupId: number | null; budgetExcluded: boolean }): Choice =>
  c.budgetGroupId !== null ? c.budgetGroupId : c.budgetExcluded ? 'excluded' : 'inherit'
const suggestionOf = (c: BudgetCategory): Choice | null =>
  c.suggestedGroupId !== null ? c.suggestedGroupId : c.suggestedExcluded ? 'excluded' : null

/**
 * TAGs dos grupos: cada TAG de despesa escolhe o grupo, e a sub-TAG herda o
 * da mãe se não tiver um próprio. Na primeira vez (nenhuma TAG ligada) a
 * lista chega com a proposta pelos nomes, marcada "sugerido"; nada grava
 * até Salvar.
 */
export function CategoryGroupsPanel({ settings }: { settings: BudgetSettings }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const groups = settings.groups.filter((g) => !g.archived && g.source === 'categories')
  const groupName = new Map(settings.groups.map((g) => [g.id, g.name]))
  const firstTime = settings.categories.every((c) => c.budgetGroupId === null && !c.budgetExcluded)

  const initial = useMemo(
    () => new Map(settings.categories.map((c) => [c.id, firstTime ? suggestionOf(c) ?? 'inherit' : choiceOf(c)] as [number, Choice])),
    [settings.categories, firstTime],
  )
  const [choices, setChoices] = useState(initial)
  const saved = useMemo(() => new Map(settings.categories.map((c) => [c.id, choiceOf(c)] as [number, Choice])), [settings.categories])
  const changed = settings.categories.filter((c) => choices.get(c.id) !== saved.get(c.id))

  const parents = settings.categories.filter((c) => c.parentId === null)
  const childrenOf = (id: number) => settings.categories.filter((c) => c.parentId === id)
  const byId = new Map(settings.categories.map((c) => [c.id, c]))

  /** O grupo que a TAG teria com as escolhas da tela (para mostrar o "herda de"). */
  const effective = (id: number): Choice | null => {
    let current = byId.get(id)
    const seen = new Set<number>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      const choice = choices.get(current.id) ?? 'inherit'
      if (choice !== 'inherit') return choice
      current = current.parentId === null ? undefined : byId.get(current.parentId)
    }
    return null
  }
  const ungroupedCount = settings.categories.filter((c) => effective(c.id) === null).length

  const applySuggestions = () =>
    setChoices((current) => {
      const next = new Map(current)
      for (const c of settings.categories) {
        const s = suggestionOf(c)
        if (s !== null && (next.get(c.id) ?? 'inherit') === 'inherit') next.set(c.id, s)
      }
      return next
    })

  const save = useMutation({
    mutationFn: () =>
      api.put('/budget/categories', {
        items: changed.map((c) => {
          const choice = choices.get(c.id) ?? 'inherit'
          return { categoryId: c.id, budgetGroupId: typeof choice === 'number' ? choice : null, budgetExcluded: choice === 'excluded' }
        }),
      }),
    onSuccess: () => {
      toast('TAGs dos grupos salvas')
      queryClient.invalidateQueries({ queryKey: ['budget'] })
      queryClient.invalidateQueries({ queryKey: ['budget-settings'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const options = (isChild: boolean) => [
    { value: 'inherit', label: isChild ? 'Herdar da mãe' : 'Sem grupo' },
    ...groups.map((g) => ({ value: String(g.id), label: g.name })),
    { value: 'excluded', label: 'Fora do orçamento' },
  ]

  const row = (c: BudgetCategory, isChild: boolean) => {
    const choice = choices.get(c.id) ?? 'inherit'
    const suggestion = suggestionOf(c)
    const isSuggested = suggestion !== null && choice === suggestion && saved.get(c.id) !== choice
    const inherited = choice === 'inherit' && isChild ? effective(c.id) : null
    return (
      <li key={c.id} className={`tag-group-row${isChild ? ' tag-group-row--child' : ''}`}>
        <span className="tag-group-row__name">
          {c.name}
          {isSuggested && <span className="badge badge--info">sugerido</span>}
        </span>
        <span className="tag-group-row__select">
          <Select
            value={String(choice)}
            options={options(isChild)}
            onChange={(value) =>
              setChoices((current) => new Map(current).set(c.id, value === null || value === 'inherit' ? 'inherit' : value === 'excluded' ? 'excluded' : Number(value)))
            }
          />
          {inherited !== null && (
            <span className="field__hint">
              {inherited === 'excluded' ? 'fora do orçamento, pela mãe' : `${groupName.get(inherited as number) ?? ''}, pela mãe`}
            </span>
          )}
        </span>
      </li>
    )
  }

  return (
    <Card
      title="TAGs dos grupos"
      subtitle="Cada TAG de despesa pertence a um grupo; a sub-TAG herda o da mãe. Vale também para os meses passados."
      actions={
        <Button size="sm" variant="quiet" icon="sparkle" onClick={applySuggestions}>
          Aplicar sugestões
        </Button>
      }
    >
      <div className="stack">
        {firstTime && (
          <p className="plan-evidence">
            Proposta inicial pelos nomes das suas TAGs, marcada como "sugerido". Revise e salve; nada é gravado antes disso. Grupos de
            aporte (Metas e Liberdade Financeira) não aparecem aqui: eles medem compras de ativos.
          </p>
        )}
        <ul className="tag-group-list">
          {parents.map((p) => (
            <li key={p.id} className="tag-group-family">
              <ul className="tag-group-list">
                {row(p, false)}
                {childrenOf(p.id).map((child) => row(child, true))}
              </ul>
            </li>
          ))}
        </ul>
        <div className="row row--between row--wrap" style={{ gap: 'var(--sp-2)' }}>
          <span className="field__hint">
            {ungroupedCount === 0 ? 'Todas as TAGs têm grupo.' : `${ungroupedCount} ${ungroupedCount === 1 ? 'TAG fica' : 'TAGs ficam'} em "Sem grupo".`}
          </span>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            {changed.length > 0 && (
              <Button variant="quiet" onClick={() => setChoices(saved)}>
                Desfazer
              </Button>
            )}
            <Button variant="primary" icon="check" disabled={changed.length === 0} loading={save.isPending} onClick={() => save.mutate()}>
              {changed.length > 0 ? `Salvar ${changed.length} ${changed.length === 1 ? 'TAG' : 'TAGs'}` : 'Salvar'}
            </Button>
          </span>
        </div>
      </div>
    </Card>
  )
}
