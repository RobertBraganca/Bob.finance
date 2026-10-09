import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { invalidateInvestmentData } from '../lib/invalidate'
import { useMeta } from '../lib/store'
import type { IconName } from '../components/ui/Icon'
import { bps, centsToInput, date as fmtDate, money, parseMoneyInput, period as fmtPeriod } from '../lib/format'
import {
  Assumptions,
  Bento,
  Button,
  Card,
  EmptyState,
  HeroFigure,
  Icon,
  Slab,
  StatTile,
  SkeletonLines,
  useToast,
  type AssumptionBag,
  LoadError,
} from '../components/ui'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { PageHeader } from '../components/shell/Shell'
import { NetWorthHistoryChart, type NetWorthPoint } from '../components/charts/NetWorthHistoryChart'

/**
 * Patrimônio: a tela que separa "de quanto eu disponho" (Financeiro) de
 * "quanto eu possuo" (Imobilizado). Existe porque o imobilizado não cabia
 * na tela de Investimentos — lá tudo é comparado contra uma política de
 * alocação, e um bem físico não se rebalanceia (ver `ILLIQUID_ASSET_CLASS`
 * em `services/investments.ts`, que o tira de `allocation()` no servidor).
 *
 * Toda leitura aqui é derivada, nada é guardado: `netWorth` recompõe saldo,
 * carteira e dívida a cada chamada, e a série histórica reconstitui os três
 * em cada mês (`decisions` de "derivar, nunca guardar").
 */

type NetWorth = {
  balanceCents: number
  investmentsCents: number
  illiquidCents: number
  financialCents: number
  /** "Quanto você deve" pessoal: dívidas + cartões pessoais (decisions/0045) */
  debtCents: number
  debtBreakdown: { debtsCents: number; cardsCents: number }
  /** patrimônio PESSOAL: contas pessoais + investimentos − dívida */
  liquidityCents: number
  company: { accountName: string | null; balanceCents: number; cardsCents: number; withdrawableCents: number | null } | null
  assumptions: AssumptionBag
}

/** Quais meses do histórico são foto gravada e quais são reconstruídos (decisions/0045). */
function historyNote(points: Array<{ period: string; source?: 'foto' | 'reconstruído' }> | undefined): string {
  if (!points || points.length === 0) return ''
  const firstPhoto = points.find((p) => p.source === 'foto')
  if (!firstPhoto) return 'Ainda sem foto mensal: todos os meses são reconstruídos com os dados de hoje.'
  const before = points.filter((p) => p.period < firstPhoto.period).length
  return before > 0 ? `Foto mensal desde ${fmtPeriod(firstPhoto.period)}; os ${before} meses antes dela são reconstruídos.` : 'Todos os meses são fotos gravadas no fim do mês.'
}

type IlliquidItem = {
  assetId: number
  name: string
  valueCents: number
  shareBps: number
  lastPricedOn: string | null
}

type IlliquidOverview = { totalCents: number; items: IlliquidItem[]; assumptions: AssumptionBag }

