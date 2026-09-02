import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, fileToBase64 } from '../lib/api'
import { telemetry } from '../lib/telemetry'
import { useAccounts } from '../lib/store'
import { date as fmtDate, money } from '../lib/format'
import {
  Bento,
  Button,
  Card,
  CategorySelect,
  EmptyState,
  Icon,
  Select,
  SkeletonLines,
  StatTile,
  useToast,
} from '../components/ui'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { PageHeader } from '../components/shell/Shell'

type Detection = {
  filename: string
  profileId: number | null
  profileName: string | null
  score: number
  matched: string[]
  missing: string[]
  headers: string[]
  delimiter: string
  detectedEncoding: string
  encodingMismatch: boolean
  headerRow: number
  suggestedSkipRows: number
  suggestedAccountId: number | null
}

type StagedRow = {
  id: number
  rowIndex: number
  postedOn: string | null
  description: string
  amountCents: number | null
  rawCategory: string | null
  duplicateOf: 'none' | 'in_batch' | 'in_ledger'
  duplicateTxnId: number | null
  possibleManualMatchId: number | null
  replaceManualMatch: boolean
  manualMatchDescription: string | null
  manualMatchPostedOn: string | null
  suggestedCategoryId: number | null
  suggestionSource: string
  suggestionDetail: string | null
  categoryId: number | null
  include: boolean
  parseError: string | null
  rawLine: string | null
}

type BatchView = {
  batch: { id: number; filename: string; profileName: string | null; accountId: number; status: string }
  rows: StagedRow[]
  summary: { total: number; includable: number; duplicates: number; errors: number; uncategorized: number }
}

type QueueItem = {
  key: string
  filename: string
  base64: string
  detection: Detection | null
  profileId: number | null
  accountId: number | null
  error: string | null
}

