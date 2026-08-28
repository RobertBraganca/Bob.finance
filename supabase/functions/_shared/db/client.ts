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
 * false` is required, not optional, or queries fail. `max: 1` seemed
 * right at first (one isolate, no benefit to a local pool) but hung
 * indefinitely — never errored, just never responded — on routes with
 * per-row concurrent fan-out (N+1 `Promise.all`, e.g.
 * `listDebts`/`portfolioSummary`); `max: 5` (same ceiling as the
 * Node/session-pooler client) cleared those. `goals.ts#goalHistory`'s
 * deeper fan-out (12+ months, each running its own 5-query
 * `getPeriodProgress`) still hung past that at every `max` tried up to
 * 20 — fixed at the source instead (made fully sequential, see its own
 * comment) rather than by chasing `max` further.
 *
 * Separately, and worse: endpoints that had been passing reliably
 * started hanging on every single request, indefinitely, after a
 * period of heavy testing — never recovering on their own even after
 * several minutes idle. That is the known Supabase failure mode for
 * warm serverless isolates reusing a stale pooled connection: the
 * pooler or NAT drops an inactive TCP socket, but postgres-js's local
 * pool still considers it live and hands it out, so the next query on
 * it just hangs forever waiting for a response the dead socket will
 * never deliver (Supabase's own "hanging queries in Serverless
 * Functions" troubleshooting doc). `idle_timeout` makes postgres-js
 * close and drop a connection itself once it has sat idle — before it
 * goes stale under it — rather than leaving that to chance between
 * invocations of a reused warm isolate.
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
  max: 5,
  idle_timeout: 20,
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
