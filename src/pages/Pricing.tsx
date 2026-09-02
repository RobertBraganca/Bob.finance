import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAccounts } from '../lib/store'
import { telemetry } from '../lib/telemetry'
import {
  bps,
  bpsToInput,
  centsToInput,
  date as fmtDate,
  money,
  parseMoneyInput,
  parsePercentInput,
} from '../lib/format'
import {
  Assumptions,
  Bento,
  Button,
  Card,
  EmptyState,
  Modal,
  Segmented,
  Select,
  Slab,
  SkeletonLines,
  TextInput,
  useToast,
  type AssumptionBag,
} from '../components/ui'
import { PageHeader } from '../components/shell/Shell'

const QUOTE_STATUSES = ['draft', 'sent', 'in_review', 'needs_changes', 'rejected', 'approved'] as const
type QuoteStatus = (typeof QUOTE_STATUSES)[number]

/** Tom da pill de status: aprovada é o único desfecho bom, rejeitada o único ruim; o resto é caminho, não veredito. */
const QUOTE_STATUS_TONE: Record<QuoteStatus, 'good' | 'warning' | 'critical' | 'neutral'> = {
  draft: 'neutral',
  sent: 'neutral',
  in_review: 'neutral',
  needs_changes: 'warning',
  rejected: 'critical',
  approved: 'good',
}

const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Rascunho',
  sent: 'Enviada',
  in_review: 'Em revisão',
  needs_changes: 'Em ajuste',
  rejected: 'Reprovada',
  approved: 'Aprovada',
}

/**
 * Precificação de projetos.
 *
 * The two numbers on screen are a floor and a scenario, never an
 * instruction: the copy says what the configured parameters produce, and the
 * "como calculamos" disclosure carries the whole chain back to the
 * break-even the motor financeiro already shows (ADR 0010 / 0012).
 */

type MultiplierOption = {
  id: number
  dimension: string
  label: string
  description: string | null
  multiplierBps: number
  sortOrder: number
  active: boolean
}

type MultipliersResponse = {
  multipliers: MultiplierOption[]
  byDimension: Record<string, MultiplierOption[]>
  dimensions: Array<{ value: string; label: string }>
}

type Simulation = {
  hourlyBaseCents: number
  minimumPriceCents: number
  recommendedPriceCents: number
  premiumPriceCents: number
  breakdown: {
    period: string
    breakEvenCents: number
    billableHours: number
    directCostsCents: number
    combinedMultiplierBps: number
    taxRateBps: number
    extraMarginBps: number
  }
  multipliers: Array<{ dimension: string; dimensionLabel: string; label: string; multiplierBps: number }>
  assumptions: AssumptionBag
}

type Quote = {
  id: number
  clientLabel: string
  estimatedHours: number
  directCosts: Array<{ label: string; amountCents: number }>
  complexityOptionId: number | null
  urgencyOptionId: number | null
  clientSizeOptionId: number | null
  usageRightsOptionId: number | null
  extraMarginBps: number
  hourlyBaseCents: number
  minimumPriceCents: number
  recommendedPriceCents: number
  premiumPriceCents: number
  actualPriceCents: number | null
  installments: number
  paymentTerms: string | null
  status: QuoteStatus
  createdAt: string
  updatedAt: string
}

type PricingSettings = { availableHoursPerMonth: number; billablePercentageBps: number }

type DirectCostDraft = { label: string; value: string }

export function PricingPage() {
  const [tab, setTab] = useState<'simular' | 'historico' | 'parametros'>('simular')

  return (
    <>
      <PageHeader
        title="Precificação"
        subtitle="Quanto cobrar por um projeto, a partir do seu próprio custo de operar"
        actions={
          <Segmented
            ariaLabel="Seção"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'simular', label: 'Simular' },
              { value: 'historico', label: 'Histórico' },
              { value: 'parametros', label: 'Parâmetros' },
            ]}
          />
        }
      />
      <div className="page">
        {tab === 'simular' ? <SimulateTab /> : tab === 'historico' ? <QuotesTab /> : <ParamsTab />}
      </div>
    </>
  )
}

/**
 * Campos de entrada de uma simulação — horas, margem, multiplicadores,
 * custos diretos. Compartilhado entre "Simular" (SimulateTab) e o modal de
 * edição de uma cotação salva (EditQuoteModal, `decisions/0021`): os dois
 * editam o mesmo conjunto de campos, um formulário só, nunca dois que podem
 * divergir.
 */
