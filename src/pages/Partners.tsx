import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAccounts, useMeta } from '../lib/store'
import { currentPeriod, periodBounds } from '../lib/period'
import {
  bps,
  centsToInput,
  date as fmtDate,
  money,
  moneyCompact,
  parseMoneyInput,
} from '../lib/format'
import {
  Bento,
  Button,
  Card,
  EmptyState,
  HeroFigure,
  Icon,
  Meter,
  Modal,
  PeriodNav,
  Select,
  SkeletonLines,
  Slab,
  StatTile,
  StatusBadge,
  TextInput,
  useToast,
  type AssumptionBag,
  type MeterState,
} from '../components/ui'
import { PageHeader } from '../components/shell/Shell'
import {
  PartnerEvolutionChart,
  type PartnerEvolutionData,
} from '../components/charts/PartnerEvolutionChart'

/**
 * Receita de parceiros: comissões de plataformas (Wbuy, Hostinger,
 * Nuvemshop, Adobe) que ficam paradas na plataforma até bater um mínimo
 * de saque.
 *
 * O saldo mostrado aqui NÃO é dinheiro em conta, e a tela é feita para
 * não deixar dúvida sobre isso: o hero diz "acumulado nas plataformas", e
 * a receita só é reconhecida no saque, quando de fato entra numa conta
 * real (ver o cabeçalho de `server/src/services/partners.ts` e
 * `decisions/0037` para as três alternativas de modelagem consideradas).
 *
 * Por isso o card de Representatividade mede SAQUES contra a receita
 * total, não comissões: as duas pontas do % vêm do mesmo ledger, pela
 * mesma função (`totals()`), e comparar competência com caixa daria um
 * percentual que não fecha com nenhuma outra tela.
 */

type PlatformRow = {
  id: number
  name: string
  minWithdrawalCents: number
  notes: string | null
  active: boolean
  balanceCents: number
  earnedCents: number
  withdrawnCents: number
  commissionCount: number
  lastCommissionOn: string | null
  lastWithdrawalOn: string | null
  progressBps: number | null
  missingCents: number
  readyToWithdraw: boolean
}

type PartnerOverview = {
  range: { from: string; to: string }
  totalBalanceCents: number
  earnedInRangeCents: number
  withdrawnInRangeCents: number
  platforms: PlatformRow[]
  representativeness: {
    partnerIncomeCents: number
    totalIncomeCents: number
    shareBps: number | null
    previousPartnerIncomeCents: number
    previousTotalIncomeCents: number
    previousShareBps: number | null
    deltaPoints: number | null
    valueDeltaBps: number | null
  }
  assumptions: AssumptionBag
}

type CommissionRow = {
  id: number
  platformId: number
  platformName: string
  earnedOn: string
  amountCents: number
  notes: string | null
}

/**
 * Os três tons de badge do app, com as palavras desta tela.
 *
 * Este NÃO usa `targetProgressState`, e a diferença é o ponto: numa meta
 * de reserva, 87% do alvo vale 87% — progresso parcial é progresso, e por
 * isso ali 85% já lê verde ("No ritmo"). Um mínimo de saque é um LIMIAR,
 * não uma rampa: com R$ 43,71 de um mínimo de R$ 50,00 você não saca
 * nada, exatamente como com R$ 0,00. Reaproveitar o classificador de meta
 * aqui pintava "Quase no mínimo" de verde com um ícone de check, do lado
 * de um saldo que a plataforma não libera (medido na tela em 03/09/2026).
 *
 * Então o tom é binário no limiar, e o "quase" vive no RÓTULO e na linha
 * de "faltam R$ X" — nuance nas palavras, honestidade na cor.
 */
function withdrawalState(platform: PlatformRow): { state: MeterState; label: string } {
  if (platform.minWithdrawalCents === 0) {
    return platform.balanceCents > 0
      ? { state: 'met', label: 'Pronto para saque' }
      : { state: 'no_target', label: 'Sem mínimo' }
  }
  if (platform.balanceCents >= platform.minWithdrawalCents) {
    return { state: 'met', label: 'Pronto para saque' }
  }
  // O mesmo corte de 85% que o resto do app chama de "quase lá" (AT_RISK_AT
  // em services/goals.ts), mas aqui ele só troca a palavra, não o tom.
  const closeToMinimum = (platform.progressBps ?? 0) >= 8_500
  return { state: 'at_risk', label: closeToMinimum ? 'Quase no mínimo' : 'Abaixo do mínimo' }
}

