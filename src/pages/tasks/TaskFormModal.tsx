import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { centsToInput, parseMoneyInput } from '../../lib/format'
import { todayIso } from '../../lib/period'
import { Button, Field, Modal, Segmented, Select, TextArea, TextInput, useToast } from '../../components/ui'
import { ClientPicker } from '../clients/ClientPicker'
import { MONTH_LABEL, WEEKDAY_LABEL, type ManualTask } from './types'

type Kind = ManualTask['kind']
type Recurrence = ManualTask['recurrence']
const NO_PARENT = 0

/**
 * Criar ou editar uma tarefa manual (docs/specs/tarefas-comercial-contador):
 * o que o sistema não enxerga sozinho, como emitir a nota fiscal de um cliente
 * todo mês. Nota fiscal pede o cliente e já sugere o título.
 *
 * "Tarefa principal" só junta subtarefas (ex.: "Dentista", com "marcar a
 * consulta" e "ir à consulta" dentro): não tem data nem valor. Uma tarefa
 * comum pode ficar dentro de uma principal pelo campo "Dentro de".
 */
export function TaskFormModal({
  task,
  groups,
  parentId: initialParentId,
  onClose,
}: {
  task?: ManualTask
  /** as suas tarefas principais, para o campo "Dentro de" */
  groups: Array<{ id: number; title: string }>
  /** nova subtarefa de uma principal já escolhida */
  parentId?: number | null
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<Kind>(task?.kind ?? 'custom')
  const [parentId, setParentId] = useState<number>(task?.parentId ?? initialParentId ?? NO_PARENT)
  const [title, setTitle] = useState(task?.title ?? '')
  const [clientId, setClientId] = useState<number | null>(task?.clientId ?? null)
  const [recurrence, setRecurrence] = useState<Recurrence>(task?.recurrence ?? (initialParentId ? 'once' : 'monthly'))
  const [dueOn, setDueOn] = useState(task?.dueOn ?? todayIso())
  const [dueDay, setDueDay] = useState(String(task?.dueDay ?? 5))
  const [weekday, setWeekday] = useState<number>(task?.recurrence === 'weekly' ? (task.dueDay ?? 5) : 5)
  const [dueMonth, setDueMonth] = useState<number>(task?.dueMonth ?? 5)
  const [endsOn, setEndsOn] = useState(task?.endsOn ?? '')
  const [amount, setAmount] = useState(task?.amountCents ? centsToInput(task.amountCents) : '')
  const [notes, setNotes] = useState(task?.notes ?? '')

  const group = kind === 'group'
  const day = Number(dueDay)
  const dayValid = Number.isInteger(day) && day >= 1 && day <= 31
  const amountCents = amount.trim() === '' ? null : parseMoneyInput(amount)
  const whenValid = recurrence === 'once' ? Boolean(dueOn) : recurrence === 'weekly' ? weekday >= 1 && weekday <= 7 : dayValid
  const canSave =
    title.trim().length > 0 &&
    (group || ((kind !== 'nf' || clientId !== null) && whenValid && amountCents !== undefined && (amount.trim() === '' || amountCents !== null)))
  const parentOptions = [{ value: NO_PARENT, label: 'Nenhuma (tarefa solta)' }, ...groups.filter((g) => g.id !== task?.id).map((g) => ({ value: g.id, label: g.title }))]

  const save = useMutation({
    mutationFn: () => {
      const body = group
        ? { title: title.trim(), kind, parentId: null, notes: notes.trim() || null }
        : {
            title: title.trim(),
            kind,
            parentId: parentId === NO_PARENT ? null : parentId,
            clientId: kind === 'nf' ? clientId : null,
            recurrence,
            dueOn: recurrence === 'once' ? dueOn : null,
            dueDay: recurrence === 'once' ? null : recurrence === 'weekly' ? weekday : day,
            dueMonth: recurrence === 'yearly' ? dueMonth : null,
            endsOn: recurrence === 'once' ? null : endsOn || null,
            amountCents: amountCents === null ? null : Math.abs(amountCents),
            notes: notes.trim() || null,
          }
      return task ? api.patch(`/tasks/${task.id}`, body) : api.post('/tasks', body)
    },
    onSuccess: () => {
      toast(task ? 'Tarefa atualizada' : group ? 'Tarefa principal criada' : 'Tarefa criada')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar a tarefa', 'error'),
  })

  return (
    <Modal
      title={task ? (group ? 'Editar tarefa principal' : 'Editar tarefa') : initialParentId ? 'Nova subtarefa' : 'Nova tarefa'}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={!canSave} loading={save.isPending}>
            {task ? 'Salvar' : group ? 'Criar tarefa principal' : 'Criar tarefa'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!initialParentId && (
          <div className="field">
            <span className="field__label">Tipo</span>
            <Segmented
              ariaLabel="Tipo de tarefa"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'custom', label: 'Tarefa' },
                { value: 'group', label: 'Tarefa principal' },
                { value: 'nf', label: 'Emitir nota fiscal' },
              ]}
            />
          </div>
        )}
        {group ? (
          <>
            <Field label="Título" hint="Ex.: Dentista, Voltar para a academia. As subtarefas entram depois, pelo detalhe dela.">
              {(id) => <TextInput id={id} value={title} onChange={setTitle} placeholder="ex. Organizar a casa" />}
            </Field>
            <Field label="Observação">{(id) => <TextArea id={id} value={notes} onChange={setNotes} rows={2} />}</Field>
          </>
        ) : (
          renderTaskFields()
        )}
      </div>
    </Modal>
  )

  // Função comum, não componente: um componente declarado aqui seria recriado a
  // cada render, e os campos perderiam o foco a cada tecla.
  function renderTaskFields() {
    return (
      <>
        {groups.length > 0 && (
          <Field label="Dentro de" hint="A tarefa principal que junta esta. Opcional.">
            {(id) => <Select id={id} value={parentId} onChange={(next) => setParentId(next ?? NO_PARENT)} options={parentOptions} />}
          </Field>
        )}
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
              { value: 'weekly', label: 'Toda semana' },
              { value: 'monthly', label: 'Todo mês' },
              { value: 'yearly', label: 'Todo ano' },
            ]}
          />
        </div>
        {recurrence === 'once' ? (
          <Field label="Data">{(id) => <TextInput id={id} type="date" value={dueOn} onChange={setDueOn} />}</Field>
        ) : (
          <div className="form-grid">
            {recurrence === 'weekly' ? (
              <Field label="Dia da semana">
                {(id) => <Select id={id} value={weekday} onChange={(d) => d && setWeekday(d)} options={WEEKDAY_LABEL.map((label, i) => ({ value: i + 1, label }))} />}
              </Field>
            ) : (
              <Field label="Dia do vencimento" error={dueDay.trim() && !dayValid ? 'Um dia de 1 a 31.' : null} hint="Em mês mais curto, vale o último dia.">
                {(id) => <TextInput id={id} value={dueDay} onChange={setDueDay} numeral />}
              </Field>
            )}
            {recurrence === 'yearly' && (
              <Field label="Mês">
                {(id) => (
                  <Select id={id} value={dueMonth} onChange={(m) => m && setDueMonth(m)} options={MONTH_LABEL.map((label, i) => ({ value: i + 1, label }))} />
                )}
              </Field>
            )}
            <Field label="Até" hint="Opcional: a última data.">
              {(id) => <TextInput id={id} type="date" value={endsOn} onChange={setEndsOn} />}
            </Field>
          </div>
        )}
        <Field label="Valor (R$)" hint="Opcional: o valor da nota ou do pagamento, para lembrar.">
          {(id) => <TextInput id={id} value={amount} onChange={setAmount} placeholder="0,00" numeral />}
        </Field>
        <Field label="Observação">{(id) => <TextArea id={id} value={notes} onChange={setNotes} rows={2} />}</Field>
      </>
    )
  }
}