function QuoteFormFields({
  hours,
  setHours,
  margin,
  setMargin,
  selected,
  setSelected,
  costs,
  setCosts,
}: {
  hours: string
  setHours: (v: string) => void
  margin: string
  setMargin: (v: string) => void
  selected: Record<string, number | null>
  setSelected: (updater: (prev: Record<string, number | null>) => Record<string, number | null>) => void
  costs: DirectCostDraft[]
  setCosts: (updater: (prev: DirectCostDraft[]) => DirectCostDraft[]) => void
}) {
  const multipliers = useQuery({
    queryKey: ['pricing-multipliers'],
    queryFn: () => api.get<MultipliersResponse>('/pricing/multipliers'),
  })
  const dimensions = multipliers.data?.dimensions ?? []
  const byDimension = multipliers.data?.byDimension ?? {}

  return (
    <>
      <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
        <div className="field" style={{ width: 150 }}>
          <label className="field__label">Horas estimadas</label>
          <TextInput value={hours} onChange={setHours} numeral />
        </div>
        <div className="field" style={{ width: 150 }}>
          <label className="field__label">Margem extra (%)</label>
          <TextInput value={margin} onChange={setMargin} numeral placeholder="0" />
          <span className="field__hint">Deste projeto, além da margem mensal</span>
        </div>
      </div>

      <div className="stack stack--tight">
        <span className="label">Multiplicadores</span>
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
          {dimensions.map((dim) => (
            <div className="field" key={dim.value} style={{ minWidth: 190, flex: 1 }}>
              <label className="field__label">{dim.label}</label>
              <Select
                value={selected[dim.value] ?? null}
                placeholder="Não informado (1,0x)"
                options={(byDimension[dim.value] ?? []).map((o) => ({
                  value: o.id,
                  label: `${o.label} (${(o.multiplierBps / 10_000).toLocaleString('pt-BR')}x)`,
                }))}
                onChange={(value) => setSelected((prev) => ({ ...prev, [dim.value]: value }))}
              />
            </div>
          ))}
        </div>
        <p className="chart__note">
          Uma dimensão sem opção escolhida vale 1,0x e não altera o resultado.
        </p>
      </div>

      <div className="stack stack--tight">
        <div className="row row--between">
          <span className="label">Custos diretos</span>
          <Button size="sm" icon="plus" onClick={() => setCosts((prev) => [...prev, { label: '', value: '' }])}>
            Adicionar
          </Button>
        </div>
        {costs.length === 0 ? (
          <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            Nenhum custo direto. Licenças, banco de imagens, impressão ou qualquer valor que sai do
            projeto entram aqui e são somados antes dos multiplicadores.
          </p>
        ) : (
          costs.map((cost, index) => (
            <div key={index} className="row" style={{ gap: 'var(--sp-2)' }}>
              <TextInput
                value={cost.label}
                onChange={(v) => setCosts((prev) => prev.map((c, i) => (i === index ? { ...c, label: v } : c)))}
                placeholder="Descrição"
              />
              <div style={{ width: 140 }}>
                <TextInput
                  value={cost.value}
                  onChange={(v) => setCosts((prev) => prev.map((c, i) => (i === index ? { ...c, value: v } : c)))}
                  placeholder="0,00"
                  numeral
                />
              </div>
              <Button
                variant="quiet"
                size="sm"
                icon="trash"
                title="Remover custo"
                onClick={() => setCosts((prev) => prev.filter((_, i) => i !== index))}
              />
            </div>
          ))
        )}
      </div>
    </>
  )
}

/* ================================================================== *
 * Simular
 * ================================================================== */
