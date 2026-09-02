import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { telemetry } from '../lib/telemetry'
import { forwardBoundsFor, useAccounts, useCategoryIndex, useRange } from '../lib/store'
import { centsToInput, date as fmtDate, money, parseMoneyInput } from '../lib/format'
import {
  Bento,
  Button,
  Card,
  CategorySelect,
  EmptyState,
  Icon,
  Modal,
  PendingEditScopeModal,
  PendingScopeModal,
  Segmented,
  Slab,
  StatTile,
  TextInput,
  useToast,
  type PendingDeleteScope,
} from '../components/ui'
import { PageHeader, RangeFilter } from '../components/shell/Shell'
import { TransactionForm, type TransactionFormValue } from '../components/forms/TransactionForm'

/** Substitui os antigos checkboxes "Entradas e saídas / Só entradas / Só saídas" — um único controle, sempre exatamente um estado ativo. */
type DirectionFilter = 'in' | 'out' | 'transfer'

type Row = {
  id: number
  postedOn: string
  description: string
  amountCents: number
  direction: string
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  rawCategory: string | null
  source: string
  categorizedBy: string
  accountId: number
  accountName: string | null
  duplicateAccepted: boolean
  pending: boolean
  forecastId: number | null
  debtId: number | null
}

type ListResponse = {
  rows: Row[]
  total: number
  inflowCents: number
  outflowCents: number
  pendingInflowCents: number
  pendingOutflowCents: number
  limit: number
  offset: number
}

const PROVENANCE: Record<string, string> = {
  rule: 'regra',
  memory: 'aprendido',
  manual: 'manual',
  raw_category: 'banco',
  none: '-',
}

/**
 * `;` como delimitador (não `,`) porque o Excel em pt-BR já espera vírgula
 * como separador decimal — um CSV com `,` como delimitador e valor
 * monetário formatado (`R$ 1.234,56`) quebraria em colunas erradas.
 */
