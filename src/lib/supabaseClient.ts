import { createClient } from '@supabase/supabase-js'

/**
 * Auth precisa de uma URL/anon key REAIS de Supabase mesmo em dev local sem
 * `VITE_SUPABASE_URL` configurada — ao contrário de `api.ts`, não existe um
 * "proxy de Auth" equivalente ao proxy do Vite para as Edge Functions. Os
 * valores abaixo são a mesma anon key pública que já é embutida no bundle
 * de produção (Vercel) sempre que `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`
 * estão configuradas — não é segredo novo, só o mesmo dado já público
 * disponível como fallback para quando essas variáveis não estão setadas
 * localmente. Isso é deliberadamente separado da lógica de roteamento de
 * `api.ts` (proxy do Vite vs. Edge Function): productionizar a URL aqui
 * NUNCA muda para onde `/api/*` é enviado, só habilita login.
 */
const FALLBACK_SUPABASE_URL = 'https://ubgsgzlvugjbzyzbufel.supabase.co'
const FALLBACK_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InViZ3Nnemx2dWdqYnp5emJ1ZmVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NzE0ODUsImV4cCI6MjEwMzQ0NzQ4NX0.z19tKGWxd8Cu0Q3Y4H0P7nacH7Zudb36kpFMYTqBtWU'

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || FALLBACK_SUPABASE_URL
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || FALLBACK_SUPABASE_ANON_KEY

export const supabase = createClient(url, anonKey)
