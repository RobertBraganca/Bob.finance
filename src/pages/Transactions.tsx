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
  FilterSelect,
  Icon,
  Meter,
  Modal,
  PendingEditScopeModal,
  PendingScopeModal,
  Segmented,
  Select,
  Slab,
  StatTile,
  targetProgressState,
  TextInput,
  useToast,
  type PendingDeleteScope,
} from '../components/ui'
import { PageHeader, RangeFilter } from '../components/shell/Shell'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { TransactionForm, type TransactionFormValue } from '../components/forms/TransactionForm'

/**
 * Substitui os antigos checkboxes "Entradas e saídas / Só entradas / Só
 * saídas". `null` é "Todas Transações" — mesma convenção de `value: null`
 * = sem filtro já usada pelo `FilterSelect` de conta (`RangeFilter`,
 * `Shell.tsx`), não um quarto valor de string à parte.
 */
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
  hidden: boolean
  pending: boolean
  forecastId: number | null
  debtId: number | null
  creditCardId: number | null
}

type InstallmentRow = {
  id: number
  description: string
  direction: 'in' | 'out'
  installmentAmountCents: number
  installmentCount: number
  installmentsRealized: number
  totalCents: number
  paidCents: number
  remainingCents: number
  finished: boolean
  categoryId: number | null
  categoryName: string | null
  accountId: number | null
  accountName: string | null
  dueDay: number
  startPeriod: string
  active: boolean
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
  const header = ['Data', 'Descrição', 'TAG', 'Conta', 'Direção', 'Valor', 'Origem', 'Pendente']
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

  /**
   * Parcelamentos era uma página própria (item 6 do backlog de
   * 07/09/2026); virou aba aqui na revisão de sidebar seguinte, mesmo
   * padrão de consolidação já usado em Categorias ("Visão por gasto") —
   * uma view leve o bastante para não justificar rota própria.
   */
  const [tab, setTab] = useState<'ledger' | 'installments'>('ledger')

  const [search, setSearch] = useState('')
  const [onlyUncategorized, setOnlyUncategorized] = useState(params.get('uncategorized') === '1')
  const [direction, setDirection] = useState<DirectionFilter | null>(null)
  const [parentCategoryId, setParentCategoryId] = useState<number | null>(() => {
    const raw = params.get('parentCategoryId')
    return raw ? Number(raw) : null
  })
  /** Item 4 do backlog de 07/09/2026: filtro de categoria "de verdade" (escolhe, não só limpa) -- independente do badge de `parentCategoryId` acima, que continua vindo só de navegação por URL. */
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [sort, setSort] = useState<'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'>('date_desc')
  const [includeHidden, setIncludeHidden] = useState(false)
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
      categoryId,
      sort,
      includeHidden,
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
        categoryId: categoryId ?? undefined,
        sort,
        includeHidden: includeHidden ? true : undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    enabled: range.ready,
    placeholderData: (previous) => previous,
  })

  const [installmentStatus, setInstallmentStatus] = useState<'ongoing' | 'finished'>('ongoing')
  const [installmentIncludeInactive, setInstallmentIncludeInactive] = useState(false)
  const installments = useQuery({
    queryKey: ['installments', installmentIncludeInactive],
    queryFn: () =>
      api.get<{ installments: InstallmentRow[] }>('/cash-flow/installments', {
        includeInactive: installmentIncludeInactive,
      }),
    enabled: tab === 'installments',
  })

  /** Item 4 do backlog de 07/09/2026: um botão só, some com todo filtro de busca/categoria/ordenação -- nunca mexe no período (RangeFilter é outra coisa, já tem o próprio "Redefinir"). */
  const clearFilters = () => {
    setSearch('')
    setOnlyUncategorized(false)
    setDirection(null)
    setParentCategoryId(null)
    setCategoryId(null)
    setSort('date_desc')
    setIncludeHidden(false)
    setPage(0)
  }
  const hasActiveFilters =
    search !== '' ||
    onlyUncategorized ||
    direction !== null ||
    parentCategoryId !== null ||
    categoryId !== null ||
    sort !== 'date_desc' ||
    includeHidden

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

  const setHidden = useMutation({
    mutationFn: (input: { ids: number[]; hidden: boolean }) =>
      api.post<{ updated: number }>('/transactions/hide', input),
    onSuccess: (result, variables) => {
      toast(`${result.updated} lançamento(s) ${variables.hidden ? 'ocultado(s)' : 'reexibido(s)'}`)
      setSelected(new Set())
      queryClient.invalidateQueries({ queryKey: ['transactions'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao ocultar', 'error'),
  })

  const rows = query.data?.rows ?? []

  // Se tudo que está selecionado já está oculto, o botão vira "Reexibir"
  // em vez de "Ocultar" — evita um segundo controle separado só pra isso.
  const selectionAllHidden =
    selected.size > 0 && rows.filter((row) => selected.has(row.id)).every((row) => row.hidden)

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
          // Antes faltavam aqui (achado da auditoria de 07/09/2026): sem
          // eles, exportar com um filtro de categoria ativo baixava
          // lançamentos de TODAS as categorias (só o total de linhas
          // batia com a tela, o conteúdo não), e "Mostrar ocultos"
          // desligado ainda incluía ocultos no CSV.
          categoryId: categoryId ?? undefined,
          includeHidden: includeHidden ? true : undefined,
          sort,
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
  const [installmentModal, setInstallmentModal] = useState<InstallmentRow | 'new' | null>(null)

  return (
    <>
      <PageHeader
        title="Lançamentos"
        subtitle={
          tab === 'ledger'
            ? `${(query.data?.total ?? 0).toLocaleString('pt-BR')} no período e filtros atuais`
            : 'Compras e recebíveis parcelados, do total à última parcela'
        }
        actions={
          tab === 'ledger' ? (
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
          ) : (
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
              <label className="row" style={{ gap: 'var(--sp-2)', fontSize: 'var(--text-sm)' }}>
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={installmentIncludeInactive}
                  onChange={(event) => setInstallmentIncludeInactive(event.target.checked)}
                />
                Mostrar ocultos
              </label>
              <Button variant="primary" icon="plus" onClick={() => setInstallmentModal('new')}>
                Novo parcelamento
              </Button>
            </div>
          )
        }
      />

      <div className="page">
        <Tabs value={tab} onValueChange={(value) => setTab(value as 'ledger' | 'installments')}>
          <TabsList aria-label="Seção">
            <TabsTrigger value="ledger">Lançamentos</TabsTrigger>
            <TabsTrigger value="installments">Parcelamentos</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === 'installments' && (
          <InstallmentsPanel
            rows={installments.data?.installments ?? []}
            isError={installments.isError}
            status={installmentStatus}
            onStatusChange={setInstallmentStatus}
            onEdit={setInstallmentModal}
          />
        )}

        {tab === 'ledger' && (
        <Bento>
          <PeriodFlowCard
            label="Receitas do período"
            confirmedCents={query.data?.inflowCents ?? 0}
            pendingCents={query.data?.pendingInflowCents ?? 0}
            pendingWord="a receber"
          />
          <PeriodFlowCard
            label="Despesas do período"
            confirmedCents={query.data?.outflowCents ?? 0}
            pendingCents={query.data?.pendingOutflowCents ?? 0}
            pendingWord="a pagar"
          />
          <Slab span={4}>
            <StatTile
              label="Resultado"
              value={money((query.data?.inflowCents ?? 0) - (query.data?.outflowCents ?? 0))}
              foot="entradas menos saídas já confirmadas"
              large
            />
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
                    placeholder="Buscar por descrição, TAG ou data…"
                  />
                </div>
                <FilterSelect
                  icon="filter"
                  placeholder="Todas Transações"
                  value={direction}
                  onChange={(value) => {
                    setDirection(value)
                    setPage(0)
                  }}
                  options={[
                    { value: 'in', label: 'Entradas (Receitas)' },
                    { value: 'out', label: 'Saídas (Despesas)' },
                    { value: 'transfer', label: 'Transferências' },
                  ]}
                />
                <div style={{ minWidth: 170 }}>
                  <CategorySelect
                    value={categoryId}
                    onChange={(value) => {
                      setCategoryId(value)
                      setPage(0)
                    }}
                    placeholder="Todas TAGs"
                  />
                </div>
                <div style={{ minWidth: 170 }}>
                  <Select
                    value={sort}
                    onChange={(value) => {
                      setSort(value ?? 'date_desc')
                      setPage(0)
                    }}
                    options={[
                      { value: 'date_desc', label: 'Data (mais recentes)' },
                      { value: 'date_asc', label: 'Data (mais antigas)' },
                      { value: 'amount_desc', label: 'Valor (maior primeiro)' },
                      { value: 'amount_asc', label: 'Valor (menor primeiro)' },
                    ]}
                  />
                </div>
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
                  Só sem TAG
                </label>
                <label className="row" style={{ gap: 'var(--sp-2)', fontSize: 'var(--text-sm)' }}>
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={includeHidden}
                    onChange={(event) => {
                      setIncludeHidden(event.target.checked)
                      setPage(0)
                    }}
                  />
                  Mostrar ocultos
                </label>
                {hasActiveFilters && (
                  <Button variant="quiet" size="sm" icon="x" onClick={clearFilters}>
                    Limpar filtros
                  </Button>
                )}
                {parentCategoryId !== null && (
                  <span className="badge badge--info row" style={{ gap: 'var(--sp-2)' }}>
                    {parentCategoryName ?? `TAG #${parentCategoryId}`}
                    <button
                      type="button"
                      onClick={() => setParentCategoryId(null)}
                      aria-label="Remover filtro de TAG"
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
                  icon="eyeOff"
                  disabled={selected.size === 0 || setHidden.isPending}
                  onClick={() => setHidden.mutate({ ids: [...selected], hidden: !selectionAllHidden })}
                  title={
                    selectionAllHidden
                      ? 'Reexibir na lista'
                      : 'Ocultar da lista, sem apagar nem mudar TAG'
                  }
                >
                  {selectionAllHidden ? 'Reexibir' : 'Ocultar'}
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
                        <th style={{ width: 190 }}>TAG</th>
                        <th style={{ width: 130 }}>Conta</th>
                        <th className="table__num" style={{ width: 128 }}>Valor</th>
                        <th style={{ width: 40 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        // Uma linha MATERIALIZADA (dívida ou previsão recorrente/
                        // parcelada — as duas únicas origens que nascem `pending`)
                        // já confirmada fica opaca para recuar visualmente da que
                        // ainda está pendente, com um rótulo pela direção do dinheiro
                        // em vez de um "paga" genérico que não fazia sentido para uma
                        // receita. Extensão de 04/09/2026 do ajuste de 03/09 (que
                        // cobria só `debtId`) para também cobrir `forecastId` — um
                        // "a receber" recorrente/parcelado que chegou merece o mesmo
                        // tratamento de uma fatura que foi paga.
                        //
                        // Só linhas com essa origem: o resto do ledger é confirmado
                        // por padrão (é a maioria das linhas), e apagar tudo que não
                        // é `previsto` deixaria a tabela inteira esmaecida.
                        const settled = (row.debtId !== null || row.forecastId !== null) && !row.pending
                        const settledLabel = row.direction === 'in' ? 'recebido' : 'pago'
                        return (
                          <tr
                            key={row.id}
                            data-selected={selected.has(row.id)}
                            data-settled={settled}
                            data-hidden={row.hidden}
                          >
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
                                {settled && <span className="badge badge--good">{settledLabel}</span>}
                                {row.duplicateAccepted && <span className="badge badge--warning">duplicata aceita</span>}
                                {row.hidden && <span className="badge">oculto</span>}
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
                            <div className="row" style={{ gap: 'var(--sp-1)' }}>
                              <Button
                                variant="quiet"
                                size="sm"
                                icon="pencil"
                                onClick={() => setEditing(row)}
                                title="Editar lançamento"
                              />
                              <Button
                                variant="quiet"
                                size="sm"
                                icon="eyeOff"
                                disabled={setHidden.isPending}
                                onClick={() => setHidden.mutate({ ids: [row.id], hidden: !row.hidden })}
                                title={row.hidden ? 'Reexibir na lista' : 'Ocultar da lista'}
                              />
                            </div>
                          </td>
                          </tr>
                        )
                      })}
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
        )}
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
      {installmentModal !== null && (
        <InstallmentModal
          installment={installmentModal === 'new' ? null : installmentModal}
          onClose={() => setInstallmentModal(null)}
        />
      )}
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
 * Aba "Parcelamentos" dentro de Lançamentos (revisão de sidebar de
 * 07/09/2026, consolidando a antiga página própria `/parcelamentos`).
 * Sem filtro de período/conta de propósito: uma compra parcelada é um
 * estado corrente (quanto já foi pago de um total fixo), não um recorte
 * de tempo — o mesmo motivo pelo qual a versão antiga nunca usou
 * `RangeFilter`.
 */
function InstallmentsPanel({
  rows,
  isError,
  status,
  onStatusChange,
  onEdit,
}: {
  rows: InstallmentRow[]
  isError: boolean
  status: 'ongoing' | 'finished'
  onStatusChange: (status: 'ongoing' | 'finished') => void
  onEdit: (row: InstallmentRow) => void
}) {
  const filtered = useMemo(
    () => rows.filter((row) => (status === 'ongoing' ? !row.finished : row.finished)),
    [rows, status],
  )
  const ongoingCount = rows.filter((row) => !row.finished).length
  const finishedCount = rows.filter((row) => row.finished).length
  const remainingTotalCents = rows
    .filter((row) => !row.finished)
    .reduce((sum, row) => sum + row.remainingCents, 0)

  return (
    <Bento>
      <Slab span={4}>
        <StatTile label="Em andamento" value={ongoingCount} large />
      </Slab>
      <Slab span={4}>
        <StatTile label="Finalizadas" value={finishedCount} large />
      </Slab>
      <Slab span={4}>
        <StatTile label="Restante a pagar/receber" value={money(remainingTotalCents)} large />
      </Slab>

      <Card
        span={12}
        flush
        title="Compras parceladas"
        actions={
          <Segmented
            ariaLabel="Situação"
            value={status}
            onChange={(value) => onStatusChange(value as 'ongoing' | 'finished')}
            options={[
              { value: 'ongoing', label: 'Em andamento' },
              { value: 'finished', label: 'Finalizadas' },
            ]}
          />
        }
      >
        {isError ? (
          <EmptyState
            icon="alert"
            title="Falha ao carregar parcelamentos"
            body="Não foi possível carregar os parcelamentos agora. Tente novamente em instantes."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="list"
            title={status === 'ongoing' ? 'Nenhum parcelamento em andamento' : 'Nenhum parcelamento finalizado'}
            body="Parcelamentos nascem de uma previsão de fluxo de caixa do tipo parcelado, criada em uma pendência do Painel."
          />
        ) : (
          <div className="stack" style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
            {filtered.map((row) => {
              const progressBps =
                row.installmentCount > 0
                  ? Math.round((row.installmentsRealized / row.installmentCount) * 10_000)
                  : 0
              return (
                <div
                  key={row.id}
                  className="stack stack--tight"
                  style={{
                    padding: 'var(--sp-3) 0',
                    borderBottom: '1px solid var(--line)',
                    opacity: row.active ? 1 : 0.55,
                  }}
                >
                  <div className="row row--between row--wrap">
                    <span className="row" style={{ gap: 'var(--sp-2)', minWidth: 0 }}>
                      <strong className="truncate">{row.description}</strong>
                      {row.categoryName && <span className="badge">{row.categoryName}</span>}
                      {!row.active && <span className="badge">oculto</span>}
                    </span>
                    <span className="row" style={{ gap: 'var(--sp-2)' }}>
                      <span className="tabular" style={{ fontSize: 'var(--text-sm)' }}>
                        {row.installmentsRealized} / {row.installmentCount}x de {money(row.installmentAmountCents)}
                      </span>
                      <Button variant="quiet" size="sm" icon="pencil" onClick={() => onEdit(row)} title="Editar" />
                      <DeleteInstallmentButton installmentId={row.id} description={row.description} />
                    </span>
                  </div>
                  <Meter usedBps={progressBps} state={targetProgressState(progressBps)} />
                  <div className="kv">
                    <span className="kv__k">Total</span>
                    <span className="kv__v">{money(row.totalCents)}</span>
                    <span className="kv__k">{row.direction === 'in' ? 'Recebido' : 'Pago'}</span>
                    <span className="kv__v">{money(row.paidCents)}</span>
                    <span className="kv__k">Restante</span>
                    <span className="kv__v">{money(row.remainingCents)}</span>
                  </div>
                  <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                    {row.accountName ?? 'sem conta'}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </Bento>
  )
}

function DeleteInstallmentButton({ installmentId, description }: { installmentId: number; description: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const remove = useMutation({
    mutationFn: () => api.del(`/cash-flow/forecasts/${installmentId}`),
    onSuccess: () => {
      toast(`${description} removido`)
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
      title="Excluir parcelamento"
    />
  )
}

/**
 * Item 5 do backlog de 07/09/2026 ("faltam as opções de adição de
 * parcelamento com modal de registro, edição e exclusão"). Mesmas rotas de
 * previsão de fluxo de caixa (`POST/PATCH/DELETE /cash-flow/forecasts`)
 * que a Home já usa pra criar uma pendência parcelada (`PendingModal`,
 * Dashboard.tsx) — sempre `kind: 'installment'` aqui, sem o seletor de
 * tipo que aquele modal precisa (recorrente/parcelado/pontual), porque
 * esta tela É a de parcelamentos.
 *
 * `installmentsRealized` só é lido na CRIAÇÃO (ver comentário de
 * `listInstallments` em cashFlow.ts: nada no app avança esse número depois
 * — a contagem real vem das `transactions` confirmadas) — por isso o
 * campo só aparece quando `installment` é `null` (nova compra), nunca na
 * edição de uma já existente.
 */
function InstallmentModal({ installment, onClose }: { installment: InstallmentRow | null; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()

  const [description, setDescription] = useState(installment?.description ?? '')
  const [direction, setDirection] = useState<'in' | 'out'>(installment?.direction ?? 'out')
  const [amount, setAmount] = useState(centsToInput(installment?.installmentAmountCents ?? null))
  const [accountId, setAccountId] = useState<number | null>(installment?.accountId ?? null)
  const [categoryId, setCategoryId] = useState<number | null>(installment?.categoryId ?? null)
  const [installmentCount, setInstallmentCount] = useState(
    installment ? String(installment.installmentCount) : '3',
  )
  const [installmentsRealized, setInstallmentsRealized] = useState('0')
  const [paymentDate, setPaymentDate] = useState(() => {
    if (!installment) return new Date().toISOString().slice(0, 10)
    return `${installment.startPeriod}-${String(installment.dueDay).padStart(2, '0')}`
  })
  const [dueDay, setDueDay] = useState(String(installment?.dueDay ?? 10))

  const save = useMutation({
    mutationFn: () => {
      const rawCents = parseMoneyInput(amount)
      if (rawCents === null || rawCents === 0) throw new Error('informe o valor')
      if (accountId === null) throw new Error('escolha a conta')
      const amountCents = direction === 'in' ? Math.abs(rawCents) : -Math.abs(rawCents)
      const count = Math.max(1, Math.round(Number(installmentCount)) || 1)
      if (installment) {
        return api.patch(`/cash-flow/forecasts/${installment.id}`, {
          description: description.trim(),
          amountCents,
          accountId,
          categoryId,
          dueDay: Math.min(31, Math.max(1, Math.round(Number(dueDay)) || 10)),
          installmentCount: count,
        })
      }
      return api.post('/cash-flow/forecasts', {
        description: description.trim(),
        kind: 'installment',
        amountCents,
        accountId,
        categoryId,
        startPeriod: paymentDate.slice(0, 7),
        dueDay: Number(paymentDate.slice(8, 10)),
        installmentCount: count,
        installmentsRealized: Math.max(0, Math.round(Number(installmentsRealized)) || 0),
      })
    },
    onSuccess: () => {
      toast(installment ? 'Parcelamento atualizado' : 'Parcelamento cadastrado')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title={installment ? `Editar ${installment.description}` : 'Novo parcelamento'}
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
            disabled={!description.trim() || save.isPending}
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label className="field__label">Descrição</label>
            <TextInput value={description} onChange={setDescription} placeholder="ex. Notebook em 12x" />
          </div>
          <div className="field" style={{ minWidth: 170 }}>
            <label className="field__label">Direção</label>
            <Segmented
              ariaLabel="Direção"
              value={direction}
              onChange={setDirection}
              options={[
                { value: 'out', label: 'Saída (compra)' },
                { value: 'in', label: 'Entrada (a receber)' },
              ]}
            />
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Valor por parcela (R$)</label>
            <TextInput value={amount} onChange={setAmount} placeholder="0,00" numeral />
          </div>
          {installment ? (
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label">Dia de vencimento</label>
              <TextInput value={dueDay} onChange={setDueDay} placeholder="ex. 10" numeral />
            </div>
          ) : (
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label">Data de pagamento</label>
              <TextInput value={paymentDate} onChange={setPaymentDate} type="date" />
              <span className="field__hint">O dia (não o mês) se repete nas próximas parcelas.</span>
            </div>
          )}
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 170 }}>
            <label className="field__label">Conta</label>
            <Select
              value={accountId}
              placeholder="Selecione"
              options={(accounts.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
              onChange={setAccountId}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 170 }}>
            <label className="field__label">TAG (opcional)</label>
            <CategorySelect value={categoryId} direction={direction === 'in' ? 'in' : 'out'} onChange={setCategoryId} />
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Total de parcelas</label>
            <TextInput value={installmentCount} onChange={setInstallmentCount} placeholder="ex. 12" numeral />
          </div>
          {!installment && (
            <div className="field" style={{ flex: 1, minWidth: 150 }}>
              <label className="field__label">Parcelas já confirmadas/recebidas</label>
              <TextInput value={installmentsRealized} onChange={setInstallmentsRealized} placeholder="ex. 1" numeral />
              <span className="field__hint">A pendência só materializa as parcelas futuras, a partir da próxima.</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Pago e pendente do mesmo período, juntos — antes eram quatro cards
 * soltos ("Entradas", "Saídas", "Resultado", e um quarto que virava "A
 * pagar" ou "A receber" conforme o filtro de direção, nunca os dois ao
 * mesmo tempo), sem nenhuma ligação visual entre o que já aconteceu e o
 * que ainda falta da mesma conta. Pedido do usuário, 04/09/2026.
 *
 * `Meter` aqui não julga nada (por isso `state="no_target"`, o mesmo
 * neutro que a barra de progresso de uma meta sem alvo usa): não existe
 * "bom" ou "ruim" em ter pendências no período, só o fato de quanto já
 * está resolvido contra o total.
 */
function PeriodFlowCard({
  label,
  confirmedCents,
  pendingCents,
  pendingWord,
}: {
  label: string
  confirmedCents: number
  pendingCents: number
  pendingWord: 'a pagar' | 'a receber'
}) {
  const totalCents = confirmedCents + pendingCents
  const confirmedBps = totalCents > 0 ? Math.round((confirmedCents / totalCents) * 10_000) : 0

  return (
    <Slab span={4}>
      <div className="stack stack--tight">
        <div className="row row--between">
          <span className="stat__label">{label}</span>
          <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
            {money(totalCents)} no total
          </span>
        </div>
        <span className="stat__value">{money(confirmedCents)}</span>
        <Meter usedBps={confirmedBps} state="no_target" />
        <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
          {pendingCents > 0 ? `${money(pendingCents)} ${pendingWord}` : `nada ${pendingWord} no período`}
        </span>
      </div>
    </Slab>
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
  const [creditCardId, setCreditCardId] = useState<number | null>(row.creditCardId)

  const cards = useQuery({
    queryKey: ['credit-cards'],
    queryFn: () => api.get<{ cards: Array<{ id: number; name: string }> }>('/credit-cards'),
  })

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
      if (creditCardId !== row.creditCardId) {
        await api.post('/transactions/credit-card', { ids: [row.id], creditCardId })
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
        <div className="field" style={{ marginTop: 'var(--sp-3)' }}>
          <label className="field__label">Cartão de crédito</label>
          <Select
            value={creditCardId}
            placeholder="Nenhum"
            options={(cards.data?.cards ?? []).map((c) => ({ value: c.id, label: c.name }))}
            onChange={setCreditCardId}
          />
          <span className="field__hint">
            Liga esta compra a um cartão, para ela entrar na fatura em Cartões. Nunca é ligado sozinho.
          </span>
        </div>
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
        <label className="field__label">TAG</label>
        <CategorySelect
          value={categoryId}
          placeholder="Remover TAG"
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