export function PatrimonioPage() {
  const meta = useMeta()
  const [adding, setAdding] = useState(false)
  const [revaluing, setRevaluing] = useState<IlliquidItem | null>(null)

  const netWorth = useQuery({
    queryKey: ['patrimonio-net-worth'],
    queryFn: () => api.get<NetWorth>('/financial-health/net-worth'),
    enabled: meta.isSuccess,
  })

  const history = useQuery({
    queryKey: ['patrimonio-net-worth-history'],
    queryFn: () => api.get<{ history: NetWorthPoint[] }>('/financial-health/net-worth-history', { months: 12 }),
    enabled: meta.isSuccess,
  })

  const illiquid = useQuery({
    queryKey: ['patrimonio-illiquid'],
    queryFn: () => api.get<IlliquidOverview>('/investments/illiquid'),
    enabled: meta.isSuccess,
  })

  const nw = netWorth.data
  // Uma fonte só: o servidor já entrega o patrimônio pessoal.
  const netWorthCents = nw?.liquidityCents ?? 0

  return (
    <>
      <PageHeader
        title="Patrimônio"
        subtitle="O seu patrimônio pessoal: o que você tem e o que você deve, com a empresa à parte"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            Adicionar bem
          </Button>
        }
      />

      <div className="page">
        {netWorth.isError && !nw && (
          <Card>
            <LoadError onRetry={() => netWorth.refetch()} retrying={netWorth.isFetching} />
          </Card>
        )}
        <Bento>
          <Slab span={6} accent assumptions={nw?.assumptions}>
            <HeroFigure label="Patrimônio pessoal hoje" value={nw ? money(netWorthCents) : '-'}>
              <div className="stack stack--tight" style={{ marginTop: 'var(--sp-4)' }}>
                <HeroLine label="Financeiro" value={nw ? money(nw.financialCents) : '-'} />
                <HeroLine label="Imobilizado" value={nw ? money(nw.illiquidCents) : '-'} />
                <HeroLine label="Dívida" value={nw ? `- ${money(nw.debtCents)}` : '-'} />
              </div>
              <p style={{ color: 'var(--on-slab-2)', fontSize: 'var(--text-xs)', marginTop: 'var(--sp-3)' }}>
                A dívida é a mesma do Endividamento, sem os cartões da empresa; a conta PJ fica à parte.
              </p>
            </HeroFigure>
          </Slab>

          <Card
            span={6}
            title="Composição"
            subtitle="De onde vem cada parte do patrimônio"
            assumptions={nw?.assumptions}
          >
            {!nw ? (
              <SkeletonLines lines={4} />
            ) : (
              <div className="card__fill card__fill--spread">
                {/*
                  Linha compacta, o MESMO padrão do card Imobilizado logo
                  abaixo. Antes eram quatro `StatTile` com número em tamanho
                  hero, o que deixava este card cinco vezes mais alto que o
                  hero ao lado e impedia o par — e era a inconsistência de
                  `list_pattern` que o próprio usuário apontou: duas listas
                  de valores na mesma página com tratamentos diferentes
                  (02/09/2026).
                */}
                <CompositionRow icon="wallet" label="Saldo das contas pessoais" value={money(nw.balanceCents)} />
                <CompositionRow
                  icon="trending"
                  label="Investimentos negociáveis"
                  value={money(nw.financialCents - nw.balanceCents)}
                />
                <CompositionRow icon="landmark" label="Imobilizado" value={money(nw.illiquidCents)} />
                <CompositionRow icon="alert" label="Dívidas e acordos" value={`- ${money(nw.debtBreakdown.debtsCents)}`} negative />
                <CompositionRow icon="wallet" label="Cartões pessoais (limite usado)" value={`- ${money(nw.debtBreakdown.cardsCents)}`} negative />
                <p className="chart__note">
                  Financeiro e Imobilizado somam o que existe; dívidas e cartões são subtraídos no
                  patrimônio ao lado. Um bem imobilizado conta como patrimônio, mas não paga uma conta.
                </p>
              </div>
            )}
          </Card>

          {nw?.company && (
            <Card
              span={12}
              title={`Empresa${nw.company.accountName ? ` (${nw.company.accountName})` : ''}`}
              subtitle="Fora do patrimônio pessoal: o dinheiro da PJ tem DAS, contas e colchão antes de ser seu"
            >
              <div className="card__fill card__fill--spread">
                <CompositionRow icon="bank" label="Saldo da conta PJ" value={money(nw.company.balanceCents)} />
                {nw.company.cardsCents > 0 && (
                  <CompositionRow icon="wallet" label="Cartão da empresa (limite usado)" value={`- ${money(nw.company.cardsCents)}`} negative />
                )}
                <CompositionRow
                  icon="trending"
                  label="Retirável hoje (Minha empresa)"
                  value={nw.company.withdrawableCents === null ? '-' : money(nw.company.withdrawableCents)}
                />
              </div>
            </Card>
          )}

          <Card
            span={12}
            title="Imobilizado"
            assumptions={illiquid.data?.assumptions}
            subtitle="Bens que entram no patrimônio mas não se rebalanceiam: imóvel, veículo, joia"
          >
            {illiquid.isError ? (
              <LoadError onRetry={() => illiquid.refetch()} retrying={illiquid.isFetching} />
            ) : !illiquid.data ? (
              <SkeletonLines lines={4} />
            ) : illiquid.data.items.length === 0 ? (
              <EmptyState
                icon="sparkle"
                title="Nenhum bem cadastrado"
                body="Cadastre imóveis, veículos ou outros bens para que entrem no seu patrimônio líquido."
                action={
                  <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
                    Adicionar bem
                  </Button>
                }
              />
            ) : (
              <>
                <div className="stack stack--tight">
                  {illiquid.data.items.map((item) => (
                    <div key={item.assetId} className="asset-row" style={{ alignItems: 'flex-start' }}>
                      <span className="row" style={{ gap: 'var(--sp-3)', minWidth: 0, alignItems: 'flex-start' }}>
                        <span className="icon-chip">
                          <Icon name="landmark" size={16} />
                        </span>
                        <span className="stack" style={{ gap: 0, minWidth: 0 }}>
                          {/* Sem truncate (revisão de responsividade de 26/09/2026):
                              nome do bem é texto livre do usuário, cortado virava
                              "Celular de tr…" num telefone. */}
                          <span style={{ fontWeight: 600 }}>
                            {item.name}
                          </span>
                          <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                            {item.lastPricedOn
                              ? `valor de ${fmtDate(item.lastPricedOn)}`
                              : 'valor do cadastro, nunca reavaliado'}
                            {' · '}
                            {bps(item.shareBps, 0)} do imobilizado
                          </span>
                        </span>
                      </span>
                      <span className="row" style={{ gap: 'var(--sp-2)', flex: 'none' }}>
                        <span className="tabular" style={{ fontWeight: 600 }}>
                          {money(item.valueCents)}
                        </span>
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="pencil"
                          title="Atualizar o valor deste bem"
                          aria-label={`Atualizar o valor de ${item.name}`}
                          onClick={() => setRevaluing(item)}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>


          <Card
            span={12}
            title="Evolução do patrimônio"
            subtitle={`Patrimônio pessoal, últimos 12 meses. ${historyNote(history.data?.history) || 'Reconstruído com os lançamentos e saldos registrados.'} Um bem entra na data de aquisição.`}
          >
            {history.isError ? (
              <LoadError onRetry={() => history.refetch()} retrying={history.isFetching} />
            ) : !history.data ? (
              <SkeletonLines lines={4} />
            ) : (
              <NetWorthHistoryChart points={history.data.history} surface="paper" />
            )}
          </Card>
        </Bento>
      </div>

      {adding && <AddAssetModal onClose={() => setAdding(false)} />}
      {revaluing && <RevalueModal item={revaluing} onClose={() => setRevaluing(null)} />}
    </>
  )
}

/**
 * Uma linha da Composição: ícone, rótulo, valor. Mesmo desenho das linhas
 * do card Imobilizado (`.asset-row` + `.icon-chip`), para a página ter UM
 * padrão de lista de valores e não dois.
 */
function CompositionRow({
  icon,
  label,
  value,
  negative,
}: {
  icon: IconName
  label: string
  value: string
  negative?: boolean
}) {
  return (
    <div className="asset-row" style={{ alignItems: 'flex-start' }}>
      <span className="row" style={{ gap: 'var(--sp-3)', minWidth: 0, alignItems: 'flex-start' }}>
        <span className="icon-chip icon-chip--sm">
          <Icon name={icon} size={14} />
        </span>
        {/* Sem truncate (revisão de responsividade de 26/09/2026): "Investimentos
            negociáveis" cortava pra "Investimentos neg…" num telefone — quebrar
            em duas linhas custa altura, que sobra, nunca legibilidade.
            `minWidth: 0` sozinho (sem overflow:hidden do truncate) é o que
            deixa o item de flex encolher e quebrar linha em vez de estourar. */}
        <span style={{ minWidth: 0 }}>{label}</span>
      </span>
      <span
        className="tabular"
        style={{ fontWeight: 600, flex: 'none', color: negative ? 'var(--delta-down)' : undefined }}
      >
        {value}
      </span>
    </div>
  )
}

function HeroLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="row row--between" style={{ gap: 'var(--sp-3)' }}>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-2)' }}>{label}</span>
      <span className="tabular" style={{ fontSize: 'var(--text-sm)', color: 'var(--on-slab-1)' }}>
        {value}
      </span>
    </div>
  )
}

/**
 * Um bem imobilizado precisa de DUAS chamadas para existir com valor:
 * o ativo em si e um aporte de quantidade 1 que carrega o valor. Isso não
 * é um detalhe desta tela, é como `positions()` deriva valor de mercado
 * (quantidade × cotação, ambas vindas de trades) — sem o trade, o bem
 * apareceria valendo zero.
 */
function AddAssetModal({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const meta = useMeta()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  // Data de aquisição: o degrau do bem no gráfico cai no mês certo (specs/personal-picture).
  const today = meta.data?.today ?? new Date().toISOString().slice(0, 10)
  const [acquiredOn, setAcquiredOn] = useState(today)
  const nameFieldId = useId()
  const valueFieldId = useId()
  const dateFieldId = useId()

  const create = useMutation({
    mutationFn: async () => {
      const valueCents = Math.abs(parseMoneyInput(value) ?? 0)
      const asset = await api.post<{ id: number }>('/investments/assets', {
        name: name.trim(),
        assetClass: 'illiquid',
      })
      await api.post('/investments/trades', {
        assetId: asset.id,
        kind: 'buy',
        tradedOn: acquiredOn || today,
        quantity: 1,
        unitPriceCents: valueCents,
      })
    },
    onSuccess: () => {
      toast(`${name.trim()} adicionado ao patrimônio`)
      invalidateInvestmentData(queryClient)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao adicionar', 'error'),
  })

  const canSave = name.trim().length > 0 && (parseMoneyInput(value) ?? 0) > 0

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogTitle>Adicionar bem ao patrimônio</DialogTitle>
        <div className="stack stack--loose">
          <div className="field">
            <label className="field__label" htmlFor={nameFieldId}>Nome do bem</label>
            <Input
              id={nameFieldId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Apartamento, carro, aliança..."
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={valueFieldId}>Valor estimado</label>
            <Input
              id={valueFieldId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0,00"
              className="text-right tabular-nums"
            />
            <span className="field__hint">
              Bem físico não tem cotação de mercado: este valor é o que você informa, e fica assim
              até você reavaliar. Se o bem tem financiamento, cadastre a dívida em Endividamento.
            </span>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={dateFieldId}>Data de aquisição</label>
            <Input id={dateFieldId} type="date" value={acquiredOn} max={today} onChange={(e) => setAcquiredOn(e.target.value)} />
            <span className="field__hint">O bem entra no patrimônio a partir desta data, também no gráfico de evolução.</span>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" disabled={!canSave || create.isPending} onClick={() => create.mutate()}>
            Adicionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Reavaliar grava uma cotação nova, nunca edita a anterior — o histórico de valor do bem fica inteiro. */
function RevalueModal({ item, onClose }: { item: IlliquidItem; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const meta = useMeta()
  const [value, setValue] = useState(() => centsToInput(item.valueCents))
  const valueFieldId = useId()

  const save = useMutation({
    mutationFn: () =>
      api.post(`/investments/assets/${item.assetId}/valuation`, {
        unitPriceCents: Math.abs(parseMoneyInput(value) ?? 0),
        asOf: meta.data?.today ?? new Date().toISOString().slice(0, 10),
      }),
    onSuccess: () => {
      toast(`Valor de ${item.name} atualizado`)
      invalidateInvestmentData(queryClient)
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao atualizar', 'error'),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogTitle>Atualizar valor de {item.name}</DialogTitle>
        <div className="stack stack--loose">
          <div className="field">
            <label className="field__label" htmlFor={valueFieldId}>Valor atual</label>
            <Input
              id={valueFieldId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0,00"
              className="text-right tabular-nums"
            />
            <span className="field__hint">
              O valor anterior fica no histórico do bem, esta reavaliação não apaga nada.
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={(parseMoneyInput(value) ?? 0) <= 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
