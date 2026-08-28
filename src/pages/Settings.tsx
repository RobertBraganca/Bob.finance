import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAccounts, useCategoryIndex, useMeta, type Account } from '../lib/store'
import { centsToInput, money, parseMoneyInput } from '../lib/format'
import {
  Button,
  Card,
  CategorySelect,
  EmptyState,
  Icon,
  Modal,
  Select,
  Slab,
  StatTile,
  TextInput,
  useToast,
} from '../components/ui'
import { PageHeader } from '../components/shell/Shell'

type ColumnMap = Record<string, string | number | undefined>

type Profile = {
  id: number
  name: string
  institution: string
  delimiter: string
  encoding: string
  dateFormat: string
  decimalSeparator: string
  thousandsSeparator: string
  signConvention: string
  hasHeader: boolean
  skipRows: number
  columnMap: ColumnMap
  headerSignature: string[]
  ignorePatterns: string[]
  defaultAccountId: number | null
  active: boolean
}

const ACCOUNT_KIND: Record<string, string> = {
  checking: 'Conta corrente',
  savings: 'Poupança',
  credit_card: 'Cartão de crédito',
  investment: 'Investimentos',
  loan: 'Empréstimo',
  cash: 'Dinheiro',
}

const SIGN_LABEL: Record<string, string> = {
  signed: 'Valor com sinal (− = saída)',
  signed_inverted: 'Valor com sinal invertido (fatura de cartão)',
  debit_credit: 'Colunas separadas de débito e crédito',
  type_flag: 'Valor absoluto + coluna de tipo (D/C)',
}

