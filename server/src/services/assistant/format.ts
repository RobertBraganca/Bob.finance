/**
 * Formatação em português e pequenas regras de texto do assistente. Sem banco.
 * Os valores chegam em centavos e as datas em AAAA-MM-DD.
 */

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']

/** "R$ 1.250,50" (sempre o valor absoluto: o sinal é dito pelo texto ao redor). */
export function formatBRL(cents: number): string {
  const reais = (Math.abs(cents) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `R$ ${reais}`
}

/** A data existe de verdade no calendário (rejeita 2026-02-31). */
export function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toISOString().slice(0, 10) === iso
}

/** "19/10/2026 (segunda-feira)". */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  const weekday = WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]
  return `${d}/${m}/${y} (${weekday})`
}

/** Dias entre duas datas ISO (positivo quando `to` é depois de `from`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** Quantidade de ativo: até 8 casas, sem zeros sobrando. */
export function formatQuantity(quantity: number): string {
  return quantity.toLocaleString('pt-BR', { maximumFractionDigits: 8 })
}

const NOTE_SEPARATOR = ' · '

/** Comentário que ACRESCENTA ao que já existe (nunca substitui): "antigo · novo". */
export function appendNote(existing: string | null | undefined, note: string): string {
  const current = existing?.trim()
  return current ? `${current}${NOTE_SEPARATOR}${note.trim()}` : note.trim()
}
