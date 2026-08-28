/**
 * Generates synthetic-but-representative Brazilian bank statement fixtures,
 * one per parser profile, so the whole import pipeline can be exercised
 * end to end without anyone's real financial data.
 *
 * Deterministic on purpose: a fixed LCG seed means the fixtures (and every
 * verification assertion that counts rows or sums amounts) are reproducible.
 * Run: npx tsx scripts/make-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const OUT_DIR = resolve('fixtures')
mkdirSync(OUT_DIR, { recursive: true })

/* ------------------------------------------------------------------ *
 * Deterministic pseudo-randomness (no Math.random anywhere)
 * ------------------------------------------------------------------ */
let seed = 20260819
const next = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const between = (min: number, max: number) => min + next() * (max - min)
const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */
const pad2 = (n: number) => String(n).padStart(2, '0')

function formatAmount(cents: number, decimal: string, thousands: string): string {
  const abs = Math.abs(cents)
  const intPart = String(Math.floor(abs / 100))
  const frac = pad2(abs % 100)
  const grouped = thousands
    ? intPart.replace(/(\d)(?=(\d{3})+$)/g, `$1${thousands}`)
    : intPart
  return `${grouped}${decimal}${frac}`
}

const signed = (cents: number, decimal: string, thousands: string) =>
  `${cents < 0 ? '-' : ''}${formatAmount(cents, decimal, thousands)}`

const isoDate = (year: number, month: number, day: number) =>
  `${year}-${pad2(month)}-${pad2(day)}`
const brDate = (year: number, month: number, day: number) =>
  `${pad2(day)}/${pad2(month)}/${year}`

/* ------------------------------------------------------------------ *
 * The ledger entries each bank will emit
 * ------------------------------------------------------------------ */
type Entry = {
  year: number
  month: number
  day: number
  description: string
  cents: number
  rawCategory?: string
}

type Recurring = { day: number; description: string; cents: number; rawCategory?: string }
type Variable = {
  description: string | readonly string[]
  min: number
  max: number
  perMonth: number
  rawCategory?: string
}

const MONTHS: Array<[number, number]> = [
  [2026, 6],
  [2026, 7],
  [2026, 8],
]

function build(recurring: Recurring[], variable: Variable[], maxDay = 28): Entry[] {
  const entries: Entry[] = []
  for (const [year, month] of MONTHS) {
    for (const r of recurring) {
      entries.push({ year, month, day: r.day, description: r.description, cents: r.cents, ...(r.rawCategory ? { rawCategory: r.rawCategory } : {}) })
    }
    for (const v of variable) {
      for (let i = 0; i < v.perMonth; i++) {
        const description = typeof v.description === 'string' ? v.description : pick(v.description)
        const magnitude = Math.round(between(v.min, v.max))
        entries.push({
          year,
          month,
          day: Math.max(1, Math.min(maxDay, Math.round(between(1, maxDay)))),
          description,
          cents: v.min < 0 ? -magnitude * -1 : magnitude,
          ...(v.rawCategory ? { rawCategory: v.rawCategory } : {}),
        })
      }
    }
  }
  return entries.sort((a, b) => a.month - b.month || a.day - b.day)
}

/** Negative helper: variable specs give magnitudes, this signs them as expenses. */
const out = (spec: Omit<Variable, 'min' | 'max'> & { min: number; max: number }): Variable => spec

/* ------------------------------------------------------------------ *
 * 1. Itau — conta corrente PF. signed, ';', comma decimal, latin1,
 *    plus the SALDO lines the real export appends.
 * ------------------------------------------------------------------ */
