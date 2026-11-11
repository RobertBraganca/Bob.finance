/**
 * Publica Edge Functions e invalida o cache das leituras (core/responseCache.ts).
 *
 *   npm run deploy:fn -- insights ledger
 *
 * Uma resposta guardada no `api_cache` vale enquanto nenhum dado mudar no dia;
 * um deploy que muda o formato de uma resposta precisa invalidar tudo, senão a
 * tela nova leria a resposta velha até a próxima escrita. Subir a
 * `data_version` faz isso sem apagar nada.
 */
import { spawnSync } from 'node:child_process'
import { sql } from 'drizzle-orm'
import { db } from '../server/src/db/client'

const names = process.argv.slice(2)
if (names.length === 0) {
  console.error('uso: npm run deploy:fn -- <função> [<função> ...]')
  process.exit(1)
}

for (const name of names) {
  console.log(`\n> supabase functions deploy ${name}`)
  const result = spawnSync('npx', ['supabase', 'functions', 'deploy', name], { stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    console.error(`deploy de ${name} falhou; o cache não foi invalidado`)
    process.exit(result.status ?? 1)
  }
}

const rows = await db.execute<{ v: number }>(sql`update data_version set v = v + 1 where id = 1 returning v`)
console.log(rows[0] ? `\ncache invalidado (data_version = ${rows[0].v})` : '\ndata_version não existe: aplique a migração 20261111180000')
process.exit(0)
