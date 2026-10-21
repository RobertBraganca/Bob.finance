import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { date as fmtDate, money } from '../../lib/format'
import { Button, EmptyState, Icon, Modal, SkeletonLines, TextInput, useToast } from '../../components/ui'
import { REVENUE_VIA_LABEL, type TransactionCandidate } from './types'

/**
 * Escolher à mão os lançamentos do extrato que são deste cliente
 * (specs/clientes-e-negocios). Vale mais que o orçamento de origem e que o nome
 * do pagador. Um lançamento já escolhido para outro cliente fica travado:
 * desliga-se lá antes. Os que contam para outro cliente só pelo nome ou pelo
 * documento podem ser escolhidos aqui, e a tela avisa que mudam de cliente.
 */
export function TransactionPickerModal({ clientId, clientName, onClose }: { clientId: number; clientName: string; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [picked, setPicked] = useState<Map<number, TransactionCandidate>>(new Map())
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 300)
    return () => window.clearTimeout(t)
  }, [search])

  const candidates = useQuery({
    queryKey: ['client', clientId, 'transaction-candidates', debounced],
    queryFn: () =>
      api.get<{ transactions: TransactionCandidate[] }>(`/pricing/clients/${clientId}/transaction-candidates`, { q: debounced || undefined }),
    placeholderData: (previous) => previous,
  })

  const link = useMutation({
    mutationFn: () => api.post<{ linked: number; alreadyLinked: number }>(`/pricing/clients/${clientId}/transactions`, { transactionIds: [...picked.keys()] }),
    onSuccess: ({ linked }) => {
      toast(linked === 1 ? '1 lançamento ligado ao cliente' : `${linked} lançamentos ligados ao cliente`)
      queryClient.invalidateQueries({ queryKey: ['client'] })
      queryClient.invalidateQueries({ queryKey: ['clients'] })
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao ligar os lançamentos', 'error'),
  })

  const toggle = (t: TransactionCandidate) =>
    setPicked((current) => {
      const next = new Map(current)
      if (next.has(t.id)) next.delete(t.id)
      else next.set(t.id, t)
      return next
    })

  const rows = candidates.data?.transactions ?? []
  const pickedCents = [...picked.values()].reduce((sum, t) => sum + t.amountCents, 0)
  const moving = [...picked.values()].filter((t) => t.linkedTo && t.linkedTo.clientId !== clientId).length

  return (
    <Modal
      title={`Escolher lançamentos de ${clientName}`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            {picked.size === 0 ? 'Nenhum escolhido' : `${picked.size} escolhido${picked.size === 1 ? '' : 's'} · ${money(pickedCents)}`}
          </span>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" onClick={onClose} disabled={link.isPending}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" onClick={() => link.mutate()} disabled={picked.size === 0} loading={link.isPending}>
              {picked.size <= 1 ? 'Ligar lançamento' : `Ligar ${picked.size} lançamentos`}
            </Button>
          </span>
        </>
      }
    >
      <div className="stack">
        <div className="search-field">
          <Icon name="search" size={15} />
          <TextInput value={search} onChange={setSearch} placeholder="Busque pela descrição do extrato (ex. opus, pix recebido)" ariaLabel="Buscar lançamentos" autoFocus />
        </div>
        <p className="chart__note" style={{ margin: 0 }}>
          Entradas do extrato, das mais recentes. O lançamento escolhido passa a contar para este cliente no LTV e no MRR, acima do nome do pagador e do orçamento.
          {moving > 0 && ` ${moving === 1 ? '1 escolhido conta hoje para outro cliente e muda para este' : `${moving} escolhidos contam hoje para outro cliente e mudam para este`}.`}
        </p>
        {candidates.isError ? (
          <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar os lançamentos agora. Tente de novo em instantes." />
        ) : !candidates.data ? (
          <SkeletonLines lines={6} />
        ) : rows.length === 0 ? (
          <EmptyState icon="search" title="Nenhuma entrada encontrada" body="Tente outra palavra da descrição do extrato." />
        ) : (
          <ul className="txn-pick">
            {rows.map((t) => {
              const mine = t.linkedTo?.clientId === clientId
              const lockedElsewhere = t.linkedTo !== null && !mine && t.linkedTo.via === 'manual'
              const alreadyChosen = mine && t.linkedTo?.via === 'manual'
              const disabled = lockedElsewhere || alreadyChosen
              const checked = alreadyChosen || picked.has(t.id)
              const note = !t.linkedTo
                ? null
                : mine
                  ? alreadyChosen
                    ? 'já escolhido para este cliente'
                    : `já conta para este cliente pelo ${REVENUE_VIA_LABEL[t.linkedTo.via]}`
                  : lockedElsewhere
                    ? `escolhido para ${t.linkedTo.clientName}: desligue lá antes`
                    : `conta hoje para ${t.linkedTo.clientName} pelo ${REVENUE_VIA_LABEL[t.linkedTo.via]}`
              return (
                <li key={t.id}>
                  <label className={`txn-pick__row${disabled ? ' txn-pick__row--disabled' : ''}`}>
                    <input type="checkbox" className="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(t)} />
                    <span className="txn-pick__body">
                      <span className="txn-pick__desc">{t.description}</span>
                      <span className="muted txn-pick__meta">
                        {fmtDate(t.postedOn)}
                        {t.accountName ? ` · ${t.accountName}` : ''}
                        {t.categoryName ? ` · ${t.categoryName}` : ''}
                        {t.pending ? ' · a receber' : ''}
                      </span>
                      {note && <span className={`txn-pick__note${!mine && t.linkedTo ? ' txn-pick__note--warn' : ''}`}>{note}</span>}
                    </span>
                    <strong className="tabular pos">{money(t.amountCents)}</strong>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
