import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

/**
 * Supabase Postgres ("BOB.FINANÇA") from an Edge Function — a different
 * connection shape than server/src/db/client.ts (the Fastify/Node
 * version). Edge Functions are short-lived, possibly-concurrent
 * invocations, which is exactly the case Supabase's own docs say the
 * session pooler (used by the Node server) is NOT suited for — it caps
 * total concurrent clients project-wide, and a burst of Edge Function
 * invocations would exhaust that fast. The transaction pooler (port
 * 6543, Supavisor) is what Supabase explicitly recommends for
 * serverless/edge: many transient connections, pooled per-transaction
 * rather than per-client-session.
 *
 * Transaction mode does not support prepared statements — `prepare:
 * false` is required, not optional, or queries fail. `max: 1`: each
 * function invocation is its own isolate: there is no benefit to
 * holding a local pool of more than one connection open per instance.
 */
function requireEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} não configurado (secrets da função)`)
  return value
}

// Neither SUPABASE_*-prefixed nor the standard libpq PG* names: the
// platform reserves SUPABASE_* for its own injected secrets (silently
// strips the prefix from anything set via `supabase secrets set`), and
// PGHOST/PGUSER/PGPASSWORD/PGDATABASE collided with something the
// platform also sets for its own database connection — both took a
// live deploy to discover (password authentication failed against a
// password already confirmed correct via the session pooler).
const client = postgres({
  host: requireEnv('APPDB_HOST'),
  port: Number(Deno.env.get('APPDB_TRANSACTION_PORT') ?? 6543),
  username: requireEnv('APPDB_USER'),
  password: requireEnv('APPDB_PASSWORD'),
  database: Deno.env.get('APPDB_NAME') ?? 'postgres',
  ssl: 'require',
  prepare: false,
  max: 1,
  types: {
    // Same fix as server/src/db/client.ts: bigint (oid 20) and numeric
    // (oid 1700) come back as strings from postgres-js by default —
    // confirmed to reproduce identically under Deno in the feasibility
    // test. Every amount here is cents, safely within
    // Number.MAX_SAFE_INTEGER.
    bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
  },
})

export const db = drizzle(client, { schema })
export type DB = typeof db
export { schema }
