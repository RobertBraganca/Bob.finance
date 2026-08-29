import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { Button, Card, TextInput } from '../components/ui'
import logo from '../assets/logo-red.svg'

/**
 * App de um usuário só — não existe fluxo de cadastro aqui de propósito
 * (o único jeito de existir uma conta é o admin criar via Supabase
 * diretamente). Errar a senha nunca diz qual dos dois campos está errado,
 * mesmo padrão de qualquer login que não quer confirmar se um e-mail existe.
 */
export function LoginPage() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (!email.trim() || !password) return
    setSubmitting(true)
    setError(null)
    const { error } = await signIn(email.trim(), password)
    setSubmitting(false)
    if (error) setError('E-mail ou senha incorretos.')
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--paper)',
      }}
    >
      <div style={{ width: 360 }}>
        <Card>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <div className="stack stack--tight" style={{ alignItems: 'center', marginBottom: 'var(--sp-2)' }}>
              <img src={logo} alt="" style={{ width: 40, height: 40 }} />
              <h1 className="display" style={{ fontSize: 'var(--text-xl)' }}>
                Finanças
              </h1>
            </div>
            <div className="field">
              <label className="field__label">E-mail</label>
              <TextInput value={email} onChange={setEmail} type="email" placeholder="voce@exemplo.com" />
            </div>
            <div className="field">
              <label className="field__label">Senha</label>
              <TextInput value={password} onChange={setPassword} type="password" />
            </div>
            {error && (
              <p className="chart__note" style={{ color: 'var(--status-critical)' }}>
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" icon="check" disabled={submitting || !email.trim() || !password}>
              Entrar
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}
