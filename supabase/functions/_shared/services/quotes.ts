import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { assets } from '../db/schema.ts'
import { recordValuation, updateAsset, type Position } from './investments.ts'
import { todayIso } from '../core/dates.ts'

/**
 * BRAPI (brapi.dev) quotes for B3-listed stocks and FIIs — the free
 * plan allows exactly ONE ticker per request (batching more throws
 * `QUOTES_PER_REQUEST_EXCEEDED`), so refreshing several assets means
 * several sequential requests. At a real-world portfolio's size that
 * is nowhere near the plan's 15k/month cap; this is never called
 * automatically (no polling) — only on an explicit button press.
 */
const BRAPI_BASE = 'https://brapi.dev/api/quote'
/** Only these classes trade on B3 the way BRAPI understands. */
const QUOTABLE_CLASSES = new Set(['stocks', 'fii'])

export type QuoteResult = {
  ticker: string
  priceCents: number
  regularMarketTime: string | null
  /** BRAPI's summaryProfile.sector (e.g. "Energia", "Bancos") — feeds the sector-balance step in suggestContribution. */
  sector: string | null
}

export class QuoteError extends Error {}

async function fetchOne(ticker: string): Promise<QuoteResult> {
  const token = Deno.env.get('BRAPI_TOKEN')
  if (!token) throw new QuoteError('BRAPI_TOKEN não configurado (.env)')

  const res = await fetch(`${BRAPI_BASE}/${encodeURIComponent(ticker)}?modules=summaryProfile&token=${token}`)
  const body = await res.json().catch(() => null)

  if (!res.ok || !body || body.error) {
    throw new QuoteError(body?.message ?? `BRAPI: falha ao consultar ${ticker} (HTTP ${res.status})`)
  }

  const quote = body.results?.[0]
  if (!quote || typeof quote.regularMarketPrice !== 'number') {
    throw new QuoteError(`BRAPI: ${ticker} não retornou cotação`)
  }

  return {
    ticker,
    priceCents: Math.round(quote.regularMarketPrice * 100),
    regularMarketTime: quote.regularMarketTime ?? null,
    sector: quote.summaryProfile?.sector ?? null,
  }
}

export type RefreshResult = {
  assetId: number
  name: string
  ticker: string
  status: 'updated' | 'error' | 'skipped'
  priceCents?: number
  error?: string
}

/** One asset, one BRAPI request — used by the per-asset "atualizar cotação" button. */
export async function refreshAssetQuote(assetId: number): Promise<RefreshResult> {
  const asset = (await db.select().from(assets).where(eq(assets.id, assetId)))[0]
  if (!asset) throw new QuoteError('ativo não encontrado')
  if (!asset.ticker) return { assetId, name: asset.name, ticker: '', status: 'skipped', error: 'sem ticker cadastrado' }
  if (!QUOTABLE_CLASSES.has(asset.assetClass)) {
    return { assetId, name: asset.name, ticker: asset.ticker, status: 'skipped', error: 'classe não cotada na B3' }
  }

  try {
    const quote = await fetchOne(asset.ticker)
    await recordValuation(assetId, todayIso(), quote.priceCents)
    if (quote.sector && quote.sector !== asset.sector) await updateAsset(assetId, { sector: quote.sector })
    return { assetId, name: asset.name, ticker: asset.ticker, status: 'updated', priceCents: quote.priceCents }
  } catch (error) {
    return {
      assetId,
      name: asset.name,
      ticker: asset.ticker,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Every quotable asset with a ticker, one request each, sequentially
 * (never in parallel — a burst of simultaneous requests is more likely
 * to be rate-limited than the same requests spread out). A failure on
 * one ticker never stops the rest.
 */
export async function refreshAllQuotes(positions: Position[]): Promise<{ results: RefreshResult[] }> {
  const candidates = positions.filter((p) => p.ticker && QUOTABLE_CLASSES.has(p.assetClass))
  const results: RefreshResult[] = []
  for (const p of candidates) {
    results.push(await refreshAssetQuote(p.assetId))
  }
  return { results }
}

/** Guards the caller from asking for assets outside this app's own ledger. */
export async function assertOwnedAssets(assetIds: number[]): Promise<void> {
  const rows = await db.select({ id: assets.id }).from(assets).where(inArray(assets.id, assetIds))
  if (rows.length !== assetIds.length) throw new QuoteError('ativo desconhecido')
}
