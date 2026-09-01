import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useMeta } from '../lib/store'
import {
  bpsToInput,
  centsToInput,
  money,
  moneyCompact,
  parseMoneyInput,
  parsePercentInput,
  periodLong,
} from '../lib/format'
import {
  Assumptions,
  Bento,
  Button,
  Card,
  EmptyState,
  HeroFigure,
  Select,
  Slab,
  SkeletonLines,
  StatTile,
  useToast,
  type AssumptionBag,
} from '../components/ui'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { PageHeader } from '../components/shell/Shell'

/**
 * Motor financeiro: alocação do disponível e ponto de equilíbrio.
 *
 * Everything here follows the instrumental-language table in
 * `decisions/0010`. The page never closes a sentence with an instruction:
 * the destinations table reports meta, realizado and diferença and stops
 * there, and the break-even card states what revenue WOULD cover what is
 * configured, in the conditional, never "fature X".
 *
 * The destination list is rendered in the exact order the API returns it.
 * That order is alphabetical on purpose, and re-sorting it here by size or
 * by "what is furthest behind" would reintroduce, as a layout choice, the
 * recommendation the API deliberately refuses to make.
 */

type Destination = {
  key: string
  label: string
  targetCents: number | null
  realizedCents: number
  differenceCents: number | null
  assumptions: AssumptionBag
}

type FinancialEngineRecords = {
  highestAvailable: { periodo: string; valorCents: number } | null
  daysSinceNegativeBalance: number | null
  lastNegativeOn: string | null
}

type Available = {
  period: string
  availableCents: number
  terms: {
    consolidatedBalanceCents: number
    futureCommitmentsCents: number
    provisionedCardBillCents: number
    alreadyAllocatedCents: number
  }
  destinations: Destination[]
  assumptions: AssumptionBag
}

type BreakEvenLine = { key: string; label: string; amountCents: number; assumptions: AssumptionBag }

type BreakEven = {
  period: string
  breakEvenCents: number | null
  /** o mesmo cálculo sem as metas de investimento e reserva */
  minimoCents: number | null
  /** quanto as metas configuradas acrescentam ao mínimo */
  metasCents: number | null
  lines: BreakEvenLine[]
  billedCents: number
  differenceCents: number | null
  assumptions: AssumptionBag
}

type EngineSettings = {
  pjAccountId: number | null
  pfAccountId: number | null
  proLaboreCents: number | null
  taxRateBps: number
  reservePlannedCents: number
  marginCents: number
}

function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + months
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/**
 * Why a line is zero, when it is zero for a reason the user can act on.
 * States the situation and stops there: what to do about it is not a
 * sentence this product finishes (decisions/0010).
 */
function lineHint(line: BreakEvenLine): string | null {
  const origem = typeof line.assumptions.origem === 'string' ? line.assumptions.origem : ''
  if (origem.startsWith('não derivável')) return 'contas PJ e PF não informadas'
  if (line.assumptions.configurado === false) return 'não configurado'
  return null
}

