import { eq, inArray } from 'drizzle-orm'
import { db, type DbExecutor } from '../db/client.ts'
import { googleCalendarConnection, googleCalendarEvents } from '../db/schema.ts'
import { addDays, todayIso } from '../core/dates.ts'
import { listTasks, type TaskOccurrence } from './tasks.ts'

/**
 * Google Agenda (docs/specs/tarefas-comercial-contador, fase 3): cada tarefa
 * aberta vira um evento na agenda do dono, com lembrete, e o evento some quando
 * a tarefa é feita ou deixa de existir.
 *
 * Conexão: OAuth do Google com acesso offline. O retorno do consentimento cai
 * no próprio site (`/tarefas/google`), que manda o código ao servidor com a
 * sessão do dono: nenhum endereço público novo. O token de atualização fica só
 * no banco (RLS sem política), nunca vai ao navegador.
 *
 * Só `fetch`, sem SDK, para rodar igual no Node e no Deno. Em sequência.
 */

export class GoogleCalendarError extends Error {}

export type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string }

const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'openid', 'email']
const TIME_ZONE = 'America/Sao_Paulo'
/** Lembretes do evento: no horário (9h do dia) e um dia antes. */
const REMINDERS = [
  { method: 'popup', minutes: 0 },
  { method: 'popup', minutes: 24 * 60 },
]

export function googleConfigFromEnv(get: (name: string) => string | undefined): GoogleConfig | null {
  const clientId = get('GOOGLE_CLIENT_ID')
  const clientSecret = get('GOOGLE_CLIENT_SECRET')
  const redirectUri = get('GOOGLE_REDIRECT_URI')
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null
}

export function authUrl(config: GoogleConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    // Sempre pede o consentimento: é o que garante um refresh_token novo.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

async function googleJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new GoogleCalendarError(`${what}: o Google respondeu ${response.status}${text ? ` (${text.slice(0, 160)})` : ''}`)
  }
  return (await response.json()) as T
}

export async function connect(config: GoogleConfig, code: string, executor: DbExecutor = db) {
  const token = await googleJson<{ access_token: string; refresh_token?: string }>(
    await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code' }),
    }),
    'falha ao conectar',
  )
  if (!token.refresh_token) throw new GoogleCalendarError('o Google não devolveu acesso offline; tente conectar de novo')
  const info = await googleJson<{ email?: string }>(
    await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } }),
    'falha ao ler a conta',
  ).catch(() => ({ email: undefined }))

  // Conta nova: os eventos de antes eram de outra agenda.
  await executor.delete(googleCalendarEvents)
  await executor.delete(googleCalendarConnection)
  await executor.insert(googleCalendarConnection).values({ id: 1, email: info.email ?? null, refreshToken: token.refresh_token })
  return status(config, executor)
}

export async function status(config: GoogleConfig | null, executor: DbExecutor = db) {
  const row = (await executor.select().from(googleCalendarConnection).limit(1))[0]
  const events = row ? (await executor.select({ id: googleCalendarEvents.id }).from(googleCalendarEvents)).length : 0
  return {
    configured: config !== null,
    connected: Boolean(row),
    email: row?.email ?? null,
    lastSyncAt: row?.lastSyncAt ?? null,
    lastError: row?.lastError ?? null,
    events,
  }
}

async function accessToken(config: GoogleConfig, refreshToken: string): Promise<string> {
  const token = await googleJson<{ access_token: string }>(
    await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token' }),
    }),
    'falha ao renovar o acesso (reconecte o Google Agenda)',
  )
  return token.access_token
}

