import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useMeta, useRange } from '../lib/store'
import { bps, money, moneyCompact } from '../lib/format'
import {
  Button,
  Card,
  CategorySelect,
  EmptyState,
  HeroFigure,
  Icon,
  Slab,
  SkeletonLines,
  StatTile,
  useToast,
} from '../components/ui'
import { PageHeader, RangeFilter } from '../components/shell/Shell'

type DreLine = {
  categoryId: number | null
  name: string
  color: string
  amountCents: number
  transactionCount: number
  shareBps: number
}

type UncategorizedGroup = {
  signature: string
  sampleDescription: string
  count: number
  netCents: number
  ids: number[]
}

type DreResponse = {
  totals: {
    incomeCents: number
    expenseCents: number
    netCents: number
    transactionCount: number
    uncategorizedCount: number
  }
  income: DreLine[]
  expense: DreLine[]
  uncategorized: {
    groups: UncategorizedGroup[]
    groupCount: number
    totalCount: number
    hasMore: boolean
  }
  serviceAverages: {
    avgRevenuePerTransactionCents: number
    avgExpensePerTransactionCents: number
    revenueTransactionCount: number
    expenseTransactionCount: number
  } | null
}

type FormalDreResponse = {
  receitaBrutaCents: number
  deducoesCents: number
  receitaLiquidaCents: number
  custosCents: number
  lucroBrutoCents: number
  despesasOperacionaisCents: number
  resultadoOperacionalCents: number
  resultadoFinanceiroCents: number
  impostosCents: number
  lucroLiquidoCents: number
}

type FlowEdge = {
  fromAccountId: number
  toAccountId: number
  amountCents: number
  count: number
}

/**
 * DRE separado por conta, lado a lado. Deliberadamente ignora o filtro de
 * conta global (Shell.tsx) — essa é justamente a página que sempre mostra
 * PJ e PF juntos, então "todas as contas" ali não significaria nada aqui.
 */
