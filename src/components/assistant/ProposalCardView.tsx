import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { AssistantActionType, AssistantCard, CardFlag } from '@shared/assistantTypes'
import { Button, Field, Icon, TextInput } from '../ui'
import { APPLY_ACCEPTS_EDITS, type CardEdit } from '../../lib/assistantApi'
import { centsToInput, date as fmtDate, money, parseMoneyInput } from '../../lib/format'
import type { CardStatus } from './useAssistantChat'

const KIND_LABEL: Record<AssistantActionType, string> = {
  update_pending: 'Atualizar pendência',
  add_note: 'Acrescentar comentário',
  create_transaction: 'Novo lançamento',
  diary_entry: 'Entrada do Diário',
  record_trade: 'Compra ou venda de ativo',
  reserve_contribution: 'Aporte na reserva',
}

const FLAG_TEXT: Record<CardFlag, { label: string; tone: 'badge--warning' | 'badge--info'; icon: 'alert' | 'info' }> = {
  divergent_amount: { label: 'Valor diferente do cadastro', tone: 'badge--warning', icon: 'alert' },
  far_date: { label: 'Data muito distante de hoje', tone: 'badge--warning', icon: 'alert' },
  new_record: { label: 'Registro novo', tone: 'badge--info', icon: 'info' },
}

/** Campos que o usuário pode ajustar antes de confirmar: data, comentário e valor. */
type EditKey = keyof CardEdit
const EDITABLE: Record<string, { key: EditKey; label: string; kind: 'date' | 'money' | 'text' }> = {
  postedOn: { key: 'postedOn', label: 'Data', kind: 'date' },
  tradedOn: { key: 'tradedOn', label: 'Data da operação', kind: 'date' },
  amountCents: { key: 'amountCents', label: 'Valor', kind: 'money' },
  notes: { key: 'notes', label: 'Comentário', kind: 'text' },
  note: { key: 'note', label: 'Comentário', kind: 'text' },
}

/** "19/10/2026" ou "2026-10-19" para AAAA-MM-DD; vazio se não for uma data. */
function toIsoDate(text: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (iso) return text.trim()
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim())
  return br ? `${br[3]}-${br[2]}-${br[1]}` : ''
}

function isRealDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const parsed = new Date(`${iso}T00:00:00`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso
}

/** O texto "depois" do card, já com o ajuste do usuário por cima. */
function displayAfter(change: AssistantCard['changes'][number], edit: CardEdit | undefined): string {
  const spec = EDITABLE[change.field]
  const value = spec && edit ? edit[spec.key] : undefined
  if (value === undefined) return change.after
  if (spec?.kind === 'money') return money(Number(value))
  if (spec?.kind === 'date') return fmtDate(String(value))
  return String(value)
}

type Props = {
  card: AssistantCard
  status: CardStatus
  edit: CardEdit | undefined
  /** proposta expirada ou bloqueada: só leitura */
  locked: boolean
  onConfirm: () => void
  onCancel: () => void
  onSaveEdit: (edit: CardEdit | null) => void
}

