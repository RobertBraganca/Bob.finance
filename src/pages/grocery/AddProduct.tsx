import { useId, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { normalizeName, type GroceryUnit } from '@shared/grocery'
import { api, ApiError } from '../../lib/api'
import { Button, Field, Select, TextInput, useToast } from '../../components/ui'
import { groceryKeys } from './useGrocery'
import type { GroceryProduct } from './types'

/**
 * Campo único para pôr um produto na lista: sugere os do catálogo (datalist)
 * e, se o nome for novo, pede a unidade e cria o produto. Nome repetido, com
 * acento ou caixa diferentes, reaproveita o existente (o servidor também
 * garante isso por `name_key`).
 */
export function AddProduct({
  products,
  excludeIds,
  onAdd,
  label = 'Adicionar produto',
}: {
  products: GroceryProduct[]
  excludeIds: Set<number>
  onAdd: (product: GroceryProduct) => void
  label?: string
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const listId = useId()
  const [name, setName] = useState('')
  const [unit, setUnit] = useState<GroceryUnit>('un')
  const [error, setError] = useState<string | null>(null)

  const byKey = useMemo(() => new Map(products.map((p) => [normalizeName(p.name), p])), [products])
  const match = byKey.get(normalizeName(name)) ?? null
  const suggestions = products.filter((p) => !excludeIds.has(p.id))

  const create = useMutation({
    mutationFn: () => api.post<{ product: GroceryProduct; created: boolean }>('/grocery/products', { name, unit }),
    onSuccess: ({ product }) => {
      void queryClient.invalidateQueries({ queryKey: groceryKeys.products })
      onAdd({ ...product, lastUnitPriceCents: null, lastPurchasedOn: null })
      setName('')
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Não foi possível criar o produto. Confira a conexão e tente de novo.', 'error'),
  })

  const submit = () => {
    if (!normalizeName(name)) {
      setError('Digite o nome do produto.')
      return
    }
    setError(null)
    if (match) {
      if (excludeIds.has(match.id)) {
        setError(`${match.name} já está na lista.`)
        return
      }
      onAdd(match)
      setName('')
      return
    }
    create.mutate()
  }

  return (
    <form
      className="grocery-add"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Field label={label} error={error} hint={match ? `Já cadastrado, em ${match.unit}` : name ? 'Produto novo: escolha a unidade' : undefined}>
        {(id) => (
          <TextInput
            id={id}
            value={name}
            onChange={(v) => {
              setName(v)
              setError(null)
            }}
            placeholder="Leite integral 1L"
            list={listId}
          />
        )}
      </Field>
      <datalist id={listId}>
        {suggestions.map((p) => (
          <option key={p.id} value={p.name} />
        ))}
      </datalist>
      {!match && (
        <Field label="Unidade">
          {(id) => (
            <Select<GroceryUnit>
              id={id}
              value={unit}
              onChange={(v) => v && setUnit(v)}
              options={[
                { value: 'un', label: 'un' },
                { value: 'kg', label: 'kg' },
                { value: 'L', label: 'L' },
              ]}
            />
          )}
        </Field>
      )}
      <Button type="submit" icon="plus" loading={create.isPending}>
        Adicionar
      </Button>
    </form>
  )
}