export function DrePage() {
  const range = useRange()
  const meta = useMeta()

  const pj = (meta.data?.accounts ?? []).find((account) => account.name === 'Nubank PJ')
  const pf = (meta.data?.accounts ?? []).find((account) => account.name === 'Nubank PF')

  // Same query key/fn the two DreColumn instances use below, so this never
  // costs an extra request — React Query serves it from the shared cache.
  const pjDre = useQuery({
    queryKey: ['dre', pj?.id, range.from, range.to],
    queryFn: () => api.get<DreResponse>('/analytics/dre', { accountId: pj!.id, from: range.from, to: range.to }),
    enabled: !!pj,
    placeholderData: (previous) => previous,
  })
  const pfDre = useQuery({
    queryKey: ['dre', pf?.id, range.from, range.to],
    queryFn: () => api.get<DreResponse>('/analytics/dre', { accountId: pf!.id, from: range.from, to: range.to }),
    enabled: !!pf,
    placeholderData: (previous) => previous,
  })

  // DRE formal (specs/dre, "DRE PJ formal") — só a conta PJ, é conceito de
  // empresa (CSP, Imposto sobre o lucro não fazem sentido pra conta pessoal).
  const formalDre = useQuery({
    queryKey: ['dre-formal', pj?.id, range.from, range.to],
    queryFn: () => api.get<FormalDreResponse>('/analytics/dre/formal', { accountId: pj!.id, from: range.from, to: range.to }),
    enabled: !!pj,
    placeholderData: (previous) => previous,
  })

  // The account-to-account flow already pairs PJ<->PF legs by amount and
  // date (server/src/services/transfers.ts) — the ground truth for how much
  // actually moved between the two, independent of whether every leg on
  // both sides got the same category label.
  const flows = useQuery({
    queryKey: ['flows', range.from, range.to],
    queryFn: () => api.get<{ edges: FlowEdge[] }>('/analytics/flows', { from: range.from, to: range.to }),
    enabled: range.ready,
    placeholderData: (previous) => previous,
  })

  const reconciliation =
    pj && pf && pjDre.data && pfDre.data && flows.data
      ? computeReconciliation(pj.id, pf.id, pjDre.data, pfDre.data, flows.data.edges)
      : null

  return (
    <>
      <PageHeader
        title="DRE PJ x PF"
        subtitle="Receita e despesa por categoria, separadas por conta"
        actions={<RangeFilter hideAccountFilter />}
      />

      <div className="page">
        {!meta.isSuccess ? (
          <Card>
            <SkeletonLines lines={2} />
          </Card>
        ) : meta.data && !meta.data.hasData ? (
          <Card>
            <EmptyState
              icon="upload"
              title="Nenhum dado importado ainda"
              body="Importe os extratos da Nubank PJ e PF para ver o resultado do período."
              action={
                <Link to="/importar">
                  <Button variant="primary" icon="upload">
                    Importar CSV
                  </Button>
                </Link>
              }
            />
          </Card>
        ) : !pj || !pf ? (
          <Card>
            <EmptyState
              icon="alert"
              title="Contas 'Nubank PJ' e 'Nubank PF' não encontradas"
              body="Esta página espera contas com esses nomes exatos. Confira os nomes em Contas e bancos."
              action={
                <Link to="/ajustes">
                  <Button icon="settings">Ver contas</Button>
                </Link>
              }
            />
          </Card>
        ) : (
          <div className="bento">
            <FormalDreCard data={formalDre.data} isError={formalDre.isError} accountLabel={pj.name} />
            {reconciliation && <ReconciliationSlab data={reconciliation} pjLabel={pj.name} pfLabel={pf.name} />}
            <DreColumn
              accountId={pj.id}
              accountLabel={pj.name}
              from={range.from}
              to={range.to}
              business
              proLaboreCents={reconciliation ? Math.max(0, reconciliation.netToPfCents) : 0}
            />
            <DreColumn accountId={pf.id} accountLabel={pf.name} from={range.from} to={range.to} />
          </div>
        )}
      </div>
    </>
  )
}

/**
 * DRE formal (PJ) — waterfall contábil de verdade, distinto do resumo
 * simplificado que `BusinessSummary` já mostra dentro de cada `DreColumn`
 * (aquele soma tudo em "Despesas Totais"; este separa Custo do Serviço,
 * Despesa Operacional, Resultado Financeiro e Imposto sobre o Lucro, cada
 * um numa linha própria — specs/dre, "DRE PJ formal"). Só a conta PJ:
 * CSP e Imposto sobre o lucro não são conceito de conta pessoal.
 */
