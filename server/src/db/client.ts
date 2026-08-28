import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// Loaded here, not in index.ts: ESM evaluates every imported module's
// top-level code before the importing module's own top-level code runs,
// so an env load in index.ts would run AFTER this file already tried to
// read process.env. Safe to call more than once (a later loadEnvFile in
// index.ts is a no-op); missing .env is fine for the same reason it was
// before — every process.env.* read below just stays undefined.
try {
  process.loadEnvFile()
} catch {
  // no .env
}

/**
 * Supabase Postgres ("BOB.FINANÇA") — fonte real desde decisions/0026,
 * Fase 3. Conecta via session pooler (porta 5432): suporta prepared
 * statements e IPv4, apropriado para um servidor Node de processo
 * longo como este (não serverless/edge, que usaria o transaction
 * pooler na 6543).
 */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} não configurado (.env)`)
  return value
}

const client = postgres({
  host: requireEnv('SUPABASE_DB_HOST'),
  port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
  username: requireEnv('SUPABASE_DB_USER'),
  password: requireEnv('SUPABASE_DB_PASSWORD'),
  database: process.env.SUPABASE_DB_NAME ?? 'postgres',
  ssl: 'require',
  // The session pooler caps this project at 15 concurrent clients total,
  // shared with anything else connected (Supabase Studio, ad-hoc scripts).
  // Several routes now fan out with Promise.all across converted-to-async
  // services, so a generous per-app pool could exhaust that cap on its
  // own — postgres-js queues excess concurrent queries against a smaller
  // pool rather than erroring, which is the safer failure mode here.
  max: 5,
  idle_timeout: 20,
  types: {
    // postgres-js returns bigint (oid 20 — every `count(*)`, every `id`
    // column read via a raw query) and numeric (oid 1700 — `sum()` over a
    // bigint column, e.g. amount_cents) as strings by default, since
    // neither fits losslessly into a JS number for arbitrary values.
    // Drizzle's own typed bigint columns already coerce with Number() on
    // the way out (see PgBigInt53.mapFromDriverValue) regardless of what
    // the driver hands back, but the many raw `db.execute(sql\`...\`)`
    // analytics queries in this app do not go through that column
    // mapping — they'd otherwise get a string and silently corrupt
    // downstream arithmetic (e.g. `sum + row.amount` string-concatenating
    // instead of adding). Every amount in this app is cents, safely
    // within Number.MAX_SAFE_INTEGER, so parsing both as Number at the
    // connection level is safe and matches what Drizzle already does.
    bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
  },
})

export const db = drizzle(client, { schema })
export type DB = typeof db
export { schema }

export async function closeDb(): Promise<void> {
  await client.end()
}