function SimulateTab() {
  const toast = useToast()
  const queryClient = useQueryClient()

  const [hours, setHours] = useState('10')
  const [costs, setCosts] = useState<DirectCostDraft[]>([])
  const [selected, setSelected] = useState<Record<string, number | null>>({})
  const [margin, setMargin] = useState('')
  const [result, setResult] = useState<Simulation | null>(null)
  const [saving, setSaving] = useState(false)

  const body = () => ({
    estimatedHours: Number(hours.replace(',', '.')),
    directCosts: costs
      .map((c) => ({ label: c.label.trim() || 'Custo direto', amountCents: parseMoneyInput(c.value) ?? 0 }))
      .filter((c) => c.amountCents !== 0),
    complexityOptionId: selected.complexity ?? null,
    urgencyOptionId: selected.urgency ?? null,
    clientSizeOptionId: selected.client_size ?? null,
    usageRightsOptionId: selected.usage_rights ?? null,
    extraMarginBps: margin.trim() === '' ? 0 : (parsePercentInput(margin) ?? 0),
  })

  const simulate = useMutation({
    mutationFn: () => api.post<Simulation>('/pricing/simulate', body()),
    onSuccess: (data) => setResult(data),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao simular', 'error'),
  })

  const hoursValid = Number.isFinite(Number(hours.replace(',', '.'))) && Number(hours.replace(',', '.')) > 0

  return (
    <Bento>
      <Card span={7} title="Projeto a simular">
        <div className="stack stack--loose">
          <QuoteFormFields
            hours={hours}
            setHours={setHours}
            margin={margin}
            setMargin={setMargin}
            selected={selected}
            setSelected={setSelected}
            costs={costs}
            setCosts={setCosts}
          />

          <div className="row">
            <Button
              variant="primary"
              icon="sparkle"
              disabled={!hoursValid || simulate.isPending}
              onClick={() => simulate.mutate()}
            >
              Calcular
            </Button>
            {result && (
              <Button icon="check" onClick={() => setSaving(true)}>
                Salvar como cotação
              </Button>
            )}
          </div>
        </div>
      </Card>

      {result ? (
        <>
          <Slab span={5} accent>
            <div className="stack">
              <div className="stack stack--tight">
                <span className="stat__label">Preço recomendado</span>
                <span className="hero-figure">{money(result.recommendedPriceCents)}</span>
              </div>
              <hr className="divider" />
              <div className="kv">
                <span className="kv__k" style={{ color: 'var(--on-slab-2)' }}>
                  Preço mínimo
                </span>
                <span className="kv__v">{money(result.minimumPriceCents)}</span>
                <span className="kv__k" style={{ color: 'var(--on-slab-2)' }}>
                  Preço premium
                </span>
                <span className="kv__v">{money(result.premiumPriceCents)}</span>
                <span className="kv__k" style={{ color: 'var(--on-slab-2)' }}>
                  Hora base
                </span>
                <span className="kv__v">{money(result.hourlyBaseCents)}</span>
              </div>
              <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-xs)' }}>
                Considerando os parâmetros configurados, o preço mínimo é {money(result.minimumPriceCents)},{' '}
                o recomendado é {money(result.recommendedPriceCents)} e uma referência premium (30% acima do
                recomendado) é {money(result.premiumPriceCents)}, três pontos de ancoragem: a decisão de
                quanto cobrar continua sua.
              </p>
            </div>
          </Slab>

          <Card span={12} title="Como chegamos a esse preço">
            <div className="kv">
              <span className="kv__k">Ponto de equilíbrio do mês</span>
              <span className="kv__v">{money(result.breakdown.breakEvenCents)}</span>
              <span className="kv__k">Horas faturáveis no mês</span>
              <span className="kv__v">{result.breakdown.billableHours.toLocaleString('pt-BR')}</span>
              <span className="kv__k">Hora base</span>
              <span className="kv__v">{money(result.hourlyBaseCents)}</span>
              <span className="kv__k">Preço mínimo (horas × hora base)</span>
              <span className="kv__v">{money(result.minimumPriceCents)}</span>
              <span className="kv__k">Custos diretos</span>
              <span className="kv__v">{money(result.breakdown.directCostsCents)}</span>
              <span className="kv__k">Multiplicador combinado</span>
              <span className="kv__v">
                {(result.breakdown.combinedMultiplierBps / 10_000).toLocaleString('pt-BR')}x
              </span>
              <span className="kv__k">Alíquota embutida no preço</span>
              <span className="kv__v">{bps(result.breakdown.taxRateBps)}</span>
              <span className="kv__k">Margem extra do projeto</span>
              <span className="kv__v">{bps(result.breakdown.extraMarginBps)}</span>
              <span className="kv__k">Preço premium (recomendado × 1,3)</span>
              <span className="kv__v">{money(result.premiumPriceCents)}</span>
            </div>
            <hr className="divider" />
            <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
              {result.multipliers.map((m) => (
                <span key={m.dimension} className="badge">
                  {m.dimensionLabel}: {m.label} ({(m.multiplierBps / 10_000).toLocaleString('pt-BR')}x)
                </span>
              ))}
            </div>
            <p className="chart__note">
              O preço mínimo nunca é reescrito por multiplicador: mesmo que a combinação puxe o
              recomendado para baixo, o mínimo continua sendo o piso técnico das horas.
            </p>
            <Assumptions data={result.assumptions} />
          </Card>
        </>
      ) : (
        <Card span={5}>
          <EmptyState
            icon="sparkle"
            title="Nenhuma simulação ainda"
            body="Informe as horas estimadas e calcule para ver o preço mínimo e o recomendado, com a memória de cálculo completa."
          />
        </Card>
      )}

      {saving && result && (
        <SaveQuoteModal
          payload={body()}
          result={result}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false)
            queryClient.invalidateQueries({ queryKey: ['pricing-quotes'] })
            toast('Cotação salva')
          }}
        />
      )}
    </Bento>
  )
}

