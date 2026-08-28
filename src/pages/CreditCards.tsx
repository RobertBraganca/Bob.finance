import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { telemetry } from '../lib/telemetry'
import { useAccounts } from '../lib/store'
import { bps, centsToInput, money, moneyCompact, date as fmtDate, parseMoneyInput } from '../lib/format'
import {
  Button,
  Card,
  capUsageState,
  EmptyState,
  HeroFigure,
  Meter,
  Modal,
  Select,
  Slab,
  TextInput,
  useToast,
} from '../components/ui'
import { PageHeader } from '../components/shell/Shell'

export type CardRow = {
  id: number
  name: string
  institution: string | null
  accountId: number | null
  accountName: string | null
  creditLimitCents: number
  availableLimitCents: number
  usedCents: number
  usedBps: number
  closingDay: number
  dueDay: number
  nextClosingOn: string
  nextDueOn: string
  lastMeasuredOn: string | null
}

export function CreditCardsPage() {
  const [editing, setEditing] = useState<CardRow | 'new' | null>(null)
  const [snapshotFor, setSnapshotFor] = useState<CardRow | null>(null)

  const cards = useQuery({
    queryKey: ['credit-cards'],
    queryFn: () => api.get<{ cards: CardRow[] }>('/credit-cards'),
  })

  const data = cards.data?.cards ?? []
  const totalLimitCents = data.reduce((s, c) => s + c.creditLimitCents, 0)
  const totalAvailableCents = data.reduce((s, c) => s + c.availableLimitCents, 0)
  const totalUsedCents = data.reduce((s, c) => s + c.usedCents, 0)

  return (
    <>
      <PageHeader
        title="Cartões"
        subtitle="Limite, ciclo de fatura e disponibilidade: a base para cruzar com o que é gasto no crédito"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            Cadastrar cartão
          </Button>
        }
      />

      <div className="page">
        {!cards.data ? (
          <Card>
            <EmptyState title="Carregando…" />
          </Card>
        ) : data.length === 0 ? (
          <div className="bento">
            <Slab span={12} accent>
              <div className="stack" style={{ maxWidth: '62ch' }}>
                <span className="stat__label">Nenhum cartão cadastrado</span>
                <h2 className="display" style={{ fontSize: 'var(--text-xl)' }}>
                  Cadastre limite, fechamento e vencimento
                </h2>
                <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-base)' }}>
                  Com o ciclo de cada cartão registrado, o app te avisa quando a fatura fecha e vence,
                  e vira a base para cruzar gasto no crédito com o limite disponível.
                </p>
                <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
                  <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
                    Cadastrar primeiro cartão
                  </Button>
                </div>
              </div>
            </Slab>
          </div>
        ) : (
          <div className="bento">
            <Slab span={4} accent>
              <HeroFigure label="Limite disponível" value={moneyCompact(totalAvailableCents)}>
                <div className="kv" style={{ marginTop: 'var(--sp-3)' }}>
                  <span className="kv__k">Limite total</span>
                  <span className="kv__v">{money(totalLimitCents)}</span>
                  <span className="kv__k">Usado</span>
                  <span className="kv__v neg">{money(totalUsedCents)}</span>
                </div>
              </HeroFigure>
            </Slab>

            <Card span={8} flush title="Cartões cadastrados">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Cartão</th>
                      <th>Conta</th>
                      <th style={{ textAlign: 'center' }}>Fechamento</th>
                      <th style={{ textAlign: 'center' }}>Vencimento</th>
                      <th style={{ textAlign: 'right' }}>Limite disponível</th>
                      <th style={{ width: 108 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((card) => (
                      <tr key={card.id}>
                        <td>
                          <strong>{card.name}</strong>
                          {card.institution && (
                            <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                              {' '}
                              · {card.institution}
                            </span>
                          )}
                        </td>
                        <td className="muted">{card.accountName ?? '-'}</td>
                        <td style={{ textAlign: 'center' }}>{fmtDate(card.nextClosingOn)}</td>
                        <td style={{ textAlign: 'center' }}>{fmtDate(card.nextDueOn)}</td>
                        <td className="table__num">
                          {money(card.availableLimitCents)}
                          <br />
                          <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                            de {money(card.creditLimitCents)} · {bps(10_000 - card.usedBps, 0)} livre
                          </span>
                        </td>
                        <td>
                          <div className="row" style={{ gap: 2 }}>
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="clock"
                              onClick={() => setSnapshotFor(card)}
                              title="Registrar limite disponível de hoje"
                            />
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="pencil"
                              onClick={() => setEditing(card)}
                              title="Editar"
                            />
                            <DeleteCardButton cardId={card.id} name={card.name} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </div>

      {editing !== null && (
        <CardModal card={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {snapshotFor && <SnapshotModal card={snapshotFor} onClose={() => setSnapshotFor(null)} />}
    </>
  )
}

function DeleteCardButton({ cardId, name }: { cardId: number; name: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const remove = useMutation({
    mutationFn: () => api.del(`/credit-cards/${cardId}`),
    onSuccess: () => {
      toast(`${name} removido`)
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  return (
    <Button
      variant="quiet"
      size="sm"
      icon="trash"
      onClick={() => remove.mutate()}
      disabled={remove.isPending}
      title="Excluir cartão"
    />
  )
}

function CardModal({ card, onClose }: { card: CardRow | null; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()
  const [name, setName] = useState(card?.name ?? '')
  const [institution, setInstitution] = useState(card?.institution ?? '')
  const [accountId, setAccountId] = useState<number | null>(card?.accountId ?? null)
  const [creditLimit, setCreditLimit] = useState(centsToInput(card?.creditLimitCents ?? null))
  const [closingDay, setClosingDay] = useState(card ? String(card.closingDay) : '1')
  const [dueDay, setDueDay] = useState(card ? String(card.dueDay) : '10')

  const save = useMutation({
    mutationFn: () => {
      const creditLimitCents = parseMoneyInput(creditLimit)
      if (creditLimitCents === null) throw new Error('informe o limite')
      const body = {
        name: name.trim(),
        institution: institution.trim() || null,
        accountId,
        creditLimitCents: Math.abs(creditLimitCents),
        closingDay: Math.min(31, Math.max(1, Math.round(Number(closingDay)) || 1)),
        dueDay: Math.min(31, Math.max(1, Math.round(Number(dueDay)) || 10)),
      }
      return card ? api.patch(`/credit-cards/${card.id}`, body) : api.post('/credit-cards', body)
    },
    onSuccess: () => {
      if (!card) telemetry.action('credit-cards', 'card_created')
      toast(card ? 'Cartão atualizado' : 'Cartão cadastrado')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const remove = useMutation({
    mutationFn: () => api.del(`/credit-cards/${card!.id}`),
    onSuccess: () => {
      toast('Cartão removido')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  return (
    <Modal
      title={card ? `Editar ${card.name}` : 'Novo cartão'}
      onClose={onClose}
      footer={
        <>
          {card ? (
            <Button variant="danger" icon="trash" onClick={() => remove.mutate()}>
              Remover
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="primary"
            icon="check"
            onClick={() => save.mutate()}
            disabled={!name.trim() || save.isPending}
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label className="field__label">Nome do cartão</label>
            <TextInput value={name} onChange={setName} placeholder="ex. Nubank Ultravioleta" />
          </div>
          <div className="field" style={{ minWidth: 190 }}>
            <label className="field__label">Conta vinculada</label>
            <Select
              value={accountId}
              placeholder="Nenhuma"
              options={(accounts.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
              onChange={setAccountId}
            />
          </div>
        </div>

        <div className="field">
          <label className="field__label">Instituição</label>
          <TextInput value={institution} onChange={setInstitution} placeholder="opcional" />
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Limite total (R$)</label>
            <TextInput value={creditLimit} onChange={setCreditLimit} placeholder="0,00" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 120 }}>
            <label className="field__label">Dia de fechamento</label>
            <TextInput value={closingDay} onChange={setClosingDay} placeholder="ex. 25" numeral />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 120 }}>
            <label className="field__label">Dia de vencimento</label>
            <TextInput value={dueDay} onChange={setDueDay} placeholder="ex. 5" numeral />
          </div>
        </div>
      </div>
    </Modal>
  )
}

function SnapshotModal({ card, onClose }: { card: CardRow; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10))
  const [available, setAvailable] = useState(centsToInput(card.availableLimitCents))

  const save = useMutation({
    mutationFn: () => {
      const availableLimitCents = parseMoneyInput(available)
      if (availableLimitCents === null) throw new Error('informe o limite disponível')
      return api.post(`/credit-cards/${card.id}/snapshot`, {
        asOf,
        availableLimitCents: Math.abs(availableLimitCents),
      })
    },
    onSuccess: () => {
      toast('Limite disponível registrado')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const usedPreview = Math.max(0, card.creditLimitCents - (parseMoneyInput(available) ?? card.availableLimitCents))
  const usedBpsPreview =
    card.creditLimitCents > 0 ? Math.round((usedPreview / card.creditLimitCents) * 10_000) : 0

  return (
    <Modal
      title={`Limite disponível de ${card.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending}>
            Registrar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Data</label>
            <TextInput value={asOf} onChange={setAsOf} type="date" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Limite disponível (R$)</label>
            <TextInput value={available} onChange={setAvailable} placeholder="0,00" numeral />
            <span className="field__hint">De um limite total de {money(card.creditLimitCents)}.</span>
          </div>
        </div>
        <Meter usedBps={usedBpsPreview} state={capUsageState(usedBpsPreview)} />
      </div>
    </Modal>
  )
}
