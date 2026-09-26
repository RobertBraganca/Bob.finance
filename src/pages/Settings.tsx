import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAccounts, useCategoryIndex, useMeta, type Account } from '../lib/store'
import { centsToInput, money, parseMoneyInput } from '../lib/format'
import {
  Bento,
  Button,
  Card,
  CategorySelect,
  ConfirmDeleteModal,
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
        <Bento>
          {/*
            Os três num card só, em `auto-fit`: como cards separados eles
            davam dois pareados e um órfão de meia largura no grid de duas
            colunas (medido a 1440px em 02/09/2026). Mesmo padrão do card de
            KPI do Painel, da aba Carteira e da Rentabilidade.
          */}
          <Slab span={12}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                gap: 'var(--sp-5)',
              }}
            >
              <StatTile label="Contas ativas" value={accounts.data?.accounts.length ?? 0} large />
              <StatTile label="Perfis de banco" value={profiles.data?.profiles.length ?? 0} large />
              <StatTile
                label="Convenções de sinal cobertas"
                value={new Set((profiles.data?.profiles ?? []).map((p) => p.signConvention)).size}
                large
                foot="de 4 suportadas"
              />
            </div>
          </Slab>

          <Card span={12} flush title="Contas" subtitle="O saldo é sempre derivado dos lançamentos">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Conta</th>
                    <th scope="col">Instituição</th>
                    <th scope="col">Tipo</th>
                    <th scope="col" className="table__num">Saldo atual</th>
                    <th scope="col" style={{ width: 76 }} />
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
            {profiles.isError ? (
              <EmptyState
                icon="alert"
                title="Falha ao carregar perfis"
                body="Não foi possível carregar os perfis de banco agora. Tente novamente em instantes."
              />
            ) : (profiles.data?.profiles ?? []).length === 0 ? (
              <EmptyState icon="bank" title="Nenhum perfil" body="Cadastre o formato de CSV do seu banco." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Perfil</th>
                      <th scope="col">Delimitador</th>
                      <th scope="col">Data</th>
                      <th scope="col">Decimal</th>
                      <th scope="col">Convenção de sinal</th>
                      <th scope="col">Codificação</th>
                      <th scope="col" style={{ width: 44 }} />
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
        </Bento>
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
  const nameFieldId = useId()
  const institutionFieldId = useId()
  const kindFieldId = useId()
  const balanceFieldId = useId()
  const [confirmingDelete, setConfirmingDelete] = useState(false)

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

  if (confirmingDelete) {
    return (
      <ConfirmDeleteModal
        title={`Excluir ${account!.name}?`}
        body="Lançamentos que já usam esta conta não são apagados nem perdem o histórico. Isso não pode ser desfeito."
        confirmLabel="Excluir conta"
        pending={remove.isPending}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => remove.mutate()}
      />
    )
  }

  return (
    <Modal
      title={isEdit ? `Editar ${account.name}` : 'Nova conta'}
      onClose={onClose}
      footer={
        <>
          {isEdit ? (
            <Button variant="danger" icon="trash" onClick={() => setConfirmingDelete(true)} disabled={remove.isPending}>
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
          <label className="field__label" htmlFor={nameFieldId}>Nome</label>
          <TextInput id={nameFieldId} value={name} onChange={setName} placeholder="ex. Conta PJ" />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={institutionFieldId}>Instituição</label>
          <TextInput id={institutionFieldId} value={institution} onChange={setInstitution} placeholder="ex. Inter" />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={kindFieldId}>Tipo</label>
          <Select
            id={kindFieldId}
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
            <label className="field__label" htmlFor={balanceFieldId}>Saldo inicial (R$)</label>
            <TextInput id={balanceFieldId} value={balance} onChange={setBalance} placeholder="0,00" numeral />
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
  const reportedFieldId = useId()
  const dateFieldId = useId()
  const descriptionFieldId = useId()
  const categoryFieldId = useId()

  const reportedCents = parseMoneyInput(reported)
  const diffCents = reportedCents === null ? 0 : reportedCents - derivedCents
  const reajusteCategoryId = options.find((o) => o.path === 'Financeiro/Reajuste de saldo')?.id ?? null
  const direction: 'in' | 'out' = diffCents >= 0 ? 'in' : 'out'

  const launch = useMutation({
    mutationFn: () => {
      if (diffCents === 0) throw new Error('não há diferença para lançar')
      if (mode === 'manual' && categoryId === null) throw new Error('escolha uma TAG')
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
      title={`Conferir saldo: ${account.name}`}
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
          <label className="field__label" htmlFor={reportedFieldId}>Saldo real (do extrato)</label>
          <TextInput id={reportedFieldId} value={reported} onChange={setReported} placeholder="0,00" numeral />
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
              <label className="field__label" htmlFor={dateFieldId}>Data</label>
              <TextInput id={dateFieldId} value={postedOn} onChange={setPostedOn} type="date" />
            </div>
            <p className="chart__note">
              TAG "Financeiro/Reajuste de saldo": não conta como receita nem despesa, é uma
              correção de registro.
            </p>
          </>
        )}

        {mode === 'manual' && (
          <>
            <div className="field">
              <label className="field__label" htmlFor={dateFieldId}>Data</label>
              <TextInput id={dateFieldId} value={postedOn} onChange={setPostedOn} type="date" />
            </div>
            <div className="field">
              <label className="field__label" htmlFor={descriptionFieldId}>Descrição</label>
              <TextInput id={descriptionFieldId} value={description} onChange={setDescription} placeholder="ex. saque em espécie" />
            </div>
            <div className="field">
              <label className="field__label" htmlFor={categoryFieldId}>TAG</label>
              <CategorySelect id={categoryFieldId} value={categoryId} onChange={setCategoryId} direction={direction} />
            </div>
            <p className="chart__note">
              Para dinheiro que realmente entrou ou saiu e nunca foi lançado, não um erro de registro.
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
  const [confirming, setConfirming] = useState(false)

  const remove = useMutation({
    mutationFn: () => api.del<{ archived: boolean; deleted: boolean; affected: number }>(`/accounts/${account.id}`),
    onSuccess: (result) => {
      toast(
        result.deleted
          ? 'Conta excluída'
          : `Conta arquivada, ${result.affected} lançamento(s) preservados`,
      )
      queryClient.invalidateQueries()
      setConfirming(false)
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        icon="trash"
        onClick={() => setConfirming(true)}
        disabled={remove.isPending}
        title="Excluir conta"
      />
      {confirming && (
        <ConfirmDeleteModal
          title={`Excluir ${account.name}?`}
          body="Lançamentos que já usam esta conta não são apagados nem perdem o histórico. Isso não pode ser desfeito."
          confirmLabel="Excluir conta"
          pending={remove.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => remove.mutate()}
        />
      )}
    </>
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
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const profileNameFieldId = useId()
  const profileInstitutionFieldId = useId()
  const delimiterFieldId = useId()
  const dateFormatFieldId = useId()
  const decimalFieldId = useId()
  const thousandsFieldId = useId()
  const encodingFieldId = useId()
  const skipRowsFieldId = useId()
  const signConventionFieldId = useId()
  const columnMapFieldId = useId()
  const rawCategoryFieldId = useId()
  const signatureFieldId = useId()
  const ignoreFieldId = useId()
  const defaultAccountFieldId = useId()

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

  if (confirmingDelete) {
    return (
      <ConfirmDeleteModal
        title={`Excluir ${profile!.name}?`}
        body="Lançamentos já importados com este perfil não são afetados. Isso não pode ser desfeito."
        confirmLabel="Excluir perfil"
        pending={remove.isPending}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => remove.mutate()}
      />
    )
  }

  return (
    <Modal
      wide
      title={profile ? `Editar ${profile.name}` : 'Novo perfil de banco'}
      onClose={onClose}
      footer={
        <>
          {profile ? (
            <Button variant="danger" icon="trash" onClick={() => setConfirmingDelete(true)}>
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
            <label className="field__label" htmlFor={profileNameFieldId}>Nome do perfil</label>
            <TextInput id={profileNameFieldId} value={form.name} onChange={(v) => set('name', v)} placeholder="ex. Sicoob Extrato" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 160 }}>
            <label className="field__label" htmlFor={profileInstitutionFieldId}>Instituição</label>
            <TextInput
              id={profileInstitutionFieldId}
              value={form.institution}
              onChange={(v) => set('institution', v)}
              placeholder="ex. Sicoob"
            />
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <div className="field" style={{ minWidth: 130 }}>
            <label className="field__label" htmlFor={delimiterFieldId}>Delimitador</label>
            <Select
              id={delimiterFieldId}
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
            <label className="field__label" htmlFor={dateFormatFieldId}>Formato de data</label>
            <Select
              id={dateFormatFieldId}
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
            <label className="field__label" htmlFor={decimalFieldId}>Decimal</label>
            <Select
              id={decimalFieldId}
              value={form.decimalSeparator}
              options={[
                { value: ',', label: 'vírgula' },
                { value: '.', label: 'ponto' },
              ]}
              onChange={(v) => set('decimalSeparator', v ?? ',')}
            />
          </div>
          <div className="field" style={{ minWidth: 110 }}>
            <label className="field__label" htmlFor={thousandsFieldId}>Milhar</label>
            <Select
              id={thousandsFieldId}
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
            <label className="field__label" htmlFor={encodingFieldId}>Codificação</label>
            <Select
              id={encodingFieldId}
              value={form.encoding}
              options={[
                { value: 'utf-8', label: 'UTF-8' },
                { value: 'latin1', label: 'Latin-1 / ANSI' },
              ]}
              onChange={(v) => set('encoding', v ?? 'utf-8')}
            />
          </div>
          <div className="field" style={{ minWidth: 110 }}>
            <label className="field__label" htmlFor={skipRowsFieldId}>Linhas a pular</label>
            <TextInput id={skipRowsFieldId} value={form.skipRows} onChange={(v) => set('skipRows', v)} numeral />
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={signConventionFieldId}>Convenção de sinal</label>
          <Select
            id={signConventionFieldId}
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
              ['rawCategory', 'TAG do banco', false],
            ]
              .filter(([, , show]) => show !== false || ['rawCategory'].includes(String(0)))
              .map(([key, label, required]) => (
                <div className="field" key={String(key)} style={{ minWidth: 170, flex: 1 }}>
                  <label className="field__label" htmlFor={`${columnMapFieldId}-${String(key)}`}>
                    {String(label)}
                    {required ? ' *' : ''}
                  </label>
                  <TextInput
                    id={`${columnMapFieldId}-${String(key)}`}
                    value={columnMap[String(key)] ?? ''}
                    onChange={(value) =>
                      setColumnMap((current) => ({ ...current, [String(key)]: value }))
                    }
                    placeholder="nome no cabeçalho"
                  />
                </div>
              ))}
            <div className="field" style={{ minWidth: 170, flex: 1 }}>
              <label className="field__label" htmlFor={rawCategoryFieldId}>TAG do banco</label>
              <TextInput
                id={rawCategoryFieldId}
                value={columnMap.rawCategory ?? ''}
                onChange={(value) => setColumnMap((current) => ({ ...current, rawCategory: value }))}
                placeholder="opcional"
              />
            </div>
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={signatureFieldId}>Assinatura do cabeçalho</label>
          <TextInput
            id={signatureFieldId}
            value={signature}
            onChange={setSignature}
            placeholder="Data, Histórico, Valor, Saldo"
          />
          <span className="field__hint">
            Colunas usadas para reconhecer o banco automaticamente. Basta dois terços casarem.
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={ignoreFieldId}>Linhas a ignorar</label>
          <TextInput id={ignoreFieldId} value={ignore} onChange={setIgnore} placeholder="saldo anterior, saldo do dia, total" />
          <span className="field__hint">
            Descrições de linhas de resumo que o banco anexa e que não são lançamentos.
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={defaultAccountFieldId}>Conta padrão</label>
          <Select
            id={defaultAccountFieldId}
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
