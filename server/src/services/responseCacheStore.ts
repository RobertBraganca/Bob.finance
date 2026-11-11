import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * O armazenamento do cache das leituras (core/responseCache.ts): `data_version`
 * e `api_cache`, migração 20261111180000. Chaves que começam com `__` são de
 * estado interno (a assinatura da materialização) e não entram na limpeza diária.
 */
export async function readCached(key: string, day: string): Promise<{ version: number; body: string | null }> {
  const rows = await db.execute<{ version: number; body: string | null }>(sql`
    select d.v as version, c.body
    from data_version d
    left join api_cache c on c.key = ${key} and c.version = d.v and c.day = ${day}
    where d.id = 1
  `)
  const row = rows[0]
  // Sem a migração (ou sem a linha), nada guardado vale: calcula sempre.
  if (!row) throw new Error('data_version vazia')
  return { version: Number(row.version), body: row.body }
}

export async function writeCached(key: string, version: number, day: string, body: string): Promise<void> {
  // A limpeza do que é de outro dia vai junto, numa consulta só; não toca na
  // própria chave (mexer duas vezes na mesma linha num comando não é permitido).
  await db.execute(sql`
    with purge as (
      delete from api_cache where day <> ${day} and key <> ${key} and left(key, 2) <> '__'
    )
    insert into api_cache (key, version, day, body) values (${key}, ${version}, ${day}, ${body})
    on conflict (key) do update
      set version = excluded.version, day = excluded.day, body = excluded.body, stored_at = now()
      where api_cache.version <= excluded.version or api_cache.day <> excluded.day
  `)
}

/** Estado interno guardado no mesmo lugar (ex.: a assinatura da materialização). */
export async function readState(key: string): Promise<string | null> {
  const rows = await db.execute<{ body: string }>(sql`select body from api_cache where key = ${key}`)
  return rows[0]?.body ?? null
}

export async function writeState(key: string, value: string): Promise<void> {
  await db.execute(sql`
    insert into api_cache (key, version, day, body) values (${key}, 0, '', ${value})
    on conflict (key) do update set body = excluded.body, stored_at = now()
  `)
}
