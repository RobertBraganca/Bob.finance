/**
 * Log de uso por feature — tela aberta, ação-chave feita, erro exibido ao
 * usuário. Base para melhoria contínua de UX/UI (pedido do usuário,
 * 28/08/2026), nunca conteúdo financeiro nem clique a clique. Ver
 * supabase/functions/telemetry.
 *
 * Fire-and-forget por natureza: uma falha aqui (rede fora, function
 * indisponível) nunca deve virar erro visível nem atrapalhar a ação real
 * que está sendo registrada — por isso o catch silencioso.
 */

const SESSION_KEY = 'bob-finance-telemetry-session'

function sessionId(): string {
  try {
    let id = localStorage.getItem(SESSION_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    // Modo privado ou storage bloqueado: um id por carregamento de página
    // ainda agrupa os eventos daquela sessão, só não persiste entre elas.
    return crypto.randomUUID()
  }
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const SID = sessionId()

function send(kind: 'view' | 'action' | 'error', feature: string, name: string, detail?: Record<string, unknown>) {
  if (!SUPABASE_URL) return // sem Edge Functions configuradas (dev local sem VITE_SUPABASE_URL) — nada a chamar
  fetch(`${SUPABASE_URL}/functions/v1/telemetry/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY ?? '' },
    body: JSON.stringify({ sessionId: SID, feature, kind, name, detail }),
    keepalive: true,
  }).catch(() => {})
}

export const telemetry = {
  /** Uma tela abriu — chamado uma vez por navegação em App.tsx, não precisa ser repetido por página. */
  view: (feature: string) => send('view', feature, 'page_view'),
  /** Uma ação-chave da feature foi concluída (criar, importar, categorizar...). */
  action: (feature: string, name: string, detail?: Record<string, unknown>) => send('action', feature, name, detail),
  /** Um erro apareceu pro usuário — validação, falha de rede, rota ainda não portada etc. */
  error: (feature: string, name: string, detail?: Record<string, unknown>) => send('error', feature, name, detail),
}