export function ProposalCardView({ card, status, edit, locked, onConfirm, onCancel, onSaveEdit }: Props) {
  const [editing, setEditing] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  const titleId = useId()
  const editableFields = APPLY_ACCEPTS_EDITS
    ? card.changes.filter((change) => EDITABLE[change.field]).map((change) => ({ change, spec: EDITABLE[change.field]! }))
    : []
  const canAct = status === 'pending' && !locked
  const applying = status === 'applying'
  const hasEdit = edit !== undefined && Object.keys(edit).length > 0

  // Ao sair da edição (guardar, cancelar ou Esc) o foco volta para o botão Editar.
  useEffect(() => {
    if (editing) wasEditing.current = true
    else if (wasEditing.current) {
      wasEditing.current = false
      editButton.current?.focus()
    }
  }, [editing])

  return (
    <article
      id={`assistant-card-${card.actionId}`}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={`assistant-card${status === 'applied' ? ' assistant-card--applied' : ''}${status === 'cancelled' || status === 'undone' ? ' assistant-card--cancelled' : ''}`}
    >
      <header className="assistant-card__head">
        <div>
          <h3 id={titleId} className="assistant-card__title">
            {card.title}
          </h3>
          <p className="assistant-card__kind">{KIND_LABEL[card.kind]}</p>
        </div>
        <div className="assistant-card__badges">
          {hasEdit && status === 'pending' && (
            <span className="badge">
              <Icon name="pencil" size={11} /> Editado
            </span>
          )}
          {status === 'applied' && (
            <span className="badge badge--good">
              <Icon name="check" size={11} strokeWidth={2.4} /> Gravado
            </span>
          )}
          {status === 'cancelled' && <span className="badge">Cancelado</span>}
          {status === 'undone' && <span className="badge">Desfeito</span>}
        </div>
      </header>

      <table className="assistant-changes">
        <caption className="sr-only">Mudanças propostas: {card.title}</caption>
        <thead>
          <tr>
            <th scope="col">Campo</th>
            <th scope="col">Antes</th>
            <th scope="col">Depois</th>
          </tr>
        </thead>
        <tbody>
          {card.changes.map((change) => {
            const flag = change.flag ? FLAG_TEXT[change.flag] : null
            const edited = edit !== undefined && EDITABLE[change.field] !== undefined && edit[EDITABLE[change.field]!.key] !== undefined
            const rowClass =
              change.flag === 'new_record'
                ? 'assistant-changes__row--flag assistant-changes__row--new'
                : change.flag
                  ? 'assistant-changes__row--flag'
                  : undefined
            return (
              <Fragment key={change.field}>
              <tr className={rowClass ? `${rowClass} assistant-changes__row--open` : undefined}>
                <th scope="row">{change.label}</th>
                <td className="assistant-changes__before">
                  {change.before === null ? (
                    <>
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">sem valor anterior</span>
                    </>
                  ) : (
                    change.before
                  )}
                </td>
                <td>
                  <span className="assistant-changes__after">{displayAfter(change, edit)}</span>
                  {edited && <span className="assistant-meta"> (editado)</span>}
                </td>
              </tr>
              {flag && (
                /* O selo ocupa a linha inteira: numa coluna estreita o texto quebrava em três linhas. */
                <tr className={rowClass}>
                  <td colSpan={3} className="assistant-changes__flagcell">
                    <span className={`badge assistant-flag ${flag.tone}`}>
                      <Icon name={flag.icon} size={11} strokeWidth={2.4} />
                      <span>
                        <span className="sr-only">{change.flag === 'new_record' ? 'Sobre' : 'Atenção em'} {change.label}: </span>
                        {flag.label}
                      </span>
                    </span>
                  </td>
                </tr>
              )}
              </Fragment>
            )
          })}
        </tbody>
      </table>

      {card.warnings.length > 0 && (
        <ul className="assistant-warnings" aria-label="Avisos">
          {card.warnings.map((warning) => (
            <li key={warning}>
              <Icon name="alert" size={14} />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {editing && canAct ? (
        <EditForm
          fields={editableFields.map(({ change, spec }) => ({ change, spec }))}
          current={edit}
          onCancel={() => setEditing(false)}
          onSave={(next) => {
            onSaveEdit(next)
            setEditing(false)
          }}
        />
      ) : (
        canAct || applying ? (
          <div className="assistant-actions">
            <Button variant="primary" icon="check" onClick={onConfirm} loading={applying} disabled={applying}>
              Confirmar
            </Button>
            {editableFields.length > 0 && (
              /* `Button` não repassa ref, e o foco precisa voltar a este botão ao sair da edição. */
              <button
                ref={editButton}
                type="button"
                className="btn btn--ghost"
                disabled={applying}
                onClick={() => setEditing(true)}
              >
                <Icon name="pencil" size={15} />
                Editar
              </button>
            )}
            <Button variant="quiet" onClick={onCancel} disabled={applying}>
              Cancelar
            </Button>
          </div>
        ) : null
      )}
    </article>
  )
}

type EditFormProps = {
  fields: Array<{ change: AssistantCard['changes'][number]; spec: (typeof EDITABLE)[string] }>
  current: CardEdit | undefined
  onCancel: () => void
  onSave: (edit: CardEdit | null) => void
}

function initialValue(
  change: AssistantCard['changes'][number],
  spec: (typeof EDITABLE)[string],
  current: CardEdit | undefined,
): string {
  const edited = current?.[spec.key]
  if (spec.kind === 'date') return edited !== undefined ? String(edited) : toIsoDate(change.after)
  if (spec.kind === 'money') {
    if (edited !== undefined) return centsToInput(Number(edited))
    const cents = parseMoneyInput(change.after)
    return cents === null ? '' : centsToInput(cents)
  }
  return edited !== undefined ? String(edited) : change.after
}

function EditForm({ fields, current, onCancel, onSave }: EditFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map(({ change, spec }) => [spec.key, initialValue(change, spec, current)])),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})

  const submit = () => {
    const edit: CardEdit = {}
    const nextErrors: Record<string, string> = {}
    for (const { change, spec } of fields) {
      const raw = (values[spec.key] ?? '').trim()
      const original = initialValue(change, spec, undefined).trim()
      if (spec.kind === 'date') {
        if (!isRealDate(raw)) nextErrors[spec.key] = 'Informe uma data válida.'
        else if (raw !== original) edit[spec.key as 'postedOn' | 'tradedOn'] = raw
      } else if (spec.kind === 'money') {
        const cents = parseMoneyInput(raw)
        if (cents === null || cents <= 0) nextErrors[spec.key] = 'Informe um valor maior que zero.'
        else if (raw !== original) edit.amountCents = cents
      } else if (spec.kind === 'text') {
        if (raw.length === 0) nextErrors[spec.key] = 'O comentário não pode ficar vazio.'
        else if (raw.length > 500) nextErrors[spec.key] = 'Use até 500 caracteres.'
        else if (raw !== original) edit[spec.key as 'notes' | 'note'] = raw
      }
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    onSave(Object.keys(edit).length > 0 ? edit : null)
  }

  // Esc fecha só a edição; o painel não fecha junto (Dialog confere `defaultPrevented`).
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <form
      className="assistant-edit"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      aria-label="Editar campos do cartão"
    >
      {fields.map(({ spec }, index) => (
        <Field key={spec.key} label={spec.label} error={errors[spec.key]}>
          {(id) =>
            spec.kind === 'text' ? (
              <input
                id={id}
                className="input"
                maxLength={500}
                autoFocus={index === 0}
                value={values[spec.key] ?? ''}
                aria-invalid={errors[spec.key] ? true : undefined}
                onChange={(event) => setValues((current) => ({ ...current, [spec.key]: event.target.value }))}
              />
            ) : (
              <TextInput
                id={id}
                type={spec.kind === 'date' ? 'date' : 'text'}
                numeral={spec.kind === 'money'}
                autoFocus={index === 0}
                value={values[spec.key] ?? ''}
                onChange={(value) => setValues((current) => ({ ...current, [spec.key]: value }))}
              />
            )
          }
        </Field>
      ))}
      <div className="assistant-actions">
        <Button variant="primary" type="submit" icon="check">
          Guardar edição
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancelar edição
        </Button>
      </div>
    </form>
  )
}