export function PartnersPage() {
  const meta = useMeta()
  const [period, setPeriod] = useState(() => currentPeriod())
  const [addingPlatform, setAddingPlatform] = useState(false)
  const [editing, setEditing] = useState<PlatformRow | null>(null)
  const [addingCommission, setAddingCommission] = useState<PlatformRow | null>(null)
  const [withdrawing, setWithdrawing] = useState<PlatformRow | null>(null)
  const [history, setHistory] = useState<PlatformRow | null>(null)

  const range = useMemo(() => periodBounds(period), [period])

  const overview = useQuery({
    queryKey: ['partners', range.from, range.to],
    queryFn: () => api.get<PartnerOverview>('/partners', range),
    enabled: meta.isSuccess,
  })

  const evolution = useQuery({
    queryKey: ['partners-evolution'],
    queryFn: () => api.get<PartnerEvolutionData & { assumptions: AssumptionBag }>('/partners/evolution', { months: 12 }),
    enabled: meta.isSuccess,
  })

  const data = overview.data
  const platforms = data?.platforms ?? []
  const rep = data?.representativeness

  return (
    <>
      <PageHeader
        title="Receita de parceiros"
        subtitle="Comissões acumuladas nas plataformas e o que já virou dinheiro em conta"
        actions={
          <div className="row">
            <PeriodNav period={period} onChange={setPeriod} />
            <Button variant="primary" icon="plus" onClick={() => setAddingPlatform(true)}>
              Cadastrar plataforma
            </Button>
          </div>
        }
      />

      <div className="page">
        <Bento>
          <Slab span={6} accent>
            <HeroFigure
              label="Acumulado nas plataformas"
              value={data ? moneyCompact(data.totalBalanceCents) : '-'}
            >
              <div className="stack stack--tight" style={{ marginTop: 'var(--sp-4)' }}>
                {!data ? (
                  <SkeletonLines lines={3} />
                ) : platforms.length === 0 ? (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--on-slab-2)' }}>
                    Nenhuma plataforma cadastrada ainda.
                  </span>
                ) : (
                  platforms.map((platform) => (
                    <HeroLine
                      key={platform.id}
                      label={platform.name}
                      value={money(platform.balanceCents)}
                    />
                  ))
                )}
              </div>
            </HeroFigure>
          </Slab>

          <Card
            span={6}
            title="Representatividade"
            subtitle="Quanto da receita do mês veio de parceiros"
            assumptions={data?.assumptions}
          >
            {!rep ? (
              <SkeletonLines lines={4} />
            ) : (
              <div className="card__fill card__fill--spread">
                <StatTile
                  label="Participação na receita do mês"
                  value={rep.shareBps === null ? 'sem receita no mês' : bps(rep.shareBps)}
                  large
                  delta={rep.deltaPoints}
                  deltaUnit="points"
                  deltaLabel="vs mês anterior"
                  foot={
                    rep.previousShareBps !== null ? (
                      <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                        mês anterior: {bps(rep.previousShareBps)}
                      </span>
                    ) : null
                  }
                />
                <div className="stack stack--tight">
                  <KeyLine
                    label="Sacado no mês"
                    value={money(rep.partnerIncomeCents)}
                    hint="entrou em conta, conta como receita"
                  />
                  <KeyLine label="Receita total do mês" value={money(rep.totalIncomeCents)} />
                  <KeyLine
                    label="Comissões lançadas no mês"
                    value={money(data.earnedInRangeCents)}
                    hint="competência, ainda não é receita"
                  />
                </div>
              </div>
            )}
          </Card>

          <Card
            span={12}
            title="Plataformas"
            subtitle="Saldo de cada parceiro contra o mínimo de saque"
          >
            {overview.isLoading ? (
              <SkeletonLines lines={6} />
            ) : platforms.length === 0 ? (
              <EmptyState
                icon="layers"
                title="Nenhuma plataforma cadastrada"
                body="Cadastre Wbuy, Hostinger, Nuvemshop ou qualquer parceiro que pague comissão para acompanhar o saldo e o mínimo de saque."
                action={
                  <Button variant="primary" size="sm" icon="plus" onClick={() => setAddingPlatform(true)}>
                    Cadastrar plataforma
                  </Button>
                }
              />
            ) : (
              <div className="stack stack--loose">
                {platforms.map((platform) => (
                  <PlatformLine
                    key={platform.id}
                    platform={platform}
                    onCommission={() => setAddingCommission(platform)}
                    onWithdraw={() => setWithdrawing(platform)}
                    onEdit={() => setEditing(platform)}
                    onHistory={() => setHistory(platform)}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card
            span={12}
            title="Evolução"
            subtitle="Saldo acumulado por plataforma, últimos 12 meses"
            assumptions={evolution.data?.assumptions}
          >
            <PartnerEvolutionChart
              data={{ points: evolution.data?.points ?? [], platforms: evolution.data?.platforms ?? [] }}
              surface="paper"
            />
          </Card>
        </Bento>
      </div>

      {addingPlatform && <PlatformModal onClose={() => setAddingPlatform(false)} />}
      {editing && <PlatformModal platform={editing} onClose={() => setEditing(null)} />}
      {addingCommission && (
        <CommissionModal platform={addingCommission} onClose={() => setAddingCommission(null)} />
      )}
      {withdrawing && <WithdrawModal platform={withdrawing} onClose={() => setWithdrawing(null)} />}
      {history && <HistoryModal platform={history} onClose={() => setHistory(null)} />}
    </>
  )
}

/** Uma linha da lista lateral do hero — mesmo desenho do card de Patrimônio. */
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

function KeyLine({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="row row--between" style={{ gap: 'var(--sp-3)' }}>
      <span className="stack stack--tight" style={{ gap: 0, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--text-xs)' }}>{label}</span>
        {hint && (
          <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
            {hint}
          </span>
        )}
      </span>
      <span className="tabular" style={{ fontSize: 'var(--text-sm)' }}>
        {value}
      </span>
    </div>
  )
}

function PlatformLine({
  platform,
  onCommission,
  onWithdraw,
  onEdit,
  onHistory,
}: {
  platform: PlatformRow
  onCommission: () => void
  onWithdraw: () => void
  onEdit: () => void
  onHistory: () => void
}) {
  const { state, label } = withdrawalState(platform)
  const hasMinimum = platform.minWithdrawalCents > 0

  return (
    <div className="stack stack--tight">
      <div className="row row--between row--wrap" style={{ gap: 'var(--sp-3)' }}>
        <span className="row" style={{ gap: 'var(--sp-2)', minWidth: 0 }}>
          <strong className="truncate" style={{ fontSize: 'var(--text-sm)' }}>
            {platform.name}
          </strong>
          <StatusBadge state={state} label={label} />
        </span>
        {/* Saldo e ações quebram uma em relação à outra (`row--wrap`), mas o
            grupo de botões é ATÔMICO (`row`, que é nowrap): em 375px o
            saldo mais as quatro ações não cabem numa linha, e deixar tudo
            quebrar livremente largava um botão de ícone sozinho na segunda
            linha. Assim o desktop segue numa linha só e o mobile desce o
            bloco inteiro de botões de uma vez (medido em 03/09/2026). */}
        <span className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
          <span className="tabular" style={{ fontSize: 'var(--text-sm)' }}>
            {money(platform.balanceCents)}
            {hasMinimum && (
              <span className="muted"> de {money(platform.minWithdrawalCents)}</span>
            )}
          </span>
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button size="sm" icon="plus" onClick={onCommission} title="Registrar comissão">
              Comissão
            </Button>
            <Button
              size="sm"
              variant={platform.readyToWithdraw ? 'primary' : 'ghost'}
              icon="arrowDownLeft"
              onClick={onWithdraw}
              disabled={platform.balanceCents <= 0}
              title={
                platform.balanceCents <= 0
                  ? 'sem saldo acumulado para sacar'
                  : 'Registrar saque para uma conta'
              }
            >
              Sacar
            </Button>
            <Button size="sm" icon="list" onClick={onHistory} title="Comissões lançadas" />
            <Button size="sm" icon="settings" onClick={onEdit} title="Editar plataforma" />
          </span>
        </span>
      </div>

      {/* Sem mínimo não existe progresso a desenhar: uma barra cheia ou
          vazia aqui afirmaria um alvo que ninguém configurou. */}
      {hasMinimum && <Meter usedBps={platform.progressBps ?? 0} state={state} />}

      <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
        {hasMinimum
          ? platform.missingCents > 0
            ? `faltam ${money(platform.missingCents)} para o mínimo`
            : 'mínimo atingido, pode sacar'
          : 'sem mínimo de saque configurado'}
        {platform.lastCommissionOn && ` · última comissão em ${fmtDate(platform.lastCommissionOn)}`}
        {platform.withdrawnCents > 0 && ` · ${money(platform.withdrawnCents)} já sacados`}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Modais
 * ------------------------------------------------------------------ */
function PlatformModal({ platform, onClose }: { platform?: PlatformRow; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [name, setName] = useState(platform?.name ?? '')
  const [minimum, setMinimum] = useState(centsToInput(platform?.minWithdrawalCents ?? 0))
  const [notes, setNotes] = useState(platform?.notes ?? '')

  const save = useMutation({
    mutationFn: () => {
      const trimmed = name.trim()
      if (!trimmed) throw new Error('informe o nome da plataforma')
      const minWithdrawalCents = parseMoneyInput(minimum) ?? 0
      if (minWithdrawalCents < 0) throw new Error('o mínimo de saque não pode ser negativo')
      const body = { name: trimmed, minWithdrawalCents, notes: notes.trim() || null }
      return platform
        ? api.patch(`/partners/platforms/${platform.id}`, body)
        : api.post('/partners/platforms', body)
    },
    onSuccess: () => {
      toast(platform ? 'Plataforma atualizada' : 'Plataforma cadastrada')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const remove = useMutation({
    mutationFn: () => api.del<{ removed: number; keptTransactions: number }>(`/partners/platforms/${platform!.id}`),
    onSuccess: (result) => {
      toast(
        result.keptTransactions > 0
          ? `Plataforma removida. ${result.keptTransactions} saque(s) continuam em Lançamentos.`
          : 'Plataforma removida',
      )
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  return (
    <Modal
      title={platform ? `Editar ${platform.name}` : 'Cadastrar plataforma'}
      onClose={onClose}
      footer={
        <>
          {platform && (
            <Button
              variant="danger"
              icon="trash"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              Remover
            </Button>
          )}
          <Button variant="quiet" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label">Nome</label>
          <TextInput value={name} onChange={setName} placeholder="ex. Wbuy" />
        </div>

        <div className="field">
          <label className="field__label">Mínimo de saque (R$)</label>
          <TextInput value={minimum} onChange={setMinimum} placeholder="0,00" numeral />
          <span className="field__hint">
            Zero significa sem mínimo. Pode ser alterado a qualquer momento.
          </span>
        </div>

        <div className="field">
          <label className="field__label">Notas (opcional)</label>
          <TextInput value={notes} onChange={setNotes} placeholder="ex. paga todo dia 15" />
        </div>

        {platform && platform.withdrawnCents > 0 && (
          <p className="chart__note">
            Remover a plataforma apaga as comissões lançadas nela, mas mantém os saques já
            registrados em Lançamentos: aquele dinheiro entrou na conta de verdade.
          </p>
        )}
      </div>
    </Modal>
  )
}

function CommissionModal({ platform, onClose }: { platform: PlatformRow; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [earnedOn, setEarnedOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')

  const save = useMutation({
    mutationFn: () => {
      const amountCents = parseMoneyInput(amount)
      if (amountCents === null || amountCents <= 0) throw new Error('informe o valor da comissão')
      return api.post('/partners/commissions', {
        platformId: platform.id,
        earnedOn,
        amountCents: Math.abs(amountCents),
        notes: notes.trim() || null,
      })
    },
    onSuccess: () => {
      toast('Comissão registrada')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title={`Registrar comissão de ${platform.name}`}
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
            <TextInput value={earnedOn} onChange={setEarnedOn} type="date" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Valor (R$)</label>
            <TextInput value={amount} onChange={setAmount} placeholder="0,00" numeral />
          </div>
        </div>

        <div className="field">
          <label className="field__label">Notas (opcional)</label>
          <TextInput value={notes} onChange={setNotes} placeholder="ex. comissão de outubro" />
        </div>

        <p className="chart__note">
          Soma no saldo acumulado da plataforma. Não entra em Lançamentos nem na receita do mês:
          esse dinheiro só passa a existir em conta quando for sacado.
        </p>
      </div>
    </Modal>
  )
}

function WithdrawModal({ platform, onClose }: { platform: PlatformRow; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()
  const [accountId, setAccountId] = useState<number | null>(null)
  const [postedOn, setPostedOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [amount, setAmount] = useState(() => centsToInput(platform.balanceCents))
  const [notes, setNotes] = useState('')

  const options = useMemo(
    () =>
      (accounts.data?.accounts ?? []).map((account) => ({
        value: account.id,
        label: `${account.name} (${account.institution})`,
      })),
    [accounts.data],
  )

  const requested = parseMoneyInput(amount)
  const exceeds = requested !== null && requested > platform.balanceCents

  const save = useMutation({
    mutationFn: () => {
      if (accountId === null) throw new Error('escolha a conta de destino')
      if (requested === null || requested <= 0) throw new Error('informe o valor do saque')
      return api.post(`/partners/platforms/${platform.id}/withdraw`, {
        accountId,
        amountCents: Math.abs(requested),
        postedOn,
        notes: notes.trim() || null,
      })
    },
    onSuccess: () => {
      toast('Saque registrado e lançado na conta de destino')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <Modal
      title={`Registrar saque de ${platform.name}`}
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
            disabled={save.isPending || exceeds}
          >
            Registrar saque
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label">Conta de destino</label>
          <Select
            value={accountId}
            options={options}
            onChange={setAccountId}
            placeholder="Escolha a conta"
          />
          <span className="field__hint">
            As mesmas contas já cadastradas no app. Para um aporte direto, escolha a conta da
            corretora.
          </span>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Data</label>
            <TextInput value={postedOn} onChange={setPostedOn} type="date" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label className="field__label">Valor (R$)</label>
            <TextInput value={amount} onChange={setAmount} placeholder="0,00" numeral />
            {exceeds ? (
              <span className="field__error">
                acima do acumulado de {money(platform.balanceCents)}
              </span>
            ) : (
              <span className="field__hint">acumulado: {money(platform.balanceCents)}</span>
            )}
          </div>
        </div>

        {platform.minWithdrawalCents > 0 && !platform.readyToWithdraw && (
          <p className="chart__note">
            <Icon name="alert" size={12} /> O acumulado ainda está abaixo do mínimo de{' '}
            {money(platform.minWithdrawalCents)} desta plataforma. O saque continua permitido: o
            mínimo é regra do parceiro, e quem sabe se ele foi liberado é você.
          </p>
        )}

        <div className="field">
          <label className="field__label">Notas (opcional)</label>
          <TextInput value={notes} onChange={setNotes} placeholder="ex. saque solicitado dia 10" />
        </div>

        <p className="chart__note">
          Gera uma entrada normal em Lançamentos, na conta escolhida, categorizada como Comissões.
          É neste momento que a comissão passa a contar como receita do mês.
        </p>
      </div>
    </Modal>
  )
}

function HistoryModal({ platform, onClose }: { platform: PlatformRow; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const commissions = useQuery({
    queryKey: ['partner-commissions', platform.id],
    queryFn: () => api.get<{ commissions: CommissionRow[] }>('/partners/commissions', { platformId: platform.id }),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.del<{ removed: number }>(`/partners/commissions/${id}`),
    onSuccess: () => {
      toast('Comissão removida')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  const rows = commissions.data?.commissions ?? []

  return (
    <Modal
      title={`Comissões de ${platform.name}`}
      onClose={onClose}
      footer={
        <Button variant="quiet" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      {commissions.isLoading ? (
        <SkeletonLines lines={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="list"
          title="Nenhuma comissão lançada"
          body="Registre a primeira comissão para o saldo desta plataforma começar a acumular."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Data</th>
                <th style={{ textAlign: 'right' }}>Valor</th>
                <th>Notas</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="tabular">{fmtDate(row.earnedOn)}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>
                    {money(row.amountCents)}
                  </td>
                  <td className="muted truncate">{row.notes ?? ''}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Button
                      size="sm"
                      icon="trash"
                      title="Excluir comissão"
                      onClick={() => remove.mutate(row.id)}
                      disabled={remove.isPending}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
