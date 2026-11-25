import { readFileSync } from 'node:fs'
import { db } from '../server/src/db/client'
import { normalizeName, type GroceryUnit } from '../shared/grocery'
import * as grocery from '../server/src/services/grocery'

/**
 * Carga das compras antigas (docs/specs/lista-de-compras, plano etapa 8).
 *
 *   npx.cmd tsx scripts/grocery-seed.ts            (só mostra o que faria)
 *   npx.cmd tsx scripts/grocery-seed.ts --gravar   (grava)
 *
 * Lê `data/grocery-seed.json` (fora do git), já revisado. Cada compra vira uma
 * compra concluída (`importDoneTrip`, sem passar pela lista em andamento),
 * sem vínculo, com os produtos criados ou reaproveitados
 * pelo nome normalizado. Idempotente: uma compra com a mesma data e os mesmos
 * itens (produto, quantidade e preço) já gravada é pulada. Tudo numa transação:
 * se algo falhar, nada fica gravado. O .env é lido pelo próprio client do banco
 * (nunca `source .env`).
 */

type SeedItem = { name: string; unit: GroceryUnit; qty: number; unitPriceCents: number }
type SeedTrip = { purchasedOn: string; items: SeedItem[] }

const write = process.argv.includes('--gravar')
const seed = JSON.parse(readFileSync(new URL('../data/grocery-seed.json', import.meta.url), 'utf8')) as { trips: SeedTrip[] }

const signature = (items: Array<{ key: string; qty: number; price: number | null }>) =>
  items
    .map((i) => `${i.key}|${i.qty}|${i.price}`)
    .sort()
    .join(';')

class DryRun extends Error {}

async function main() {
  const existing = await grocery.listTrips()
  const existingSigs = new Set<string>()
  for (const t of existing) {
    const full = await grocery.getTrip(t.id)
    existingSigs.add(`${full.purchasedOn}#${signature(full.items.filter((i) => i.checked).map((i) => ({ key: normalizeName(i.name), qty: i.qty ?? i.plannedQty, price: i.unitPriceCents })))}`)
  }

  try {
    await db.transaction(async (tx) => {
      for (const trip of seed.trips) {
        const sig = `${trip.purchasedOn}#${signature(trip.items.map((i) => ({ key: normalizeName(i.name), qty: i.qty, price: i.unitPriceCents })))}`
        if (existingSigs.has(sig)) {
          console.log(`${trip.purchasedOn}: já gravada, pulando`)
          continue
        }
        // Direto como concluída: a lista em andamento no app (se houver) não é tocada.
        const done = await grocery.importDoneTrip(trip, tx)
        console.log(`${trip.purchasedOn}: ${done.totals.checkedCount} itens, R$ ${(done.totals.realCents / 100).toFixed(2)}${write ? '' : ' (simulação)'}`)
      }
      if (!write) throw new DryRun()
    })
  } catch (error) {
    if (!(error instanceof DryRun)) throw error
    console.log('Nada gravado. Rode com --gravar para gravar.')
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
