import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { AuthProvider } from './lib/auth'
import { RangeProvider } from './lib/store'
import { ThemeProvider } from './lib/theme'
import { ToastProvider } from './components/ui'
import { TooltipProvider } from './components/ui/tooltip'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // 2 minutos, não 10 s: o app tem um usuário só e toda gravação já marca
      // como velho o que ela afeta (`invalidateQueries`), então voltar a uma
      // tela visitada há pouco pode mostrar o cache em vez de refazer todas
      // as chamadas (revisão de desempenho de 04/10/2026).
      staleTime: 2 * 60_000,
      retry: 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ToastProvider>
            <AuthProvider>
              <BrowserRouter>
                <RangeProvider>
                  <App />
                </RangeProvider>
              </BrowserRouter>
            </AuthProvider>
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
