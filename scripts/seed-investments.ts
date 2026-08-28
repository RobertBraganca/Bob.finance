/**
 * Loads the user's real current investment positions, straight from the
 * numbers they gave (ticker, quantity, average price, current price for
 * the classes they detailed; a single aggregate value + return for the
 * classes they haven't broken down yet), plus their target allocation
 * per class.
 *
 * Each detailed asset gets exactly one 'buy' trade (quantity @ average
 * price) and one valuation (current price) — the two facts the whole
 * app derives everything else from. Each aggregate-only class gets a
 * single placeholder asset sized so its value and all-time return match
 * what the user reported; its name says "a detalhar" so it reads as a
 * stand-in, not a real ticker, until it is broken into real assets.
 *
 * Idempotent: running twice does not double the portfolio — it skips
 * any asset name that already exists.
 *
 * Run: npm run seed:investments
 */
import { db } from '../server/src/db/client'
import { assets } from '../server/src/db/schema'
import { eq } from 'drizzle-orm'
import * as investments from '../server/src/services/investments'

const TODAY = new Date().toISOString().slice(0, 10)

type DetailedAsset = {
  name: string
  ticker: string
  assetClass: string
  quantity: number
  avgPriceCents: number
  currentPriceCents: number
}

const DETAILED: DetailedAsset[] = [
  { name: 'WEGE3', ticker: 'WEGE3', assetClass: 'stocks', quantity: 28, avgPriceCents: 3460, currentPriceCents: 4793 },
  { name: 'ITUB4', ticker: 'ITUB4', assetClass: 'stocks', quantity: 5, avgPriceCents: 3338, currentPriceCents: 3814 },
  { name: 'EGIE3', ticker: 'EGIE3', assetClass: 'stocks', quantity: 2, avgPriceCents: 3978, currentPriceCents: 2790 },
  { name: 'BRCR11', ticker: 'BRCR11', assetClass: 'fii', quantity: 2, avgPriceCents: 5610, currentPriceCents: 3907 },
]

type AggregateGroup = {
  name: string
  assetClass: string
  valueCents: number
  /** all-time return as a fraction, e.g. 0.4054 for 40.54% */
  returnRate: number
}

const AGGREGATES: AggregateGroup[] = [
  { name: 'Tesouro Direto (a detalhar)', assetClass: 'treasury', valueCents: 20401, returnRate: 0.4054 },
  { name: 'Criptomoedas (a detalhar)', assetClass: 'crypto', valueCents: 2661, returnRate: -0.1391 },
  { name: 'Renda fixa (a detalhar)', assetClass: 'fixed_income', valueCents: 34689, returnRate: 1.3409 },
]

const TARGET_ALLOCATION_BPS: Record<string, number> = {
  stocks: 3000,
  fii: 2000,
  treasury: 1500,
  crypto: 2000,
  fixed_income: 1000,
  etf_intl: 500,
}

async function assetExists(name: string): Promise<boolean> {
  return (await db.select({ id: assets.id }).from(assets).where(eq(assets.name, name)))[0] !== undefined
}

let created = 0
let skipped = 0

for (const item of DETAILED) {
  if (await assetExists(item.name)) {
    skipped++
    continue
  }
  const asset = await investments.createAsset({ name: item.name, ticker: item.ticker, assetClass: item.assetClass })
  await investments.createTrade({
    assetId: asset.id,
    kind: 'buy',
    tradedOn: TODAY,
    quantity: item.quantity,
    unitPriceCents: item.avgPriceCents,
  })
  await investments.recordValuation(asset.id, TODAY, item.currentPriceCents)
  created++
}

for (const group of AGGREGATES) {
  if (await assetExists(group.name)) {
    skipped++
    continue
  }
  const contributedCents = Math.round(group.valueCents / (1 + group.returnRate))
  const asset = await investments.createAsset({ name: group.name, ticker: null, assetClass: group.assetClass })
  await investments.createTrade({
    assetId: asset.id,
    kind: 'buy',
    tradedOn: TODAY,
    quantity: 1,
    unitPriceCents: contributedCents,
  })
  await investments.recordValuation(asset.id, TODAY, group.valueCents)
  created++
}

await investments.setTargetAllocation(
  null,
  Object.entries(TARGET_ALLOCATION_BPS).map(([assetClass, targetBps]) => ({ assetClass, targetBps })),
)

console.log(`${created} ativo(s) criado(s), ${skipped} já existiam. Alocação-alvo definida para ${Object.keys(TARGET_ALLOCATION_BPS).length} classes.`)
