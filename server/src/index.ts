import Fastify from 'fastify'
import cors from '@fastify/cors'
import { ZodError } from 'zod'
import { seed } from './db/seed'
import { ledgerRoutes } from './routes/ledger'
import { insightsRoutes } from './routes/insights'
import { backupRoutes } from './routes/backups'
import { pricingRoutes } from './routes/pricing'
import { simulateRoutes } from './routes/simulate'

// Secrets (e.g. BRAPI_TOKEN) live in .env, gitignored — never hardcoded in
// source. Missing the file is fine (local dev without any external API
// keys configured yet), so this is a no-op rather than a startup failure.
try {
  process.loadEnvFile()
} catch {
  // no .env — every process.env.* read below just stays undefined
}

/**
 * Deliberately NOT `PORT`: dev tooling and preview harnesses set that for the
 * web server, and the API silently stealing it collides with Vite.
 */
const PORT = Number(process.env.FINANCE_API_PORT ?? 3001)
const HOST = process.env.FINANCE_API_HOST ?? '127.0.0.1'

const app = Fastify({
  logger: { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } },
  // Statements are text; 25 MB covers years of history in one upload.
  bodyLimit: 25 * 1024 * 1024,
})

// Zod failures are user input problems, not server faults.
app.setErrorHandler((error: unknown, _req, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: 'dados inválidos', issues: error.issues })
  }
  app.log.error(error)
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: number }).statusCode) || 500
      : 500
  const message = error instanceof Error ? error.message : 'erro interno'
  return reply.code(status).send({ error: message })
})

await app.register(cors, { origin: true })
await app.register(ledgerRoutes, { prefix: '/api' })
await app.register(insightsRoutes, { prefix: '/api' })
await app.register(backupRoutes, { prefix: '/api' })
await app.register(pricingRoutes, { prefix: '/api' })
await app.register(simulateRoutes, { prefix: '/api' })

app.get('/api/health', async () => ({ ok: true, db: 'supabase' }))

// Seed on boot: `npm run dev` is the only setup step there is. Schema
// migrations run separately via `supabase db push` (decisions/0026).
const seeded = await seed()

await app.listen({ port: PORT, host: HOST })
app.log.info(
  `Supabase (BOB.FINANÇA) — ${seeded.categories} categorias, ${seeded.profiles} perfis, ${seeded.rules} regras`,
)
