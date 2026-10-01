import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './components/shell/Shell'
import { SidebarInset, SidebarProvider, SidebarTrigger } from './components/ui/sidebar'
import { Card, Icon, PageSkeleton } from './components/ui'
import { telemetry } from './lib/telemetry'
import { useAuth } from './lib/auth'
import { useUserProfile } from './lib/store'
import { LoginPage } from './pages/Login'
import { NotFoundPage, RouteErrorBoundary, clearChunkReloadFlag } from './components/shell/RouteErrorBoundary'

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
const FinancialHealthPage = lazy(() =>
  import('./pages/FinancialHealth').then((m) => ({ default: m.FinancialHealthPage })),
)
const PricingPage = lazy(() => import('./pages/Pricing').then((m) => ({ default: m.PricingPage })))
const PartnersPage = lazy(() => import('./pages/Partners').then((m) => ({ default: m.PartnersPage })))
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })))
const ProfilePage = lazy(() => import('./pages/Profile').then((m) => ({ default: m.ProfilePage })))

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
 * own comment: another session's dev server may already hold 5173), mas
 * preferências como tema (`lib/theme.tsx`) e notificações dispensadas
 * (`lib/insights.ts`) ficam em `localStorage`, escopado por origem (host +
 * porta). Trocar de porta entre reinícios silenciosamente reseta essas
 * preferências — isso avisa em vez de deixar o usuário achar que é bug.
 */
function PortWarning() {
  const [port] = useState(() => window.location.port)
  if (!port || port === '5173') return null
  return (
    <div style={{ margin: 'var(--sp-4) var(--sp-4) 0' }}>
      <Card muted className="row row--wrap">
        <Icon name="alert" size={16} />
        <span style={{ fontSize: 'var(--text-xs)' }}>
          Servidor nesta sessão está na porta {port}, não a 5173 padrão. Preferências salvas
          neste navegador (ex. tema, notificações dispensadas) podem não persistir entre
          reinícios do servidor.
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
  '/saude': 'financial-health',
  '/precificacao': 'pricing',
  '/parceiros': 'partners',
  '/importar': 'import',
  '/categorias': 'categories',
  '/ajustes': 'settings',
  '/perfil': 'profile',
}

/** Uma chamada por navegação cobre toda página sem precisar instrumentar cada uma. */
function usePageViewTelemetry() {
  const location = useLocation()
  useEffect(() => {
    const feature = FEATURE_BY_PATH[location.pathname] ?? 'unknown'
    telemetry.view(feature)
  }, [location.pathname])
}

/** Mesmo rótulo do item de navegação lateral (Shell.tsx) para cada rota. */
const PAGE_TITLE_BY_PATH: Record<string, string> = {
  '/': 'Visão geral',
  '/patrimonio': 'Patrimônio',
  '/diario': 'Diário',
  '/lancamentos': 'Lançamentos',
  '/dre': 'DRE',
  '/saude': 'Saúde financeira',
  '/precificacao': 'Precificação',
  '/parceiros': 'Receita de parceiros',
  '/metas': 'Metas do mês',
  '/dividas': 'Endividamento',
  '/investimentos': 'Investimentos',
  '/ajustes': 'Contas e bancos',
  '/cartoes': 'Cartões',
  '/categorias': 'TAGs e regras',
  '/importar': 'Importar',
  '/perfil': 'Perfil',
}

/**
 * Auditoria de acessibilidade de 26/09/2026: numa SPA, trocar de rota não
 * recarrega a página, então o título da aba (e o que um leitor de tela
 * anuncia ao navegar) ficava travado em "Finanças" pras 15 rotas do app.
 * Mesmo mapa de rótulos da navegação lateral, pra nunca discordar dela.
 */
function usePageTitle() {
  const location = useLocation()
  useEffect(() => {
    const label = PAGE_TITLE_BY_PATH[location.pathname]
    document.title = label ? `${label} · Finanças` : 'Finanças'
  }, [location.pathname])
}

/**
 * Só monta depois do gate de sessão em `App`, então `useUserProfile` (e
 * qualquer outra query autenticada) nunca dispara com um 401 previsível
 * enquanto ninguém logou ainda.
 */
/** Só monta quando a rota terminou de carregar: aí a recarga automática de chunk pode valer de novo. */
function ChunkLoaded() {
  useEffect(() => clearChunkReloadFlag(), [])
  return null
}

function AuthedApp() {
  // Revisão de UX de 26/09/2026: modo "Pessoal" trava telas pensadas só pra
  // quem fatura como PJ/freelancer. Enquanto o perfil ainda carrega, o
  // padrão é `freelancer` (permissivo) — nunca bloqueia de forma
  // momentânea quem já tem acesso, só quando o servidor de fato confirma
  // `personal`.
  const profile = useUserProfile()
  const isPersonalAccount = profile.data?.profile.accountType === 'personal'
  const location = useLocation()

  return (
    <SidebarProvider>
      <Sidebar />
      {/* `min-w-0`: sem isso a área principal crescia até o conteúdo mais
          largo (as 7 abas de Investimentos, 113px além da tela em 840px) em
          vez de deixar a pílula de abas rolar por dentro. */}
      <SidebarInset className="min-w-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          <SidebarTrigger />
          <span className="text-sm font-semibold">Finanças</span>
        </div>
        <div className="main">
          <PortWarning />
          <RouteErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<RouteFallback />}>
            <ChunkLoaded />
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
              <Route path="/saude" element={<FinancialHealthPage />} />
              <Route
                path="/precificacao"
                element={isPersonalAccount ? <Navigate to="/" replace /> : <PricingPage />}
              />
              <Route
                path="/parceiros"
                element={isPersonalAccount ? <Navigate to="/" replace /> : <PartnersPage />}
              />
              <Route path="/importar" element={<ImportPage />} />
              <Route path="/categorias" element={<CategoriesPage />} />
              <Route path="/ajustes" element={<SettingsPage />} />
              <Route path="/perfil" element={<ProfilePage />} />
              {/* Rotas absorvidas como aba em revisão de sidebar (07/09/2026) — redirect para quem
                  não tinha o link salvo com o hash da aba nova. */}
              <Route path="/parcelamentos" element={<Navigate to="/lancamentos" replace />} />
              <Route path="/aposentadoria" element={<Navigate to="/investimentos" replace />} />
              <Route path="/motor" element={<Navigate to="/saude" replace />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
          </RouteErrorBoundary>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

export function App() {
  usePageViewTelemetry()
  usePageTitle()
  const { session, loading } = useAuth()

  // Nada renderiza (nem a tela de login) até saber se já existe uma sessão
  // salva — evita o flash de "login" antes do redirect silencioso de quem
  // já estava logado.
  if (loading) return null
  if (!session) return <LoginPage />

  return <AuthedApp />
}
