import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAccounts, useMeta } from '../lib/store'
import {
  centsToInput,
  date as fmtDate,
  money,
  moneyCompact,
  parseMoneyInput,
  periodLong,
} from '../lib/format'
import {
  Bento,
  Button,
  Card,
  CategorySelect,
  EmptyState,
  HeroFigure,
  Icon,
  Meter,
  Select,
  Slab,
  StatTile,
  StatusBadge,
  useToast,
  type MeterState,
  PeriodNav,
} from '../components/ui'
import { Input } from '../components/ui/input'
import { PageHeader } from '../components/shell/Shell'
import { SpendAreaChart } from '../components/charts/SpendAreaChart'

type DailyResponse = {
  range: { from: string; to: string }
  period: string
  days: Array<{ day: string; expenseCents: number; transactionCount: number }>
  streak: { days: number; lastEntryOn: string | null }
  pace: {
    daysElapsed: number
    daysTotal: number
    spentCents: number
    capCents: number | null
    paceCents: number | null
    aheadOfPaceCents: number | null
    projectedMonthCents: number
    dailyAllowanceCents: number | null
  }
  receivableCents: number
}

export function DailyPage() {
  const meta = useMeta()
  const today = meta.data?.today ?? '2026-08-19'
  const [period, setPeriod] = useState(() => today.slice(0, 7))

  const daily = useQuery({
    queryKey: ['daily', period],
    queryFn: () => api.get<DailyResponse>('/analytics/daily', { period }),
    enabled: meta.isSuccess,
    placeholderData: (previous) => previous,
  })

  const pace = daily.data?.pace
  const paceState: MeterState = useMemo(() => {
    if (!pace || pace.capCents === null) return 'no_target'
    if (pace.spentCents > pace.capCents) return 'exceeded'
    if (pace.aheadOfPaceCents !== null && pace.aheadOfPaceCents > 0) return 'at_risk'
    return 'on_track'
  }, [pace])

  const daysWithSpend = (daily.data?.days ?? []).filter((d) => d.expenseCents > 0)
  const busiest = daysWithSpend.reduce<{ day: string; expenseCents: number } | null>(
    (max, day) => (max === null || day.expenseCents > max.expenseCents ? day : max),
    null,
  )
  const avgPerActiveDay =
    daysWithSpend.length > 0
      ? Math.round(daysWithSpend.reduce((sum, d) => sum + d.expenseCents, 0) / daysWithSpend.length)
      : 0

  return (
    <>
      <PageHeader
        title="Diário"
        subtitle={periodLong(period)}
        actions={
          <PeriodNav period={period} onChange={setPeriod} max={today.slice(0, 7)} />
        }
      />

      <div className="page">
        <Bento>
          <QuickAdd today={today} />

          <Slab span={6} accent>
            <HeroFigure
              label={`Gasto em ${periodLong(period)}`}
              value={moneyCompact(pace?.spentCents ?? 0)}
            >
              <div className="stack stack--tight" style={{ marginTop: 'var(--sp-3)' }}>
                <div className="row row--between">
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-2)' }}>
                    {pace ? `dia ${pace.daysElapsed} de ${pace.daysTotal}` : ''}
                  </span>
                  <StatusBadge state={paceState} />
                </div>
                <Meter
                  usedBps={
                    pace?.capCents ? Math.round((pace.spentCents / pace.capCents) * 10_000) : 0
                  }
                  paceBps={
                    pace?.capCents && pace.paceCents !== null
                      ? Math.round((pace.paceCents / pace.capCents) * 10_000)
                      : null
                  }
                  state={paceState}
                />
                {pace?.capCents ? (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-2)' }}>
                    Teto do mês {money(pace.capCents)} · marca branca = ritmo esperado hoje
                  </span>
                ) : (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-3)' }}>
                    Defina um teto de gastos em Metas do mês para acompanhar o ritmo.
                  </span>
                )}
              </div>
            </HeroFigure>
          </Slab>

          {/* Largura inteira: com span 8 a linha fechava em 11 (8 + o
              primeiro tile de 3) e sobrava 1 coluna morta, e os outros 3
              tiles caíam numa linha de 9 com 3 colunas vazias. Agora o
              gráfico ocupa uma linha e os 4 tiles fecham a seguinte em
              3+3+3+3 (auditoria de layout de 01/09/2026). */}
          {/*
            Meia largura, ao lado do hero: e UM numero, e ocupava 1105px
            sozinho enquanto os quatro KPI de ritmo logo abaixo tinham 545
            cada — a mesma informacao com dois pesos (02/09/2026).
          */}
          <Card span={6}>
            <StatTile
              label="A receber"
              value={moneyCompact(daily.data?.receivableCents ?? 0)}
              foot="entradas pendentes de confirmação no período"
            />
          </Card>

          <Slab span={12} title="Intensidade por dia" subtitle="Gasto de cada dia do mês selecionado">
            <SpendAreaChart days={daily.data?.days ?? []} surface="paper" />
          </Slab>

          <Card span={6}>
            <StatTile
              label="Ritmo projetado para o mês"
              value={moneyCompact(pace?.projectedMonthCents ?? 0)}
              foot={
                pace?.capCents
                  ? pace.projectedMonthCents > pace.capCents
                    ? `${money(pace.projectedMonthCents - pace.capCents)} acima do teto`
                    : `${money(pace.capCents - pace.projectedMonthCents)} de folga`
                  : 'sem teto definido'
              }
            />
          </Card>
          <Card span={6}>
            <StatTile
              label="Pode gastar por dia"
              value={pace?.dailyAllowanceCents !== null && pace?.dailyAllowanceCents !== undefined ? moneyCompact(pace.dailyAllowanceCents) : '-'}
              foot={
                pace && pace.daysTotal - pace.daysElapsed > 0
                  ? `nos ${pace.daysTotal - pace.daysElapsed} dias restantes`
                  : 'mês encerrado'
              }
            />
          </Card>
          <Card span={6}>
            <StatTile
              label="Média por dia com gasto"
              value={moneyCompact(avgPerActiveDay)}
              foot={`${daysWithSpend.length} dias com movimento`}
            />
          </Card>
          <Card span={6}>
            <StatTile
              label="Maior dia"
              value={busiest ? moneyCompact(busiest.expenseCents) : '-'}
              foot={busiest ? fmtDate(busiest.day) : 'sem gastos'}
            />
          </Card>
          <Card span={12}>
            <div className="row row--between" style={{ alignItems: 'center' }}>
              <span className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
                <span className="icon-chip icon-chip--sm">
                  <Icon name="check" size={14} />
                </span>
                <span style={{ fontSize: 'var(--text-sm)' }}>
                  {daily.data?.streak.days
                    ? `${daily.data.streak.days} dia${daily.data.streak.days > 1 ? 's' : ''} seguido${daily.data.streak.days > 1 ? 's' : ''} com lançamento no Diário`
                    : 'Nenhum lançamento no Diário hoje ainda'}
                </span>
              </span>
              {daily.data?.streak.lastEntryOn && (
                <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                  Último em {fmtDate(daily.data.streak.lastEntryOn)}
                </span>
              )}
            </div>
          </Card>

          <RecentDaily period={period} />
        </Bento>
      </div>
    </>
  )
}

