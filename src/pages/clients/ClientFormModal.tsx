import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button, Field, Modal, Segmented, Select, TextArea, TextInput, useToast } from '../../components/ui'
import { CLIENT_KIND_LABEL, CLIENT_STATUS_LABEL, type ClientKind, type ClientRecord, type ClientStatus } from './types'

type Form = {
  name: string
  kind: ClientKind
  status: ClientStatus
  email: string
  phone: string
  segment: string
  document: string
  website: string
  source: string
  description: string
  isRecurring: boolean
}

const blank: Form = {
  name: '',
  kind: 'company',
  status: 'active',
  email: '',
  phone: '',
  segment: '',
  document: '',
  website: '',
  source: '',
  description: '',
  isRecurring: false,
}

const fromRecord = (c: ClientRecord): Form => ({
  name: c.name,
  kind: c.kind,
  status: c.status,
  email: c.email ?? '',
  phone: c.phone ?? '',
  segment: c.segment ?? '',
  document: c.document ?? '',
  website: c.website ?? '',
  source: c.source ?? '',
  description: c.description ?? '',
  isRecurring: c.isRecurring,
})

/**
 * Cadastrar ou editar um cliente (docs/specs/clientes-e-negocios, fase 2):
 * lead, empresa ou pessoa, com e-mail, telefone e descrição. Contatos e
 * nomes no extrato ficam na ficha do cliente, depois de criado.
 */
export function ClientFormModal({
  client,
  initialName,
  onClose,
  onSaved,
}: {
  client?: ClientRecord
  /** quando aberto de um seletor, já vem com o nome digitado lá */
  initialName?: string
  onClose: () => void
  onSaved?: (client: ClientRecord) => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Form>(client ? fromRecord(client) : { ...blank, name: initialName ?? '' })
  const update = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        kind: form.kind,
        status: form.status,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        segment: form.segment.trim() || null,
        document: form.document.trim() || null,
        website: form.website.trim() || null,
        source: form.source.trim() || null,
        description: form.description.trim() || null,
        isRecurring: form.isRecurring,
      }
      return client ? api.patch<ClientRecord>(`/pricing/clients/${client.id}`, body) : api.post<ClientRecord>('/pricing/clients', body)
    },
    onSuccess: (saved) => {
      toast(client ? 'Cliente atualizado' : `${saved.name} cadastrado`)
      queryClient.invalidateQueries({ queryKey: ['clients'] })
      queryClient.invalidateQueries({ queryKey: ['client', saved.id] })
      queryClient.invalidateQueries({ queryKey: ['deals'] })
      onSaved?.(saved)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar o cliente', 'error'),
  })

  const emailInvalid = form.email.trim() !== '' && !/^\S+@\S+\.\S+$/.test(form.email.trim())
  const canSave = form.name.trim().length > 0 && !emailInvalid

  return (
    <Modal
      title={client ? `Editar ${client.name}` : 'Novo cliente'}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={!canSave} loading={save.isPending}>
            {client ? 'Salvar cliente' : 'Cadastrar cliente'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Nome">{(id) => <TextInput id={id} value={form.name} onChange={(name) => update({ name })} placeholder="Empresa ou pessoa" />}</Field>
        <div className="row row--wrap" style={{ gap: 'var(--sp-4)' }}>
          <div className="field">
            <span className="field__label">Tipo</span>
            <Segmented
              ariaLabel="Tipo de cliente"
              value={form.kind}
              onChange={(kind) => update({ kind })}
              options={(Object.keys(CLIENT_KIND_LABEL) as ClientKind[]).map((value) => ({ value, label: CLIENT_KIND_LABEL[value] }))}
            />
          </div>
          {/* Menu, não botões: com "Contrato encerrado" as quatro opções não cabem lado a lado no celular. */}
          <div className="field" style={{ flex: '1 1 200px', minWidth: 0 }}>
            <Field label="Situação">
              {(id) => (
                <Select
                  id={id}
                  value={form.status}
                  onChange={(status) => status && update({ status })}
                  options={(Object.keys(CLIENT_STATUS_LABEL) as ClientStatus[]).map((value) => ({ value, label: CLIENT_STATUS_LABEL[value] }))}
                />
              )}
            </Field>
            {form.status === 'ended' && (
              <span className="field__hint">O histórico continua no LTV; o cliente sai dos ativos, dos recorrentes e do MRR.</span>
            )}
          </div>
        </div>
        <div className="form-grid">
          <Field label="E-mail" error={emailInvalid ? 'Confira o e-mail.' : null}>
            {(id) => <TextInput id={id} type="email" value={form.email} onChange={(email) => update({ email })} placeholder="contato@empresa.com" />}
          </Field>
          <Field label="Telefone">{(id) => <TextInput id={id} type="tel" value={form.phone} onChange={(phone) => update({ phone })} placeholder="(27) 99999-0000" />}</Field>
          <Field label="Segmento">{(id) => <TextInput id={id} value={form.segment} onChange={(segment) => update({ segment })} placeholder="ex. moda, saúde, educação" />}</Field>
          <Field label="CPF ou CNPJ">{(id) => <TextInput id={id} value={form.document} onChange={(document) => update({ document })} />}</Field>
          <Field label="Site">{(id) => <TextInput id={id} type="url" value={form.website} onChange={(website) => update({ website })} placeholder="https://" />}</Field>
          <Field label="Origem" hint="Como chegou: indicação, rede social, site...">
            {(id) => <TextInput id={id} value={form.source} onChange={(source) => update({ source })} />}
          </Field>
        </div>
        <Field label="Descrição">
          {(id) => <TextArea id={id} value={form.description} onChange={(description) => update({ description })} rows={3} placeholder="O que faz, como trabalha com você, observações" />}
        </Field>
        <label className="row" style={{ gap: 'var(--sp-2)', cursor: 'pointer', minHeight: 44 }}>
          <input type="checkbox" className="checkbox" checked={form.isRecurring} onChange={(event) => update({ isRecurring: event.target.checked })} />
          <span style={{ fontSize: 'var(--text-sm)' }}>Cliente recorrente (contrato ou trabalho todo mês)</span>
        </label>
      </div>
    </Modal>
  )
}