export function ImportPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()
  const inputRef = useRef<HTMLInputElement>(null)

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [dragging, setDragging] = useState(false)
  const [activeBatchId, setActiveBatchId] = useState<number | null>(null)

  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<{ profiles: Array<{ id: number; name: string; institution: string }> }>('/profiles'),
  })

  const batches = useQuery({
    queryKey: ['imports'],
    queryFn: () =>
      api.get<{
        batches: Array<{
          id: number
          filename: string
          status: string
          rowCount: number
          duplicateCount: number
          errorCount: number
          committedCount: number
          createdAt: string
          profileName: string | null
        }>
      }>('/imports'),
  })

  async function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files).filter((file) => /\.(csv|txt)$/i.test(file.name))
    if (incoming.length === 0) {
      toast('Selecione arquivos .csv', 'error')
      return
    }

    for (const file of incoming) {
      const key = `${file.name}-${file.size}-${queue.length}-${file.lastModified}`
      try {
        const base64 = await fileToBase64(file)
        const detection = await api.post<Detection>('/imports/detect', {
          filename: file.name,
          contentBase64: base64,
        })
        setQueue((current) => [
          ...current,
          {
            key,
            filename: file.name,
            base64,
            detection,
            profileId: detection.profileId,
            accountId: detection.suggestedAccountId,
            error: null,
          },
        ])
      } catch (error) {
        setQueue((current) => [
          ...current,
          {
            key,
            filename: file.name,
            base64: '',
            detection: null,
            profileId: null,
            accountId: null,
            error: error instanceof Error ? error.message : 'falha ao ler o arquivo',
          },
        ])
      }
    }
  }

  const stage = useMutation({
    mutationFn: async (item: QueueItem) => {
      if (!item.profileId || !item.accountId) throw new Error('escolha o banco e a conta')
      return api.post<{ batchId: number; parsedCount: number; duplicateCount: number; errorCount: number; ignoredCount: number }>(
        '/imports/stage',
        {
          filename: item.filename,
          contentBase64: item.base64,
          profileId: item.profileId,
          accountId: item.accountId,
        },
      )
    },
    onSuccess: (result, item) => {
      setQueue((current) => current.filter((q) => q.key !== item.key))
      setActiveBatchId(result.batchId)
      queryClient.invalidateQueries({ queryKey: ['imports'] })
      toast(
        `${item.filename}: ${result.parsedCount} linhas lidas, ${result.duplicateCount} duplicatas, ${result.ignoredCount} ignoradas`,
      )
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao processar', 'error'),
  })

  const accountOptions = (accounts.data?.accounts ?? []).map((account) => ({
    value: account.id,
    label: `${account.name} · ${account.institution}`,
  }))
  const profileOptions = (profiles.data?.profiles ?? []).map((profile) => ({
    value: profile.id,
    label: profile.name,
  }))

  return (
    <>
      <PageHeader
        title="Importar CSV"
        subtitle="Detecta o banco, normaliza os dados e mostra tudo antes de gravar"
        actions={
          <Button icon="refresh" onClick={() => batches.refetch()}>
            Atualizar
          </Button>
        }
      />

      <div className="page">
        <Bento>
          <Card span={6} title="Enviar extratos" subtitle="Vários arquivos e vários bancos de uma vez">
            <div
              className="dropzone"
              data-over={dragging}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                void addFiles(event.dataTransfer.files)
              }}
            >
              <div className="stack" style={{ alignItems: 'center', gap: 'var(--sp-2)' }}>
                <span className="muted">
                  <Icon name="upload" size={24} strokeWidth={1.5} />
                </span>
                <strong>Arraste os CSVs aqui</strong>
                <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
                  ou clique para escolher, nada é gravado antes da sua revisão
                </span>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                multiple
                className="sr-only"
                onChange={(event) => {
                  if (event.target.files) void addFiles(event.target.files)
                  event.target.value = ''
                }}
              />
            </div>

            {queue.length > 0 && (
              <div className="stack">
                {queue.map((item) => (
                  <div key={item.key} className="card card--muted" style={{ padding: 'var(--sp-4)', gap: 'var(--sp-3)' }}>
                    <div className="row row--between row--wrap">
                      <span className="row">
                        <Icon name="file" size={15} />
                        <strong>{item.filename}</strong>
                      </span>
                      {item.detection && (
                        <span className={`badge ${item.detection.profileId ? 'badge--good' : 'badge--warning'}`}>
                          <Icon name={item.detection.profileId ? 'check' : 'alert'} size={11} strokeWidth={2.4} />
                          {item.detection.profileId
                            ? `${item.detection.profileName} · ${Math.round(item.detection.score * 100)}% do cabeçalho`
                            : 'Banco não reconhecido'}
                        </span>
                      )}
                    </div>

                    {item.error ? (
                      <p className="field__error">{item.error}</p>
                    ) : (
                      <>
                        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
                          <div style={{ minWidth: 220, flex: 1 }}>
                            <label className="field__label">Perfil do banco</label>
                            <Select
                              value={item.profileId}
                              placeholder="Escolha o banco"
                              options={profileOptions}
                              onChange={(value) =>
                                setQueue((current) =>
                                  current.map((q) => (q.key === item.key ? { ...q, profileId: value } : q)),
                                )
                              }
                            />
                          </div>
                          <div style={{ minWidth: 220, flex: 1 }}>
                            <label className="field__label">Conta de destino</label>
                            <Select
                              value={item.accountId}
                              placeholder="Escolha a conta"
                              options={accountOptions}
                              onChange={(value) =>
                                setQueue((current) =>
                                  current.map((q) => (q.key === item.key ? { ...q, accountId: value } : q)),
                                )
                              }
                            />
                          </div>
                        </div>

                        {item.detection?.encodingMismatch && (
                          <p className="field__hint">
                            O arquivo parece estar em {item.detection.detectedEncoding}, diferente do
                            que o perfil declara. A leitura usa o perfil; se acentos saírem
                            errados, ajuste a codificação em Contas e bancos.
                          </p>
                        )}

                        {item.detection && !item.detection.profileId && (
                          <p className="field__hint">
                            Cabeçalho lido: {item.detection.headers.join(' · ') || '(vazio)'}
                          </p>
                        )}

                        {item.detection && item.detection.suggestedSkipRows > 0 && (
                          <p className="field__hint">
                            O cabeçalho está na linha {item.detection.headerRow + 1}, as{' '}
                            {item.detection.suggestedSkipRows} linhas de preâmbulo antes dele são
                            puladas pelo perfil.
                          </p>
                        )}

                        <div className="row">
                          <Button
                            variant="primary"
                            size="sm"
                            icon="check"
                            disabled={!item.profileId || !item.accountId || stage.isPending}
                            onClick={() => stage.mutate(item)}
                          >
                            Processar e revisar
                          </Button>
                          <Button
                            variant="quiet"
                            size="sm"
                            onClick={() => setQueue((current) => current.filter((q) => q.key !== item.key))}
                          >
                            Remover
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card span={6} title="Como a importação funciona">
            <ol className="stack" style={{ gap: 'var(--sp-4)', counterReset: 'step' }}>
              {[
                ['Detecção', 'O cabeçalho do arquivo é comparado com a assinatura de cada perfil de banco cadastrado.'],
                ['Normalização', 'Datas viram ISO, valores viram centavos inteiros e o sinal segue a convenção do banco (valor assinado, débito/crédito ou coluna D/C).'],
                ['Deduplicação', 'Cada linha ganha uma impressão digital de conta + data + valor + descrição. Repetições no arquivo e no que já existe são marcadas.'],
                ['Revisão', 'Você vê tudo, ajusta categorias na tabela e decide o que entra. Só então grava.'],
              ].map(([title, body], index) => (
                <li key={title} className="row" style={{ alignItems: 'flex-start', gap: 'var(--sp-3)' }}>
                  <span
                    className="numeral"
                    style={{
                      background: 'var(--surface-muted)',
                      borderRadius: 'var(--r-sm)',
                      width: 24,
                      height: 24,
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 'var(--text-xs)',
                      flex: 'none',
                    }}
                  >
                    {index + 1}
                  </span>
                  <span>
                    <strong style={{ display: 'block', fontSize: 'var(--text-sm)' }}>{title}</strong>
                    <span className="muted" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>{body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>

          <Card span={12} title="Importações anteriores" flush>
            {batches.isError ? (
              <EmptyState
                icon="alert"
                title="Falha ao carregar importações"
                body="Não foi possível carregar o histórico agora. Tente novamente em instantes."
              />
            ) : (batches.data?.batches ?? []).length === 0 ? (
              <EmptyState icon="clock" title="Nenhuma importação ainda" body="O histórico aparece aqui." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Arquivo</th>
                      <th>Banco</th>
                      <th>Status</th>
                      <th className="table__num">Linhas</th>
                      <th className="table__num">Duplicatas</th>
                      <th className="table__num">Erros</th>
                      <th className="table__num">Gravadas</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(batches.data?.batches ?? []).map((batch) => (
                      <tr key={batch.id}>
                        <td className="truncate" style={{ maxWidth: 280 }}>{batch.filename}</td>
                        <td className="muted">{batch.profileName ?? '-'}</td>
                        <td>
                          <span
                            className={`badge ${
                              batch.status === 'committed'
                                ? 'badge--good'
                                : batch.status === 'staged'
                                  ? 'badge--info'
                                  : ''
                            }`}
                          >
                            {batch.status === 'committed'
                              ? 'Importado'
                              : batch.status === 'staged'
                                ? 'Aguardando revisão'
                                : 'Descartado'}
                          </span>
                        </td>
                        <td className="table__num">{batch.rowCount}</td>
                        <td className="table__num">{batch.duplicateCount}</td>
                        <td className="table__num">{batch.errorCount}</td>
                        <td className="table__num">{batch.committedCount}</td>
                        <td className="table__num">
                          {batch.status === 'staged' ? (
                            <Button size="sm" onClick={() => setActiveBatchId(batch.id)}>
                              Revisar
                            </Button>
                          ) : batch.status === 'committed' ? (
                            <RevertButton batchId={batch.id} />
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </Bento>
      </div>

      {activeBatchId !== null && (
        <ReviewModal batchId={activeBatchId} onClose={() => setActiveBatchId(null)} />
      )}
    </>
  )
}

function RevertButton({ batchId }: { batchId: number }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const revert = useMutation({
    mutationFn: () => api.post<{ removed: number }>(`/imports/${batchId}/revert`),
    onSuccess: (result) => {
      toast(`${result.removed} lançamentos removidos do ledger`)
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao desfazer', 'error'),
  })
  return (
    <Button variant="danger" size="sm" icon="trash" disabled={revert.isPending} onClick={() => revert.mutate()}>
      Desfazer
    </Button>
  )
}

/* ------------------------------------------------------------------ *
 * Review screen — the gate between a parsed file and the ledger.
 * ------------------------------------------------------------------ */
function ReviewModal({ batchId, onClose }: { batchId: number; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<'all' | 'problems' | 'uncategorized'>('all')

  const batch = useQuery({
    queryKey: ['imports', batchId],
    queryFn: () => api.get<BatchView>(`/imports/${batchId}`),
  })

  const patch = useMutation({
    mutationFn: (
      patches: Array<{ id: number; categoryId?: number | null; include?: boolean; replaceManualMatch?: boolean }>,
    ) => api.patch<BatchView>(`/imports/${batchId}/rows`, { patches }),
    onSuccess: (data) => queryClient.setQueryData(['imports', batchId], data),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const commit = useMutation({
    mutationFn: () => api.post<{ committed: number; skipped: number }>(`/imports/${batchId}/commit`),
    onSuccess: (result) => {
      telemetry.action('import', 'csv_committed', { committed: result.committed, skipped: result.skipped })
      toast(`${result.committed} lançamentos gravados, ${result.skipped} ignorados`)
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao gravar', 'error'),
  })

  const discard = useMutation({
    mutationFn: () => api.post(`/imports/${batchId}/discard`),
    onSuccess: () => {
      toast('Lote descartado')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao descartar', 'error'),
  })

  const rows = batch.data?.rows ?? []
  const visible = useMemo(() => {
    if (filter === 'problems') return rows.filter((r) => r.parseError !== null || r.duplicateOf !== 'none')
    if (filter === 'uncategorized') return rows.filter((r) => r.categoryId === null && r.parseError === null)
    return rows
  }, [rows, filter])

  const summary = batch.data?.summary

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[880px]">
        <DialogTitle>{`Revisar: ${batch.data?.batch.filename ?? ''}`}</DialogTitle>
      {!batch.data ? (
        <SkeletonLines lines={5} />
      ) : (
        <>
          <div className="bento" style={{ gap: 'var(--sp-3)' }}>
            <Card span={3} muted>
              <StatTile label="Linhas lidas" value={summary!.total} />
            </Card>
            <Card span={3} muted>
              <StatTile label="Vão entrar" value={summary!.includable} />
            </Card>
            <Card span={3} muted>
              <StatTile label="Duplicatas" value={summary!.duplicates} />
            </Card>
            <Card span={3} muted>
              <StatTile label="Sem categoria" value={summary!.uncategorized} />
            </Card>
          </div>

          <div className="row row--between row--wrap">
            <Tabs value={filter} onValueChange={(value) => setFilter(value as typeof filter)}>
              <TabsList aria-label="Filtrar linhas">
                <TabsTrigger value="all">{`Todas (${rows.length})`}</TabsTrigger>
                <TabsTrigger value="problems">{`Atenção (${summary!.duplicates + summary!.errors})`}</TabsTrigger>
                <TabsTrigger value="uncategorized">{`Sem categoria (${summary!.uncategorized})`}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="row">
              <Button
                size="sm"
                onClick={() =>
                  patch.mutate(
                    visible
                      .filter((r) => r.parseError === null)
                      .map((r) => ({ id: r.id, include: true })),
                  )
                }
              >
                Marcar visíveis
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  patch.mutate(
                    rows.filter((r) => r.duplicateOf !== 'none').map((r) => ({ id: r.id, include: false })),
                  )
                }
              >
                Desmarcar duplicatas
              </Button>
            </div>
          </div>

          <div
            className="table-wrap"
            style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}
          >
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <span className="sr-only">Incluir</span>
                  </th>
                  <th style={{ width: 96 }}>Data</th>
                  <th>Descrição</th>
                  <th className="table__num" style={{ width: 116 }}>Valor</th>
                  <th style={{ width: 210 }}>Categoria</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.id}
                    className={
                      row.parseError
                        ? 'table__row--error'
                        : row.duplicateOf !== 'none'
                          ? 'table__row--dup'
                          : undefined
                    }
                  >
                    <td>
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={row.include}
                        disabled={row.parseError !== null}
                        onChange={(event) => patch.mutate([{ id: row.id, include: event.target.checked }])}
                        aria-label={`Incluir linha ${row.rowIndex}`}
                      />
                    </td>
                    <td className="tabular">{row.postedOn ? fmtDate(row.postedOn) : '-'}</td>
                    <td style={{ maxWidth: 300 }}>
                      <div className="truncate" title={row.description}>
                        {row.description || <span className="muted">(vazio)</span>}
                      </div>
                      {row.parseError && (
                        <div className="field__error">
                          linha {row.rowIndex}: {row.parseError}
                        </div>
                      )}
                      {row.duplicateOf !== 'none' && (
                        <div className="field__hint">
                          {row.duplicateOf === 'in_ledger'
                            ? 'já existe no ledger'
                            : 'repetida dentro deste arquivo'}
                        </div>
                      )}
                      {row.possibleManualMatchId !== null && (
                        <div className="field__hint" style={{ color: 'var(--status-warning)' }}>
                          <label className="row" style={{ gap: 'var(--sp-1)', alignItems: 'center' }}>
                            <input
                              type="checkbox"
                              className="checkbox"
                              checked={row.replaceManualMatch}
                              onChange={(event) =>
                                patch.mutate([{ id: row.id, replaceManualMatch: event.target.checked }])
                              }
                            />
                            <span>
                              possível mesmo evento de "{row.manualMatchDescription}"
                              {row.manualMatchPostedOn ? `, ${fmtDate(row.manualMatchPostedOn)}` : ''} — marcar
                              pra substituir o lançamento manual
                            </span>
                          </label>
                        </div>
                      )}
                      {row.suggestionDetail && row.categoryId === row.suggestedCategoryId && (
                        <div className="field__hint">{row.suggestionDetail}</div>
                      )}
                    </td>
                    <td
                      className={`table__num ${row.amountCents !== null && row.amountCents < 0 ? 'neg' : 'pos'}`}
                    >
                      {row.amountCents === null ? '-' : money(row.amountCents)}
                    </td>
                    <td>
                      <CategorySelect
                        bare
                        value={row.categoryId}
                        direction={row.amountCents === null ? undefined : row.amountCents < 0 ? 'out' : 'in'}
                        onChange={(value) => patch.mutate([{ id: row.id, categoryId: value }])}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="chart__note">
            Linhas com erro de leitura nunca são gravadas, mas ficam visíveis aqui para você ver
            exatamente o que o banco exportou fora do padrão.
          </p>
        </>
      )}
        <DialogFooter>
          <Button variant="danger" icon="trash" onClick={() => discard.mutate()} disabled={discard.isPending}>
            Descartar lote
          </Button>
          <Button
            variant="primary"
            icon="check"
            onClick={() => commit.mutate()}
            disabled={commit.isPending || (summary?.includable ?? 0) === 0}
          >
            Gravar {summary?.includable ?? 0} lançamentos
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
