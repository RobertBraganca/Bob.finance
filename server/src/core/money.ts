/**
 * Money is stored as signed integer cents everywhere. Nothing in this app
 * holds a monetary value as a float, so no rounding drift can accumulate.
 */

export type AmountFormat = {
  decimalSeparator: string
  thousandsSeparator: string
}

export class AmountParseError extends Error {}

const CURRENCY = /R\$|BRL|US\$|USD|€|EUR/gi
// JS \s already covers NBSP (U+00A0) and narrow NBSP (U+202F), which
// Brazilian bank exports use as the thousands spacer.
const SPACES = /\s/g

/**
 * Parses a Brazilian (or US) formatted amount into signed cents.
 * Handles: "1.234,56" · "-1.234,56" · "1.234,56-" · "(1.234,56)" ·
 * "R$ 1.234,56" · "1234.56" · "1234" · "1.234,56 D"
 */
export function parseAmountToCents(raw: string, fmt: AmountFormat): number {
  let s = String(raw ?? '')
    .replace(CURRENCY, '')
    .replace(SPACES, '')
    .trim()

  if (!s) throw new AmountParseError('valor vazio')

  let negative = false

  // Accounting parentheses
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true
    s = s.slice(1, -1)
  }

  // Trailing D/C flag some Brazilian exports append to the amount itself
  const flag = s.match(/([DC])$/i)
  if (flag) {
    if (flag[1]!.toUpperCase() === 'D') negative = true
    s = s.slice(0, -1)
  }

  // Trailing sign
  if (s.endsWith('-')) {
    negative = true
    s = s.slice(0, -1)
  } else if (s.endsWith('+')) {
    s = s.slice(0, -1)
  }

  // Leading sign
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }

  if (!s) throw new AmountParseError('valor vazio')

  const thousands = fmt.thousandsSeparator
  const decimal = fmt.decimalSeparator

  if (thousands) s = s.split(thousands).join('')
  if (decimal && decimal !== '.') s = s.split(decimal).join('.')

  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new AmountParseError(`valor invalido: ${raw}`)
  }

  const cents = Math.round(Number(s) * 100)
  if (!Number.isSafeInteger(cents)) throw new AmountParseError(`valor fora de faixa: ${raw}`)

  return negative ? -cents : cents
}

/** Formats signed cents as pt-BR currency. Server-side only for logs/exports. */
export function formatCents(cents: number, currency = 'BRL'): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(cents / 100)
}

export const centsOf = (value: number) => Math.round(value * 100)
export const bpsToRate = (bps: number) => bps / 10_000