/**
 * Quick-add is deliberately NOT the full transaction form: amount,
 * category, note. Everything else is inferred, so repeated entry is fast.
 */
function QuickAdd({ today }: { today: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()
  const amountRef = useRef<HTMLDivElement>(null)

  const [amount, setAmount] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [day, setDay] = useState(today)
  const [accountId, setAccountId] = useState<number | null>(null)

  const defaultAccount = accountId ?? accounts.data?.accounts[0]?.id ?? null

  const add = useMutation({
    mutationFn: () => {
      const cents = parseMoneyInput(amount)
      if (cents === null || cents === 0) throw new Error('informe um valor')
      if (!defaultAccount) throw new Error('cadastre uma conta primeiro')
      return api.post('/transactions', {
        accountId: defaultAccount,
        postedOn: day,
        // A daily log entry is a spend, so the sign is implied.
        amountCents: -Math.abs(cents),
        description: note.trim() || 'Gasto avulso',
        categoryId,
        source: 'daily',
      })
    },
    onSuccess: () => {
      toast(`Lançado ${money(-Math.abs(parseMoneyInput(amount) ?? 0))}`)
      setAmount('')
      setNote('')
      queryClient.invalidateQueries()
      amountRef.current?.querySelector('input')?.focus()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao lançar', 'error'),
  })

  return (
    <Card span={12} title="Lançamento rápido" subtitle="Para o gasto do dia, sem abrir formulário completo">
      <form
        className="row row--wrap"
        style={{ gap: 'var(--sp-3)', alignItems: 'flex-end' }}
        onSubmit={(event) => {
          event.preventDefault()
          add.mutate()
        }}
      >
        <div className="field" style={{ width: 150 }} ref={amountRef}>
          <label className="field__label">Valor</label>
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0,00"
            className="text-right tabular-nums"
          />
        </div>
        <div className="field" style={{ minWidth: 200, flex: 1 }}>
          <label className="field__label">Categoria</label>
          <CategorySelect value={categoryId} direction="out" onChange={setCategoryId} />
        </div>
        <div className="field" style={{ minWidth: 180, flex: 1 }}>
          <label className="field__label">Nota</label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="ex. almoço com cliente" />
        </div>
        <div className="field" style={{ width: 150 }}>
          <label className="field__label">Data</label>
          <Input value={day} onChange={(e) => setDay(e.target.value)} type="date" max={today} />
        </div>
        <div className="field" style={{ minWidth: 160 }}>
          <label className="field__label">Conta</label>
          <Select
            value={defaultAccount}
            options={(accounts.data?.accounts ?? []).map((account) => ({
              value: account.id,
              label: account.name,
            }))}
            onChange={setAccountId}
          />
        </div>
        <Button variant="primary" icon="plus" type="submit" disabled={add.isPending}>
          Lançar
        </Button>
      </form>
      <p className="chart__note">
        <Icon name="info" size={12} /> Entradas do diário vão para a mesma tabela de lançamentos que
        os extratos importados, e nenhum painel trata as duas de forma diferente.
      </p>
    </Card>
  )
}

function RecentDaily({ period }: { period: string }) {
  const bounds = useMemo(() => {
    const [y, m] = period.split('-').map(Number) as [number, number]
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` }
  }, [period])

  const query = useQuery({
    queryKey: ['daily-entries', period],
    queryFn: () =>
      api.get<{ rows: Array<{ id: number; postedOn: string; description: string; amountCents: number; categoryName: string | null; categoryColor: string | null }> }>(
        '/transactions',
        { from: bounds.from, to: bounds.to, source: 'daily', limit: 50 },
      ),
  })

  const rows = query.data?.rows ?? []

  return (
    <Card span={12} flush title="Lançamentos do diário neste mês">
      {query.isError ? (
        <EmptyState
          icon="alert"
          title="Falha ao carregar lançamentos"
          body="Não foi possível carregar os lançamentos do diário agora. Tente novamente em instantes."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="Nenhum lançamento rápido neste mês"
          body="Use o formulário acima para registrar gastos do dia a dia."
        />
      ) : (
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Data</th>
                <th>Nota</th>
                <th style={{ width: 200 }}>Categoria</th>
                <th className="table__num" style={{ width: 130 }}>Valor</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="tabular">{fmtDate(row.postedOn)}</td>
                  <td className="truncate">{row.description}</td>
                  <td>
                    <span className="row" style={{ gap: 'var(--sp-2)' }}>
                      {row.categoryColor && <span className="swatch" style={{ background: row.categoryColor }} />}
                      <span className="truncate">{row.categoryName ?? 'Sem categoria'}</span>
                    </span>
                  </td>
                  <td className="table__num neg">{money(row.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