function csvField(value: string): string {
  // Uma descrição de lançamento vem de banco/CSV importado ou digitação
  // manual — nunca confiável o bastante para começar com =/+/-/@ sem
  // neutralizar. Excel/LibreOffice/Sheets tratam uma célula assim como
  // fórmula ao abrir o arquivo (CSV/formula injection); um apóstrofo na
  // frente força texto literal sem mudar o valor visível.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

function transactionsToCsv(rows: Row[]): string {
  const header = ['Data', 'Descrição', 'Categoria', 'Conta', 'Direção', 'Valor', 'Origem', 'Pendente']
  const lines = rows.map((row) =>
    [
      fmtDate(row.postedOn),
      row.description,
      row.categoryName ?? row.rawCategory ?? '',
      row.accountName ?? '',
      row.direction === 'in' ? 'Entrada' : row.direction === 'out' ? 'Saída' : 'Transferência',
      money(row.amountCents),
      PROVENANCE[row.categorizedBy] ?? row.categorizedBy,
      row.pending ? 'Sim' : 'Não',
    ]
      .map(csvField)
      .join(';'),
  )
  // BOM no início: sem ele o Excel abre acento/"R$" como texto corrompido
  // ao detectar a codificação errada de um CSV puro UTF-8.
  return '﻿' + [header.join(';'), ...lines].join('\r\n')
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function TransactionsPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const range = useRange()
  const accounts = useAccounts()
  const [params, setParams] = useSearchParams()

  const [search, setSearch] = useState('')
  const [onlyUncategorized, setOnlyUncategorized] = useState(params.get('uncategorized') === '1')
  const [direction, setDirection] = useState<DirectionFilter>('out')
  const [parentCategoryId, setParentCategoryId] = useState<number | null>(() => {
    const raw = params.get('parentCategoryId')
    return raw ? Number(raw) : null
  })
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [page, setPage] = useState(0)

  const PAGE_SIZE = 100

  useEffect(() => {
    if (onlyUncategorized) params.set('uncategorized', '1')
    else params.delete('uncategorized')
    if (parentCategoryId !== null) params.set('parentCategoryId', String(parentCategoryId))
    else params.delete('parentCategoryId')
    setParams(params, { replace: true })
  }, [onlyUncategorized, parentCategoryId])

  const { byId: categoriesById } = useCategoryIndex()
  const parentCategoryName = parentCategoryId !== null ? categoriesById.get(parentCategoryId)?.path ?? null : null

  // Every backward-looking preset (mtd/3m/6m/12m/ytd/max) caps `to` at
  // "now" — correct for confirmed history, but a pending forecast dated
  // later this month (or a recurring one materialized into next month)
  // fell outside every preset no matter which was picked, so it silently
  // never showed up in the list at all. `forwardBoundsFor`'s `to` is
  // always >= the backward one, so widening only ever reveals pending
  // rows further out — a manually-picked custom range is left exactly as
  // the user set it, same precedent as the dashboard's pending cards.
  const to = range.preset === 'custom' ? range.to : forwardBoundsFor(range.preset, range.anchor).to

  const query = useQuery({
    queryKey: [
      'transactions',
      range.from,
      to,
      range.accountId,
      search,
      onlyUncategorized,
      direction,
      parentCategoryId,
      page,
    ],
    queryFn: () =>
      api.get<ListResponse>('/transactions', {
        from: range.from,
        to,
        accountId: range.accountId,
        search: search || undefined,
        uncategorized: onlyUncategorized ? true : undefined,
        direction: direction === 'transfer' ? undefined : direction,
        categoryKind: direction === 'transfer' ? 'transfer' : undefined,
        parentCategoryId: parentCategoryId ?? undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    enabled: range.ready,
    placeholderData: (previous) => previous,
  })

  const categorize = useMutation({
    mutationFn: (input: { ids: number[]; categoryId: number | null; saveAsRule: boolean }) =>
      api.post<{ updated: number; learned: Array<{ signature: string; hits: number; promoted: boolean }>; ruleId: number | null }>(
        '/transactions/categorize',
        input,
      ),
    onSuccess: (result) => {
      const promoted = result.learned.filter((l) => l.promoted)
      const parts = [`${result.updated} lançamentos atualizados`]
      if (result.ruleId) parts.push('regra criada')
      if (promoted.length > 0) parts.push(`${promoted.length} padrão(ões) promovido(s) a regra`)
      toast(parts.join(' · '))
      setSelected(new Set())
      setBulkOpen(false)
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao categorizar', 'error'),
  })

  const rows = query.data?.rows ?? []

  // Exporta TODO o filtro atual, não só a página de 100 visível na tela —
  // chamadas com o mesmo filtro, não uma segunda fonte de dado. Em páginas
  // de EXPORT_PAGE_SIZE (o teto que a própria API aceita por chamada, ver
  // `limit: z.coerce.number()...max(2000)` em ledger/index.ts): pedir
  // `limit: total` de uma vez só falhava a validação (400) sempre que o
  // filtro tinha mais de 2000 lançamentos — daí o export "retornando erro"
  // em qualquer recorte maior que isso.
  const EXPORT_PAGE_SIZE = 2000
  const exportCsv = useMutation({
    mutationFn: async () => {
      const total = query.data?.total ?? 0
      if (total === 0) throw new Error('nada para exportar com este filtro')
      const rows: Row[] = []
      for (let offset = 0; offset < total; offset += EXPORT_PAGE_SIZE) {
        const page = await api.get<ListResponse>('/transactions', {
          from: range.from,
          to,
          accountId: range.accountId,
          search: search || undefined,
          uncategorized: onlyUncategorized ? true : undefined,
          direction: direction === 'transfer' ? undefined : direction,
          categoryKind: direction === 'transfer' ? 'transfer' : undefined,
          parentCategoryId: parentCategoryId ?? undefined,
          limit: EXPORT_PAGE_SIZE,
          offset,
        })
        rows.push(...page.rows)
        if (page.rows.length === 0) break
      }
      return rows
    },
    onSuccess: (allRows) => {
      downloadCsv(`lancamentos-${range.from}-a-${to}.csv`, transactionsToCsv(allRows))
      toast(`${allRows.length} lançamento(s) exportado(s)`)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao exportar', 'error'),
  })

  const remove = useMutation({
    mutationFn: ({ ids, scope }: { ids: number[]; scope?: PendingDeleteScope }) =>
      api.post<{ removed: number }>('/transactions/delete', { ids, scope }),
    onSuccess: (result) => {
      toast(`${result.removed} lançamentos removidos`)
      setSelected(new Set())
      queryClient.invalidateQueries()
      setScopePrompt(null)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })
  // Pergunta o escopo só quando a seleção inclui uma pendência ainda
  // vinculada a um template (forecast/dívida) — uma seleção comum exclui
  // direto, sem modal extra (decisions/0020).
  const [scopePrompt, setScopePrompt] = useState<number[] | null>(null)
  const requestDelete = (ids: number[]) => {
    const hasTemplateLink = rows.some((r) => ids.includes(r.id) && r.pending && (r.forecastId || r.debtId))
    if (hasTemplateLink) setScopePrompt(ids)
    else remove.mutate({ ids })
  }

  // Segue a mesma direção marcada no filtro: Entrada mostra receitas
  // futuras/pendentes ("a receber"), Saída mostra despesas futuras/
  // pendentes ("a pagar") — nunca soma as duas, o mesmo par de números que
  // já aparecia como rodapé de "Entradas"/"Saídas no filtro" acima, só num
  // card próprio.
  const pendingLabel = direction === 'out' ? 'A pagar' : 'A receber'
  const pendingFoot = direction === 'out' ? 'despesas futuras/pendentes' : 'receitas futuras/pendentes'
  const pendingCents =
    direction === 'out' ? query.data?.pendingOutflowCents ?? 0 : query.data?.pendingInflowCents ?? 0

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id))
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / PAGE_SIZE))

  const toggle = (id: number) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectedRows = useMemo(() => rows.filter((row) => selected.has(row.id)), [rows, selected])
  const [creating, setCreating] = useState(false)

  return (
    <>
      <PageHeader
        title="Lançamentos"
        subtitle={`${(query.data?.total ?? 0).toLocaleString('pt-BR')} no período e filtros atuais`}
        actions={
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <RangeFilter />
            <Button
              variant="quiet"
              icon="download"
              onClick={() => exportCsv.mutate()}
              disabled={exportCsv.isPending || (query.data?.total ?? 0) === 0}
              title="Exportar lançamentos do período e filtros atuais para CSV"
            >
              Exportar CSV
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              Novo lançamento
            </Button>
          </div>
        }
      />

      <div className="page">
        <Bento>
          <Slab span={3}>
            <StatTile label="Entradas no filtro" value={money(query.data?.inflowCents ?? 0)} large />
          </Slab>
          <Slab span={3}>
            <StatTile label="Saídas no filtro" value={money(query.data?.outflowCents ?? 0)} large />
          </Slab>
          <Slab span={3}>
            <StatTile
              label="Resultado"
              value={money((query.data?.inflowCents ?? 0) - (query.data?.outflowCents ?? 0))}
              large
            />
          </Slab>
          <Slab span={3}>
            <StatTile label={pendingLabel} value={money(pendingCents)} foot={pendingFoot} large />
          </Slab>

          <Card span={12} flush>
            <div style={{ padding: 'var(--sp-4) var(--sp-5)' }} className="stack">
              <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
                <div style={{ minWidth: 240, flex: 1 }}>
                  <TextInput
                    value={search}
                    onChange={(value) => {
                      setSearch(value)
                      setPage(0)
                    }}
                    placeholder="Buscar por descrição, categoria ou data…"
                  />
                </div>
                <Segmented
                  ariaLabel="Direção"
                  value={direction}
                  onChange={(value) => {
                    setDirection(value)
                    setPage(0)
                  }}
                  options={[
                    { value: 'in', label: 'Entrada' },
                    { value: 'out', label: 'Saída' },
                    { value: 'transfer', label: 'Transferência' },
                  ]}
                />
                <label className="row" style={{ gap: 'var(--sp-2)', fontSize: 'var(--text-sm)' }}>
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={onlyUncategorized}
                    onChange={(event) => {
                      setOnlyUncategorized(event.target.checked)
                      setPage(0)
                    }}
                  />
                  Só sem categoria
                </label>
                {parentCategoryId !== null && (
                  <span className="badge badge--info row" style={{ gap: 'var(--sp-2)' }}>
                    {parentCategoryName ?? `categoria #${parentCategoryId}`}
                    <button
                      type="button"
                      onClick={() => setParentCategoryId(null)}
                      aria-label="Remover filtro de categoria"
                      style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0, display: 'flex' }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                )}
                <div className="grow" />
                <Button
                  variant="primary"
                  icon="tags"
                  disabled={selected.size === 0}
                  onClick={() => setBulkOpen(true)}
                >
                  Categorizar {selected.size > 0 ? `(${selected.size})` : ''}
                </Button>
                <Button
                  variant="danger"
                  icon="trash"
                  disabled={selected.size === 0}
                  onClick={() => requestDelete([...selected])}
                >
                  Excluir
                </Button>
              </div>
            </div>

            {query.isError ? (
              <EmptyState
                icon="alert"
                title="Falha ao carregar lançamentos"
                body="Não foi possível carregar os lançamentos agora. Tente novamente em instantes."
              />
            ) : rows.length === 0 ? (
              <EmptyState
                icon="search"
                title="Nenhum lançamento encontrado"
                body="Ajuste o período, a conta ou os filtros, ou importe um extrato."
              />
            ) : (
              <>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>
                          <input
                            type="checkbox"
                            className="checkbox"
                            checked={allSelected}
                            onChange={() =>
                              setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)))
                            }
                            aria-label="Selecionar todos"
                          />
                        </th>
                        <th style={{ width: 100 }}>Data</th>
                        <th>Descrição</th>
                        <th style={{ width: 190 }}>Categoria</th>
                        <th style={{ width: 130 }}>Conta</th>
                        <th className="table__num" style={{ width: 128 }}>Valor</th>
                        <th style={{ width: 40 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id} data-selected={selected.has(row.id)}>
                          <td>
                            <input
                              type="checkbox"
                              className="checkbox"
                              checked={selected.has(row.id)}
                              onChange={() => toggle(row.id)}
                              aria-label={`Selecionar ${row.description}`}
                            />
                          </td>
                          <td className="tabular">{fmtDate(row.postedOn)}</td>
                          <td style={{ maxWidth: 340 }}>
                            <div className="truncate" title={row.description}>
                              {row.description}
                            </div>
                            <div className="row" style={{ gap: 'var(--sp-2)' }}>
                              <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                                {PROVENANCE[row.categorizedBy] ?? row.categorizedBy}
                              </span>
                              {row.source === 'daily' && <span className="badge">diário</span>}
                              {row.pending && <span className="badge badge--warning">previsto</span>}
                              {row.duplicateAccepted && <span className="badge badge--warning">duplicata aceita</span>}
                            </div>
                          </td>
                          <td>
                            <div className="row" style={{ gap: 'var(--sp-2)' }}>
                              {row.categoryColor && (
                                <span className="swatch" style={{ background: row.categoryColor }} />
                              )}
                              <CategorySelect
                                bare
                                value={row.categoryId}
                                direction={row.direction === 'in' ? 'in' : 'out'}
                                onChange={(value) =>
                                  categorize.mutate({ ids: [row.id], categoryId: value, saveAsRule: false })
                                }
                              />
                            </div>
                          </td>
                          <td className="muted truncate" style={{ maxWidth: 130 }}>
                            {row.accountName}
                          </td>
                          <td className={`table__num ${row.amountCents < 0 ? 'neg' : 'pos'}`}>
                            {money(row.amountCents)}
                          </td>
                          <td>
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="pencil"
                              onClick={() => setEditing(row)}
                              title="Editar lançamento"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div
                    className="row row--between"
                    style={{ padding: 'var(--sp-3) var(--sp-5)', borderTop: '1px solid var(--line)' }}
                  >
                    <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                      Página {page + 1} de {totalPages}
                    </span>
                    <div className="row">
                      <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                        Anterior
                      </Button>
                      <Button
                        size="sm"
                        disabled={page + 1 >= totalPages}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Próxima
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </Bento>
      </div>

      {bulkOpen && (
        <BulkCategorizeModal
          rows={selectedRows}
          onClose={() => setBulkOpen(false)}
          onApply={(categoryId, saveAsRule) =>
            categorize.mutate({ ids: [...selected], categoryId, saveAsRule })
          }
          pending={categorize.isPending}
        />
      )}

      {editing && <EditTransactionModal row={editing} onClose={() => setEditing(null)} />}
      {creating && <NewTransactionModal onClose={() => setCreating(false)} />}
      {scopePrompt && (
        <PendingScopeModal
          pending={remove.isPending}
          onCancel={() => setScopePrompt(null)}
          onConfirm={(scope: PendingDeleteScope) => remove.mutate({ ids: scopePrompt, scope })}
        />
      )}
    </>
  )
}

/**
 * The one place a posting mistake gets fixed after the fact, instead of
 * delete-and-re-add. Amount, date, description and account go through
 * `PATCH /transactions/:id` (which recomputes direction and the dedupe
 * hash); category goes through the same `/transactions/categorize` every
 * other picker in the app uses, so a category change here also feeds the
 * learned-correction memory exactly like it would from the inline select.
 * Every mutation invalidates broadly on success — dashboard KPIs, category
 * totals, goal progress and proventos all read from `transactions`
 * directly, so there is nothing else to recompute by hand.
 */
function EditTransactionModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  // decisions/0029: só pergunta escopo quando a edição de fato muda um
  // campo que o template governa (descrição/valor/conta) — mudar só a
  // data ou a categoria não tem o que propagar, segue direto.
  const [scopePrompt, setScopePrompt] = useState(false)

  const [value, setValue] = useState<TransactionFormValue>({
    description: row.description,
    postedOn: row.postedOn,
    direction: row.direction === 'in' ? 'in' : 'out',
    amount: centsToInput(Math.abs(row.amountCents)),
    accountId: row.accountId,
    categoryId: row.categoryId,
  })

  const save = useMutation({
    mutationFn: async (scope?: PendingDeleteScope) => {
      const rawCents = parseMoneyInput(value.amount)
      if (rawCents === null || rawCents === 0) throw new Error('informe o valor')
      const amountCents = value.direction === 'in' ? Math.abs(rawCents) : -Math.abs(rawCents)
      if (value.accountId === null) throw new Error('escolha a conta')

      await api.patch(`/transactions/${row.id}`, {
        postedOn: value.postedOn,
        description: value.description.trim(),
        amountCents,
        accountId: value.accountId,
        ...(scope ? { scope } : {}),
      })
      if (value.categoryId !== row.categoryId) {
        await api.post('/transactions/categorize', {
          ids: [row.id],
          categoryId: value.categoryId,
          saveAsRule: false,
        })
      }
    },
    onSuccess: async () => {
      toast('Lançamento atualizado')
      // Awaited: reabrir antes do refetch reidrataria do cache pré-edição.
      await queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const requestSave = () => {
    const amountCents =
      value.direction === 'in'
        ? Math.abs(parseMoneyInput(value.amount) ?? 0)
        : -Math.abs(parseMoneyInput(value.amount) ?? 0)
    const changesTemplateField =
      value.description.trim() !== row.description || amountCents !== row.amountCents || value.accountId !== row.accountId
    const qualifiesForScope = row.pending && (row.forecastId !== null || row.debtId !== null)
    if (qualifiesForScope && changesTemplateField) setScopePrompt(true)
    else save.mutate(undefined)
  }

  return (
    <>
      <Modal
        title="Editar lançamento"
        onClose={onClose}
        footer={
          <>
            <Button variant="quiet" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" onClick={requestSave} disabled={save.isPending}>
              Salvar
            </Button>
          </>
        }
      >
        <TransactionForm value={value} onChange={(patch) => setValue((current) => ({ ...current, ...patch }))} />
      </Modal>
      {scopePrompt && (
        <PendingEditScopeModal
          pending={save.isPending}
          onCancel={() => setScopePrompt(false)}
          onConfirm={(scope) => save.mutate(scope)}
        />
      )}
    </>
  )
}

/**
 * The only way to create a transaction by hand used to be Diário's
 * QuickAdd, which is expense-only and always dated today. This covers
 * income too and any date — e.g. logging a cash payment or an old
 * receipt that never came through a bank statement.
 */
function NewTransactionModal({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()

  const [value, setValue] = useState<TransactionFormValue>({
    description: '',
    postedOn: new Date().toISOString().slice(0, 10),
    direction: 'out',
    amount: '',
    accountId: null,
    categoryId: null,
  })

  // The account <select> has no blank/placeholder option, so with
  // accountId still null the browser just shows its first option as if
  // chosen — this keeps the actual state in sync with what's visibly
  // selected the moment the accounts load, instead of letting "Salvar"
  // reject a form that looks fully filled in.
  useEffect(() => {
    if (value.accountId === null && accounts.data?.accounts.length) {
      setValue((current) => ({ ...current, accountId: accounts.data!.accounts[0]!.id }))
    }
  }, [value.accountId, accounts.data])

  const save = useMutation({
    mutationFn: () => {
      const rawCents = parseMoneyInput(value.amount)
      if (rawCents === null || rawCents === 0) throw new Error('informe o valor')
      if (value.accountId === null) throw new Error('escolha a conta')
      const amountCents = value.direction === 'in' ? Math.abs(rawCents) : -Math.abs(rawCents)

      return api.post('/transactions', {
        accountId: value.accountId,
        postedOn: value.postedOn,
        description: value.description.trim(),
        amountCents,
        categoryId: value.categoryId,
        source: 'manual',
      })
    },
    onSuccess: () => {
      telemetry.action('transactions', 'transaction_created_manual')
      toast('Lançamento criado')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title="Novo lançamento"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            icon="check"
            onClick={() => save.mutate()}
            disabled={!value.description.trim() || save.isPending}
          >
            Salvar
          </Button>
        </>
      }
    >
      <TransactionForm
        value={value}
        onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
        descriptionPlaceholder="ex. Pagamento em dinheiro"
      />
    </Modal>
  )
}

/**
 * Bulk re-categorization. "Salvar como regra" is opt-in and separate from
 * the automatic learning: assigning a category always teaches the memory,
 * but only an explicit choice creates a rule that fires on everything
 * matching from now on.
 */
function BulkCategorizeModal({
  rows,
  onClose,
  onApply,
  pending,
}: {
  rows: Row[]
  onClose: () => void
  onApply: (categoryId: number | null, saveAsRule: boolean) => void
  pending: boolean
}) {
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [saveAsRule, setSaveAsRule] = useState(false)

  const distinct = useMemo(() => {
    const set = new Set(rows.map((row) => row.description.toLowerCase()))
    return set.size
  }, [rows])

  // Only meaningful (and only safe to filter by) when every selected row
  // agrees on direction — a mixed selection shows every category, same as
  // before this picker existed, rather than guess which side wins.
  const uniformDirection = useMemo(() => {
    const directions = new Set(rows.map((row) => (row.direction === 'in' ? 'in' : 'out')))
    return directions.size === 1 ? ([...directions][0] as 'in' | 'out') : undefined
  }, [rows])

  return (
    <Modal
      title={`Categorizar ${rows.length} lançamentos`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            icon="check"
            disabled={pending}
            onClick={() => onApply(categoryId, saveAsRule)}
          >
            Aplicar
          </Button>
        </>
      }
    >
      <div className="stack">
        <label className="field__label">Categoria</label>
        <CategorySelect
          value={categoryId}
          placeholder="Remover categoria"
          direction={uniformDirection}
          onChange={setCategoryId}
        />

        <label className="row" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            className="checkbox"
            checked={saveAsRule}
            disabled={categoryId === null}
            onChange={(event) => setSaveAsRule(event.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong style={{ fontSize: 'var(--text-sm)' }}>Salvar como regra</strong>
            <br />
            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Cria uma regra a partir do comerciante do primeiro lançamento selecionado, com
              precedência sobre as regras genéricas.
            </span>
          </span>
        </label>

        <hr className="divider" />

        <div className="kv">
          <span className="kv__k">Lançamentos selecionados</span>
          <span className="kv__v">{rows.length}</span>
          <span className="kv__k">Descrições distintas</span>
          <span className="kv__v">{distinct}</span>
          <span className="kv__k">Soma</span>
          <span className="kv__v">{money(rows.reduce((sum, row) => sum + row.amountCents, 0))}</span>
        </div>

        <p className="chart__note">
          <Icon name="info" size={12} /> Toda atribuição manual alimenta a memória de correções.
          Depois de três confirmações do mesmo comerciante, a correção vira regra sozinha.
        </p>
      </div>
    </Modal>
  )
}
