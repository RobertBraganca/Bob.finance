import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { centsToInput, parseMoneyInput } from '../../lib/format'
import { todayIso } from '../../lib/period'
import { Button, Field, Modal, Segmented, Select, TextArea, TextInput, useToast } from '../../components/ui'
import { ClientPicker } from '../clients/ClientPicker'
import { MONTH_LABEL, type ManualTask } from './types'

type Kind = ManualTask['kind']
type Recurrence = ManualTask['recurrence']

/**
 * Criar ou editar uma tarefa manual (docs/specs/tarefas-comercial-contador):
 * o que o sistema não enxerga sozinho, como emitir a nota fiscal de um cliente
 * todo mês. Nota fiscal pede o cliente e já sugere o título.
 */
export function TaskFormModal({ task, onClose }: { task?: ManualTask; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<Kind>(task?.kind ?? 'custom')
  const [title, setTitle] = useState(task?.title ?? '')
  const [clientId, setClientId] = useState<number | null>(task?.clientId ?? null)
  const [recurrence, setRecurrence] = useState<Recurrence>(task?.recurrence ?? 'monthly')
  const [dueOn, setDueOn] = useState(task?.dueOn ?? todayIso())
  const [dueDay, setDueDay] = useState(String(task?.dueDay ?? 5))
  const [dueMonth, setDueMonth] = useState<number>(task?.dueMonth ?? 5)
  const [amount, setAmount] = useState(task?.amountCents ? centsToInput(task.amountCents) : '')
  const [notes, setNotes] = useState(task?.notes ?? '')

  const day = Number(dueDay)
  const dayValid = Number.isInteger(day) && day >= 1 && day <= 31
  const amountCents = amount.trim() === '' ? null : parseMoneyInput(amount)
  const canSave = title.trim().length > 0 && (kind !== 'nf' || clientId !== null) && (recurrence === 'once' ? Boolean(dueOn) : dayValid) && amountCents !== undefined && (amount.trim() === '' || amountCents !== null)

  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        kind,
        clientId: kind === 'nf' ? clientId : null,
        recurrence,
        dueOn: recurrence === 'once' ? dueOn : null,
        dueDay: recurrence === 'once' ? null : day,
        dueMonth: recurrence === 'yearly' ? dueMonth : null,
        amountCents: amountCents === null ? null : Math.abs(amountCents),
        notes: notes.trim() || null,
      }
      return task ? api.patch(`/tasks/${task.id}`, body) : api.post('/tasks', body)
    },
    onSuccess: () => {
      toast(task ? 'Tarefa atualizada' : 'Tarefa criada')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar a tarefa', 'error'),
  })

  return (
    <Modal
      title={task ? 'Editar tarefa' : 'Nova tarefa'}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={!canSave} loading={save.isPending}>
            {task ? 'Salvar tarefa' : 'Criar tarefa'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <span className="field__label">Tipo</span>
          <Segmented
            ariaLabel="Tipo de tarefa"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'nf', label: 'Emitir nota fiscal' },
              { value: 'custom', label: 'Outra' },
            ]}
          />
        </div>
        {kind === 'nf' && (
          <Field label="Cliente">
            {(id) => (
              <ClientPicker
                id={id}
                value={clientId}
                onChange={(client) => {
                  setClientId(client?.id ?? null)
                  if (client && (!title.trim() || title.startsWith('Emitir NF de '))) setTitle(`Emitir NF de ${client.name}`)
                }}
              />
            )}
          </Field>
        )}
        <Field label="Título">{(id) => <TextInput id={id} value={title} onChange={setTitle} placeholder={kind === 'nf' ? 'Emitir NF de...' : 'ex. Enviar o extrato ao contador'} />}</Field>
        <div className="field">
          <span className="field__label">Repetição</span>
          <Segmented
            ariaLabel="Repetição"
            value={recurrence}
            onChange={setRecurrence}
            options={[
              { value: 'once', label: 'Uma vez' },
              { value: 'monthly', label: 'Todo mês' },
              { value: 'yearly', label: 'Todo ano' },
            ]}
          />
        </div>
        {recurrence === 'once' ? (
          <Field label="Data">{(id) => <TextInput id={id} type="date" value={dueOn} onChange={setDueOn} />}</Field>
        ) : (
          <div className="form-grid">
            <Field label="Dia do vencimento" error={dueDay.trim() && !dayValid ? 'Um dia de 1 a 31.' : null} hint="Em mês mais curto, vale o último dia.">
              {(id) => <TextInput id={id} value={dueDay} onChange={setDueDay} numeral />}
            </Field>
            {recurrence === 'yearly' && (
              <Field label="Mês">
                {(id) => (
                  <Select id={id} value={dueMonth} onChange={(m) => m && setDueMonth(m)} options={MONTH_LABEL.map((label, i) => ({ value: i + 1, label }))} />
                )}
              </Field>
            )}
          </div>
        )}
        <Field label="Valor (R$)" hint="Opcional: o valor da nota ou do pagamento, para lembrar.">
          {(id) => <TextInput id={id} value={amount} onChange={setAmount} placeholder="0,00" numeral />}
        </Field>
        <Field label="Observação">{(id) => <TextArea id={id} value={notes} onChange={setNotes} rows={2} />}</Field>
      </div>
    </Modal>
  )
}
