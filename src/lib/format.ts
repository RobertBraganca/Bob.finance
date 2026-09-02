/** All display formatting for pt-BR. Values arrive as integer cents. */

const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
})

const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 })

export const money = (cents: number) => brl.format(cents / 100)
/**
 * Compact money for axis ticks and tight stat tiles: R$ 12,5 mil / R$ 1,2 mi.
 * Full precision always remains available in the table view and tooltips.
 */
export function moneyCompact(cents: number): string {
  const value = Math.abs(cents) / 100
  const sign = cents < 0 ? '-' : ''
  if (value >= 1_000_000) return `${sign}R$ ${decimal.format(value / 1_000_000)} mi`
  if (value >= 1_000) return `${sign}R$ ${decimal.format(Math.round(value / 100) / 10)} mil`
  return `${sign}R$ ${decimal.format(value)}`
}

/** Axis ticks: no currency symbol, so the axis stays quiet. */
export function axisMoney(cents: number): string {
  const value = Math.abs(cents) / 100
  const sign = cents < 0 ? '-' : ''
  if (value >= 1_000_000) return `${sign}${decimal.format(value / 1_000_000)}mi`
  if (value >= 1_000) return `${sign}${Math.round(value / 1_000)}k`
  return `${sign}${Math.round(value)}`
}

export const bps = (value: number, digits = 1) =>
  `${(value / 100).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`

export const signedBps = (value: number, digits = 1) =>
  `${value > 0 ? '+' : ''}${bps(value, digits)}`

/**
 * Basis points read as percentage POINTS, not as a share: 1000 -> "10,0 p.p.".
 * The distinction matters wherever a number is the DIFFERENCE between two
 * percentages (allocation drift, for one). Printing that with a % sign
 * claims something else entirely.
 */
export const points = (value: number, digits = 1) =>
  `${(value / 100).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} p.p.`

export const signedPoints = (value: number, digits = 1) =>
  `${value > 0 ? '+' : ''}${points(value, digits)}`

export const quantity = (value: number) =>
  value.toLocaleString('pt-BR', { maximumFractionDigits: 8 })

/* ---- Dates -------------------------------------------------------- */
export const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const MONTHS_LONG = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]
/** "2026-06-14" -> "14/06/2026" */
export function date(iso: string | null): string {
  if (!iso) return '-'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

/** "2026-06-14" -> "14 jun" */
export function dateShort(iso: string | null): string {
  if (!iso) return '-'
  const [, m, d] = iso.split('-') as [string, string, string]
  return `${d} ${MONTHS_SHORT[Number(m) - 1]}`
}

/** "2026-06" -> "jun/26" */
export function period(value: string): string {
  const [y, m] = value.split('-') as [string, string]
  return `${MONTHS_SHORT[Number(m) - 1]}/${y.slice(2)}`
}

/** "2026-06" -> "junho de 2026" */
export function periodLong(value: string): string {
  const [y, m] = value.split('-') as [string, string]
  return `${MONTHS_LONG[Number(m) - 1]} de ${y}`
}

export function monthsLabel(months: number | null): string {
  if (months === null) return 'nunca'
  if (months === 0) return 'quitado'
  if (months < 12) return `${months} ${months === 1 ? 'mês' : 'meses'}`
  const years = Math.floor(months / 12)
  const rest = months % 12
  const yearPart = `${years} ${years === 1 ? 'ano' : 'anos'}`
  return rest === 0 ? yearPart : `${yearPart} e ${rest} ${rest === 1 ? 'mês' : 'meses'}`
}

/* ---- Parsing user input ------------------------------------------- */
/**
 * Accepts what a Brazilian actually types: "1.234,56", "1234,56", "1234.56",
 * "R$ 89,90". Returns integer cents, or null when it is not a number.
 */
export function parseMoneyInput(raw: string): number | null {
  const cleaned = String(raw ?? '')
    .replace(/[R$\s ]/gi, '')
    .trim()
  if (!cleaned) return null

  const negative = cleaned.startsWith('-')
  let body = negative ? cleaned.slice(1) : cleaned

  const lastComma = body.lastIndexOf(',')
  const lastDot = body.lastIndexOf('.')

  if (lastComma > lastDot) {
    body = body.split('.').join('').replace(',', '.')
  } else if (lastDot > lastComma) {
    body = body.split(',').join('')
  } else {
    body = body.split('.').join('').split(',').join('')
  }

  if (!/^\d*\.?\d*$/.test(body) || body === '' || body === '.') return null
  const cents = Math.round(Number(body) * 100)
  if (!Number.isFinite(cents)) return null
  return negative ? -cents : cents
}

/** Percentage typed as "12,5" -> 1250 basis points. */
export function parsePercentInput(raw: string): number | null {
  const cleaned = String(raw ?? '').replace('%', '').replace(',', '.').trim()
  if (!cleaned) return null
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return null
  return Math.round(value * 100)
}

export const centsToInput = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ',')

export const bpsToInput = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : (value / 100).toFixed(2).replace('.', ',')