/** O evento que a tarefa pede: 9h do dia de vencimento, meia hora, com lembrete. */
export function eventFor(task: TaskOccurrence) {
  const money = task.amountCents !== null ? (task.amountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : null
  return {
    summary: money ? `${task.title} (${money})` : task.title,
    description: [task.detail, 'Tarefa do BOB Finanças: marque como feita no app e o evento sai da agenda.'].filter(Boolean).join('\n\n'),
    start: { dateTime: `${task.dueOn}T09:00:00`, timeZone: TIME_ZONE },
    end: { dateTime: `${task.dueOn}T09:30:00`, timeZone: TIME_ZONE },
    reminders: { useDefault: false, overrides: REMINDERS },
    extendedProperties: { private: { bobTaskKey: task.key } },
  }
}

/**
 * Deixa a agenda igual às tarefas abertas da janela (7 dias para trás, 30 para a
 * frente): cria o que falta, atualiza o que mudou e apaga o que foi feito ou
 * sumiu. Com `onlyKeys`, só mexe nessas (ex.: logo depois de marcar uma tarefa).
 */
export async function sync(config: GoogleConfig, options: { onlyKeys?: string[] } = {}, executor: DbExecutor = db) {
  const row = (await executor.select().from(googleCalendarConnection).limit(1))[0]
  if (!row) return { connected: false, created: 0, updated: 0, removed: 0 }
  const today = todayIso()
  let created = 0
  let updated = 0
  let removed = 0
  try {
    const token = await accessToken(config, row.refreshToken)
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(row.calendarId)}/events`
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    const { tasks } = await listTasks({ from: addDays(today, -7), to: addDays(today, 30) }, executor)
    const wanted = new Map(tasks.filter((t) => !t.done && t.dueOn >= addDays(today, -7)).map((t) => [t.key, t] as const))
    const only = options.onlyKeys ? new Set(options.onlyKeys) : null
    const mapped = only
      ? await executor.select().from(googleCalendarEvents).where(inArray(googleCalendarEvents.taskKey, [...only]))
      : await executor.select().from(googleCalendarEvents)
    const byKey = new Map(mapped.map((m) => [m.taskKey, m] as const))

    for (const [key, task] of wanted) {
      if (only && !only.has(key)) continue
      const body = eventFor(task)
      const signature = JSON.stringify(body)
      const current = byKey.get(key)
      if (current && current.signature === signature) continue
      if (current) {
        const response = await fetch(`${base}/${encodeURIComponent(current.eventId)}`, { method: 'PATCH', headers, body: signature })
        if (response.status === 404 || response.status === 410) {
          // Apagado à mão na agenda: cria de novo.
          const fresh = await googleJson<{ id: string }>(await fetch(base, { method: 'POST', headers, body: signature }), 'falha ao criar o evento')
          await executor.update(googleCalendarEvents).set({ eventId: fresh.id, signature, syncedAt: new Date().toISOString() }).where(eq(googleCalendarEvents.id, current.id))
          created += 1
          continue
        }
        await googleJson(response, 'falha ao atualizar o evento')
        await executor.update(googleCalendarEvents).set({ signature, syncedAt: new Date().toISOString() }).where(eq(googleCalendarEvents.id, current.id))
        updated += 1
      } else {
        const fresh = await googleJson<{ id: string }>(await fetch(base, { method: 'POST', headers, body: signature }), 'falha ao criar o evento')
        await executor.insert(googleCalendarEvents).values({ taskKey: key, eventId: fresh.id, signature })
        created += 1
      }
    }

    for (const m of mapped) {
      if (wanted.has(m.taskKey)) continue
      const response = await fetch(`${base}/${encodeURIComponent(m.eventId)}`, { method: 'DELETE', headers })
      if (!response.ok && response.status !== 404 && response.status !== 410) await googleJson(response, 'falha ao apagar o evento')
      await executor.delete(googleCalendarEvents).where(eq(googleCalendarEvents.id, m.id))
      removed += 1
    }

    await executor.update(googleCalendarConnection).set({ lastSyncAt: new Date().toISOString(), lastError: null }).where(eq(googleCalendarConnection.id, 1))
    return { connected: true, created, updated, removed }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'falha ao sincronizar'
    await executor.update(googleCalendarConnection).set({ lastError: message.slice(0, 300) }).where(eq(googleCalendarConnection.id, 1))
    throw error instanceof GoogleCalendarError ? error : new GoogleCalendarError(message)
  }
}

/** Depois de mexer numa tarefa: sincroniza só ela, sem deixar a falha do Google atrapalhar a tela. */
export async function syncQuietly(config: GoogleConfig | null, keys?: string[]) {
  if (!config) return
  try {
    await sync(config, keys ? { onlyKeys: keys } : {})
  } catch {
    // o erro fica em `last_error` e aparece no card do Google Agenda
  }
}

/** Desconecta: apaga os eventos criados, revoga o acesso e esquece a conta. */
export async function disconnect(config: GoogleConfig | null, executor: DbExecutor = db) {
  const row = (await executor.select().from(googleCalendarConnection).limit(1))[0]
  if (!row) return { connected: false }
  if (config) {
    try {
      const token = await accessToken(config, row.refreshToken)
      const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(row.calendarId)}/events`
      for (const m of await executor.select().from(googleCalendarEvents)) {
        await fetch(`${base}/${encodeURIComponent(m.eventId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
      }
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(row.refreshToken)}`, { method: 'POST' })
    } catch {
      // sem acesso ao Google: ainda assim esquece a conta aqui
    }
  }
  await executor.delete(googleCalendarEvents)
  await executor.delete(googleCalendarConnection)
  return { connected: false }
}
