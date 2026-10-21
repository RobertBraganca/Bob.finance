import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button, Select } from '../../components/ui'
import { ClientFormModal } from './ClientFormModal'
import { CLIENT_KIND_LABEL, type ClientRecord, type ClientsResponse } from './types'

/** Os clientes que dá para escolher num documento (arquivados ficam fora, como na lista). */
export function useClientOptions() {
  return useQuery({
    queryKey: ['clients', 'options'],
    queryFn: () => api.get<ClientsResponse>('/pricing/clients'),
    staleTime: 60_000,
  })
}

/**
 * Escolher o cliente da lista ao montar uma cotação ou um orçamento
 * (docs/specs/clientes-e-negocios, fase 2), com "Novo cliente" na hora. O
 * nome escrito no documento continua sendo um campo à parte: quem chama decide
 * se preenche com o nome do cliente escolhido.
 */
export function ClientPicker({
  id,
  value,
  onChange,
  suggestedName,
}: {
  id?: string
  value: number | null
  /** devolve o cliente escolhido (ou null ao desligar) */
  onChange: (client: ClientRecord | null) => void
  /** nome já digitado no documento, para abrir "Novo cliente" com ele */
  suggestedName?: string
}) {
  const clients = useClientOptions()
  const [creating, setCreating] = useState(false)
  const list = clients.data?.clients ?? []
  const options = [
    { value: 0, label: 'Sem cliente da lista' },
    ...list.map((c) => ({ value: c.id, label: c.kind === 'lead' ? `${c.name} (${CLIENT_KIND_LABEL.lead})` : c.name })),
  ]

  return (
    <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'stretch' }}>
      <div className="grow" style={{ minWidth: 0 }}>
        <Select
          id={id}
          value={value ?? 0}
          options={options}
          placeholder={clients.isPending ? 'Carregando clientes…' : 'Escolha o cliente'}
          onChange={(next) => {
            if (!next) return onChange(null)
            onChange(list.find((c) => c.id === next) ?? null)
          }}
        />
      </div>
      <Button icon="plus" onClick={() => setCreating(true)} title="Cadastrar um cliente novo">
        Novo
      </Button>
      {creating && (
        <ClientFormModal
          initialName={suggestedName}
          onClose={() => setCreating(false)}
          onSaved={(client) => onChange(client)}
        />
      )}
    </div>
  )
}
