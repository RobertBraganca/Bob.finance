import { useState } from 'react'
import { Route, Routes } from 'react-router-dom'
import { Sidebar } from './components/shell/Shell'
import { Card, Icon } from './components/ui'
import { Dashboard } from './pages/Dashboard'
import { DrePage } from './pages/Dre'
import { ImportPage } from './pages/Import'
import { TransactionsPage } from './pages/Transactions'
import { CategoriesPage } from './pages/Categories'
import { DailyPage } from './pages/Daily'
import { GoalsPage } from './pages/Goals'
import { DebtPage } from './pages/Debt'
import { CreditCardsPage } from './pages/CreditCards'
import { InvestmentsPage } from './pages/Investments'
import { FinancialHealthPage } from './pages/FinancialHealth'
import { FinancialEnginePage } from './pages/FinancialEngine'
import { PricingPage } from './pages/Pricing'
import { SettingsPage } from './pages/Settings'

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
          Servidor nesta sessão está na porta {port}, não a 5173 padrão — personalizações salvas
          neste navegador (ex. arranjo do Painel) podem não persistir entre reinícios do servidor.
        </span>
      </Card>
    </div>
  )
}

export function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <PortWarning />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/diario" element={<DailyPage />} />
          <Route path="/lancamentos" element={<TransactionsPage />} />
          <Route path="/dre" element={<DrePage />} />
          <Route path="/metas" element={<GoalsPage />} />
          <Route path="/dividas" element={<DebtPage />} />
          <Route path="/cartoes" element={<CreditCardsPage />} />
          <Route path="/investimentos" element={<InvestmentsPage />} />
          <Route path="/saude" element={<FinancialHealthPage />} />
          <Route path="/motor" element={<FinancialEnginePage />} />
          <Route path="/precificacao" element={<PricingPage />} />
          <Route path="/importar" element={<ImportPage />} />
          <Route path="/categorias" element={<CategoriesPage />} />
          <Route path="/ajustes" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  )
}
