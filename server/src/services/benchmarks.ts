import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { benchmarkReturns } from '../db/schema'
import { periodOf } from '../core/dates'

/**
 * Benchmark monthly returns for the "Rentabilidade" comparison — CDI and
 * IPCA come from the Banco Central's SGS API (a public series with full
 * history, no key required); the B3 indices this app doesn't have a
 * direct feed for (IBOV, IFIX, SMLL, IDIV) are approximated by the ETF
 * that tracks each one, priced through BRAPI (already used for asset
 * quotes elsewhere). IVVB11 is itself a BRAPI ticker, no proxy needed.
 *
 * BRAPI's free plan only returns a rolling ~3-month daily window per
 * request — nowhere near back to when this portfolio started — so the
 * ETF-derived codes are never "backfilled": every refresh call upserts
 * whatever complete months fall inside that window, and history builds
 * up one refresh at a time. CDI/IPCA have no such limit and come back
 * complete on the first call.
 */

export type BenchmarkCode = 'CDI' | 'IPCA' | 'IBOV' | 'IFIX' | 'SMLL' | 'IDIV' | 'IVVB11'

const BCB_BENCHMARKS: Array<{ code: BenchmarkCode; sgsSeries: number }> = [
  { code: 'CDI', sgsSeries: 4390 }, // Taxa de juros - CDI acumulada no mês (%)
  { code: 'IPCA', sgsSeries: 433 }, // IPCA - variação mensal (%)
]

const ETF_BENCHMARKS: Array<{ code: BenchmarkCode; ticker: string }> = [
  { code: 'IBOV', ticker: 'BOVA11' },
  { code: 'IFIX', ticker: 'XFIX11' },
  { code: 'SMLL', ticker: 'SMAL11' },
  { code: 'IDIV', ticker: 'DIVO11' },
  { code: 'IVVB11', ticker: 'IVVB11' },
]

export const BENCHMARK_LABELS: Record<BenchmarkCode, string> = {
  CDI: 'CDI',
  IPCA: 'IPCA',
  IBOV: 'Ibovespa',
  IFIX: 'IFIX',
  SMLL: 'Small Caps',
  IDIV: 'Dividendos (IDIV)',
  IVVB11: 'IVVB11 (S&P 500)',
}

export class BenchmarkError extends Error {}

async function upsert(code: BenchmarkCode, period: string, returnBps: number, source: 'bcb' | 'brapi_etf') {
  const existing = (
    await db
      .select({ id: benchmarkReturns.id })
      .from(benchmarkReturns)
      .where(and(eq(benchmarkReturns.code, code), eq(benchmarkReturns.period, period)))
  )[0]
  if (existing) {
    await db.update(benchmarkReturns).set({ returnBps, source }).where(eq(benchmarkReturns.id, existing.id))
  } else {
    await db.insert(benchmarkReturns).values({ code, period, returnBps, source })
  }
}

/** "dd/MM/yyyy" (BCB's own date format) -> "yyyy-MM" */
function bcbDateToPeriod(raw: string): string {
  const [, month, year] = raw.split('/') as [string, string, string]
  return `${year}-${month}`
}

async function syncBcb(code: BenchmarkCode, sgsSeries: number): Promise<{ months: number }> {
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${sgsSeries}/dados?formato=json`
  const res = await fetch(url)
  if (!res.ok) throw new BenchmarkError(`BCB: falha ao consultar a série ${sgsSeries} (HTTP ${res.status})`)
  const rows = (await res.json()) as Array<{ data: string; valor: string }>
  for (const row of rows) {
    const returnBps = Math.round(Number(row.valor) * 100)
    if (!Number.isFinite(returnBps)) continue
    await upsert(code, bcbDateToPeriod(row.data), returnBps, 'bcb')
  }
  return { months: rows.length }
}

type BrapiHistoricalPoint = { date: number; close: number }

async function fetchEtfHistory(ticker: string): Promise<BrapiHistoricalPoint[]> {
  const token = process.env.BRAPI_TOKEN
  if (!token) throw new BenchmarkError('BRAPI_TOKEN não configurado (.env)')
  const url = `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}?range=3mo&interval=1d&token=${token}`
  const res = await fetch(url)
  const body = await res.json().catch(() => null)
  if (!res.ok || !body || body.error) {
    throw new BenchmarkError(body?.message ?? `BRAPI: falha ao consultar ${ticker} (HTTP ${res.status})`)
  }
  const hist = body.results?.[0]?.historicalDataPrice
  if (!Array.isArray(hist)) throw new BenchmarkError(`BRAPI: ${ticker} não retornou histórico`)
  return hist
    .filter((p: BrapiHistoricalPoint) => typeof p.close === 'number')
    .sort((a: BrapiHistoricalPoint, b: BrapiHistoricalPoint) => a.date - b.date)
}

/** Last close on or before each calendar month present in `history`, keyed by period. */
function monthEndCloses(history: BrapiHistoricalPoint[]): Map<string, number> {
  const byMonth = new Map<string, number>()
  for (const point of history) {
    const period = periodOf(new Date(point.date * 1000).toISOString().slice(0, 10))
    byMonth.set(period, point.close) // later (larger) date in the same month overwrites — history is sorted ascending
  }
  return byMonth
}

async function syncEtf(code: BenchmarkCode, ticker: string): Promise<{ months: number }> {
  const history = await fetchEtfHistory(ticker)
  const closes = monthEndCloses(history)
  const periods = [...closes.keys()].sort()
  let months = 0
  // A return needs the PRIOR month's close too, so the earliest period in
  // the window never gets one — it only anchors the following month.
  for (let i = 1; i < periods.length; i++) {
    const prevPeriod = periods[i - 1]!
    const period = periods[i]!
    const prevClose = closes.get(prevPeriod)!
    const close = closes.get(period)!
    const returnBps = Math.round((close / prevClose - 1) * 10_000)
    await upsert(code, period, returnBps, 'brapi_etf')
    months++
  }
  return { months }
}

export type RefreshOutcome = { code: BenchmarkCode; status: 'updated' | 'error'; months?: number; error?: string }

export async function refreshBenchmarks(): Promise<{ results: RefreshOutcome[] }> {
  const results: RefreshOutcome[] = []
  for (const b of BCB_BENCHMARKS) {
    try {
      const { months } = await syncBcb(b.code, b.sgsSeries)
      results.push({ code: b.code, status: 'updated', months })
    } catch (error) {
      results.push({ code: b.code, status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const b of ETF_BENCHMARKS) {
    try {
      const { months } = await syncEtf(b.code, b.ticker)
      results.push({ code: b.code, status: 'updated', months })
    } catch (error) {
      results.push({ code: b.code, status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { results }
}

export type BenchmarkSeriesPoint = { period: string; returnBps: number }

export async function listBenchmarkSeries(codes: BenchmarkCode[]): Promise<Record<string, BenchmarkSeriesPoint[]>> {
  const rows = await db
    .select({ code: benchmarkReturns.code, period: benchmarkReturns.period, returnBps: benchmarkReturns.returnBps })
    .from(benchmarkReturns)
    .where(inArray(benchmarkReturns.code, codes))
    .orderBy(asc(benchmarkReturns.period))
  const out: Record<string, BenchmarkSeriesPoint[]> = {}
  for (const code of codes) out[code] = []
  for (const row of rows) out[row.code]?.push({ period: row.period, returnBps: row.returnBps })
  return out
}

export const ALL_BENCHMARK_CODES: BenchmarkCode[] = [...BCB_BENCHMARKS, ...ETF_BENCHMARKS].map((b) => b.code)
