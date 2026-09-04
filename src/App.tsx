import { lazy, Suspense, useEffect, useState } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './components/shell/Shell'
import { SidebarInset, SidebarProvider, SidebarTrigger } from './components/ui/sidebar'
import { Card, Icon, PageSkeleton } from './components/ui'
import { telemetry } from './lib/telemetry'
import { useAuth } from './lib/auth'
import { LoginPage } from './pages/Login'

/**
 * Uma tela por rota, carregada só na primeira visita — antes disto, o
 * build de produção gerava um bundle único de ~1,4 MB (402 KB gzip) com as
 * 14 telas inteiras, mesmo pra quem só abre o Painel (achado de 29/08/2026).
 * `LoginPage` acima fica de fora de propósito: é a única coisa que TEM que
 * carregar antes de saber se existe sessão, então adiá-la só atrasaria o
 * próprio login. Cada `import()` resolve pro módulo inteiro da página — o
 * `.then` extrai só o export nomeado que `React.lazy` precisa (`default`).
 */
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const DrePage = lazy(() => import('./pages/Dre').then((m) => ({ default: m.DrePage })))
const ImportPage = lazy(() => import('./pages/Import').then((m) => ({ default: m.ImportPage })))
const TransactionsPage = lazy(() => import('./pages/Transactions').then((m) => ({ default: m.TransactionsPage })))
const CategoriesPage = lazy(() => import('./pages/Categories').then((m) => ({ default: m.CategoriesPage })))
const DailyPage = lazy(() => import('./pages/Daily').then((m) => ({ default: m.DailyPage })))
const GoalsPage = lazy(() => import('./pages/Goals').then((m) => ({ default: m.GoalsPage })))
const DebtPage = lazy(() => import('./pages/Debt').then((m) => ({ default: m.DebtPage })))
const CreditCardsPage = lazy(() => import('./pages/CreditCards').then((m) => ({ default: m.CreditCardsPage })))
const InvestmentsPage = lazy(() => import('./pages/Investments').then((m) => ({ default: m.InvestmentsPage })))
const PatrimonioPage = lazy(() => import('./pages/Patrimonio').then((m) => ({ default: m.PatrimonioPage })))
const AposentadoriaPage = lazy(() =>
  import('./pages/Aposentadoria').then((m) => ({ default: m.AposentadoriaPage })),
)
const FinancialHealthPage = lazy(() =>
  import('./pages/FinancialHealth').then((m) => ({ default: m.FinancialHealthPage })),
)
const FinancialEnginePage = lazy(() =>
  import('./pages/FinancialEngine').then((m) => ({ default: m.FinancialEnginePage })),
)
const PricingPage = lazy(() => import('./pages/Pricing').then((m) => ({ default: m.PricingPage })))
const PartnersPage = lazy(() => import('./pages/Partners').then((m) => ({ default: m.PartnersPage })))
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })))

/** Fallback do Suspense enquanto o chunk da rota baixa — só aparece na
 * primeira visita a cada tela (chunk fica em cache do navegador depois).
 * Genérico de propósito: não sabe ainda qual tela está vindo. */
function RouteFallback() {
  return (
    <PageSkeleton
      cards={[
        { span: 12, variant: 'block', height: 120 },
        { span: 6, variant: 'lines', lines: 4 },
        { span: 6, variant: 'lines', lines: 4 },
      ]}
    />
  )
}

/**
 * `.claude/launch.json` keeps `autoPort: true` on purpose (vite.config.ts's
 * own comment: another session's dev server may already hold 5173), but
 * `bentoLayout.ts`'s personalização do Painel is keyed to `localStorage`,
 * which is scoped by origin (host + porta). Trocar de porta entre reinícios
 * silenciosamente reresetava o arranjo salvo — isso avisa em vez de deixar
 * o usuário achar que é bug do componente de layout.
 */
function PortWarning() {
  const [port] = useState(() => window.location.port)
  if (!port || port === '5173') return null
  return (
    <div style={{ margin: 'var(--sp-4) var(--sp-4) 0' }}>
      <Card muted className="row row--wrap">
        <Icon name="alert" size={16} />
        <span style={{ fontSize: 'var(--text-xs)' }}>
          Servidor nesta sessão está na porta {port}, não a 5173 padrão. Personalizações salvas
          neste navegador (ex. arranjo do Painel) podem não persistir entre reinícios do servidor.
        </span>
      </Card>
    </div>
  )
}

/** Uma feature por rota — chave de log de uso, não rótulo de UI. */
const FEATURE_BY_PATH: Record<string, string> = {
  '/': 'dashboard',
  '/diario': 'daily',
  '/lancamentos': 'transactions',
  '/dre': 'dre',
  '/metas': 'goals',
  '/dividas': 'debt',
  '/cartoes': 'credit-cards',
  '/investimentos': 'investments',
  '/patrimonio': 'patrimonio',
  '/aposentadoria': 'aposentadoria',
  '/saude': 'financial-health',
  '/motor': 'financial-engine',
  '/precificacao': 'pricing',
  '/parceiros': 'partners',
  '/importar': 'import',
  '/categorias': 'categories',
  '/ajustes': 'settings',
}

/** Uma chamada por navegação cobre toda página sem precisar instrumentar cada uma. */
function usePageViewTelemetry() {
  const location = useLocation()
  useEffect(() => {
    const feature = FEATURE_BY_PATH[location.pathname] ?? 'unknown'
    telemetry.view(feature)
  }, [location.pathname])
}

export function App() {
  usePageViewTelemetry()
  const { session, loading } = useAuth()

  // Nada renderiza (nem a tela de login) até saber se já existe uma sessão
  // salva — evita o flash de "login" antes do redirect silencioso de quem
  // já estava logado.
  if (loading) return null
  if (!session) return <LoginPage />

  return (
    <SidebarProvider>
      <Sidebar />
      <SidebarInset>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          <SidebarTrigger />
          <span className="text-sm font-semibold">Finanças</span>
        </div>
        <div className="main">
          <PortWarning />
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/diario" element={<DailyPage />} />
              <Route path="/lancamentos" element={<TransactionsPage />} />
              <Route path="/dre" element={<DrePage />} />
              <Route path="/metas" element={<GoalsPage />} />
              <Route path="/dividas" element={<DebtPage />} />
              <Route path="/cartoes" element={<CreditCardsPage />} />
              <Route path="/investimentos" element={<InvestmentsPage />} />
              <Route path="/patrimonio" element={<PatrimonioPage />} />
              <Route path="/aposentadoria" element={<AposentadoriaPage />} />
              <Route path="/saude" element={<FinancialHealthPage />} />
              <Route path="/motor" element={<FinancialEnginePage />} />
              <Route path="/precificacao" element={<PricingPage />} />
              <Route path="/parceiros" element={<PartnersPage />} />
              <Route path="/importar" element={<ImportPage />} />
              <Route path="/categorias" element={<CategoriesPage />} />
              <Route path="/ajustes" element={<SettingsPage />} />
            </Routes>
          </Suspense>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
