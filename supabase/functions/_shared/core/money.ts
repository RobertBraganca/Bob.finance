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

/**
 * Mediana de uma lista de valores em centavos, para as bases de cálculo
 * derivadas de uma janela curta de meses.
 *
 * Existe porque a média aritmética de 3 a 6 meses é refém de um único
 * valor atípico: um IPVA, um equipamento, um mês com dois projetos
 * faturados. Uma janela de 6 meses desloca a base em 1/6 do valor
 * excepcional, e essas bases alimentam reserva de emergência, Runway,
 * liquidez e comprometimento de renda ao mesmo tempo. A mediana ignora o
 * outlier por construção, sem precisar decidir o que é atípico.
 *
 * Com número par de elementos devolve a média dos dois centrais,
 * arredondada ao centavo. Lista vazia devolve 0, que os chamadores
 * tratam como "sem dado" antes de dividir por ela.
 */
export function medianCents(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/**
 * Taxa mensal equivalente a uma taxa EFETIVA anual, em regime composto:
 * `(1 + ia)^(1/12) - 1`. É a taxa equivalente da matemática financeira,
 * nunca a proporcional (`ia/12`), que só vale em juros simples.
 *
 * Vive aqui, e não em `services/debt`, porque a conversão inversa
 * (`effectiveAnnualRateBps`) é usada pela camada de entrada de dados e as
 * duas precisam ser exatamente inversas uma da outra.
 */
export const monthlyRateOf = (annualBps: number) => Math.pow(1 + annualBps / 10_000, 1 / 12) - 1

/**
 * Taxa EFETIVA anual equivalente a uma taxa mensal informada em bps:
 * `(1 + im)^12 - 1`. Usada quando o usuário informa a taxa ao mês, que é
 * como cartão rotativo e cheque especial são publicados no Brasil, para
 * gravar sempre a mesma unidade no banco.
 */
export const effectiveAnnualRateBps = (monthlyBps: number) =>
  Math.round((Math.pow(1 + monthlyBps / 10_000, 12) - 1) * 10_000)