function SaveQuoteModal({
  payload,
  result,
  onClose,
  onSaved,
}: {
  payload: Record<string, unknown>
  result: Simulation
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [label, setLabel] = useState('')

  const save = useMutation({
    mutationFn: () => api.post('/pricing/quotes', { ...payload, clientLabel: label.trim() }),
    onSuccess: () => {
      telemetry.action('pricing', 'quote_saved')
      onSaved()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title="Salvar como cotação"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            icon="check"
            disabled={label.trim() === '' || save.isPending}
            onClick={() => save.mutate()}
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label">Cliente ou projeto</label>
          <TextInput value={label} onChange={setLabel} placeholder="ex. Identidade visual, cliente X" />
        </div>
        <div className="kv">
          <span className="kv__k">Preço mínimo</span>
          <span className="kv__v">{money(result.minimumPriceCents)}</span>
          <span className="kv__k">Preço recomendado</span>
          <span className="kv__v">{money(result.recommendedPriceCents)}</span>
          <span className="kv__k">Preço premium</span>
          <span className="kv__v">{money(result.premiumPriceCents)}</span>
        </div>
        <p className="chart__note">
          Os valores ficam congelados nesta cotação. Alterar seus custos mensais depois não muda um
          número já registrado aqui.
        </p>
      </div>
    </Modal>
  )
}

/* ================================================================== *
 * Histórico
 * ================================================================== */
function QuotesTab() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const quotes = useQuery({
    queryKey: ['pricing-quotes'],
    queryFn: () => api.get<{ quotes: Quote[] }>('/pricing/quotes'),
  })
  const [approving, setApproving] = useState<Quote | null>(null)
  const [editing, setEditing] = useState<Quote | null>(null)

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/pricing/quotes/${id}`),
    onSuccess: () => {
      toast('Cotação removida')
      queryClient.invalidateQueries({ queryKey: ['pricing-quotes'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: QuoteStatus }) =>
      api.patch(`/pricing/quotes/${id}/status`, { status }),
    onSuccess: () => {
      toast('Status atualizado')
      queryClient.invalidateQueries({ queryKey: ['pricing-quotes'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao atualizar status', 'error'),
  })

  const rows = quotes.data?.quotes ?? []

  return (
    <Bento>
      <Card span={12} flush title="Cotações salvas" subtitle="Números congelados no momento de cada simulação">
        {quotes.isError ? (
          <EmptyState
            icon="alert"
            title="Falha ao carregar"
            body="Não foi possível carregar as cotações salvas agora. Tente novamente em instantes."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="file"
            title="Nenhuma cotação salva"
            body="Simule um projeto e use 'Salvar como cotação' para guardar o cálculo daquele momento."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Cliente ou projeto</th>
                  <th>Quando</th>
                  <th className="table__num">Horas</th>
                  <th className="table__num">Hora base</th>
                  <th className="table__num">Mínimo</th>
                  <th className="table__num">Recomendado</th>
                  <th className="table__num">Fechado por</th>
                  <th className="table__num">Premium</th>
                  <th>Status</th>
                  <th style={{ width: 96 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((quote) => (
                  <tr key={quote.id}>
                    <td>
                      {quote.clientLabel}
                      {(quote.installments > 1 || quote.paymentTerms) && (
                        <div className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                          {quote.installments > 1 &&
                            `${quote.installments}x de ${money(
                              Math.round((quote.actualPriceCents ?? quote.recommendedPriceCents) / quote.installments),
                            )}`}
                          {quote.installments > 1 && quote.paymentTerms ? ' · ' : ''}
                          {quote.paymentTerms}
                        </div>
                      )}
                    </td>
                    <td className="muted">{fmtDate(quote.createdAt.slice(0, 10))}</td>
                    <td className="table__num">{quote.estimatedHours.toLocaleString('pt-BR')}</td>
                    <td className="table__num">{money(quote.hourlyBaseCents)}</td>
                    <td className="table__num">{money(quote.minimumPriceCents)}</td>
                    <td className="table__num">
                      <strong>{money(quote.recommendedPriceCents)}</strong>
                    </td>
                    <td className="table__num">
                      {quote.actualPriceCents === null ? (
                        <span className="muted">-</span>
                      ) : quote.actualPriceCents === quote.recommendedPriceCents ? (
                        <span className="muted">{money(quote.actualPriceCents)}</span>
                      ) : (
                        <strong className={quote.actualPriceCents > quote.recommendedPriceCents ? 'pos' : 'neg'}>
                          {money(quote.actualPriceCents)}
                        </strong>
                      )}
                    </td>
                    <td className="table__num muted">{money(quote.premiumPriceCents)}</td>
                    <td>
                      <Select
                        value={quote.status}
                        className={`select--pill select--${QUOTE_STATUS_TONE[quote.status]}`}
                        options={QUOTE_STATUSES.map((value) => ({ value, label: QUOTE_STATUS_LABELS[value] }))}
                        onChange={(value) =>
                          value && setStatus.mutate({ id: quote.id, status: value as QuoteStatus })
                        }
                      />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                        {quote.status !== 'approved' && (
                          <Button
                            variant="quiet"
                            size="sm"
                            icon="check"
                            title="Aprovar: gera o lançamento de receita"
                            onClick={() => setApproving(quote)}
                          >
                            Aprovar
                          </Button>
                        )}
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="pencil"
                          title="Editar cotação"
                          onClick={() => setEditing(quote)}
                        />
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="trash"
                          title="Remover cotação"
                          onClick={() => remove.mutate(quote.id)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {approving && <ApproveQuoteModal quote={approving} onClose={() => setApproving(null)} />}
      {editing && <EditQuoteModal quote={editing} onClose={() => setEditing(null)} />}
    </Bento>
  )
}

/**
 * Aprovar converte a cotação num lançamento de receita real, com conta e
 * data escolhidas aqui — a mesma conversão simples que `specs/project-pricing`
 * documenta, sem depender de `specs/client-projects` existir.
 */
/**
 * Soma meses a uma DATA (`YYYY-MM-DD`) prendendo o dia ao fim do mês:
 * 31/01 + 1 mês é 28/02. Espelha `addMonthsToDate` do servidor
 * (`core/dates.ts`), que é quem de fato grava as parcelas — aqui só
 * serve para prever o cronograma na tela antes de confirmar.
 */
function addMonthsToDateInput(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const total = y * 12 + (m - 1) + n
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`
}

function ApproveQuoteModal({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()
  const [accountId, setAccountId] = useState<number | null>(null)
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10))
  // Parte do recomendado — o usuário só digita algo diferente se o valor de
  // fato fechado com o cliente divergiu (negociação, desconto, ajuste).
  const [actualPrice, setActualPrice] = useState(() => centsToInput(quote.recommendedPriceCents))
  const actualPriceCents = parseMoneyInput(actualPrice)
  const actualDiffersFromRecommended = actualPriceCents !== null && actualPriceCents !== quote.recommendedPriceCents

  const count = Math.max(1, quote.installments)
  const isInstalment = count > 1
  /** Padrão: um mês depois do recebimento da primeira, editável. */
  const [secondInstallmentOn, setSecondInstallmentOn] = useState(() =>
    addMonthsToDateInput(new Date().toISOString().slice(0, 10), 1),
  )

  /** O mesmo rateio do servidor (`splitInstallments`), só para PREVER na
   *  tela o que vai ser criado — a divisão que vale é a de lá. */
  const schedule =
    actualPriceCents === null || actualPriceCents <= 0
      ? []
      : Array.from({ length: count }, (_, i) => {
          const base = Math.floor(actualPriceCents / count)
          const amountCents = i === count - 1 ? actualPriceCents - base * (count - 1) : base
          const on = i === 0 ? paidOn : addMonthsToDateInput(secondInstallmentOn, i - 1)
          return { i, amountCents, on }
        })

  const approve = useMutation({
    mutationFn: () => {
      if (accountId === null) throw new Error('escolha a conta')
      if (actualPriceCents === null || actualPriceCents <= 0) throw new Error('informe o valor fechado')
      return api.post(`/pricing/quotes/${quote.id}/approve`, {
        accountId,
        paidOn,
        actualPriceCents,
        ...(isInstalment ? { secondInstallmentOn } : {}),
      })
    },
    onSuccess: () => {
      telemetry.action('pricing', 'quote_approved')
      toast(
        isInstalment
          ? `Cotação aprovada: ${count} parcelas criadas, a primeira recebida e as demais como pendências`
          : 'Cotação aprovada: lançamento de receita criado',
      )
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao aprovar', 'error'),
  })

  return (
    <Modal
      title={`Aprovar cotação: ${quote.clientLabel}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            icon="check"
            disabled={accountId === null || !actualPriceCents || actualPriceCents <= 0 || approve.isPending}
            onClick={() => approve.mutate()}
          >
            Aprovar
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="chart__note">
          {isInstalment
            ? `Esta cotação está parcelada em ${count}x: cria uma linha por parcela, a primeira já recebida e as seguintes como pendências em Lançamentos.`
            : 'Cria um lançamento de receita com o valor fechado abaixo e move o status desta cotação para "Aprovada".'}{' '}
          Recomendado: {money(quote.recommendedPriceCents)}.
        </p>
        <div className="field">
          <label className="field__label">Valor fechado (R$)</label>
          <TextInput value={actualPrice} onChange={setActualPrice} numeral />
          {actualDiffersFromRecommended && (
            <span className="field__hint">
              Diferente do recomendado ({money(quote.recommendedPriceCents)}): o recomendado continua
              guardado para referência, só o lançamento usa este valor.
            </span>
          )}
        </div>
        <div className="field">
          <label className="field__label">Conta</label>
          <Select
            value={accountId}
            placeholder="Escolha a conta"
            options={(accounts.data?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
            onChange={setAccountId}
          />
        </div>
        <div className="field">
          <label className="field__label">
            {isInstalment ? 'Data da 1ª parcela (recebida)' : 'Data do recebimento'}
          </label>
          <TextInput value={paidOn} onChange={setPaidOn} type="date" />
        </div>

        {isInstalment && (
          <>
            <div className="field">
              <label className="field__label">Data da 2ª parcela</label>
              <TextInput value={secondInstallmentOn} onChange={setSecondInstallmentOn} type="date" />
              {count > 2 && (
                <span className="field__hint">
                  Da 3ª em diante o vencimento anda de mês em mês a partir desta data. Cada parcela
                  vira uma linha própria e pode ser ajustada depois em Lançamentos.
                </span>
              )}
            </div>

            <div className="kv">
              {schedule.map((p) => (
                <Fragment key={p.i}>
                  <span className="kv__k">
                    {p.i + 1}ª parcela · {fmtDate(p.on)}
                    {p.i > 0 ? ' (pendente)' : ''}
                  </span>
                  <span className="kv__v">{money(p.amountCents)}</span>
                </Fragment>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * Editar uma cotação salva (`decisions/0021`): mesmo formulário de
 * "Simular", pré-preenchido, com um passo de recalcular antes de salvar —
 * o usuário vê o preço novo antes de confirmar, nunca é surpreendido pelo
 * número mudando silenciosamente. Salvar sempre recalcula no servidor
 * (`PATCH` reusa `simulate()`), o "Recalcular" aqui é só a prévia.
 */
function EditQuoteModal({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const [clientLabel, setClientLabel] = useState(quote.clientLabel)
  const [installments, setInstallments] = useState(String(quote.installments))
  const [paymentTerms, setPaymentTerms] = useState(quote.paymentTerms ?? '')
  const [hours, setHours] = useState(String(quote.estimatedHours).replace('.', ','))
  const [margin, setMargin] = useState(quote.extraMarginBps ? bpsToInput(quote.extraMarginBps) : '')
  const [selected, setSelected] = useState<Record<string, number | null>>({
    complexity: quote.complexityOptionId,
    urgency: quote.urgencyOptionId,
    client_size: quote.clientSizeOptionId,
    usage_rights: quote.usageRightsOptionId,
  })
  const [costs, setCosts] = useState<DirectCostDraft[]>(
    quote.directCosts.map((c) => ({ label: c.label, value: centsToInput(c.amountCents) })),
  )
  const [preview, setPreview] = useState<Simulation | null>(null)

  const isApproved = quote.status === 'approved'

  /** Campos comerciais: nunca recomputam preço, então vão no patch mesmo
   *  numa cotação já aprovada (ver `updateQuote` em services/pricing.ts). */
  const commercialBody = () => ({
    clientLabel: clientLabel.trim(),
    installments: Math.max(1, Number(installments) || 1),
    paymentTerms: paymentTerms.trim() === '' ? null : paymentTerms.trim(),
  })

  const body = () => ({
    estimatedHours: Number(hours.replace(',', '.')),
    directCosts: costs
      .map((c) => ({ label: c.label.trim() || 'Custo direto', amountCents: parseMoneyInput(c.value) ?? 0 }))
      .filter((c) => c.amountCents !== 0),
    complexityOptionId: selected.complexity ?? null,
    urgencyOptionId: selected.urgency ?? null,
    clientSizeOptionId: selected.client_size ?? null,
    usageRightsOptionId: selected.usage_rights ?? null,
    extraMarginBps: margin.trim() === '' ? 0 : (parsePercentInput(margin) ?? 0),
  })

  const recalc = useMutation({
    mutationFn: () => api.post<Simulation>('/pricing/simulate', body()),
    onSuccess: setPreview,
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao recalcular', 'error'),
  })

  const save = useMutation({
    // Aprovada: só o comercial vai junto. Mandar os campos de cálculo aqui
    // seria recusado com 422 pelo servidor, e com razão — o preço já virou
    // lançamento no ledger (`decisions/0021`).
    mutationFn: () =>
      api.patch(
        `/pricing/quotes/${quote.id}`,
        isApproved ? commercialBody() : { ...body(), ...commercialBody() },
      ),
    onSuccess: () => {
      toast('Cotação atualizada')
      queryClient.invalidateQueries({ queryKey: ['pricing-quotes'] })
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const hoursValid = Number.isFinite(Number(hours.replace(',', '.'))) && Number(hours.replace(',', '.')) > 0
  const canSave = clientLabel.trim().length > 0 && (isApproved || hoursValid)
  const referencePriceCents = quote.actualPriceCents ?? quote.recommendedPriceCents
  const parcels = Math.max(1, Number(installments) || 1)

  return (
    <Modal
      title={`Orçamento: ${quote.clientLabel}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          {!isApproved && (
            <Button
              variant="ghost"
              icon="sparkle"
              disabled={!hoursValid || recalc.isPending}
              onClick={() => recalc.mutate()}
            >
              Recalcular
            </Button>
          )}
          <Button
            variant="primary"
            icon="check"
            disabled={!canSave || save.isPending}
            onClick={() => save.mutate()}
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack stack--loose">
        {/* O orçamento CALCULADO, congelado no momento em que foi salvo:
            é o que o cliente recebeu, e é o que esta tela existe pra
            revisar antes de mexer em qualquer coisa. */}
        <div className="kv">
          <span className="kv__k">Hora base</span>
          <span className="kv__v">{money(quote.hourlyBaseCents)}</span>
          <span className="kv__k">Mínimo</span>
          <span className="kv__v">{money(quote.minimumPriceCents)}</span>
          <span className="kv__k">Recomendado</span>
          <span className="kv__v">{money(quote.recommendedPriceCents)}</span>
          <span className="kv__k">Premium</span>
          <span className="kv__v">{money(quote.premiumPriceCents)}</span>
          {quote.actualPriceCents !== null && (
            <>
              <span className="kv__k">Fechado por</span>
              <span className="kv__v">{money(quote.actualPriceCents)}</span>
            </>
          )}
        </div>

        <hr className="divider" />

        <div className="field">
          <label className="field__label">Cliente ou projeto</label>
          <TextInput value={clientLabel} onChange={setClientLabel} />
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
          <div className="field" style={{ width: 140 }}>
            <label className="field__label">Parcelas</label>
            <TextInput value={installments} onChange={setInstallments} numeral />
            <span className="field__hint">
              {parcels > 1
                ? `${parcels}x de ${money(Math.round(referencePriceCents / parcels))}`
                : 'à vista'}
              {' sobre '}
              {quote.actualPriceCents === null ? 'o recomendado' : 'o valor fechado'}
            </span>
          </div>
          <div className="field" style={{ minWidth: 260, flex: 1 }}>
            <label className="field__label">Condição de pagamento</label>
            <TextInput
              value={paymentTerms}
              onChange={setPaymentTerms}
              placeholder="50% na aprovação, 50% na entrega"
            />
            <span className="field__hint">
              Texto livre: entra no orçamento como condição combinada, não altera nenhum preço.
            </span>
          </div>
        </div>

        <hr className="divider" />

        {quote.status === 'approved' && (
          <p className="chart__note">
            Esta cotação já foi aprovada e gerou um lançamento de receita: mudar horas, custos ou
            multiplicadores aqui será recusado, para o preço exibido não se descolar do que já está no
            ledger.
          </p>
        )}
        <QuoteFormFields
          hours={hours}
          setHours={setHours}
          margin={margin}
          setMargin={setMargin}
          selected={selected}
          setSelected={setSelected}
          costs={costs}
          setCosts={setCosts}
        />
        <div className="kv">
          <span className="kv__k">Preço mínimo (congelado hoje)</span>
          <span className="kv__v">{money(quote.minimumPriceCents)}</span>
          <span className="kv__k">Preço recomendado (congelado hoje)</span>
          <span className="kv__v">{money(quote.recommendedPriceCents)}</span>
          <span className="kv__k">Preço premium (congelado hoje)</span>
          <span className="kv__v">{money(quote.premiumPriceCents)}</span>
        </div>
        {preview && (
          <div className="kv">
            <span className="kv__k">Preço mínimo (recalculado agora)</span>
            <span className="kv__v">
              <strong>{money(preview.minimumPriceCents)}</strong>
            </span>
            <span className="kv__k">Preço recomendado (recalculado agora)</span>
            <span className="kv__v">
              <strong>{money(preview.recommendedPriceCents)}</strong>
            </span>
            <span className="kv__k">Preço premium (recalculado agora)</span>
            <span className="kv__v">
              <strong>{money(preview.premiumPriceCents)}</strong>
            </span>
          </div>
        )}
        <p className="chart__note">
          Salvar recalcula com o ponto de equilíbrio e a alíquota de agora, não os do momento em que esta
          cotação foi criada: é isso que "editar" significa aqui (`decisions/0021`).
        </p>
      </div>
    </Modal>
  )
}

/* ================================================================== *
 * Parâmetros
 * ================================================================== */
function ParamsTab() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<MultiplierOption | 'new' | null>(null)

  const settings = useQuery({
    queryKey: ['pricing-settings'],
    queryFn: () => api.get<{ settings: PricingSettings; defaults: PricingSettings }>('/pricing/settings'),
  })
  const multipliers = useQuery({
    queryKey: ['pricing-multipliers'],
    queryFn: () => api.get<MultipliersResponse>('/pricing/multipliers'),
  })

  const [hours, setHours] = useState<string | null>(null)
  const [billable, setBillable] = useState<string | null>(null)
  const current = settings.data?.settings

  const saveSettings = useMutation({
    mutationFn: () =>
      api.put('/pricing/settings', {
        ...(hours === null || hours.trim() === '' ? {} : { availableHoursPerMonth: Math.round(Number(hours.replace(',', '.'))) }),
        ...(billable === null || billable.trim() === ''
          ? {}
          : { billablePercentageBps: parsePercentInput(billable) ?? 6_000 }),
      }),
    onSuccess: () => {
      toast('Parâmetros salvos')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const toggleActive = useMutation({
    mutationFn: (option: MultiplierOption) =>
      api.patch(`/pricing/multipliers/${option.id}`, { active: !option.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pricing-multipliers'] }),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao atualizar', 'error'),
  })

  const dimensions = multipliers.data?.dimensions ?? []
  const all = multipliers.data?.multipliers ?? []

  return (
    <Bento>
      <Card span={5} title="Sua capacidade no mês" subtitle="A base que transforma custo mensal em valor-hora">
        {!current ? (
          <SkeletonLines lines={5} />
        ) : (
          <div className="stack">
            <div className="field">
              <label className="field__label">Horas disponíveis por mês</label>
              <TextInput
                value={hours ?? String(current.availableHoursPerMonth)}
                onChange={setHours}
                numeral
              />
              <span className="field__hint">176 = 22 dias úteis de 8 horas</span>
            </div>
            <div className="field">
              <label className="field__label">Percentual faturável (%)</label>
              <TextInput
                value={billable ?? bpsToInput(current.billablePercentageBps)}
                onChange={setBillable}
                numeral
              />
              <span className="field__hint">
                Ninguém fatura 100% do mês: prospecção, administração e revisão não cobrada entram aqui
              </span>
            </div>
            <Button variant="primary" icon="check" onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>
              Salvar
            </Button>
            <p className="chart__note">
              Custo, pró-labore, imposto e margem mensal não são configurados aqui: vêm do motor
              financeiro, para não existirem dois "quanto preciso faturar" divergentes.
            </p>
          </div>
        )}
      </Card>

      <Card
        span={7}
        flush
        title="Multiplicadores"
        subtitle="Sugestões iniciais, editáveis: o que é um projeto complexo muda de área para área"
        actions={
          <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
            Nova opção
          </Button>
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Dimensão</th>
                <th>Opção</th>
                <th className="table__num">Multiplicador</th>
                <th style={{ width: 96 }} />
              </tr>
            </thead>
            <tbody>
              {all.map((option) => (
                <tr key={option.id} style={option.active ? undefined : { opacity: 0.5 }}>
                  <td className="muted">
                    {dimensions.find((d) => d.value === option.dimension)?.label ?? option.dimension}
                  </td>
                  <td>
                    {option.label}
                    {option.description && (
                      <>
                        <br />
                        <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                          {option.description}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="table__num">
                    {(option.multiplierBps / 10_000).toLocaleString('pt-BR')}x
                  </td>
                  <td>
                    <span className="row" style={{ gap: 2 }}>
                      <Button
                        variant="quiet"
                        size="sm"
                        icon={option.active ? 'check' : 'x'}
                        title={option.active ? 'Desativar opção' : 'Ativar opção'}
                        onClick={() => toggleActive.mutate(option)}
                      />
                      <Button
                        variant="quiet"
                        size="sm"
                        icon="pencil"
                        title="Editar opção"
                        onClick={() => setEditing(option)}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {editing !== null && (
        <MultiplierModal
          option={editing === 'new' ? null : editing}
          dimensions={dimensions}
          onClose={() => setEditing(null)}
        />
      )}
    </Bento>
  )
}

function MultiplierModal({
  option,
  dimensions,
  onClose,
}: {
  option: MultiplierOption | null
  dimensions: Array<{ value: string; label: string }>
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [dimension, setDimension] = useState<string | null>(option?.dimension ?? dimensions[0]?.value ?? null)
  const [label, setLabel] = useState(option?.label ?? '')
  const [description, setDescription] = useState(option?.description ?? '')
  const [multiplier, setMultiplier] = useState(
    option ? (option.multiplierBps / 10_000).toFixed(2).replace('.', ',') : '1,00',
  )

  const parsedMultiplier = () => {
    const value = Number(multiplier.replace(',', '.'))
    return Number.isFinite(value) && value > 0 ? Math.round(value * 10_000) : null
  }

  const save = useMutation({
    mutationFn: () => {
      const multiplierBps = parsedMultiplier()!
      const payload = {
        label: label.trim(),
        description: description.trim() === '' ? null : description.trim(),
        multiplierBps,
      }
      return option
        ? api.patch(`/pricing/multipliers/${option.id}`, payload)
        : api.post('/pricing/multipliers', { ...payload, dimension })
    },
    onSuccess: () => {
      toast('Opção salva')
      queryClient.invalidateQueries({ queryKey: ['pricing-multipliers'] })
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const remove = useMutation({
    mutationFn: () => api.del(`/pricing/multipliers/${option!.id}`),
    onSuccess: () => {
      toast('Opção removida')
      queryClient.invalidateQueries({ queryKey: ['pricing-multipliers'] })
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  return (
    <Modal
      title={option ? `Editar "${option.label}"` : 'Nova opção de multiplicador'}
      onClose={onClose}
      footer={
        <>
          {option ? (
            <Button variant="danger" icon="trash" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Remover
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="primary"
            icon="check"
            disabled={label.trim() === '' || parsedMultiplier() === null || save.isPending}
            onClick={() => save.mutate()}
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack">
        {!option && (
          <div className="field">
            <label className="field__label">Dimensão</label>
            <Select
              value={dimension}
              options={dimensions.map((d) => ({ value: d.value, label: d.label }))}
              onChange={setDimension}
            />
          </div>
        )}
        <div className="field">
          <label className="field__label">Rótulo</label>
          <TextInput value={label} onChange={setLabel} placeholder="ex. Muito complexo" />
        </div>
        <div className="field">
          <label className="field__label">Descrição (opcional)</label>
          <TextInput value={description} onChange={setDescription} placeholder="Quando usar esta opção" />
        </div>
        <div className="field" style={{ width: 160 }}>
          <label className="field__label">Multiplicador</label>
          <TextInput value={multiplier} onChange={setMultiplier} numeral />
          <span className="field__hint">1,00 é neutro. 1,30 acrescenta 30%</span>
        </div>
      </div>
    </Modal>
  )
}
