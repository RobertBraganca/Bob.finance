/**
 * Thin typed fetch wrapper.
 *
 * Local dev (no VITE_SUPABASE_URL set): Vite proxies /api to the Fastify
 * server (vite.config.ts) — unchanged, still needed for routes not yet
 * ported to an Edge Function (backups, simulate).
 *
 * Deployed build (VITE_SUPABASE_URL set, e.g. on Vercel): there is no
 * Fastify server to proxy to, so requests go straight to the Supabase
 * Edge Functions (decisions/0026). Each Fastify route file became its own
 * function, named after the file. `pricing.ts`'s routes already had their
 * own `/pricing/...` prefix in Fastify, so that one carries over as-is;
 * `insights.ts` and `ledger.ts` didn't have one, so those two gained a
 * matching `/insights` or `/ledger` prefix here that has no Fastify-side
 * equivalent — LEDGER_PREFIXES lists exactly the path prefixes that moved
 * to `ledger.ts`, everything else not `/pricing` falls through to `insights`.
 */

import { telemetry } from './telemetry'
import { emitToast } from './toastBus'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: unknown,
  ) {
    super(message)
  }
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

const LEDGER_PREFIXES = ['/accounts', '/profiles', '/imports', '/categories', '/rules', '/transactions']

function functionFor(path: string): 'pricing' | 'ledger' | 'insights' {
  if (path === '/pricing' || path.startsWith('/pricing/')) return 'pricing'
  if (LEDGER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)))
    return 'ledger'
  return 'insights'
}

function resolveUrl(path: string): string {
  if (!SUPABASE_URL) return `/api${path}`
  const fn = functionFor(path)
  return fn === 'pricing' ? `${SUPABASE_URL}/functions/v1${path}` : `${SUPABASE_URL}/functions/v1/${fn}${path}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {}),
      ...init?.headers,
    },
  })

  const text = await response.text()
  const payload = text ? JSON.parse(text) : null

  if (!response.ok) {
    const message = payload?.error ?? `HTTP ${response.status}`
    // Ponto único: toda chamada de API passa por aqui, então um erro aqui
    // representa qualquer fricção real de UX (validação, rota ainda não
    // portada, falha do backend) sem precisar anotar cada callsite.
    telemetry.error(functionFor(path), `http_${response.status}`, { path, message })
    // GET failures are queries — until now nothing noticed when one failed,
    // every EmptyState rendered identically to "sem dado" (achado da
    // revisão de 28/08/2026). Mutations (post/put/patch/del) already carry
    // their own per-call onError toast at the call site; auto-toasting
    // those here too would double up the same failure.
    if (!init?.method) emitToast(`Falha ao carregar dado: ${message}`, 'error')
    throw new ApiError(message, response.status, payload?.issues)
  }
  return payload as T
}

const qs = (params: Record<string, unknown>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

export const api = {
  get: <T>(path: string, params: Record<string, unknown> = {}) => request<T>(`${path}${qs(params)}`),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string, params: Record<string, unknown> = {}) =>
    request<T>(`${path}${qs(params)}`, { method: 'DELETE' }),
}

/** Files travel as base64 so the whole API stays a single JSON contract. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`não foi possível ler ${file.name}`))
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}