export function SettingsPage() {
  const accounts = useAccounts()
  const meta = useMeta()
  const [accountModal, setAccountModal] = useState<Account | 'new' | null>(null)
  const [balanceCheckAccount, setBalanceCheckAccount] = useState<Account | null>(null)
  const [profileModal, setProfileModal] = useState<Profile | 'new' | null>(null)

  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<{ profiles: Profile[] }>('/profiles'),
  })

  return (
    <>
      <PageHeader
        title="Contas e bancos"
        subtitle="Contas do ledger e os perfis de leitura de CSV de cada banco"
        actions={
          <div className="row">
            <Button icon="plus" onClick={() => setAccountModal('new')}>
              Nova conta
            </Button>
            <Button variant="primary" icon="bank" onClick={() => setProfileModal('new')}>
              Novo perfil de banco
            </Button>
          </div>
        }
      />

      <div className="page">
        <div className="bento">
          <Slab span={4}>
            <StatTile label="Contas ativas" value={accounts.data?.accounts.length ?? 0} large />
          </Slab>
          <Slab span={4}>
            <StatTile label="Perfis de banco" value={profiles.data?.profiles.length ?? 0} large />
          </Slab>
          <Slab span={4}>
            <StatTile
              label="Convenções de sinal cobertas"
              value={new Set((profiles.data?.profiles ?? []).map((p) => p.signConvention)).size}
              large
              foot="de 4 suportadas"
            />
          </Slab>

          <Card span={12} flush title="Contas" subtitle="O saldo é sempre derivado dos lançamentos">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Conta</th>
                    <th>Instituição</th>
                    <th>Tipo</th>
                    <th style={{ textAlign: 'right' }}>Saldo atual</th>
                    <th style={{ width: 76 }} />
                  </tr>
                </thead>
                <tbody>
                  {(accounts.data?.accounts ?? []).map((account) => {
                    const balanceCents =
                      meta.data?.accounts.find((a) => a.id === account.id)?.balanceCents ?? account.openingBalanceCents
                    return (
                    <tr key={account.id}>
                      <td>
                        <strong>{account.name}</strong>
                      </td>
                      <td className="muted">{account.institution}</td>
                      <td className="muted">{ACCOUNT_KIND[account.kind] ?? account.kind}</td>
                      <td className={`table__num ${balanceCents < 0 ? 'neg' : ''}`}>{money(balanceCents)}</td>
                      <td>
                        <div className="row" style={{ gap: 2 }}>
                          <Button
                            variant="quiet"
                            size="sm"
                            icon="scale"
                            onClick={() => setBalanceCheckAccount(account)}
                            title="Conferir saldo"
                          />
                          <Button
                            variant="quiet"
                            size="sm"
                            icon="pencil"
                            onClick={() => setAccountModal(account)}
                            title="Editar conta"
                          />
                          <DeleteAccountButton account={account} />
                        </div>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card
            span={12}
            flush
            title="Perfis de leitura de CSV"
            subtitle="Cada banco é uma linha de configuração: adicionar um banco novo não exige mexer no código"
          >
            {(profiles.data?.profiles ?? []).length === 0 ? (
              <EmptyState icon="bank" title="Nenhum perfil" body="Cadastre o formato de CSV do seu banco." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Perfil</th>
                      <th>Delimitador</th>
                      <th>Data</th>
                      <th>Decimal</th>
                      <th>Convenção de sinal</th>
                      <th>Codificação</th>
                      <th style={{ width: 44 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {(profiles.data?.profiles ?? []).map((profile) => (
                      <tr key={profile.id}>
                        <td>
                          <strong>{profile.name}</strong>
                          <br />
                          <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
                            assinatura: {profile.headerSignature.join(' · ')}
                          </span>
                        </td>
                        <td>
                          <code style={{ fontFamily: 'var(--font-mono)' }}>
                            {profile.delimiter === 'tab' ? '\\t' : profile.delimiter}
                          </code>
                        </td>
                        <td className="muted">{profile.dateFormat}</td>
                        <td>
                          <code style={{ fontFamily: 'var(--font-mono)' }}>
                            {profile.thousandsSeparator || '·'}
                            {profile.decimalSeparator}
                          </code>
                        </td>
                        <td className="muted" style={{ maxWidth: 250 }}>
                          {SIGN_LABEL[profile.signConvention] ?? profile.signConvention}
                        </td>
                        <td className="muted">{profile.encoding}</td>
                        <td>
                          <Button
                            variant="quiet"
                            size="sm"
                            icon="pencil"
                            onClick={() => setProfileModal(profile)}
                            title="Editar perfil"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <BackupsCard />
        </div>
      </div>

      {accountModal !== null && (
        <AccountModal
          account={accountModal === 'new' ? null : accountModal}
          onClose={() => setAccountModal(null)}
        />
      )}
      {balanceCheckAccount !== null && (
        <BalanceCheckModal account={balanceCheckAccount} onClose={() => setBalanceCheckAccount(null)} />
      )}
      {profileModal !== null && (
        <ProfileModal
          profile={profileModal === 'new' ? null : profileModal}
          onClose={() => setProfileModal(null)}
        />
      )}
    </>
  )
}

/* ================================================================== *
 * Backups
 *
 * Restore is the only destructive operation in the whole product, so it is
 * the only one behind a confirmation modal that spells out what happens
 * (see `specs/backup-and-recovery`). A single click never restores.
 * ================================================================== */
type BackupEntry = {
  version: number
  timestampIso: string
  label: string
  trigger: 'migration' | 'manual' | 'pre-restore'
  filePath: string
  sizeBytes: number
}

const TRIGGER_LABEL: Record<BackupEntry['trigger'], string> = {
  migration: 'Antes de migração',
  manual: 'Manual',
  'pre-restore': 'Antes de restaurar',
}

const backupSize = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

const backupWhen = (iso: string) => {
  const [date, time] = iso.replace('Z', '').split('T')
  const [y, m, d] = (date ?? '').split('-')
  return `${d}/${m}/${y} ${(time ?? '').slice(0, 5)}`
}

function BackupsCard() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [restoring, setRestoring] = useState<BackupEntry | null>(null)

  const backups = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get<{ backups: BackupEntry[]; directory: string }>('/backups'),
  })

  const create = useMutation({
    mutationFn: () => api.post('/backups', {}),
    onSuccess: () => {
      toast('Backup criado')
      queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao criar backup', 'error'),
  })

  const rows = backups.data?.backups ?? []

  return (
    <>
      <Card
        span={12}
        flush
        title="Backups"
        subtitle="Uma cópia do banco é guardada automaticamente antes de cada migração de schema, e sob demanda a qualquer momento"
        actions={
          <Button size="sm" icon="download" onClick={() => create.mutate()} disabled={create.isPending}>
            Fazer backup agora
          </Button>
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            icon="file"
            title="Nenhum backup ainda"
            body="O primeiro roda automaticamente na próxima migração de schema, ou pode ser pedido agora pelo botão acima."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Versão</th>
                  <th>Quando</th>
                  <th>Origem</th>
                  <th>Rótulo</th>
                  <th className="table__num">Tamanho</th>
                  <th style={{ width: 110 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <tr key={entry.version}>
                    <td>
                      <strong>v{entry.version}</strong>
                    </td>
                    <td className="muted">{backupWhen(entry.timestampIso)}</td>
                    <td className="muted">{TRIGGER_LABEL[entry.trigger] ?? entry.trigger}</td>
                    <td>{entry.label}</td>
                    <td className="table__num">{backupSize(entry.sizeBytes)}</td>
                    <td>
                      <Button size="sm" icon="refresh" onClick={() => setRestoring(entry)}>
                        Restaurar
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {restoring && <RestoreModal entry={restoring} onClose={() => setRestoring(null)} />}
    </>
  )
}

function RestoreModal({ entry, onClose }: { entry: BackupEntry; onClose: () => void }) {
  const toast = useToast()
  const [done, setDone] = useState(false)

  const restore = useMutation({
    // `confirm` travels in the BODY, never a query string: a stray click on
    // a link must not be able to trigger a restore.
    mutationFn: () => api.post<{ preRestore: BackupEntry }>(`/backups/${entry.version}/restore`, { confirm: true }),
    onSuccess: () => {
      setDone(true)
      toast('Banco restaurado, reinicie o servidor')
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao restaurar', 'error'),
  })

  return (
    <Modal
      title={`Restaurar o backup v${entry.version}`}
      onClose={onClose}
      footer={
        done ? (
          <Button variant="primary" icon="check" onClick={onClose}>
            Entendi
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="danger" icon="refresh" onClick={() => restore.mutate()} disabled={restore.isPending}>
              Confirmar restauração
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="stack">
          <p>
            O banco foi restaurado a partir do backup v{entry.version}. O estado que existia até agora
            foi salvo como um backup novo, marcado "Antes de restaurar", e continua disponível nesta
            mesma lista.
          </p>
          <p className="chart__note">
            O servidor ainda está com o arquivo antigo aberto. Reinicie o <code>npm run dev</code> para
            passar a usar o banco restaurado.
          </p>
        </div>
      ) : (
        <div className="stack">
          <div className="kv">
            <span className="kv__k">Versão</span>
            <span className="kv__v">v{entry.version}</span>
            <span className="kv__k">Quando</span>
            <span className="kv__v">{backupWhen(entry.timestampIso)}</span>
            <span className="kv__k">Origem</span>
            <span className="kv__v">{TRIGGER_LABEL[entry.trigger] ?? entry.trigger}</span>
            <span className="kv__k">Tamanho</span>
            <span className="kv__v">{backupSize(entry.sizeBytes)}</span>
          </div>
          <p>
            O conteúdo atual de <code>data/finance.db</code> será substituído pelo conteúdo deste
            backup.
          </p>
          <p className="chart__note">
            Antes de qualquer sobrescrita, o estado atual é salvo automaticamente como um backup novo,
            então nada do que existe hoje se perde, mesmo que esta restauração seja um engano.
            Depois de restaurar é necessário reiniciar o servidor.
          </p>
        </div>
      )}
    </Modal>
  )
}

export function AccountModal({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const isEdit = account !== null
  const [name, setName] = useState(account?.name ?? '')
  const [institution, setInstitution] = useState(account?.institution ?? '')
  const [kind, setKind] = useState(account?.kind ?? 'checking')
  // Only a brand-new account still takes a balance here (the opening point
  // before any lançamento exists). An existing account's balance is never
  // edited directly anymore — see "Conferência de saldo" (decisions/0018).
  const [balance, setBalance] = useState(centsToInput(0))

  const save = useMutation({
    mutationFn: () => {
      const balanceCents = parseMoneyInput(balance) ?? 0
      const body = isEdit
        ? { name: name.trim(), institution: institution.trim(), kind }
        : { name: name.trim(), institution: institution.trim(), kind, openingBalanceCents: balanceCents }
      return isEdit ? api.patch(`/accounts/${account.id}`, body) : api.post('/accounts', body)
    },
    onSuccess: async () => {
      toast(isEdit ? 'Conta atualizada' : 'Conta criada')
      // Awaited: reabrir antes do refetch reidrataria do cache pré-edição.
      await queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const remove = useMutation({
    mutationFn: () => api.del<{ archived: boolean; deleted: boolean; affected: number }>(`/accounts/${account!.id}`),
    onSuccess: async (result) => {
      toast(
        result.deleted
          ? 'Conta excluída'
          : `Conta arquivada, ${result.affected} lançamento(s) preservados`,
      )
      await queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  return (
    <Modal
      title={isEdit ? `Editar ${account.name}` : 'Nova conta'}
      onClose={onClose}
      footer={
        <>
          {isEdit ? (
            <Button variant="danger" icon="trash" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Excluir
            </Button>
          ) : (
            <span />
          )}
          <div className="row">
            <Button variant="quiet" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              icon="check"
              disabled={!name.trim() || !institution.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {isEdit ? 'Salvar' : 'Criar'}
            </Button>
          </div>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label">Nome</label>
          <TextInput value={name} onChange={setName} placeholder="ex. Conta PJ" />
        </div>
        <div className="field">
          <label className="field__label">Instituição</label>
          <TextInput value={institution} onChange={setInstitution} placeholder="ex. Inter" />
        </div>
        <div className="field">
          <label className="field__label">Tipo</label>
          <Select
            value={kind}
            options={Object.entries(ACCOUNT_KIND).map(([value, label]) => ({ value, label }))}
            onChange={(value) => setKind(value ?? 'checking')}
          />
        </div>
        {isEdit ? (
          <p className="chart__note">
            <Icon name="info" size={12} /> Saldo não se edita mais aqui: use "Conferir saldo" para
            corrigir a diferença como um lançamento real, auditável em Lançamentos.
          </p>
        ) : (
          <div className="field">
            <label className="field__label">Saldo inicial (R$)</label>
            <TextInput value={balance} onChange={setBalance} placeholder="0,00" numeral />
            <span className="field__hint">Ponto de partida antes do primeiro extrato importado.</span>
          </div>
        )}
        {isEdit && (
          <p className="chart__note">
            <Icon name="info" size={12} /> Se a conta já tiver lançamentos, excluir apenas a arquiva:
            o histórico é preservado, e ela some das listas e dos filtros.
          </p>
        )}
      </div>
    </Modal>
  )
}

/**
 * Replaces the old "Saldo atual" text field (decisions/0018): the user
 * informs what the bank statement actually shows, and the difference
 * against the derived balance becomes a real, auditable transaction —
 * never a silent rewrite of `openingBalanceCents`. Reused by the
 * Dashboard's Contas card and by Settings, one implementation.
 */
export function BalanceCheckModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const meta = useMeta()
  const { options } = useCategoryIndex()
  const derivedCents = meta.data?.accounts.find((a) => a.id === account.id)?.balanceCents ?? account.openingBalanceCents

  const [reported, setReported] = useState(centsToInput(derivedCents))
  const [postedOn, setPostedOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [mode, setMode] = useState<'adjustment' | 'manual' | null>(null)

  const reportedCents = parseMoneyInput(reported)
  const diffCents = reportedCents === null ? 0 : reportedCents - derivedCents
  const reajusteCategoryId = options.find((o) => o.path === 'Financeiro/Reajuste de saldo')?.id ?? null
  const direction: 'in' | 'out' = diffCents >= 0 ? 'in' : 'out'

  const launch = useMutation({
    mutationFn: () => {
      if (diffCents === 0) throw new Error('não há diferença para lançar')
      if (mode === 'manual' && categoryId === null) throw new Error('escolha uma categoria')
      return api.post('/transactions', {
        accountId: account.id,
        postedOn,
        description:
          mode === 'adjustment' ? 'Reajuste de saldo' : description.trim() || 'Reajuste de saldo',
        amountCents: diffCents,
        categoryId: mode === 'adjustment' ? reajusteCategoryId : categoryId,
        source: mode,
      })
    },
    onSuccess: () => {
      toast(mode === 'adjustment' ? 'Reajuste lançado' : 'Lançamento criado')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao lançar', 'error'),
  })

  return (
    <Modal
      title={`Conferir saldo — ${account.name}`}
      onClose={onClose}
      footer={
        mode === null ? (
          <>
            <span />
            <Button variant="quiet" onClick={onClose}>
              Fechar
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" onClick={() => setMode(null)}>
              Voltar
            </Button>
            <Button variant="primary" icon="check" disabled={launch.isPending} onClick={() => launch.mutate()}>
              Confirmar
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label">Saldo no sistema</label>
          <div className="table__num" style={{ textAlign: 'left' }}>{money(derivedCents)}</div>
        </div>
        <div className="field">
          <label className="field__label">Saldo real (do extrato)</label>
          <TextInput value={reported} onChange={setReported} placeholder="0,00" numeral />
        </div>

        {reportedCents !== null && diffCents === 0 && (
          <p className="chart__note">
            <Icon name="info" size={12} /> Sem diferença: nada para lançar.
          </p>
        )}

        {reportedCents !== null && diffCents !== 0 && mode === null && (
          <div className="stack">
            <p className="chart__note">
              Diferença de{' '}
              <strong className={diffCents > 0 ? 'pos' : 'neg'}>{money(Math.abs(diffCents))}</strong>{' '}
              {diffCents > 0 ? 'a mais' : 'a menos'} do que o sistema mostra.
            </p>
            <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
              <Button onClick={() => setMode('adjustment')}>Lançar como reajuste</Button>
              <Button onClick={() => setMode('manual')}>Lançar como despesa/receita</Button>
            </div>
          </div>
        )}

        {mode === 'adjustment' && (
          <>
            <div className="field">
              <label className="field__label">Data</label>
              <TextInput value={postedOn} onChange={setPostedOn} type="date" />
            </div>
            <p className="chart__note">
              Categoria "Financeiro/Reajuste de saldo" — não conta como receita nem despesa, é uma
              correção de registro.
            </p>
          </>
        )}

        {mode === 'manual' && (
          <>
            <div className="field">
              <label className="field__label">Data</label>
              <TextInput value={postedOn} onChange={setPostedOn} type="date" />
            </div>
            <div className="field">
              <label className="field__label">Descrição</label>
              <TextInput value={description} onChange={setDescription} placeholder="ex. saque em espécie" />
            </div>
            <div className="field">
              <label className="field__label">Categoria</label>
              <CategorySelect value={categoryId} onChange={setCategoryId} direction={direction} />
            </div>
            <p className="chart__note">
              Para dinheiro que realmente entrou ou saiu e nunca foi lançado — não um erro de registro.
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * A direct delete action in the row, separate from the edit modal's own
 * "Excluir" button — so removing an unused account (the common case: a
 * duplicate or a test account) doesn't require opening the full editor.
 */
function DeleteAccountButton({ account }: { account: Account }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const remove = useMutation({
    mutationFn: () => api.del<{ archived: boolean; deleted: boolean; affected: number }>(`/accounts/${account.id}`),
    onSuccess: (result) => {
      toast(
        result.deleted
          ? 'Conta excluída'
          : `Conta arquivada, ${result.affected} lançamento(s) preservados`,
      )
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
      title="Excluir conta"
    />
  )
}

/**
 * The parser-profile editor. This is the screen that makes the "adding a
 * bank is data, not code" claim true in practice.
 */
function ProfileModal({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const accounts = useAccounts()

  const [form, setForm] = useState({
    name: profile?.name ?? '',
    institution: profile?.institution ?? '',
    delimiter: profile?.delimiter ?? ';',
    encoding: profile?.encoding ?? 'utf-8',
    dateFormat: profile?.dateFormat ?? 'dd/MM/yyyy',
    decimalSeparator: profile?.decimalSeparator ?? ',',
    thousandsSeparator: profile?.thousandsSeparator ?? '.',
    signConvention: profile?.signConvention ?? 'signed',
    skipRows: String(profile?.skipRows ?? 0),
    defaultAccountId: profile?.defaultAccountId ?? null,
  })

  const [columnMap, setColumnMap] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const [key, value] of Object.entries(profile?.columnMap ?? {})) {
      if (value !== undefined) initial[key] = String(value)
    }
    return initial
  })
  const [signature, setSignature] = useState((profile?.headerSignature ?? []).join(', '))
  const [ignore, setIgnore] = useState((profile?.ignorePatterns ?? []).join(', '))

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const needs = (field: string) => {
    if (field === 'amount') return ['signed', 'signed_inverted', 'type_flag'].includes(form.signConvention)
    if (field === 'debit' || field === 'credit') return form.signConvention === 'debit_credit'
    if (field === 'typeFlag') return form.signConvention === 'type_flag'
    return false
  }

  const save = useMutation({
    mutationFn: () => {
      const map: ColumnMap = {}
      for (const [key, value] of Object.entries(columnMap)) {
        if (value.trim() !== '') map[key] = value.trim()
      }
      const body = {
        ...form,
        skipRows: Number(form.skipRows) || 0,
        hasHeader: true,
        columnMap: map,
        headerSignature: signature.split(',').map((s) => s.trim()).filter(Boolean),
        ignorePatterns: ignore.split(',').map((s) => s.trim()).filter(Boolean),
        active: true,
      }
      return profile ? api.patch(`/profiles/${profile.id}`, body) : api.post('/profiles', body)
    },
    onSuccess: () => {
      toast(profile ? 'Perfil atualizado' : 'Perfil criado')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const remove = useMutation({
    mutationFn: () => api.del(`/profiles/${profile!.id}`),
    onSuccess: () => {
      toast('Perfil removido')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  return (
    <Modal
      wide
      title={profile ? `Editar ${profile.name}` : 'Novo perfil de banco'}
      onClose={onClose}
      footer={
        <>
          {profile ? (
            <Button variant="danger" icon="trash" onClick={() => remove.mutate()}>
              Remover
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="primary"
            icon="check"
            disabled={!form.name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            Salvar perfil
          </Button>
        </>
      }
    >
      <div className="stack stack--loose">
        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label className="field__label">Nome do perfil</label>
            <TextInput value={form.name} onChange={(v) => set('name', v)} placeholder="ex. Sicoob Extrato" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 160 }}>
            <label className="field__label">Instituição</label>
            <TextInput
              value={form.institution}
              onChange={(v) => set('institution', v)}
              placeholder="ex. Sicoob"
            />
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ minWidth: 130 }}>
            <label className="field__label">Delimitador</label>
            <Select
              value={form.delimiter}
              options={[
                { value: ';', label: 'ponto e vírgula' },
                { value: ',', label: 'vírgula' },
                { value: 'tab', label: 'tabulação' },
                { value: '|', label: 'barra vertical' },
                { value: 'auto', label: 'detectar' },
              ]}
              onChange={(v) => set('delimiter', v ?? ';')}
            />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label className="field__label">Formato de data</label>
            <Select
              value={form.dateFormat}
              options={[
                'dd/MM/yyyy',
                'dd/MM/yy',
                'dd-MM-yyyy',
                'dd.MM.yyyy',
                'yyyy-MM-dd',
                'yyyy/MM/dd',
                'auto',
              ].map((value) => ({ value, label: value }))}
              onChange={(v) => set('dateFormat', v ?? 'dd/MM/yyyy')}
            />
          </div>
          <div className="field" style={{ minWidth: 110 }}>
            <label className="field__label">Decimal</label>
            <Select
              value={form.decimalSeparator}
              options={[
                { value: ',', label: 'vírgula' },
                { value: '.', label: 'ponto' },
              ]}
              onChange={(v) => set('decimalSeparator', v ?? ',')}
            />
          </div>
          <div className="field" style={{ minWidth: 110 }}>
            <label className="field__label">Milhar</label>
            <Select
              value={form.thousandsSeparator}
              options={[
                { value: '.', label: 'ponto' },
                { value: ',', label: 'vírgula' },
                { value: '', label: 'nenhum' },
              ]}
              onChange={(v) => set('thousandsSeparator', v ?? '.')}
            />
          </div>
          <div className="field" style={{ minWidth: 130 }}>
            <label className="field__label">Codificação</label>
            <Select
              value={form.encoding}
              options={[
                { value: 'utf-8', label: 'UTF-8' },
                { value: 'latin1', label: 'Latin-1 / ANSI' },
              ]}
              onChange={(v) => set('encoding', v ?? 'utf-8')}
            />
          </div>
          <div className="field" style={{ minWidth: 110 }}>
            <label className="field__label">Linhas a pular</label>
            <TextInput value={form.skipRows} onChange={(v) => set('skipRows', v)} numeral />
          </div>
        </div>

        <div className="field">
          <label className="field__label">Convenção de sinal</label>
          <Select
            value={form.signConvention}
            options={Object.entries(SIGN_LABEL).map(([value, label]) => ({ value, label }))}
            onChange={(v) => set('signConvention', v ?? 'signed')}
          />
          <span className="field__hint">
            Determina como o valor é lido. É o campo que mais causa erro quando um banco novo é
            adicionado; confira o sinal na tela de revisão antes de gravar.
          </span>
        </div>

        <div>
          <span className="label">Mapa de colunas</span>
          <p className="field__hint" style={{ marginBottom: 'var(--sp-3)' }}>
            Nome exato do cabeçalho no CSV (acentos e maiúsculas não importam).
          </p>
          <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
            {[
              ['date', 'Data', true],
              ['description', 'Descrição', true],
              ['amount', 'Valor', needs('amount')],
              ['debit', 'Débito', needs('debit')],
              ['credit', 'Crédito', needs('credit')],
              ['typeFlag', 'Tipo (D/C)', needs('typeFlag')],
              ['rawCategory', 'Categoria do banco', false],
            ]
              .filter(([, , show]) => show !== false || ['rawCategory'].includes(String(0)))
              .map(([key, label, required]) => (
                <div className="field" key={String(key)} style={{ minWidth: 170, flex: 1 }}>
                  <label className="field__label">
                    {String(label)}
                    {required ? ' *' : ''}
                  </label>
                  <TextInput
                    value={columnMap[String(key)] ?? ''}
                    onChange={(value) =>
                      setColumnMap((current) => ({ ...current, [String(key)]: value }))
                    }
                    placeholder="nome no cabeçalho"
                  />
                </div>
              ))}
            <div className="field" style={{ minWidth: 170, flex: 1 }}>
              <label className="field__label">Categoria do banco</label>
              <TextInput
                value={columnMap.rawCategory ?? ''}
                onChange={(value) => setColumnMap((current) => ({ ...current, rawCategory: value }))}
                placeholder="opcional"
              />
            </div>
          </div>
        </div>

        <div className="field">
          <label className="field__label">Assinatura do cabeçalho</label>
          <TextInput
            value={signature}
            onChange={setSignature}
            placeholder="Data, Histórico, Valor, Saldo"
          />
          <span className="field__hint">
            Colunas usadas para reconhecer o banco automaticamente. Basta dois terços casarem.
          </span>
        </div>

        <div className="field">
          <label className="field__label">Linhas a ignorar</label>
          <TextInput value={ignore} onChange={setIgnore} placeholder="saldo anterior, saldo do dia, total" />
          <span className="field__hint">
            Descrições de linhas de resumo que o banco anexa e que não são lançamentos.
          </span>
        </div>

        <div className="field">
          <label className="field__label">Conta padrão</label>
          <Select
            value={form.defaultAccountId}
            placeholder="Perguntar sempre"
            options={(accounts.data?.accounts ?? []).map((account) => ({
              value: account.id,
              label: account.name,
            }))}
            onChange={(v) => set('defaultAccountId', v)}
          />
        </div>

        <p className="chart__note">
          <Icon name="info" size={12} /> Nada aqui altera dados já importados: perfis só afetam
          leituras futuras.
        </p>
      </div>
    </Modal>
  )
}
