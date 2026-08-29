/**
 * `api.ts` (plain module, no React) needs to surface a toast on request
 * failure but can't call the `useToast()` hook directly — this is the
 * imperative bridge. `ToastProvider` subscribes once; anything can emit.
 */
type Tone = 'info' | 'error'
type Listener = (message: string, tone: Tone) => void

const listeners = new Set<Listener>()
let lastErrorAt = 0
const ERROR_COOLDOWN_MS = 4000

export function emitToast(message: string, tone: Tone = 'info') {
  // A page with several failed queries at once (e.g. the whole backend
  // down) would otherwise stack one toast per query — one clear signal
  // beats a wall of identical-looking ones. Only throttles the automatic
  // bus path; a toast pushed directly via useToast() is never suppressed.
  if (tone === 'error') {
    const now = Date.now()
    if (now - lastErrorAt < ERROR_COOLDOWN_MS) return
    lastErrorAt = now
  }
  listeners.forEach((fn) => fn(message, tone))
}

export function subscribeToast(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