function FormalDreCard({
  data,
  isError,
  accountLabel,
}: {
  data: FormalDreResponse | undefined
  isError: boolean
  accountLabel: string
}) {
  if (isError) {
    return (
      <Card span={12} flush title="DRE formal (PJ)">
        <EmptyState
          icon="alert"
          title="Falha ao carregar"
          body="Não foi possível carregar o DRE formal agora. Tente novamente em instantes."
        />
      </Card>
    )
  }
  if (!data) {
    return (
      <Card span={12} flush title="DRE formal (PJ)">
        <SkeletonLines lines={6} />
      </Card>
    )
  }

  return (
    <Card span={12} flush title="DRE formal (PJ)" subtitle={`${accountLabel} · Receita Bruta → Lucro Líquido, no período selecionado`}>
      <div className="kv" style={{ padding: '0 var(--sp-5)', fontSize: 'var(--text-base)' }}>
        <span className="kv__k" style={{ gridColumn: '1 / -1', textTransform: 'uppercase', fontSize: 'var(--text-2xs)', letterSpacing: '0.03em' }}>
          Receita
        </span>
        <span className="kv__k">Receita Bruta</span>
        <span className="kv__v pos">{money(data.receitaBrutaCents)}</span>
        <span className="kv__k">(−) Deduções da Receita</span>
        <span className="kv__v neg">{money(data.deducoesCents)}</span>
        <span className="kv__k" style={{ fontWeight: 600 }}>(=) Receita Líquida</span>
        <span className={`kv__v ${data.receitaLiquidaCents < 0 ? 'neg' : 'pos'}`} style={{ fontWeight: 600 }}>
          {money(data.receitaLiquidaCents)}
        </span>

        <span
          className="kv__k"
          style={{ gridColumn: '1 / -1', textTransform: 'uppercase', fontSize: 'var(--text-2xs)', letterSpacing: '0.03em', marginTop: 'var(--sp-2)' }}
        >
          Custos e Lucro Bruto
        </span>
        <span className="kv__k">(−) Custos dos Serviços Prestados (CSP)</span>
        <span className="kv__v neg">{money(data.custosCents)}</span>
        <span className="kv__k" style={{ fontWeight: 600 }}>(=) Lucro Bruto</span>
        <span className={`kv__v ${data.lucroBrutoCents < 0 ? 'neg' : 'pos'}`} style={{ fontWeight: 600 }}>
          {money(data.lucroBrutoCents)}
        </span>

        <span
          className="kv__k"
          style={{ gridColumn: '1 / -1', textTransform: 'uppercase', fontSize: 'var(--text-2xs)', letterSpacing: '0.03em', marginTop: 'var(--sp-2)' }}
        >
          Despesas Operacionais
        </span>
        <span className="kv__k">(−) Despesas Operacionais</span>
        <span className="kv__v neg">{money(data.despesasOperacionaisCents)}</span>
        <span className="kv__k" style={{ fontWeight: 600 }}>(=) Resultado Operacional (EBIT)</span>
        <span className={`kv__v ${data.resultadoOperacionalCents < 0 ? 'neg' : 'pos'}`} style={{ fontWeight: 600 }}>
          {money(data.resultadoOperacionalCents)}
        </span>

        <span
          className="kv__k"
          style={{ gridColumn: '1 / -1', textTransform: 'uppercase', fontSize: 'var(--text-2xs)', letterSpacing: '0.03em', marginTop: 'var(--sp-2)' }}
        >
          Resultado Final
        </span>
        <span className="kv__k">(+/−) Resultado Financeiro</span>
        <span className={`kv__v ${data.resultadoFinanceiroCents < 0 ? 'neg' : 'pos'}`}>{money(data.resultadoFinanceiroCents)}</span>
        <span className="kv__k">(−) Impostos sobre o Lucro</span>
        <span className="kv__v neg">{money(data.impostosCents)}</span>
        <span className="kv__k" style={{ fontWeight: 700 }}>(=) Lucro Líquido</span>
        <span className={`kv__v ${data.lucroLiquidoCents < 0 ? 'neg' : 'pos'}`} style={{ fontWeight: 700 }}>
          {money(data.lucroLiquidoCents)}
        </span>
      </div>
    </Card>
  )
}

/**
 * Each column below excludes transfers between the user's own accounts —
 * correctly, so a PJ->PF payment never counts as revenue on one side and
 * an expense that vanished on the other. But that same exclusion is what
 * makes an isolated per-account DRE read as nonsense: PJ shows a huge
 * "profit" it never keeps (it hands most of it to PF as pró-labore), and
 * PF shows a huge "loss" it doesn't actually carry (that pró-labore covers
 * it). This reconciles the two using the real paired PJ<->PF flow from
 * server/src/services/transfers.ts — not the category labels, which don't
 * always agree on both legs of the same transfer — so the combined number
 * is trustworthy even when a leg is miscategorized.
 */
type Reconciliation = {
  pjResultCents: number
  pfResultCents: number
  /** positive = net flow PJ -> PF in the period; negative = net PF -> PJ */
  netToPfCents: number
  pjAfterCents: number
  pfAfterCents: number
  combinedCents: number
}