function itau(): string {
  const entries = build(
    [
      { day: 5, description: 'SALARIO EMPRESA BEEKOFF LTDA', cents: 1_250_000 },
      { day: 10, description: 'ALUGUEL APTO 142 IMOBILIARIA VECTRA', cents: -320_000 },
      { day: 10, description: 'CONDOMINIO EDIF AURORA', cents: -78_500 },
      { day: 12, description: 'ENEL SP FATURA ENERGIA', cents: -21_450 },
      { day: 12, description: 'SABESP CONTA DE AGUA', cents: -9_820 },
      { day: 14, description: 'COMGAS FATURA GAS', cents: -6_340 },
      { day: 15, description: 'VIVO FIBRA INTERNET 600MB', cents: -14_990 },
      { day: 18, description: 'UNIMED PLANO DE SAUDE TITULAR', cents: -68_900 },
      { day: 20, description: 'TARIFA PACOTE DE SERVICOS', cents: -3_490 },
      { day: 25, description: 'TRANSFERENCIA ENTRE CONTAS PROPRIAS NUBANK', cents: -200_000 },
    ],
    [
      out({ description: ['PIX ENVIADO JOAO M SILVA', 'PIX ENVIADO MARIA C LIMA'], min: 5_000, max: 45_000, perMonth: 2 }),
      out({ description: 'SUPERMERCADO PAO DE ACUCAR', min: 12_000, max: 38_000, perMonth: 2 }),
      out({ description: 'IPTU PREFEITURA SP PARCELA', min: 18_000, max: 18_000, perMonth: 1 }),
    ],
  ).map((e) => ({ ...e, cents: e.description.startsWith('SALARIO') ? e.cents : e.cents > 0 ? -e.cents : e.cents }))

  // An exact in-file repeat: the same purchase exported twice, which is the
  // single most common real-world duplicate. Dedupe must flag it in-batch.
  const dupSource = entries.find((e) => e.description === 'SUPERMERCADO PAO DE ACUCAR')!
  entries.push({ ...dupSource })
  entries.sort((a, b) => a.month - b.month || a.day - b.day)

  const lines = ['data;lancamento;valor;saldo']
  let balance = 480_000
  let currentMonth = -1
  for (const e of entries) {
    if (e.month !== currentMonth) {
      currentMonth = e.month
      lines.push(`${brDate(e.year, e.month, 1)};SALDO ANTERIOR;0,00;${formatAmount(balance, ',', '.')}`)
    }
    balance += e.cents
    lines.push(
      `${brDate(e.year, e.month, e.day)};${e.description};${signed(e.cents, ',', '.')};${formatAmount(balance, ',', '.')}`,
    )
  }
  lines.push(`31/08/2026;SALDO DO DIA;0,00;${formatAmount(balance, ',', '.')}`)
  return lines.join('\r\n') + '\r\n'
}

/* ------------------------------------------------------------------ *
 * 2. Nubank — conta. signed, ',', dot decimal, utf-8, Identificador col.
 * ------------------------------------------------------------------ */
function nubankConta(): string {
  const entries = build(
    [
      { day: 26, description: 'Transferência recebida - Conta Corrente Itaú', cents: 200_000 },
      { day: 8, description: 'Pagamento de fatura', cents: -285_000 },
    ],
    [
      out({ description: ['iFood', 'iFood *Restaurante Sabor'], min: 3_200, max: 9_800, perMonth: 4 }),
      out({ description: ['Uber Trip', 'Uber* Trip'], min: 1_400, max: 5_600, perMonth: 4 }),
      out({ description: 'Posto Ipiranga Rede Sol', min: 15_000, max: 28_000, perMonth: 2 }),
      out({ description: 'Drogasil Filial 0821', min: 2_100, max: 8_900, perMonth: 2 }),
      out({ description: ['Padaria Bella Vista', 'Starbucks Paulista'], min: 1_800, max: 4_500, perMonth: 3 }),
      out({ description: 'Carrefour Bairro', min: 6_500, max: 19_000, perMonth: 2 }),
    ],
  ).map((e) => ({
    ...e,
    cents: e.description.startsWith('Transferência recebida') ? e.cents : e.cents > 0 ? -e.cents : e.cents,
  }))

  const lines = ['Data,Valor,Identificador,Descrição']
  entries.forEach((e, i) => {
    const id = `6812${pad2(e.month)}${pad2(e.day)}-e5b2-4a${pad2(i % 100)}-9f31-0c2d${pad2(i % 100)}a7b4e${i % 10}`
    lines.push(`${brDate(e.year, e.month, e.day)},${signed(e.cents, '.', '')},${id},"${e.description}"`)
  })
  return lines.join('\n') + '\n'
}

/* ------------------------------------------------------------------ *
 * 3. Nubank — cartao de credito. signed_inverted, ISO dates: a positive
 *    number is a purchase, so the pipeline has to flip the sign.
 * ------------------------------------------------------------------ */
