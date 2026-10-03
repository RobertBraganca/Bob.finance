import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAccounts } from '../lib/store'
import { date as fmtDate } from '../lib/format'
import { Button, Card, ConfirmDeleteModal, EmptyState, Icon, Modal, Select, TextInput, useToast } from '../components/ui'

type Connection = {
  id: number
  accountId: number
  accountName: string
  providerItemId: string
  providerAccountLabel: string
  syncFrom: string
  lastSyncedAt: string | null
  lastSyncCount: number | null
  lastError: string | null
}

type PendingBatch = { id: number; accountId: number; filename: string; rowCount: number }

type Discovered = {
  providerAccountId: string
  label: string
  kind: 'checking' | 'credit_card'
  linkedAccountId: number | null
}

type SyncResult = { batchId: number | null; staged: number; alreadyKnown: number; pendingSkipped: number }

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * Open Finance via Meu Pluggy (decisions/0038). Sincronizar só monta um lote
 * na fila de revisão de Importar; o ledger muda quando você confirma lá,
 * exatamente como num CSV.
 */
export function OpenFinanceCard() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [connecting, setConnecting] = useState(false)
  const [removing, setRemoving] = useState<Connection | null>(null)
  const [syncingId, setSyncingId] = useState<number | null>(null)

  const data = useQuery({
    queryKey: ['bank-connections'],
    queryFn: () => api.get<{ connections: Connection[]; pendingBatches: PendingBatch[] }>('/bank-connections'),
  })

  const sync = useMutation({
    mutationFn: (id: number) => api.post<SyncResult>(`/bank-connections/${id}/sync`),
    onMutate: (id) => setSyncingId(id),
    onSettled: () => {
      setSyncingId(null)
      queryClient.invalidateQueries({ queryKey: ['bank-connections'] })
      queryClient.invalidateQueries({ queryKey: ['imports'] })
    },
    onSuccess: (result) =>
      toast(
        result.staged === 0
          ? 'Nada novo desde a última sincronização'
          : `${result.staged} ${result.staged === 1 ? 'lançamento foi' : 'lançamentos foram'} para a revisão`,
      ),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao sincronizar', 'error'),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/bank-connections/${id}`),
    onSuccess: () => {
      setRemoving(null)
      toast('Conta desconectada; ela volta a receber só CSV')
      queryClient.invalidateQueries({ queryKey: ['bank-connections'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao desconectar', 'error'),
  })

  const connections = data.data?.connections ?? []
  const pending = data.data?.pendingBatches ?? []

  return (
    <Card
      span={12}
      flush
      title="Open Finance"
      subtitle="Meu Pluggy. A sincronização manda os lançamentos para a revisão em Importar; nada entra direto no ledger."
      actions={
        <Button icon="plus" onClick={() => setConnecting(true)}>
          Conectar conta
        </Button>
      }
    >
      {pending.length > 0 && (
        <div className="stack stack--tight" style={{ padding: '0 var(--sp-5) var(--sp-4)' }}>
          {pending.map((batch) => (
            <div key={batch.id} className="row row--between row--wrap" style={{ gap: 'var(--sp-2)' }}>
              <span className="row" style={{ gap: 'var(--sp-2)', minWidth: 0 }}>
                <Icon name="clock" size={14} />
                <span style={{ minWidth: 0, fontSize: 'var(--text-sm)' }}>
                  {batch.rowCount} esperando revisão · {batch.filename}
                </span>
              </span>
              <Link to={`/importar?lote=${batch.id}`} className="btn btn--primary btn--sm">
                Revisar
              </Link>
            </div>
          ))}
        </div>
      )}

      {data.isError ? (
        <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar as conexões agora. Tente novamente em instantes." />
      ) : !data.data ? (
        <EmptyState title="Carregando…" />
      ) : connections.length === 0 ? (
        <EmptyState
          icon="bank"
          title="Nenhuma conta conectada"
          body="Conecte seus bancos no Meu Pluggy, ligue a aplicação no painel da Pluggy e cole aqui o ID de cada conexão."
        />
      ) : (
        <div className="table-wrap">
          <table className="table table--stack-mobile">
            <thead>
              <tr>
                <th scope="col">Conta no app</th>
                <th scope="col">Conta no banco</th>
                <th scope="col">Lê desde</th>
                <th scope="col">Última sincronização</th>
                <th scope="col" style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.id}>
                  <td data-label="Conta no app">
                    <strong>{c.accountName}</strong>
                  </td>
                  <td data-label="Conta no banco" className="muted">
                    {c.providerAccountLabel}
                  </td>
                  <td data-label="Lê desde" className="tabular">
                    {fmtDate(c.syncFrom)}
                  </td>
                  <td data-label="Última sincronização">
                    {c.lastSyncedAt ? (
                      <span>
                        {dateTime(c.lastSyncedAt)}
                        <span className="muted">
                          {' '}
                          · {c.lastSyncCount ?? 0} {c.lastSyncCount === 1 ? 'novo' : 'novos'}
                        </span>
                      </span>
                    ) : (
                      <span className="muted">nunca</span>
                    )}
                    {c.lastError && (
                      <span className="neg" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                        {c.lastError}
                      </span>
                    )}
                  </td>
                  <td data-label="__trail">
                    <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <Button
                        size="sm"
                        icon="refresh"
                        onClick={() => sync.mutate(c.id)}
                        disabled={sync.isPending}
                        loading={syncingId === c.id}
                      >
                        Sincronizar
                      </Button>
                      <Button variant="quiet" size="sm" icon="trash" title="Desconectar" onClick={() => setRemoving(c)} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {connecting && <ConnectModal onClose={() => setConnecting(false)} />}
      {removing && (
        <ConfirmDeleteModal
          title={`Desconectar ${removing.providerAccountLabel}?`}
          body={`${removing.accountName} para de sincronizar e volta a receber só CSV. Os lançamentos que já entraram ficam no ledger, e a conexão no Meu Pluggy não é apagada.`}
          confirmLabel="Desconectar"
          pending={remove.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.id)}
        />
      )}
    </Card>
  )
}

function ConnectModal({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()
  const itemFieldId = useId()
  const [itemId, setItemId] = useState('')
  const [found, setFound] = useState<Discovered[] | null>(null)
  const [choice, setChoice] = useState<Record<string, number | null>>({})

  const appAccounts = (accounts.data?.accounts ?? []).filter((a) => a.kind !== 'investment')
  const nameOf = (id: number) => accounts.data?.accounts.find((a) => a.id === id)?.name ?? `conta ${id}`

  const discover = useMutation({
    mutationFn: () =>
      api.get<{ accounts: Discovered[] }>('/bank-connections/discover', { itemId: itemId.trim() }),
    onSuccess: (result) => setFound(result.accounts),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao buscar', 'error'),
  })

  const link = useMutation({
    mutationFn: (input: { providerAccountId: string; accountId: number }) =>
      api.post('/bank-connections', { providerItemId: itemId.trim(), ...input }),
    onSuccess: (_result, input) => {
      toast(`Ligada a ${nameOf(input.accountId)}`)
      setFound((prev) =>
        prev?.map((f) => (f.providerAccountId === input.providerAccountId ? { ...f, linkedAccountId: input.accountId } : f)) ??
        null,
      )
      queryClient.invalidateQueries({ queryKey: ['bank-connections'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao ligar', 'error'),
  })

  const validId = /^[0-9a-f-]{36}$/i.test(itemId.trim())

  return (
    <Modal
      title="Conectar conta do Meu Pluggy"
      onClose={onClose}
      footer={
        <>
          <span />
          <Button variant="quiet" onClick={onClose}>
            Fechar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor={itemFieldId}>
            ID da conexão
          </label>
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TextInput
                id={itemFieldId}
                value={itemId}
                onChange={(v) => {
                  setItemId(v)
                  setFound(null)
                }}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </div>
            <Button onClick={() => discover.mutate()} disabled={!validId} loading={discover.isPending} icon="search">
              Buscar contas
            </Button>
          </div>
          <p className="field__hint">Fica no painel da Pluggy, na aplicação de demonstração: um ID por banco conectado.</p>
        </div>

        {found && found.length === 0 && <p className="muted">Essa conexão não tem contas.</p>}

        {found?.map((f) => (
          <div key={f.providerAccountId} className="row row--between row--wrap" style={{ gap: 'var(--sp-2) var(--sp-3)' }}>
            <span style={{ minWidth: 0 }}>
              <strong style={{ fontSize: 'var(--text-sm)' }}>{f.label}</strong>
            </span>
            {f.kind === 'credit_card' ? (
              <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                cartões entram numa fase seguinte
              </span>
            ) : f.linkedAccountId !== null ? (
              <span className="badge badge--good">
                <Icon name="check" size={11} strokeWidth={2.4} />
                ligada a {nameOf(f.linkedAccountId)}
              </span>
            ) : (
              <span className="row" style={{ gap: 'var(--sp-2)' }}>
                <div style={{ minWidth: 160 }}>
                  <Select
                    value={choice[f.providerAccountId] ?? null}
                    placeholder="Conta do app"
                    options={appAccounts.map((a) => ({ value: a.id, label: a.name }))}
                    onChange={(accountId) => setChoice((prev) => ({ ...prev, [f.providerAccountId]: accountId }))}
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!choice[f.providerAccountId]}
                  loading={link.isPending && link.variables?.providerAccountId === f.providerAccountId}
                  onClick={() => link.mutate({ providerAccountId: f.providerAccountId, accountId: choice[f.providerAccountId]! })}
                >
                  Ligar
                </Button>
              </span>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}
