import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAccounts } from '../../lib/store'
import { todayIso } from '../../lib/period'
import { date as fmtDate, money } from '../../lib/format'
import { splitProposalInstallments } from '@shared/proposals'
import { Button, Modal, Select, TextInput, useToast } from '../../components/ui'
import type { ProposalDetail } from './types'

/**
 * Aprovar (decisions/0040): conta, primeiro vencimento e parcelas. Gera uma
 * receita por parcela, mês a mês, pendentes; a primeira só entra como já
 * recebida se marcado. Quando o pagamento chega pelo extrato, a importação
 * liga sozinha à parcela.
 */
export function ApproveProposalModal({
  proposal,
  onClose,
  onApproved,
}: {
  proposal: ProposalDetail
  onClose: () => void
  onApproved?: (detail: ProposalDetail) => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()
  const [accountId, setAccountId] = useState<number | null>(null)
  const [firstDueOn, setFirstDueOn] = useState(todayIso)
  const [installments, setInstallments] = useState(String(proposal.installments))
  const [firstReceived, setFirstReceived] = useState(false)
  const accountFieldId = useId()
  const dateFieldId = useId()
  const installmentsFieldId = useId()

  const count = Math.max(1, Math.min(60, Math.floor(Number(installments) || 1)))
  const parts = splitProposalInstallments(proposal.totalCents, count)
  const accountOptions = (accounts.data?.accounts ?? [])
    .filter((a) => a.kind !== 'investment')
    .map((a) => ({ value: a.id, label: a.name }))

  const approve = useMutation({
    mutationFn: () =>
      api.post<ProposalDetail>(`/pricing/proposals/${proposal.id}/approve`, {
        accountId,
        firstDueOn,
        installments: count,
        firstAlreadyReceived: firstReceived,
      }),
    onSuccess: (detail) => {
      toast(`Orçamento aprovado: ${count === 1 ? '1 receita a receber' : `${count} receitas a receber`}`)
      queryClient.invalidateQueries()
      onApproved?.(detail)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao aprovar', 'error'),
  })

  return (
    <Modal
      title={`Aprovar ${proposal.numberLabel}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => approve.mutate()} disabled={!accountId} loading={approve.isPending}>
            Aprovar e gerar receitas
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor={accountFieldId}>
            Conta que recebe
          </label>
          <Select id={accountFieldId} value={accountId} placeholder="Selecione" options={accountOptions} onChange={setAccountId} />
        </div>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: '1 1 160px' }}>
            <label className="field__label" htmlFor={dateFieldId}>
              Primeiro vencimento
            </label>
            <TextInput id={dateFieldId} value={firstDueOn} onChange={setFirstDueOn} type="date" />
          </div>
          <div className="field" style={{ flex: '1 1 120px' }}>
            <label className="field__label" htmlFor={installmentsFieldId}>
              Parcelas
            </label>
            <TextInput id={installmentsFieldId} value={installments} onChange={setInstallments} numeral />
          </div>
        </div>
        <label className="row" style={{ gap: 'var(--sp-2)', cursor: 'pointer' }}>
          <input type="checkbox" className="checkbox" checked={firstReceived} onChange={(event) => setFirstReceived(event.target.checked)} />
          <span style={{ fontSize: 'var(--text-sm)' }}>A primeira parcela já foi recebida</span>
        </label>
        <div className="row row--between" style={{ padding: 'var(--sp-3) var(--sp-4)', background: 'var(--surface-muted)', borderRadius: 'var(--r-sm)' }}>
          <span style={{ fontSize: 'var(--text-sm)' }}>
            {count === 1 ? '1 receita' : `${count} receitas`} de {money(parts[0]!)}
            {parts.length > 1 && parts[parts.length - 1] !== parts[0] ? ` (a última, ${money(parts[parts.length - 1]!)})` : ''}, a
            partir de {fmtDate(firstDueOn)}
          </span>
          <strong className="tabular">{money(proposal.totalCents)}</strong>
        </div>
        <p className="chart__note" style={{ margin: 0 }}>
          {firstReceived
            ? 'A primeira entra como recebida; as outras ficam a receber, no Painel e na conciliação com o extrato.'
            : 'Todas ficam a receber, no Painel e na conciliação com o extrato. Quando o pagamento chega pelo Open Finance ou CSV, a parcela é baixada sozinha.'}
        </p>
      </div>
    </Modal>
  )
}