export function FinancialEnginePage() {
  const meta = useMeta()
  const [period, setPeriod] = useState<string | null>(null)
  const [tuning, setTuning] = useState(false)

  const resolvedPeriod = period ?? meta.data?.ledger.max?.slice(0, 7) ?? meta.data?.today?.slice(0, 7) ?? null

  const available = useQuery({
    queryKey: ['engine-available', resolvedPeriod],
    queryFn: () => api.get<Available>('/financial-engine/available', { period: resolvedPeriod }),
    enabled: resolvedPeriod !== null,
    placeholderData: (previous) => previous,
  })

  const breakEven = useQuery({
    queryKey: ['engine-break-even', resolvedPeriod],
    queryFn: () => api.get<BreakEven>('/financial-engine/break-even', { period: resolvedPeriod }),
    enabled: resolvedPeriod !== null,
    placeholderData: (previous) => previous,
  })

  const records = useQuery({
    queryKey: ['engine-records'],
    queryFn: () => api.get<FinancialEngineRecords>('/financial-engine/records', { months: 24 }),
    enabled: meta.isSuccess,
  })

  const hasLedger = (meta.data?.ledger.count ?? 0) > 0

  return (
    <>
      <PageHeader
        title="Motor financeiro"
        subtitle={resolvedPeriod ? periodLong(resolvedPeriod) : undefined}
        actions={
          <div className="row">
            <Button size="sm" onClick={() => setPeriod(shiftPeriod(resolvedPeriod ?? '2026-01', -1))}>
              Anterior
            </Button>
            <Button size="sm" onClick={() => setPeriod(shiftPeriod(resolvedPeriod ?? '2026-01', 1))}>
              Seguinte
            </Button>
            <Button variant="primary" icon="settings" onClick={() => setTuning(true)}>
              Parâmetros
            </Button>
          </div>
        }
      />

      <div className="page">
        {meta.isError ? (
          <Card>
            <EmptyState
              icon="alert"
              title="Falha ao carregar"
              body="Não foi possível carregar os dados da conta agora. Tente novamente em instantes."
            />
          </Card>
        ) : !hasLedger ? (
          <Card>
            <EmptyState
              icon="sparkle"
              title="Nenhum dado importado ainda"
              body="O motor cruza saldo, compromissos, limite de cartão, metas e dívida. Ele aparece assim que houver histórico para cruzar."
            />
          </Card>
        ) : available.isError ? (
          <Card>
            <EmptyState
              icon="alert"
              title="Falha ao carregar"
              body="Não foi possível carregar o disponível para alocação agora. Tente novamente em instantes."
            />
          </Card>
        ) : !available.data ? (
          <Card>
            <EmptyState title="Calculando…" />
          </Card>
        ) : (
          <Bento>
            <Slab span={4} accent>
              <HeroFigure
                label="Disponível para alocação"
                value={moneyCompact(available.data.availableCents)}
              >
                <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-xs)', marginTop: 'var(--sp-3)' }}>
                  {available.data.availableCents >= 0
                    ? 'O que resta do saldo depois dos compromissos, do limite de cartão comprometido e do que já foi destinado a metas neste período.'
                    : 'Os compromissos, o limite de cartão comprometido e o já destinado a metas somam mais que o saldo consolidado do período.'}
                </p>
              </HeroFigure>
            </Slab>

            <Card span={8} title="Como chegamos a esse número">
              <div className="kv">
                <span className="kv__k">Saldo consolidado</span>
                <span className="kv__v">{money(available.data.terms.consolidatedBalanceCents)}</span>
                <span className="kv__k">Compromissos futuros confirmados</span>
                <span className="kv__v neg">
                  {money(-available.data.terms.futureCommitmentsCents)}
                </span>
                <span className="kv__k">Limite de cartão comprometido</span>
                <span className="kv__v neg">
                  {money(-available.data.terms.provisionedCardBillCents)}
                </span>
                <span className="kv__k">Já destinado a metas no período</span>
                <span className="kv__v neg">{money(-available.data.terms.alreadyAllocatedCents)}</span>
              </div>
              <hr className="divider" />
              <div className="kv">
                <span className="kv__k">
                  <strong>Disponível</strong>
                </span>
                <span className="kv__v">
                  <strong>{money(available.data.availableCents)}</strong>
                </span>
              </div>
              <Assumptions data={available.data.assumptions} />
            </Card>

            <Card span={6} title="Recordes" subtitle="Últimos 24 meses observados">
              <div className="stack stack--loose">
                <StatTile
                  label="Maior disponível já registrado"
                  value={records.data?.highestAvailable ? moneyCompact(records.data.highestAvailable.valorCents) : '-'}
                  foot={records.data?.highestAvailable ? periodLong(records.data.highestAvailable.periodo) : undefined}
                />
                <StatTile
                  label="Dias desde o último saldo negativo"
                  value={
                    records.data?.daysSinceNegativeBalance !== null &&
                    records.data?.daysSinceNegativeBalance !== undefined
                      ? String(records.data.daysSinceNegativeBalance)
                      : 'nunca ficou negativo'
                  }
                  foot={records.data?.lastNegativeOn ? `último em ${records.data.lastNegativeOn}` : undefined}
                />
              </div>
            </Card>

            <Card
              span={6}
              title="Por destino"
              subtitle="Em ordem alfabética, deliberadamente neutra: a ordem não é calculada a partir dos valores"
            >
              {/* Same wrapper every wide table in the app uses, so a narrow
                  screen scrolls the table instead of the page. */}
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Destino</th>
                      <th className="table__num">Meta</th>
                      <th className="table__num">Realizado</th>
                      <th className="table__num">Diferença</th>
                    </tr>
                  </thead>
                  <tbody>
                    {available.data.destinations.map((destination) => (
                      <tr key={destination.key}>
                        <td>
                          {destination.label}
                          {/* The formula sits with its own row, not in a pile
                              of disclosures under the table. */}
                          <Assumptions data={destination.assumptions} />
                        </td>
                        <td className="table__num">
                          {destination.targetCents === null ? (
                            <span className="muted">sem meta</span>
                          ) : (
                            money(destination.targetCents)
                          )}
                        </td>
                        <td className="table__num">{money(destination.realizedCents)}</td>
                        <td className="table__num">
                          {destination.differenceCents === null ? (
                            <span className="muted">-</span>
                          ) : (
                            money(destination.differenceCents)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* 12, não 6: é o último card do bento e não tem par, então um
                span 6 deixava metade da tela vazia com uma tabela espremida
                do outro lado (auditoria de layout de 01/09/2026). */}
            <Card
              span={12}
              title="Ponto de equilíbrio de faturamento"
              subtitle="O faturamento que cobriria tudo que já está configurado neste mês"
            >
              {breakEven.isError ? (
                <EmptyState
                  icon="alert"
                  title="Falha ao carregar"
                  body="Não foi possível carregar o ponto de equilíbrio agora. Tente novamente em instantes."
                />
              ) : !breakEven.data ? (
                <EmptyState title="Calculando…" />
              ) : breakEven.data.breakEvenCents === null ? (
                <EmptyState
                  icon="info"
                  title="Sem ponto de equilíbrio com estes parâmetros"
                  body="Uma alíquota igual ou maior que 100% do faturamento não tem solução. O valor aparece assim que a alíquota configurada ficar abaixo disso."
                />
              ) : (
                <div className="stack stack--loose">
                  {/*
                    Dois números, nunca chamados de "meta": a palavra já tem
                    dono em `specs/monthly-goals` (teto de gasto do mês), e
                    reusá-la aqui criaria duas metas diferentes no produto.
                  */}
                  <div className="bento" style={{ gap: 'var(--sp-4)' }}>
                    <div className="col-6">
                      <StatTile
                        label="Faturamento mínimo"
                        value={
                          breakEven.data.minimoCents === null
                            ? 'sem base'
                            : money(breakEven.data.minimoCents)
                        }
                        foot={
                          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                            custos, pró-labore e impostos
                          </span>
                        }
                      />
                    </div>
                    <div className="col-6">
                      <StatTile
                        label="Faturamento com metas configuradas"
                        value={money(breakEven.data.breakEvenCents)}
                        large
                        foot={
                          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                            o mínimo mais reserva e investimento planejados
                          </span>
                        }
                      />
                    </div>
                  </div>

                  {breakEven.data.metasCents !== null && (
                    <div className="kv">
                      <span className="kv__k">
                        Quanto das metas de investimento e reserva está incluído
                      </span>
                      <span className="kv__v">{money(breakEven.data.metasCents)}</span>
                    </div>
                  )}

                  {/* Unica tabela do app que estava sem wrapper de scroll
                      (auditoria de 01/09/2026): num card span=6 ela estoura
                      a largura em telas medias em vez de rolar sozinha. */}
                  <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Componente</th>
                        <th className="table__num">Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakEven.data.lines.map((line) => {
                        const hint = lineHint(line)
                        return (
                          <tr key={line.key}>
                            <td>
                              {line.label}
                              {hint && (
                                <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                                  {' '}
                                  ({hint})
                                </span>
                              )}
                            </td>
                            <td className="table__num">{money(line.amountCents)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  </div>

                  <div className="kv">
                    <span className="kv__k">Faturado no período</span>
                    <span className="kv__v">{money(breakEven.data.billedCents)}</span>
                    <span className="kv__k">Diferença</span>
                    <span
                      className={`kv__v ${(breakEven.data.differenceCents ?? 0) >= 0 ? 'pos' : 'neg'}`}
                    >
                      {money(breakEven.data.differenceCents ?? 0)}
                    </span>
                  </div>

                  {/* The closing sentence stays conditional, per the
                      instrumental-language table in decisions/0010. */}
                  <p className="chart__note">
                    Se os custos, o pró-labore e as metas configuradas se mantiverem, os valores
                    acima seriam os necessários para cobrir o mês.
                  </p>

                  <Assumptions data={breakEven.data.assumptions} label="Como calculamos o ponto de equilíbrio" />
                </div>
              )}
            </Card>
          </Bento>
        )}
      </div>

      {tuning && <ParamsEditor onClose={() => setTuning(false)} />}
    </>
  )
}

function ParamsEditor({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const meta = useMeta()
  const accounts = meta.data?.accounts ?? []

  const settings = useQuery({
    queryKey: ['engine-settings'],
    queryFn: () => api.get<{ settings: EngineSettings; defaults: EngineSettings }>('/financial-engine/settings'),
  })
  const current = settings.data?.settings

  const [pj, setPj] = useState<number | null | undefined>(undefined)
  const [pf, setPf] = useState<number | null | undefined>(undefined)
  const [proLabore, setProLabore] = useState<string | undefined>(undefined)
  const [tax, setTax] = useState<string | undefined>(undefined)
  const [reserve, setReserve] = useState<string | undefined>(undefined)
  const [margin, setMargin] = useState<string | undefined>(undefined)

  const save = useMutation({
    mutationFn: () =>
      api.put('/financial-engine/settings', {
        ...(pj === undefined ? {} : { pjAccountId: pj }),
        ...(pf === undefined ? {} : { pfAccountId: pf }),
        ...(proLabore === undefined
          ? {}
          : { proLaboreCents: proLabore.trim() === '' ? null : parseMoneyInput(proLabore) }),
        ...(tax === undefined || tax.trim() === '' ? {} : { taxRateBps: parsePercentInput(tax) ?? 0 }),
        ...(reserve === undefined || reserve.trim() === ''
          ? {}
          : { reservePlannedCents: parseMoneyInput(reserve) ?? 0 }),
        ...(margin === undefined || margin.trim() === ''
          ? {}
          : { marginCents: parseMoneyInput(margin) ?? 0 }),
      }),
    onSuccess: () => {
      toast('Parâmetros salvos')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const accountOptions = accounts.map((account) => ({ value: account.id, label: account.name }))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[880px]">
        <DialogTitle>Parâmetros do motor financeiro</DialogTitle>
        {!current ? (
        <SkeletonLines lines={5} />
      ) : (
        <div className="stack stack--loose">
          <div className="stack stack--tight">
            <span className="label">Contas</span>
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
              <div className="field" style={{ minWidth: 200 }}>
                <label className="field__label">Conta PJ</label>
                <Select
                  value={pj === undefined ? current.pjAccountId : pj}
                  placeholder="Todo o ledger"
                  options={accountOptions}
                  onChange={setPj}
                />
                <span className="field__hint">De onde saem os custos PJ do ponto de equilíbrio</span>
              </div>
              <div className="field" style={{ minWidth: 200 }}>
                <label className="field__label">Conta PF</label>
                <Select
                  value={pf === undefined ? current.pfAccountId : pf}
                  placeholder="Não informada"
                  options={accountOptions}
                  onChange={setPf}
                />
                <span className="field__hint">Destino do repasse que vira pró-labore</span>
              </div>
            </div>
          </div>

          <div className="stack stack--tight">
            <span className="label">Valores do mês</span>
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
              <div className="field" style={{ width: 190 }}>
                <label className="field__label">Pró-labore (R$)</label>
                <Input
                  value={proLabore === undefined ? centsToInput(current.proLaboreCents) : proLabore}
                  onChange={(e) => setProLabore(e.target.value)}
                  placeholder="deixe vazio para derivar"
                  className="text-right tabular-nums"
                />
                <span className="field__hint">
                  Vazio significa derivar do repasse PJ para PF pareado no período
                </span>
              </div>
              <div className="field" style={{ width: 150 }}>
                <label className="field__label">Alíquota (%)</label>
                <Input
                  value={tax === undefined ? bpsToInput(current.taxRateBps) : tax}
                  onChange={(e) => setTax(e.target.value)}
                  className="text-right tabular-nums"
                />
                <span className="field__hint">Incide sobre o próprio faturamento</span>
              </div>
              <div className="field" style={{ width: 190 }}>
                <label className="field__label">Reserva planejada (R$)</label>
                <Input
                  value={reserve === undefined ? centsToInput(current.reservePlannedCents) : reserve}
                  onChange={(e) => setReserve(e.target.value)}
                  className="text-right tabular-nums"
                />
                <span className="field__hint">
                  Quanto deste mês você destina à reserva. O quanto falta para completá-la aparece
                  na memória de cálculo, como referência
                </span>
              </div>
              <div className="field" style={{ width: 150 }}>
                <label className="field__label">Margem (R$)</label>
                <Input
                  value={margin === undefined ? centsToInput(current.marginCents) : margin}
                  onChange={(e) => setMargin(e.target.value)}
                  className="text-right tabular-nums"
                />
              </div>
            </div>
          </div>

          <p className="chart__note">
            Custos PJ, o repasse pareado e o que falta para a reserva continuam vindo do extrato e
            das outras telas, não deste formulário. O que se configura aqui é só o que o extrato não
            tem como saber.
          </p>
        </div>
      )}
        <DialogFooter>
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            Tudo aqui é escolha sua. O que o app consegue derivar do extrato continua sendo derivado.
          </span>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
