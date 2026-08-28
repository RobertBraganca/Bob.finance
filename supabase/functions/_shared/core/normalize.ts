import { createHash } from 'node:crypto'

/**
 * Two derived strings do all the matching work in this app:
 *
 *  - `descriptionNorm` — accent-free, lowercase, noise-stripped. Used for
 *    rule matching and for the dedupe hash, so "IFOOD  *IFOOD" and
 *    "ifood *ifood" are the same transaction.
 *  - `merchantSignature` — the stable part of a description with the
 *    volatile parts (card digits, order ids, dates) removed. This is the
 *    key the learned-correction memory is stored under.
 */

const NOISE_TOKENS = new Set([
  'compra',
  'cartao',
  'card',
  'debito',
  'credito',
  'no',
  'na',
  'de',
  'da',
  'do',
  'em',
  'com',
  'ltda',
  'me',
  'sa',
  'eireli',
  'brasil',
  'br',
  'bra',
  'sao',
  'paulo',
  'rio',
  'parcela',
  'parc',
  'ref',
  'via',
  'inst',
  // Acquirer boilerplate: "Compra No Estabelecimento Xyz Presentes" — the
  // merchant is "xyz presentes", not "estabelecimento".
  'estabelecimento',
  'comercial',
  'pagamento',
  'efetuado',
  'realizado',
  // Transfer verbs: the counterparty is the identity, not the rail.
  // "PIX ENVIADO JOAO M SILVA" must signature as "joao silva", so that
  // corrections attach to the person and not to every Pix ever sent.
  // "transferencia" and "pelo" are the same boilerplate problem: without
  // them, "Transferência enviada PELO Pix - <nome>" signatured as
  // "transferencia pelo" for every single Pix transfer regardless of
  // counterparty — one shared bucket for thousands of unrelated payments,
  // which is exactly the kind of bucket a single manual correction can
  // pollute (see docs/decisions/0008).
  'pix',
  'ted',
  'pelo',
  'transferencia',
  'enviado',
  'enviada',
  'recebido',
  'recebida',
])

// Combining-marks range U+0300..U+036F, built from char codes so the source
// file stays pure ASCII and no encoding round-trip can corrupt it.
const COMBINING_MARKS = new RegExp(
  `[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`,
  'g',
)

export function stripAccents(input: string): string {
  return input.normalize('NFD').replace(COMBINING_MARKS, '')
}

export function normalizeDescription(input: string): string {
  return stripAccents(String(input ?? ''))
    .toLowerCase()
    .replace(/[*#|]/g, ' ')
    .replace(/[^a-z0-9\s/.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Collapses a description to the merchant identity. Drops anything with a
 * digit in it (card tails, order numbers, installment markers) and the
 * boilerplate Brazilian acquirers prepend to every line.
 */
export function merchantSignature(input: string): string {
  const norm = normalizeDescription(input)
  if (!norm) return ''

  const tokens = norm
    .split(' ')
    .map((t) => t.replace(/[/.-]+$/g, ''))
    .filter((t) => t.length >= 3 && !/\d/.test(t) && !NOISE_TOKENS.has(t))

  const unique: string[] = []
  for (const token of tokens) {
    if (!unique.includes(token)) unique.push(token)
    if (unique.length === 2) break
  }

  // Fallback for descriptions made entirely of boilerplate ("Pix Enviado"):
  // keep the words, drop every digit group. Digits are never merchant
  // identity, and some exports append a timestamp to the description to keep
  // same-day rows distinct — that must not fragment the signature.
  if (unique.length === 0) {
    return norm
      .replace(/\d+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24)
  }
  return unique.join(' ')
}

/**
 * Identity of a transaction for duplicate detection across re-imports:
 * same account, same day, same amount, same normalized description.
 * Deliberately does NOT include the import batch — that is the whole point.
 */
export function dedupeHash(input: {
  accountId: number
  postedOn: string
  amountCents: number
  descriptionNorm: string
}): string {
  return createHash('sha256')
    .update(`${input.accountId}|${input.postedOn}|${input.amountCents}|${input.descriptionNorm}`)
    .digest('hex')
    .slice(0, 32)
}

export const directionOf = (amountCents: number): 'in' | 'out' => (amountCents >= 0 ? 'in' : 'out')
