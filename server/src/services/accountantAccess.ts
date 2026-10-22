import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '../db/client'
import { appUsers } from '../db/schema'

/**
 * Quem pode entrar como contador (docs/specs/tarefas-comercial-contador, fase 5).
 * O convite e a remoção da conta no Supabase Auth ficam na função `accountant`
 * (precisam da chave de serviço); aqui só o registro de quem foi convidado.
 */

export class AccessError extends Error {}

const EMAIL = /^\S+@\S+\.\S+$/

export async function isActiveAccountant(userId: string, executor: DbExecutor = db): Promise<boolean> {
  const row = (
    await executor
      .select({ userId: appUsers.userId })
      .from(appUsers)
      .where(and(eq(appUsers.userId, userId), eq(appUsers.role, 'accountant'), isNull(appUsers.revokedAt)))
  )[0]
  return Boolean(row)
}

export async function accountantEmail(userId: string, executor: DbExecutor = db): Promise<string | null> {
  return (await executor.select({ email: appUsers.email }).from(appUsers).where(eq(appUsers.userId, userId)))[0]?.email ?? null
}

export async function listAccessUsers(executor: DbExecutor = db) {
  return executor.select().from(appUsers).orderBy(asc(appUsers.invitedAt))
}

export function assertEmail(email: string) {
  if (!EMAIL.test(email.trim())) throw new AccessError('confira o e-mail do contador')
}

/** Registra o contador convidado (o id vem do convite do Supabase Auth). Reconvidar reativa. */
export async function recordAccountant(userId: string, email: string, executor: DbExecutor = db) {
  assertEmail(email)
  const existing = (await executor.select().from(appUsers).where(eq(appUsers.userId, userId)))[0]
  if (existing) {
    await executor.update(appUsers).set({ email: email.trim().toLowerCase(), revokedAt: null }).where(eq(appUsers.userId, userId))
  } else {
    const sameEmail = (await executor.select().from(appUsers).where(sql`lower(${appUsers.email}) = ${email.trim().toLowerCase()}`))[0]
    if (sameEmail) await executor.delete(appUsers).where(eq(appUsers.userId, sameEmail.userId))
    await executor.insert(appUsers).values({ userId, email: email.trim().toLowerCase(), role: 'accountant' })
  }
  return (await executor.select().from(appUsers).where(eq(appUsers.userId, userId)))[0]!
}

/** Revoga: o registro fica (com a data), e a função `accountant` passa a recusar o login. */
export async function revokeAccountant(userId: string, executor: DbExecutor = db) {
  const result = await executor.update(appUsers).set({ revokedAt: sql`now_iso()` }).where(eq(appUsers.userId, userId)).returning()
  return result[0] ?? null
}
