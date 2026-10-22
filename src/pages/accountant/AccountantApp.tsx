import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { currentPeriod, shiftPeriod } from '../../lib/period'
import { supabase } from '../../lib/supabaseClient'
import { Button, Card, EmptyState, Field, LoadError, PeriodNav, SkeletonLines, TextInput } from '../../components/ui'
import logo from '../../assets/logo-red.svg'
import { AccountantMonthView, PackagesList } from './AccountantMonthView'
import type { AccountantMonth, AccountantPackage } from './types'

/**
 * O app do contador (docs/specs/tarefas-comercial-contador, fase 5): uma tela
 * só, só leitura, só a parte da empresa. Não monta o resto do app: as rotas
 * daqui chamam apenas a função `accountant`, que nega todo o resto.
 */
export function AccountantApp({ email }: { email: string | null }) {
  const { signOut } = useAuth()
  const [period, setPeriod] = useState(() => shiftPeriod(currentPeriod(), -1))
  const month = useQuery({ queryKey: ['accountant', 'month', period], queryFn: () => api.get<AccountantMonth>('/accountant/month', { period }) })
  const packages = useQuery({ queryKey: ['accountant', 'packages'], queryFn: () => api.get<{ packages: AccountantPackage[] }>('/accountant/packages') })

  return (
    <div className="accountant-app">
      <header className="accountant-app__bar">
        <img src={logo} alt="BOB Finanças" height={22} />
        <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          Área do contador{email ? ` · ${email}` : ''}
        </span>
        <Button variant="quiet" size="sm" icon="logout" onClick={() => void signOut()}>
          Sair
        </Button>
      </header>
      <main className="page">
        <div className="stack stack--loose">
          <div className="row row--between row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <h1 style={{ margin: 0 }}>Fechamento do mês</h1>
            <PeriodNav period={period} onChange={setPeriod} max={currentPeriod()} />
          </div>
          {month.isError ? (
            <Card>
              <LoadError onRetry={() => month.refetch()} retrying={month.isFetching} />
            </Card>
          ) : !month.data ? (
            <Card>
              <SkeletonLines lines={6} />
            </Card>
          ) : (
            <AccountantMonthView month={month.data} />
          )}
          <Card title="Pacotes do mês" subtitle="PDF com resumo, notas e extrato, e o extrato PJ em CSV">
            {packages.isError ? (
              <LoadError onRetry={() => packages.refetch()} retrying={packages.isFetching} />
            ) : !packages.data ? (
              <SkeletonLines lines={2} />
            ) : (
              <PackagesList packages={packages.data.packages} />
            )}
          </Card>
        </div>
      </main>
    </div>
  )
}

/** Login sem papel aqui (nem dono, nem contador ativo): só sair. */
export function AccessDenied() {
  const { signOut } = useAuth()
  return (
    <div className="page" style={{ maxWidth: 520, margin: '10vh auto' }}>
      <Card>
        <EmptyState
          icon="alert"
          title="Acesso não liberado"
          body="Esta conta não tem acesso ao app, ou o acesso foi revogado. Fale com quem convidou você."
          action={<Button onClick={() => void signOut()}>Sair</Button>}
        />
      </Card>
    </div>
  )
}

/** Quem chegou pelo link do convite (ou de nova senha) define a senha antes de entrar. */
export function SetPasswordPage({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const tooShort = password.length > 0 && password.length < 10
  const mismatch = confirm.length > 0 && confirm !== password

  const save = async () => {
    if (password.length < 10 || confirm !== password) return
    setSaving(true)
    setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    setSaving(false)
    if (error) return setError(error.message)
    window.history.replaceState(null, '', window.location.pathname)
    onDone()
  }

  return (
    <div className="page" style={{ maxWidth: 440, margin: '10vh auto' }}>
      <Card title="Defina sua senha" subtitle="É com ela que você vai entrar daqui para a frente">
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <Field label="Senha" error={tooShort ? 'Pelo menos 10 caracteres.' : null}>
            {(id) => <TextInput id={id} type="password" value={password} onChange={setPassword} autoFocus />}
          </Field>
          <Field label="Repita a senha" error={mismatch ? 'As duas não são iguais.' : null}>
            {(id) => <TextInput id={id} type="password" value={confirm} onChange={setConfirm} />}
          </Field>
          {error && <p className="field__error" role="alert">{error}</p>}
          <Button type="submit" variant="primary" icon="check" loading={saving} disabled={password.length < 10 || confirm !== password}>
            Salvar senha e entrar
          </Button>
        </form>
      </Card>
    </div>
  )
}
