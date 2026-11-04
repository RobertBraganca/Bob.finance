/**
 * Cor do cartão de cada banco, para a pilha de cartões. Casa pelo nome da
 * instituição (ou do cartão, quando a instituição está vazia), sem acento e
 * sem caixa. A tinta é escura nos fundos claros (laranja, verde, amarelo):
 * branco sobre o laranja do Inter fica abaixo de 3:1.
 *
 * `alt` é o tom do segundo cartão do mesmo banco (Nubank PF e PJ), para os
 * dois não ficarem idênticos na pilha.
 */
export type BankTint = { bg: string; alt: string; ink: 'light' | 'dark' }

const BANKS: Array<{ match: string[]; tint: BankTint }> = [
  { match: ['nubank', ' nu '], tint: { bg: '#820ad1', alt: '#4c0a7d', ink: 'light' } },
  { match: ['inter'], tint: { bg: '#ff7a00', alt: '#e86a00', ink: 'dark' } },
  { match: ['picpay'], tint: { bg: '#21c25e', alt: '#119a48', ink: 'dark' } },
  { match: ['itau'], tint: { bg: '#ec7000', alt: '#003399', ink: 'dark' } },
  { match: ['bradesco'], tint: { bg: '#cc092f', alt: '#8e0620', ink: 'light' } },
  { match: ['santander'], tint: { bg: '#cc0000', alt: '#8f0000', ink: 'light' } },
  { match: ['c6'], tint: { bg: '#242424', alt: '#3a3a3a', ink: 'light' } },
  { match: ['banco do brasil', ' bb '], tint: { bg: '#fcf800', alt: '#e6e100', ink: 'dark' } },
  { match: ['caixa'], tint: { bg: '#005ca9', alt: '#003f75', ink: 'light' } },
  { match: ['mercado pago', 'mercadopago'], tint: { bg: '#ffe600', alt: '#00b1ea', ink: 'dark' } },
  { match: [' xp '], tint: { bg: '#141414', alt: '#2b2b2b', ink: 'light' } },
  { match: ['btg'], tint: { bg: '#0a1e3c', alt: '#16335f', ink: 'light' } },
  { match: ['neon'], tint: { bg: '#00d2ff', alt: '#00a8cc', ink: 'dark' } },
  { match: ['sicoob'], tint: { bg: '#003641', alt: '#00525f', ink: 'light' } },
]

const FALLBACK: BankTint[] = [
  { bg: '#2b2f36', alt: '#2b2f36', ink: 'light' },
  { bg: '#3d4a5c', alt: '#3d4a5c', ink: 'light' },
  { bg: '#4a3f35', alt: '#4a3f35', ink: 'light' },
]

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

function bankOf(label: string): number {
  // os termos com espaço em volta (" bb ", " nu ") só casam como palavra inteira
  const hay = ` ${fold(label).replace(/[^a-z0-9]+/g, ' ')} `
  return BANKS.findIndex((b) => b.match.some((m) => hay.includes(m)))
}

/** Tons para uma lista de cartões, na ordem dada. */
export function tintsFor(cards: Array<{ id: number; name: string; institution: string | null }>): Map<number, BankTint> {
  const seen = new Map<number, number>()
  const out = new Map<number, BankTint>()
  let unknown = 0
  for (const card of cards) {
    const bank = bankOf(card.institution || card.name)
    if (bank < 0) {
      out.set(card.id, FALLBACK[unknown++ % FALLBACK.length]!)
      continue
    }
    const n = seen.get(bank) ?? 0
    seen.set(bank, n + 1)
    const tint = BANKS[bank]!.tint
    out.set(card.id, n % 2 === 1 ? { ...tint, bg: tint.alt } : tint)
  }
  return out
}