function computeReconciliation(
  pjId: number,
  pfId: number,
  pjDre: DreResponse,
  pfDre: DreResponse,
  edges: FlowEdge[],
): Reconciliation {
  const pjToPf = edges.find((e) => e.fromAccountId === pjId && e.toAccountId === pfId)?.amountCents ?? 0
  const pfToPj = edges.find((e) => e.fromAccountId === pfId && e.toAccountId === pjId)?.amountCents ?? 0
  const netToPfCents = pjToPf - pfToPj

  const pjResultCents = pjDre.totals.incomeCents - pjDre.totals.expenseCents
  const pfResultCents = pfDre.totals.incomeCents - pfDre.totals.expenseCents

  return {
    pjResultCents,
    pfResultCents,
    netToPfCents,
    pjAfterCents: pjResultCents - netToPfCents,
    pfAfterCents: pfResultCents + netToPfCents,
    combinedCents: pjResultCents + pfResultCents,
  }
}

function ReconciliationSlab({
  data,
  pjLabel,
  pfLabel,
}: {
  data: Reconciliation
  pjLabel: string
  pfLabel: string
}) {
  const { pjResultCents, pfResultCents, netToPfCents, pjAfterCents, pfAfterCents, combinedCents } = data

  // Badge tone classes go neutral on an ink card by design (contrast, not a
  // bug — see .on-slab .badge in components.css), so severity here rides on
  // the same slab-safe delta tokens Delta/StatTile already use, not badges.
  const verdict =
    combinedCents < 0
      ? {
          color: 'var(--delta-down)',
          text: `No período, a receita somada (${pjLabel} + ${pfLabel}) ficou abaixo da despesa somada, e o conjunto está no vermelho.`,
        }
      : pfAfterCents < 0
        ? {
            color: 'var(--delta-down)',
            text: `A ${pfLabel} gasta mais do que recebe, mesmo somando o repasse da ${pjLabel}, e a diferença sai do caixa acumulado.`,
          }
        : pjAfterCents < 0
          ? {
              color: 'var(--on-slab-1)',
              text: `A ${pjLabel} repassou para a ${pfLabel} mais do que gerou de lucro no período, e a empresa não reteve caixa nenhum.`,
            }
          : {
              color: 'var(--delta-up)',
              text: `Fluxo saudável: a ${pjLabel} sustenta os gastos da ${pfLabel} sem comprometer o próprio caixa.`,
            }

  return (
    <Slab span={12} accent>
      <div className="row row--between row--wrap" style={{ gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
        <HeroFigure label={`Resultado combinado (${pjLabel} + ${pfLabel})`} value={moneyCompact(combinedCents)} />
        <span
          className="row"
          style={{ maxWidth: 440, gap: 'var(--sp-2)', color: verdict.color, fontSize: 'var(--text-sm)', fontWeight: 600, alignItems: 'flex-start' }}
        >
          <span style={{ flex: 'none', marginTop: 2 }}>
            <Icon name="alert" size={14} />
          </span>
          <span>{verdict.text}</span>
        </span>
      </div>

      <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-xs)', marginTop: 'var(--sp-1)' }}>
        Cada coluna abaixo já exclui transferências entre as próprias contas, senão a mesma
        receita contaria duas vezes e isso faz cada conta parecer mais extrema do que realmente
        é. Esta linha soma de volta o que passou de uma conta para a outra, pareado por valor e
        data (não pela categoria, que nem sempre bate nos dois lados do mesmo repasse).
      </p>

      <div className="row row--wrap" style={{ gap: 'var(--sp-7)', marginTop: 'var(--sp-2)' }}>
        <div className="kv">
          <span className="kv__k">{pjLabel}, resultado isolado</span>
          <span className="kv__v">{money(pjResultCents)}</span>
          <span className="kv__k">Repasse líquido com a {pfLabel}</span>
          <span className={`kv__v ${-netToPfCents < 0 ? 'neg' : 'pos'}`}>{money(-netToPfCents)}</span>
          <span className="kv__k">= {pjLabel} após o repasse</span>
          <span className={`kv__v ${pjAfterCents < 0 ? 'neg' : 'pos'}`}>{money(pjAfterCents)}</span>
        </div>
        <div className="kv">
          <span className="kv__k">{pfLabel}, resultado isolado</span>
          <span className="kv__v">{money(pfResultCents)}</span>
          <span className="kv__k">Repasse líquido com a {pjLabel}</span>
          <span className={`kv__v ${netToPfCents < 0 ? 'neg' : 'pos'}`}>{money(netToPfCents)}</span>
          <span className="kv__k">= {pfLabel} após o repasse</span>
          <span className={`kv__v ${pfAfterCents < 0 ? 'neg' : 'pos'}`}>{money(pfAfterCents)}</span>
        </div>
      </div>
    </Slab>
  )
}

/**
 * The empresarial DRE shape for the PJ account: receita/despesa first,
 * then the two derived rates, then the two historical service averages
 * (priced off the account's ENTIRE history, not the selected period —
 * see analytics.historicalServiceAverages), then the bottom line.
 *
 * `proLaboreCents` folds in on top of the category-based expense total:
 * pró-labore is a transfer to the owner's personal account, not a
 * category-tagged "despesa" (categories.ts marks it `kind: 'transfer'`
 * precisely so the COMBINED PJ+PF view doesn't double-count money that
 * never actually left the household) — but from the PJ's OWN books,
 * standard DRE practice counts pró-labore as an administrative expense
 * regardless of where the money ends up. `proLaboreCents` is the
 * amount+date-paired PJ→PF transfer (Dre.tsx `computeReconciliation`),
 * not a category lookup — robust even when the two legs of the same
 * transfer picked up different category labels, which happens.
 */
function BusinessSummary({
  totals,
  result,
  serviceAverages,
  proLaboreCents,
}: {
  totals: DreResponse['totals']
  result: number
  serviceAverages: DreResponse['serviceAverages']
  proLaboreCents: number
}) {
  const expenseCents = totals.expenseCents + proLaboreCents
  const netResult = result - proLaboreCents
  const margemBrutaBps = totals.incomeCents > 0 ? Math.round((netResult / totals.incomeCents) * 10_000) : 0
  const taxaEconomiaBps = margemBrutaBps

  return (
    <div className="kv" style={{ padding: '0 var(--sp-5)', fontSize: 'var(--text-base)' }}>
      <span className="kv__k">(+) Receita Bruta (Entradas)</span>
      <span className="kv__v pos">{money(totals.incomeCents)}</span>

      <span
        className="kv__k"
        title={proLaboreCents > 0 ? `Inclui ${money(proLaboreCents)} de pró-labore repassado à pessoa física` : undefined}
      >
        (−) Despesas Totais (Saídas+Custos)
      </span>
      <span className="kv__v neg">{money(expenseCents)}</span>

      <span className="kv__k">% Margem Bruta</span>
      <span className="kv__v">{bps(margemBrutaBps)}</span>

      <span className="kv__k" title="Média histórica da conta PJ, não afetada pelo período selecionado">
        Custo médio de serviço
      </span>
      <span className="kv__v">
        {serviceAverages && serviceAverages.expenseTransactionCount > 0 ? money(serviceAverages.avgExpensePerTransactionCents) : '-'}
      </span>

      <span className="kv__k" title="Média histórica da conta PJ, não afetada pelo período selecionado">
        Preço médio de serviço
      </span>
      <span className="kv__v">
        {serviceAverages && serviceAverages.revenueTransactionCount > 0 ? money(serviceAverages.avgRevenuePerTransactionCents) : '-'}
      </span>

      <span className="kv__k" style={{ fontWeight: 600 }}>
        (=) Economia Registrada
      </span>
      <span className={`kv__v ${netResult < 0 ? 'neg' : 'pos'}`} style={{ fontWeight: 600 }}>
        {money(netResult)}
      </span>

      <span className="kv__k">% Taxa de Economia</span>
      <span className={`kv__v ${taxaEconomiaBps < 0 ? 'neg' : 'pos'}`}>{bps(taxaEconomiaBps)}</span>
    </div>
  )
}

function DreColumn({
  accountId,
  accountLabel,
  from,
  to,
  business,
  proLaboreCents = 0,
}: {
  accountId: number
  accountLabel: string
  from: string
  to: string
  /** Renders the empresarial DRE summary (Receita Bruta / Despesas Totais /
   * Margem Bruta / preço e custo médio / Economia Registrada / Taxa de
   * Economia) instead of the plain three-stat row — for the PJ column. */
  business?: boolean
  /** Net PJ→PF transfer for the period, folded into Despesas Totais as an
   * administrative expense — see BusinessSummary's doc comment. */
  proLaboreCents?: number
}) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const dre = useQuery({
    queryKey: ['dre', accountId, from, to],
    queryFn: () => api.get<DreResponse>('/analytics/dre', { accountId, from, to }),
    placeholderData: (previous) => previous,
  })

  const categorize = useMutation({
    mutationFn: (input: { ids: number[]; categoryId: number | null }) =>
      api.post<{ updated: number }>('/transactions/categorize', { ...input, saveAsRule: false }),
    onSuccess: (result) => {
      toast(`${result.updated} lançamentos categorizados em ${accountLabel}`)
      queryClient.invalidateQueries({ queryKey: ['dre'] })
      queryClient.invalidateQueries({ queryKey: ['meta'] })
      queryClient.invalidateQueries({ queryKey: ['transactions'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao categorizar', 'error'),
  })

  if (!dre.data) {
    return (
      <Card span={6}>
        <SkeletonLines lines={5} />
      </Card>
    )
  }

  const { totals, income, expense, uncategorized } = dre.data
  const result = totals.incomeCents - totals.expenseCents

  return (
    <Card
      span={6}
      flush
      title={accountLabel}
      subtitle={`${totals.transactionCount.toLocaleString('pt-BR')} lançamentos no período`}
    >
      {business ? (
        <BusinessSummary totals={totals} result={result} serviceAverages={dre.data.serviceAverages} proLaboreCents={proLaboreCents} />
      ) : (
        <div className="row row--wrap" style={{ padding: '0 var(--sp-5)', gap: 'var(--sp-4)' }}>
          <StatTile label="Receita bruta" value={moneyCompact(totals.incomeCents)} />
          <StatTile label="Despesas" value={moneyCompact(totals.expenseCents)} />
          <StatTile label="Resultado" value={moneyCompact(result)} />
        </div>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Categoria</th>
              <th style={{ textAlign: 'right', width: 64 }}>Qtde</th>
              <th style={{ textAlign: 'right', width: 64 }}>%</th>
              <th style={{ textAlign: 'right', width: 120 }}>Valor</th>
            </tr>
          </thead>
          <tbody>
            <StatementSection label="Receitas" lines={income} totalCents={totals.incomeCents} />
            <StatementSection label="Despesas" lines={expense} totalCents={totals.expenseCents} />
            <tr>
              <td colSpan={3}>
                <strong>Resultado (receitas − despesas)</strong>
              </td>
              <td className={`table__num ${result < 0 ? 'neg' : 'pos'}`}>
                <strong>{money(result)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {uncategorized.totalCount > 0 && (
        <UncategorizedPanel
          data={uncategorized}
          onAssign={(ids, categoryId) => categorize.mutate({ ids, categoryId })}
          pending={categorize.isPending}
        />
      )}
    </Card>
  )
}

/** One block of the statement: a labeled group of category lines plus its subtotal. */
function StatementSection({
  label,
  lines,
  totalCents,
}: {
  label: string
  lines: DreLine[]
  totalCents: number
}) {
  return (
    <>
      <tr>
        <td colSpan={4} style={{ paddingTop: 'var(--sp-4)' }}>
          <span className="stat__label">{label}</span>
        </td>
      </tr>
      {lines.length === 0 ? (
        <tr>
          <td colSpan={4} className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            Nada no período
          </td>
        </tr>
      ) : (
        lines.map((line) => (
          <tr
            key={`${label}-${line.categoryId ?? 'none'}`}
            className={line.categoryId === null ? 'table__row--warn' : undefined}
          >
            <td>
              <span className="row" style={{ gap: 'var(--sp-2)' }}>
                <span className="swatch" style={{ background: line.color }} />
                <span className="truncate">{line.name}</span>
                {line.categoryId === null && (
                  <Icon name="alert" size={12} className="muted" />
                )}
              </span>
            </td>
            <td className="table__num">{line.transactionCount}</td>
            <td className="table__num">{(line.shareBps / 100).toFixed(1)}%</td>
            <td className="table__num">{money(line.amountCents)}</td>
          </tr>
        ))
      )}
      <tr>
        <td>
          <strong>Total {label.toLowerCase()}</strong>
        </td>
        <td className="table__num" />
        <td className="table__num" />
        <td className="table__num">
          <strong>{money(totalCents)}</strong>
        </td>
      </tr>
    </>
  )
}

/**
 * Quick classification, grouped by merchant signature so one choice clears
 * every matching row in the period at once — the same identity the learned-
 * correction memory uses (server/src/core/normalize.ts), not just this page's
 * invention. Rows disappear from the group as soon as they're categorized,
 * since the query refetches after every assignment.
 */
function UncategorizedPanel({
  data,
  onAssign,
  pending,
}: {
  data: DreResponse['uncategorized']
  onAssign: (ids: number[], categoryId: number | null) => void
  pending: boolean
}) {
  return (
    <div
      className="stack"
      style={{
        padding: 'var(--sp-4) var(--sp-5) var(--sp-5)',
        borderTop: '1px solid var(--line)',
        background: 'var(--surface-muted)',
      }}
    >
      <div className="row row--between row--wrap" style={{ gap: 'var(--sp-2)' }}>
        <span className="row" style={{ gap: 'var(--sp-2)' }}>
          <Icon name="alert" size={14} />
          <strong style={{ fontSize: 'var(--text-sm)' }}>
            {data.totalCount.toLocaleString('pt-BR')} lançamentos sem categoria
          </strong>
        </span>
        <Link to="/lancamentos?uncategorized=1" className="btn btn--ghost btn--sm">
          Ver todos em Lançamentos
        </Link>
      </div>

      <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
        Agrupado por quem enviou ou recebeu: escolha uma categoria para classificar todos os
        lançamentos do grupo de uma vez.
        {data.hasMore &&
          ` Mostrando os ${data.groups.length} maiores grupos de ${data.groupCount}; o resto está em Lançamentos.`}
      </p>

      <ul className="ranked">
        {data.groups.map((group) => (
          <li
            key={group.signature}
            className="ranked__item"
            style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto 180px' }}
          >
            <span className="truncate" title={group.sampleDescription}>
              {group.sampleDescription}
            </span>
            <span className="ranked__share">{group.count}x</span>
            <span className={`ranked__value ${group.netCents < 0 ? 'neg' : 'pos'}`}>
              {money(group.netCents)}
            </span>
            <CategorySelect
              bare
              value={null}
              placeholder="Categorizar…"
              direction={group.netCents < 0 ? 'out' : 'in'}
              onChange={(categoryId) => onAssign(group.ids, categoryId)}
            />
          </li>
        ))}
      </ul>

      {pending && <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>Aplicando…</span>}
    </div>
  )
}
