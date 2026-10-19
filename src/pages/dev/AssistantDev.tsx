import { AssistantPanel } from '../../components/assistant/AssistantPanel'
import { Card, Button } from '../../components/ui'
import { forceAssistantMock } from '../../lib/assistantApi'
import { MOCK_EXAMPLES } from '../../lib/assistantMock'
import { useTheme } from '../../lib/theme'

// Esta tela só existe em desenvolvimento (App.tsx a importa dentro de
// `import.meta.env.DEV`): monta o painel do assistente isolado, sem login e
// contra o mock, para testar a tela sem a API.
forceAssistantMock()

export function AssistantDevPage() {
  const { theme, toggle } = useTheme()
  return (
    <main className="main" style={{ maxWidth: 760, margin: '0 auto' }}>
      <header className="topbar">
        <div className="topbar__title">
          <h1 className="h1">Assistente (desenvolvimento)</h1>
          <p className="muted" style={{ fontSize: 'var(--text-sm)', marginTop: 2 }}>
            Painel isolado contra o mock. Abra com o botão fixo ou com Ctrl+K.
          </p>
        </div>
        <div className="topbar__end">
          <Button icon={theme === 'dark' ? 'sun' : 'moon'} onClick={toggle}>
            {theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
          </Button>
        </div>
      </header>
      <Card title="Frases de exemplo do mock" subtitle="Cole no campo do assistente.">
        <ul className="stack stack--tight">
          {MOCK_EXAMPLES.map((example) => (
            <li key={example.text}>
              <strong>{example.label}.</strong> <span className="muted">{example.text}</span>
            </li>
          ))}
        </ul>
      </Card>
      <AssistantPanel />
    </main>
  )
}
