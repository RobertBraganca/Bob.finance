import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useMeta } from '../lib/store'
import { bps, centsToInput, date as fmtDate, money, moneyCompact, parseMoneyInput } from '../lib/format'
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
  debtCents: number
  liquidityCents: number
  assumptions: AssumptionBag
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
  const netWorthCents = nw ? nw.balanceCents + nw.investmentsCents - nw.debtCents : 0

  return (
    <>
      <PageHeader
        title="Patrimônio"
        subtitle="O que você tem, o que você deve e o que sobra"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            Adicionar bem
          </Button>
        }
      />

      <div className="page">
        <Bento>
          <Slab span={5} accent>
            <HeroFigure label="Patrimônio líquido" value={nw ? moneyCompact(netWorthCents) : '-'}>
              <div className="stack stack--tight" style={{ marginTop: 'var(--sp-4)' }}>
                <HeroLine label="Financeiro" value={nw ? money(nw.financialCents) : '-'} />
                <HeroLine label="Imobilizado" value={nw ? money(nw.illiquidCents) : '-'} />
                <HeroLine label="Dívida" value={nw ? `- ${money(nw.debtCents)}` : '-'} />
              </div>
            </HeroFigure>
          </Slab>

          <Card span={7} title="Evolução do patrimônio" subtitle="Últimos 12 meses, recalculado a cada mês">
            <NetWorthHistoryChart points={history.data?.history ?? []} surface="paper" />
          </Card>

          <Card
            span={7}
            title="Imobilizado"
            assumptions={illiquid.data?.assumptions}
            subtitle="Bens que entram no patrimônio mas não se rebalanceiam: imóvel, veículo, joia"
          >
            {illiquid.isError ? (
              <EmptyState
                icon="alert"
                title="Falha ao carregar"
                body="Não foi possível carregar os bens agora. Tente novamente em instantes."
              />
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
                    <div key={item.assetId} className="asset-row">
                      <span className="row" style={{ gap: 'var(--sp-3)', minWidth: 0 }}>
                        <span className="icon-chip">
                          <Icon name="landmark" size={16} />
                        </span>
                        <span className="stack" style={{ gap: 0, minWidth: 0 }}>
                          <span className="truncate" style={{ fontWeight: 600 }}>
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
            span={5}
            title="Composição"
            subtitle="De onde vem cada parte do patrimônio"
            assumptions={nw?.assumptions}
          >
            {!nw ? (
              <SkeletonLines lines={4} />
            ) : (
              <>
                <div className="stack stack--loose">
                  <StatTile label="Saldo em conta" value={money(nw.balanceCents)} />
                  <StatTile label="Investimentos negociáveis" value={money(nw.financialCents - nw.balanceCents)} />
                  <StatTile label="Imobilizado" value={money(nw.illiquidCents)} />
                  <StatTile label="Dívida total" value={money(nw.debtCents)} />
                </div>
                <p className="chart__note">
                  Financeiro e Imobilizado somam o que existe; a dívida é subtraída no patrimônio
                  líquido ao lado. Um bem imobilizado conta como patrimônio, mas não paga uma conta,
                  então as duas metades aparecem separadas em vez de num número só.
                </p>
              </>
            )}
          </Card>
        </Bento>
      </div>

      {adding && <AddAssetModal onClose={() => setAdding(false)} />}
      {revaluing && <RevalueModal item={revaluing} onClose={() => setRevaluing(null)} />}
    </>
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
        tradedOn: meta.data?.today ?? new Date().toISOString().slice(0, 10),
        quantity: 1,
        unitPriceCents: valueCents,
      })
    },
    onSuccess: () => {
      toast(`${name.trim()} adicionado ao patrimônio`)
      queryClient.invalidateQueries()
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
            <label className="field__label">Nome do bem</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Apartamento, carro, aliança..."
            />
          </div>
          <div className="field">
            <label className="field__label">Valor estimado</label>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0,00"
              className="text-right tabular-nums"
            />
            <span className="field__hint">
              Bem físico não tem cotação de mercado: este valor é o que você informa, e fica assim
              até você reavaliar.
            </span>
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

  const save = useMutation({
    mutationFn: () =>
      api.post(`/investments/assets/${item.assetId}/valuation`, {
        unitPriceCents: Math.abs(parseMoneyInput(value) ?? 0),
        asOf: meta.data?.today ?? new Date().toISOString().slice(0, 10),
      }),
    onSuccess: () => {
      toast(`Valor de ${item.name} atualizado`)
      queryClient.invalidateQueries()
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
            <label className="field__label">Valor atual</label>
            <Input
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
