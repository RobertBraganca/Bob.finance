import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { date, money } from '../../lib/format'
import { Button, EmptyState, Modal, SkeletonLines, useToast } from '../../components/ui'
import type { LinkCandidate } from './types'

/**
 * Liga a compra ao lançamento real de mercado (Open Finance). A compra nunca
 * cria lançamento: aqui só se escolhe qual dos que já chegaram é ela. A
 * diferença mostra o que o caixa cobrou além (ou aquém) do que a lista somou.
 */
export function LinkModal({ tripId, title = 'Vincular ao lançamento', onClose, onDone }: { tripId: number; title?: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [chosen, setChosen] = useState<number | null>(null)
  const candidates = useQuery({
    queryKey: ['grocery', 'link-candidates', tripId],
    queryFn: () => api.get<{ candidates: LinkCandidate[] }>(`/grocery/trips/${tripId}/link-candidates`).then((r) => r.candidates),
  })
  const selected = chosen ?? candidates.data?.[0]?.id ?? null

  const link = useMutation({
    mutationFn: (transactionId: number) => api.post(`/grocery/trips/${tripId}/link`, { transactionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['grocery'] })
      void queryClient.invalidateQueries({ queryKey: ['grocery-analytics'] })
      void queryClient.invalidateQueries({ queryKey: ['grocery-budget'] })
      toast('Compra vinculada ao lançamento')
      onDone()
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Não foi possível vincular. Tente de novo.', 'error'),
  })

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Vincular depois
          </Button>
          <Button variant="primary" icon="link" disabled={selected === null} loading={link.isPending} onClick={() => selected !== null && link.mutate(selected)}>
            Vincular
          </Button>
        </>
      }
    >
      {candidates.isLoading ? (
        <SkeletonLines lines={3} />
      ) : !candidates.data || candidates.data.length === 0 ? (
        <EmptyState
          icon="clock"
          title="O lançamento ainda não chegou"
          body="O Open Finance pode levar alguns dias. A compra fica salva sem vínculo e aparece na aba Análise para vincular depois."
        />
      ) : (
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="muted" style={{ marginBottom: 'var(--sp-2)' }}>
            Lançamentos de mercado de 1 dia antes a 5 dias depois da compra
          </legend>
          <ul className="grocery-candidates">
            {candidates.data.map((c) => (
              <li key={c.id}>
                <label className="grocery-candidate">
                  <input type="radio" name="grocery-link" checked={selected === c.id} onChange={() => setChosen(c.id)} />
                  <span className="stack stack--tight" style={{ flex: 1, minWidth: 0 }}>
                    <span className="truncate">{c.description}</span>
                    <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                      {date(c.postedOn)} · {c.differenceCents === 0 ? 'mesmo valor da lista' : `${money(Math.abs(c.differenceCents))} ${c.differenceCents > 0 ? 'a mais' : 'a menos'} que a lista`}
                    </span>
                  </span>
                  <strong className="numeral">{money(Math.abs(c.amountCents))}</strong>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </Modal>
  )
}