function nubankCartao(): string {
  const entries = build(
    [
      { day: 3, description: 'Netflix.com', cents: 5_590 },
      { day: 7, description: 'Spotify', cents: 3_490 },
      { day: 11, description: 'Figma Inc', cents: 7_800 },
      { day: 14, description: 'Adobe Creative Cloud', cents: 12_900 },
      { day: 16, description: 'Notion Labs', cents: 4_800 },
      { day: 19, description: 'Anthropic PBC', cents: 11_000 },
      { day: 22, description: 'Smart Fit Academia', cents: 9_990 },
      { day: 8, description: 'Pagamento recebido', cents: 285_000 },
    ],
    [
      out({ description: ['iFood *Pedido', 'Rappi Brasil'], min: 2_800, max: 8_400, perMonth: 3 }),
      out({ description: ['Restaurante Terraco', 'Outback Steakhouse'], min: 9_000, max: 24_000, perMonth: 2 }),
      out({ description: 'Amazon Prime BR', min: 1_490, max: 1_490, perMonth: 1 }),
      out({ description: 'Estapar Estacionamento', min: 1_500, max: 4_200, perMonth: 2 }),
    ],
  )

  const lines = ['date,title,amount']
  for (const e of entries) {
    lines.push(`${isoDate(e.year, e.month, e.day)},"${e.description}",${formatAmount(e.cents, '.', '')}`)
  }
  return lines.join('\n') + '\n'
}

/* ------------------------------------------------------------------ *
 * 4. Bradesco — extrato PJ. debit_credit: two columns, never both.
 * ------------------------------------------------------------------ */
function bradesco(): string {
  const entries = build(
    [
      { day: 20, description: 'DAS SIMPLES NACIONAL COMP 06/2026', cents: -142_800 },
      { day: 20, description: 'DARF IRPJ TRIMESTRAL', cents: -68_400 },
      { day: 15, description: 'PAGTO SERVICOS TERCEIRIZADOS DEV FREELA', cents: -350_000 },
      { day: 5, description: 'TARIFA MANUTENCAO CONTA PJ', cents: -8_900 },
    ],
    [
      { description: ['RECEBIMENTO CLIENTE ACME COMERCIO LTDA', 'RECEBIMENTO CLIENTE VERTEX DIGITAL'], min: 380_000, max: 920_000, perMonth: 2 },
      out({ description: 'META PLATFORMS ADS MARKETING', min: 45_000, max: 130_000, perMonth: 2 }),
      out({ description: 'GOOGLE CLOUD BRASIL', min: 8_000, max: 32_000, perMonth: 1 }),
      out({ description: 'ESCRITORIO COWORKING BEEHIVE', min: 90_000, max: 90_000, perMonth: 1 }),
    ],
  ).map((e) => ({
    ...e,
    cents: e.description.startsWith('RECEBIMENTO') ? Math.abs(e.cents) : -Math.abs(e.cents),
  }))

  const lines = ['Data;Histórico;Docto;Crédito;Débito;Saldo']
  let balance = 1_250_000
  let currentMonth = -1
  entries.forEach((e, i) => {
    if (e.month !== currentMonth) {
      currentMonth = e.month
      lines.push(`${brDate(e.year, e.month, 1)};SALDO ANTERIOR;;;;${formatAmount(balance, ',', '.')}`)
    }
    balance += e.cents
    const doc = `${900_000 + i}`
    const credit = e.cents > 0 ? formatAmount(e.cents, ',', '.') : ''
    const debit = e.cents < 0 ? formatAmount(e.cents, ',', '.') : ''
    lines.push(
      `${brDate(e.year, e.month, e.day)};${e.description};${doc};${credit};${debit};${formatAmount(balance, ',', '.')}`,
    )
  })
  return lines.join('\r\n') + '\r\n'
}

/* ------------------------------------------------------------------ *
 * 5. Santander — extrato. type_flag: absolute amount + D/C column.
 *    Carries one deliberately malformed row (invalid date) so the
 *    pipeline's error path is exercised, not just the happy path.
 * ------------------------------------------------------------------ */
