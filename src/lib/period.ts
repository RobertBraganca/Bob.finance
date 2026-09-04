/**
 * Aritmética de período (`YYYY-MM`), em um lugar só.
 *
 * `shiftPeriod` estava copiada, byte a byte idêntica, em quatro páginas
 * (Diário, Motor financeiro, Saúde financeira, Metas do mês) — descoberto
 * na revisão de design de 01/09/2026, junto com o fato de que só o Diário
 * travava a navegação no mês corrente. As outras três deixavam paginar
 * indefinidamente para meses vazios no futuro, o que é bug, não estilo.
 */

/** Soma (ou subtrai) meses a um `YYYY-MM`, virando o ano quando precisa. */
export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + months
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** O mês corrente, no fuso do navegador. */
export function currentPeriod(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Primeiro e último dia de um `YYYY-MM`, no formato que a API espera em
 * `from`/`to`.
 *
 * Existe aqui porque `RecentDaily` (src/pages/Daily.tsx) já tinha essa
 * mesma aritmética inline, e a tela de Receita de parceiros seria a
 * segunda cópia. A versão do Diário continua no lugar de propósito: trocá-la
 * é mexer numa página que não está em revisão agora.
 */
export function periodBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` }
}
