/**
 * Thin typed fetch wrapper.
 *
 * Local dev (no VITE_SUPABASE_URL set): Vite proxies /api to the Fastify
 * server (vite.config.ts) — unchanged, still needed for routes not yet
 * ported to an Edge Function (ledger, backups, simulate).
 *
 * Deployed build (VITE_SUPABASE_URL set, e.g. on Vercel): there is no
 * Fastify server to proxy to, so requests go straight to the Supabase
 * Edge Functions (decisions/0026). Each Fastify route file became its own
 * function, named after the file; `pricing.ts`'s routes already had their
 * own `/pricing/...` prefix, but `insights.ts`'s didn't, so those gained
 * an `/insights` prefix here that has no Fastify-side equivalent.
 */

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

function resolveUrl(path: string): string {
  if (!SUPABASE_URL) return `/api${path}`
  const fn = path.startsWith('/pricing/') || path === '/pricing' ? 'pricing' : 'insights'
  return fn === 'pricing' ? `${SUPABASE_URL}/functions/v1${path}` : `${SUPABASE_URL}/functions/v1/insights${path}`
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
    throw new ApiError(payload?.error ?? `HTTP ${response.status}`, response.status, payload?.issues)
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