function santander(): string {
  const entries = build(
    [
      { day: 6, description: 'PRO LABORE SOCIO ADMINISTRADOR', cents: 480_000 },
      { day: 12, description: 'SULAMERICA SEGURO SAUDE', cents: -52_300 },
      { day: 24, description: 'APLICACAO CDB LIQUIDEZ DIARIA', cents: -300_000 },
    ],
    [
      out({ description: ['MERCADO LIVRE COMPRA', 'MAGAZINE LUIZA'], min: 4_500, max: 42_000, perMonth: 2 }),
      out({ description: 'JUROS CHEQUE ESPECIAL', min: 1_200, max: 9_400, perMonth: 1 }),
      { description: 'RENDIMENTO POUPANCA', min: 800, max: 4_200, perMonth: 1 },
    ],
  ).map((e) => ({
    ...e,
    cents: /PRO LABORE|RENDIMENTO/.test(e.description) ? Math.abs(e.cents) : -Math.abs(e.cents),
  }))

  const lines = ['Data;Historico;Documento;Valor;Tipo']
  lines.push('01/06/2026;SALDO ANTERIOR;;0,00;C')
  entries.forEach((e, i) => {
    lines.push(
      `${brDate(e.year, e.month, e.day)};${e.description};${700_000 + i};${formatAmount(e.cents, ',', '.')};${e.cents < 0 ? 'D' : 'C'}`,
    )
  })
  // Malformed on purpose: month 13 cannot be parsed, so this row must land in
  // staging WITH an error rather than being silently dropped or coerced.
  lines.push('32/13/2026;LANCAMENTO COM DATA INVALIDA;799999;100,00;D')
  return lines.join('\r\n') + '\r\n'
}

/* ------------------------------------------------------------------ *
 * 6. Banco Inter — extrato PJ.
 *
 *    Faithful to the real export, which opens with five preamble lines
 *    (título, conta, período, saldo, blank) before the header and carries
 *    no category column. That preamble is exactly what the profile's
 *    skipRows has to absorb, so the fixture exercises it.
 * ------------------------------------------------------------------ */
function inter(): string {
  const entries = build(
    [
      { day: 7, description: 'PIX RECEBIDO CLIENTE NORTHWIND STUDIO', cents: 640_000 },
      { day: 15, description: 'VERCEL INC ASSINATURA PRO', cents: -9_800 },
      { day: 15, description: 'OPENAI LLC API', cents: -24_500 },
      { day: 21, description: 'DAS SIMPLES NACIONAL', cents: -98_600 },
    ],
    [
      out({ description: 'CURSO DESIGN SYSTEMS AVANCADO', min: 39_900, max: 39_900, perMonth: 1 }),
      out({ description: ['UBER TRIP SP', 'CABIFY VIAGEM'], min: 2_200, max: 6_800, perMonth: 2 }),
      { description: 'RENDIMENTO CDB INTER', min: 1_800, max: 7_500, perMonth: 1 },
    ],
  ).map((e) => ({
    ...e,
    cents: /PIX RECEBIDO|RENDIMENTO/.test(e.description) ? Math.abs(e.cents) : -Math.abs(e.cents),
  }))

  const lines = [
    'Extrato Conta Corrente ',
    'Conta ;21499055',
    'Período ;01/06/2026 a 31/08/2026',
    'Saldo: ;0,00',
    '',
    'Data Lançamento;Descrição;Valor;Saldo',
  ]
  let balance = 320_000
  for (const e of entries) {
    balance += e.cents
    lines.push(
      `${brDate(e.year, e.month, e.day)};${e.description};${signed(e.cents, ',', '.')};${formatAmount(balance, ',', '.')}`,
    )
  }
  return lines.join('\n') + '\n'
}

/* ------------------------------------------------------------------ */
const FILES: Array<{ file: string; encoding: BufferEncoding; content: () => string }> = [
  { file: 'itau-extrato-2026-06_08.csv', encoding: 'latin1', content: itau },
  { file: 'nubank-conta-2026-06_08.csv', encoding: 'utf8', content: nubankConta },
  { file: 'nubank-cartao-2026-06_08.csv', encoding: 'utf8', content: nubankCartao },
  { file: 'bradesco-extrato-2026-06_08.csv', encoding: 'latin1', content: bradesco },
  { file: 'santander-extrato-2026-06_08.csv', encoding: 'latin1', content: santander },
  { file: 'inter-extrato-2026-06_08.csv', encoding: 'utf8', content: inter },
]

for (const { file, encoding, content } of FILES) {
  const text = content()
  writeFileSync(resolve(OUT_DIR, file), Buffer.from(text, encoding))
  const rows = text.trim().split(/\r?\n/).length - 1
  console.log(`[fixture] ${file.padEnd(34)} ${String(rows).padStart(3)} rows  ${encoding}`)
}
