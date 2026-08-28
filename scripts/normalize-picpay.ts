/**
 * PicPay pre-normalizer.
 *
 * PicPay does not export a table. It exports a paginated, fixed-width,
 * PDF-shaped report where every transaction spans three lines:
 *
 *     "07/04/2026"
 *     "Pix Enviado                        - R$ 44,02        -        -"
 *     "17:46:10"
 *
 * ...interleaved with 188 repetitions of the page header and footer.
 *
 * That shape cannot be described by a parser profile, and it must not become
 * a PicPay-specific branch inside the import pipeline. So it is normalized
 * here, once, into an ordinary semicolon CSV that the generic pipeline reads
 * through the "PicPay Relatório normalizado" profile.
 *
 * The time of day is carried into the description on purpose: 30 of the 1501
 * records share date + description + amount with another record, so without
 * the timestamp the dedupe fingerprint would collapse genuinely distinct
 * transactions. `merchantSignature` strips digit groups, so the timestamp
 * does not fragment learning.
 *
 * Run: npx tsx scripts/normalize-picpay.ts <entrada.csv> <saida.csv>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** U+200B, built from a char code so this file stays pure ASCII. */
const ZERO_WIDTH = new RegExp(String.fromCharCode(0x200b), 'g')

const DATE_ONLY = /^\d{2}\/\d{2}\/\d{4}$/
const TIME_ONLY = /^\d{2}:\d{2}:\d{2}$/
/** description, optional minus, then the BRL amount */
const VALUE_LINE = /^(.*?)\s{2,}(-\s*)?R\$\s*([\d.]+,\d{2})/

export type PicPayRecord = {
  date: string
  time: string
  description: string
  movement: string
  amount: string
}

export function normalizePicPay(raw: string): { records: PicPayRecord[]; skipped: number } {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    // Strip the wrapping quotes the export adds to every line, plus the
    // zero-width spaces it sprinkles into headings.
    .map((line) => line.replace(/^"|"$/g, '').replace(ZERO_WIDTH, '').trimEnd())

  const records: PicPayRecord[] = []
  let skipped = 0

  const nextContent = (from: number) => {
    let i = from
    while (i < lines.length && lines[i]!.trim() === '') i++
    return i
  }

  for (let i = 0; i < lines.length; i++) {
    if (!DATE_ONLY.test(lines[i]!.trim())) continue

    const valueIndex = nextContent(i + 1)
    const timeIndex = nextContent(valueIndex + 1)
    const valueLine = lines[valueIndex] ?? ''
    const timeLine = (lines[timeIndex] ?? '').trim()

    const match = valueLine.match(VALUE_LINE)
    if (!match || !TIME_ONLY.test(timeLine)) {
      skipped++
      continue
    }

    const movement = match[1]!.trim()
    const negative = Boolean(match[2])
    const amount = match[3]!

    records.push({
      date: lines[i]!.trim(),
      time: timeLine,
      movement,
      description: `${movement} ${timeLine}`,
      amount: `${negative ? '-' : ''}${amount}`,
    })
  }

  return { records, skipped }
}

export function toCsv(records: PicPayRecord[]): string {
  const escape = (value: string) => (value.includes(';') ? `"${value}"` : value)
  const rows = records.map((r) =>
    [r.date, escape(r.description), r.amount, escape(r.movement)].join(';'),
  )
  return ['Data;Descrição;Valor;Movimentacao', ...rows].join('\n') + '\n'
}

const isEntry = (process.argv[1] ?? '').split(/[/\\]/).pop() === 'normalize-picpay.ts'
if (isEntry) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) {
    console.error('uso: npx tsx scripts/normalize-picpay.ts <entrada.csv> <saida.csv>')
    process.exit(1)
  }

  const { records, skipped } = normalizePicPay(readFileSync(resolve(input), 'utf8'))
  mkdirSync(dirname(resolve(output)), { recursive: true })
  writeFileSync(resolve(output), toCsv(records), 'utf8')

  const dates = records.map((r) => r.date.split('/').reverse().join('-'))
  const negatives = records.filter((r) => r.amount.startsWith('-')).length

  console.log(`[picpay] ${records.length} registros -> ${output}`)
  console.log(`[picpay] ${negatives} saídas, ${records.length - negatives} entradas, ${skipped} ignorados`)
  if (dates.length > 0) {
    console.log(
      `[picpay] período ${dates.reduce((a, b) => (a < b ? a : b))} .. ${dates.reduce((a, b) => (a > b ? a : b))}`,
    )
  }
}
