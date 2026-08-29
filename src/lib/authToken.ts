/**
 * `api.ts` (plain module, no React) needs the current access token on every
 * request but can't call `useAuth()` — same bridge pattern as `toastBus.ts`.
 * `AuthProvider` is the only writer; `api.ts` only reads.
 */
let currentAccessToken: string | null = null

export function setAccessToken(token: string | null) {
  currentAccessToken = token
}

export function getAccessToken(): string | null {
  return currentAccessToken
}
