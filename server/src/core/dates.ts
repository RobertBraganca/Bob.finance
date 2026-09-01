/**
 * Dates are stored as ISO `YYYY-MM-DD` text. SQLite sorts that
 * lexicographically, which is also chronological, so range filters and
 * `strftime` grouping work without a date type.
 */

export class DateParseError extends Error {}

const PATTERNS: Array<{ format: string; re: RegExp; order: ['d' | 'm' | 'y', 'd' | 'm' | 'y', 'd' | 'm' | 'y'] }> = [
  { format: 'dd/MM/yyyy', re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ['d', 'm', 'y'] },
  { format: 'dd/MM/yy', re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, order: ['d', 'm', 'y'] },
  { format: 'dd-MM-yyyy', re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: ['d', 'm', 'y'] },
  { format: 'dd.MM.yyyy', re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, order: ['d', 'm', 'y'] },
  { format: 'yyyy-MM-dd', re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: ['y', 'm', 'd'] },
  { format: 'yyyy/MM/dd', re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, order: ['y', 'm', 'd'] },
  { format: 'MM/dd/yyyy', re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ['m', 'd', 'y'] },
]

/**
 * Parses a raw CSV date cell into ISO. `format` selects the dialect; pass
 * "auto" to try every known pattern in order (unambiguous formats first).
 */
export function parseDateToIso(raw: string, format: string): string {
  const s = String(raw ?? '').trim()
  if (!s) throw new DateParseError('data vazia')

  // Some exports carry a timestamp — the date part is all we keep.
  const head = s.split(/[T ]/)[0]!

  const candidates =
    format === 'auto'
      ? PATTERNS.filter((p) => p.format !== 'MM/dd/yyyy')
      : PATTERNS.filter((p) => p.format === format)

  if (candidates.length === 0) throw new DateParseError(`formato desconhecido: ${format}`)

  for (const pattern of candidates) {
    const m = head.match(pattern.re)
    if (!m) continue

    const parts: Record<string, number> = {}
    pattern.order.forEach((key, i) => {
      parts[key] = Number(m[i + 1])
    })

    let year = parts.y!
    if (year < 100) year += year >= 70 ? 1900 : 2000

    const month = parts.m!
    const day = parts.d!

    if (month < 1 || month > 12) throw new DateParseError(`mes invalido em ${raw}`)
    if (day < 1 || day > daysInMonth(year, month)) throw new DateParseError(`dia invalido em ${raw}`)

    return `${pad4(year)}-${pad2(month)}-${pad2(day)}`
  }

  throw new DateParseError(`data invalida: ${raw}`)
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const pad4 = (n: number) => String(n).padStart(4, '0')

/** "2026-06-14" -> "2026-06" */
export const periodOf = (iso: string) => iso.slice(0, 7)

export function todayIso(): string {
  const d = new Date()
  return `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Inclusive first/last ISO day of a `YYYY-MM` period. */
export function periodBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split('-').map(Number) as [number, number]
  return { start: `${period}-01`, end: `${period}-${pad2(daysInMonth(y, m))}` }
}

/** Adds `n` months to a `YYYY-MM` period. */
export function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + n
  return `${pad4(Math.floor(total / 12))}-${pad2((total % 12) + 1)}`
}

/** How many months `to` is after `from` (`YYYY-MM` each); negative if `to` is earlier. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number]
  const [ty, tm] = to.split('-').map(Number) as [number, number]
  return (ty * 12 + (tm - 1)) - (fy * 12 + (fm - 1))
}

/** Every `YYYY-MM` from `from` to `to`, inclusive. */
export function periodRange(from: string, to: string): string[] {
  const out: string[] = []
  let cursor = from
  for (let guard = 0; guard < 1200 && cursor <= to; guard++) {
    out.push(cursor)
    cursor = addMonths(cursor, 1)
  }
  return out
}

/** Every ISO day from `from` to `to`, inclusive. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  let t = Date.parse(`${from}T00:00:00Z`)
  for (let guard = 0; guard < 4000 && t <= end; guard++) {
    out.push(new Date(t).toISOString().slice(0, 10))
    t += 86_400_000
  }
  return out
}

/** `iso` shifted by `days` (negative goes back). */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * `iso` (uma DATA, não um período) deslocada por `n` meses, com o dia
 * preso ao fim do mês quando ele não existe no destino: 31/01 + 1 mês é
 * 28/02, não 03/03. `addMonths` acima faz o mesmo para `YYYY-MM`, onde a
 * questão do dia nem existe — são funções irmãs, não duplicadas.
 */
export function addMonthsToDate(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const total = y * 12 + (m - 1) + n
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  return `${pad4(year)}-${pad2(month)}-${pad2(Math.min(d, daysInMonth(year, month)))}`
}
