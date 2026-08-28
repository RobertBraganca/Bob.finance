import Papa from 'papaparse'
import { parseDateToIso } from '../core/dates'
import { parseAmountToCents } from '../core/money'
import { dedupeHash, directionOf, merchantSignature, normalizeDescription } from '../core/normalize'
import { headerKey, PAPA_DELIMITERS, type ColumnMap, type ProfileConfig } from './profile'

export type ParsedRow = {
  rowIndex: number
  postedOn: string | null
  description: string
  descriptionNorm: string
  signature: string
  amountCents: number | null
  direction: 'in' | 'out' | null
  rawCategory: string | null
  dedupeHash: string | null
  parseError: string | null
  rawLine: string
}

export type ParseResult = {
  rows: ParsedRow[]
  rowCount: number
  parsedCount: number
  errorCount: number
  ignoredCount: number
  detectedDelimiter: string
  headers: string[]
}

/**
 * Turns raw CSV text into normalized rows using nothing but the profile.
 * Rows that fail carry a `parseError` and survive into staging so the user
 * can see exactly which lines their bank exported oddly — the pipeline
 * never silently drops data.
 */
export function parseCsvWithProfile(
  text: string,
  profile: ProfileConfig,
  ctx: { accountId: number },
): ParseResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const body = lines.slice(profile.skipRows).join('\n')

  const parsed = Papa.parse<string[]>(body, {
    delimiter: PAPA_DELIMITERS[profile.delimiter] ?? '',
    header: false,
    skipEmptyLines: 'greedy',
  })

  const table = parsed.data.filter((r) => Array.isArray(r) && r.some((c) => String(c).trim() !== ''))
  const detectedDelimiter = parsed.meta.delimiter ?? ''

  let headers: string[] = []
  let dataRows = table
  if (profile.hasHeader && table.length > 0) {
    headers = (table[0] ?? []).map((h) => String(h).trim())
    dataRows = table.slice(1)
  }

  const resolve = buildResolver(headers, profile.columnMap)
  const ignore = profile.ignorePatterns
    .filter((p) => p.trim() !== '')
    .map((p) => normalizeDescription(p))

  const rows: ParsedRow[] = []
  let errorCount = 0
  let ignoredCount = 0

  dataRows.forEach((cells, i) => {
    const rowIndex = i + 1
    const rawLine = cells.join(profile.delimiter === 'tab' ? '\t' : profile.delimiter)
    const description = String(resolve(cells, 'description') ?? '').trim()
    const descriptionNorm = normalizeDescription(description)

    // Balance/total/summary lines banks append are dropped, not errored.
    if (ignore.length > 0 && ignore.some((p) => descriptionNorm.includes(p))) {
      ignoredCount++
      return
    }

    const base = {
      rowIndex,
      description,
      descriptionNorm,
      signature: merchantSignature(description),
      rawCategory: nullableString(resolve(cells, 'rawCategory')),
      rawLine,
    }

    let postedOn: string
    try {
      postedOn = parseDateToIso(String(resolve(cells, 'date') ?? ''), profile.dateFormat)
    } catch (err) {
      errorCount++
      rows.push({
        ...base,
        postedOn: null,
        amountCents: null,
        direction: null,
        dedupeHash: null,
        parseError: message(err),
      })
      return
    }

    let amountCents: number
    try {
      amountCents = resolveAmount(cells, resolve, profile)
    } catch (err) {
      errorCount++
      rows.push({
        ...base,
        postedOn,
        amountCents: null,
        direction: null,
        dedupeHash: null,
        parseError: message(err),
      })
      return
    }

    if (!description) {
      errorCount++
      rows.push({
        ...base,
        postedOn,
        amountCents,
        direction: directionOf(amountCents),
        dedupeHash: null,
        parseError: 'descrição vazia',
      })
      return
    }

    rows.push({
      ...base,
      postedOn,
      amountCents,
      direction: directionOf(amountCents),
      dedupeHash: dedupeHash({
        accountId: ctx.accountId,
        postedOn,
        amountCents,
        descriptionNorm,
      }),
      parseError: null,
    })
  })

  return {
    rows,
    rowCount: dataRows.length,
    parsedCount: rows.filter((r) => r.parseError === null).length,
    errorCount,
    ignoredCount,
    detectedDelimiter,
    headers,
  }
}

type Resolver = (cells: string[], field: keyof ColumnMap) => string | undefined

function buildResolver(headers: string[], map: ColumnMap): Resolver {
  const byKey = new Map<string, number>()
  headers.forEach((h, i) => {
    const key = headerKey(h)
    if (key && !byKey.has(key)) byKey.set(key, i)
  })

  const indexFor = (ref: string | number | undefined): number | undefined => {
    if (ref === undefined) return undefined
    if (typeof ref === 'number') return ref
    const exact = byKey.get(headerKey(ref))
    if (exact !== undefined) return exact
    // Fall back to a prefix match: "Data Lançamento" vs "Data Lancamento Ajustada"
    const wanted = headerKey(ref)
    for (const [key, i] of byKey) if (key.startsWith(wanted) || wanted.startsWith(key)) return i
    return undefined
  }

  const cache = new Map<string, number | undefined>()
  return (cells, field) => {
    if (!cache.has(field)) cache.set(field, indexFor(map[field]))
    const i = cache.get(field)
    if (i === undefined) return undefined
    return cells[i]
  }
}

function resolveAmount(cells: string[], resolve: Resolver, profile: ProfileConfig): number {
  const fmt = {
    decimalSeparator: profile.decimalSeparator,
    thousandsSeparator: profile.thousandsSeparator,
  }

  switch (profile.signConvention) {
    case 'signed':
      return parseAmountToCents(required(resolve(cells, 'amount'), 'valor'), fmt)

    case 'signed_inverted':
      return -parseAmountToCents(required(resolve(cells, 'amount'), 'valor'), fmt)

    case 'debit_credit': {
      const debit = nullableString(resolve(cells, 'debit'))
      const credit = nullableString(resolve(cells, 'credit'))
      const debitCents = debit ? Math.abs(parseAmountToCents(debit, fmt)) : 0
      const creditCents = credit ? Math.abs(parseAmountToCents(credit, fmt)) : 0
      if (debitCents === 0 && creditCents === 0) throw new Error('débito e crédito vazios')
      if (debitCents > 0 && creditCents > 0) throw new Error('débito e crédito preenchidos na mesma linha')
      return debitCents > 0 ? -debitCents : creditCents
    }

    case 'type_flag': {
      const cents = Math.abs(parseAmountToCents(required(resolve(cells, 'amount'), 'valor'), fmt))
      const flag = normalizeDescription(String(resolve(cells, 'typeFlag') ?? ''))
      if (!flag) throw new Error('tipo (D/C) vazio')
      const isOut = /^(d|deb|debito|saida|pagamento|despesa)/.test(flag)
      const isIn = /^(c|cred|credito|entrada|recebimento|receita)/.test(flag)
      if (!isOut && !isIn) throw new Error(`tipo desconhecido: ${flag}`)
      return isOut ? -cents : cents
    }
  }
}

const required = (value: string | undefined, label: string): string => {
  const s = String(value ?? '').trim()
  if (!s) throw new Error(`coluna ${label} ausente ou vazia`)
  return s
}

const nullableString = (value: string | undefined): string | null => {
  const s = String(value ?? '').trim()
  return s === '' ? null : s
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
