import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import regularUrl from '../assets/fonts/Barlow-Regular.ttf?url'
import semiBoldUrl from '../assets/fonts/Barlow-SemiBold.ttf?url'
import blackUrl from '../assets/fonts/Barlow-Black.ttf?url'
import { bps, date as fmtDate, money, periodLong } from './format'
import type { AccountantMonth } from '../pages/accountant/types'

/**
 * PDF do pacote do mês para o contador (docs/specs/tarefas-comercial-contador,
 * fase 4): o resumo da empresa, as notas emitidas e o extrato da conta PJ,
 * montado no navegador com as mesmas fontes do PDF do orçamento. Só dados da
 * PJ: o recorte vem de `/accountant/month`, que não traz nada pessoal.
 */

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 45
const INK = rgb(0.035, 0.035, 0.043)
const MUTED = rgb(0.443, 0.443, 0.478)
const LINE = rgb(0.894, 0.894, 0.906)
const BRAND = rgb(1, 0, 0)

type Fonts = { regular: PDFFont; semi: PDFFont; black: PDFFont }

async function fetchBytes(url: string) {
  return (await fetch(url)).arrayBuffer()
}

/** Corta o texto com reticências para caber na largura. */
function fit(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text
  let out = text
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > width) out = out.slice(0, -1)
  return `${out}…`
}

export async function buildAccountantPdf(month: AccountantMonth, businessName: string | null): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const label = periodLong(month.period)
  doc.setTitle(`Fechamento de ${label}`)
  doc.setAuthor(businessName ?? '')
  const regularBytes = await fetchBytes(regularUrl)
  const semiBytes = await fetchBytes(semiBoldUrl)
  const blackBytes = await fetchBytes(blackUrl)
  const fonts: Fonts = {
    regular: await doc.embedFont(regularBytes, { subset: true }),
    semi: await doc.embedFont(semiBytes, { subset: true }),
    black: await doc.embedFont(blackBytes, { subset: true }),
  }

  let page: PDFPage = doc.addPage(A4)
  let y = A4[1] - MARGIN
  const width = A4[0] - MARGIN * 2
  const newPage = () => {
    page = doc.addPage(A4)
    y = A4[1] - MARGIN
  }
  const ensure = (h: number) => {
    if (y - h < MARGIN) newPage()
  }
  const text = (t: string, x: number, size: number, font: PDFFont, color = INK) => page.drawText(t, { x, y, size, font, color })
  const rule = () => {
    page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: MARGIN + width, y: y + 4 }, thickness: 0.6, color: LINE })
  }

  // Cabeçalho
  text('FECHAMENTO DO MÊS', MARGIN, 9, fonts.semi, BRAND)
  y -= 26
  text(label.charAt(0).toUpperCase() + label.slice(1), MARGIN, 24, fonts.black)
  y -= 16
  text([businessName, month.pjAccount ? `Conta ${month.pjAccount.name}` : null].filter(Boolean).join(' · '), MARGIN, 10, fonts.regular, MUTED)
  y -= 28

  // Resumo
  if (month.summary) {
    const s = month.summary
    const rows: Array<[string, string]> = [
      ['Faturamento', money(s.revenueCents)],
      ['DAS pago no mês', money(s.dasCents)],
      ['Custos da empresa', money(s.costsCents)],
      ['Resultado', money(s.profitCents)],
      ['Retiradas para a conta pessoal', money(s.withdrawalsCents)],
    ]
    text('Resumo', MARGIN, 13, fonts.semi)
    y -= 18
    for (const [k, v] of rows) {
      text(k, MARGIN, 10.5, fonts.regular)
      page.drawText(v, { x: MARGIN + width - fonts.semi.widthOfTextAtSize(v, 10.5), y, size: 10.5, font: fonts.semi, color: INK })
      y -= 16
      rule()
    }
    if (s.dasPending) {
      y -= 4
      text(`DAS do mês ainda não aparece no extrato (valor de referência ${money(s.dasMonthlyCents)}).`, MARGIN, 9, fonts.regular, MUTED)
      y -= 14
    }
    if (month.ceiling) {
      const c = month.ceiling
      y -= 6
      text(`Faturamento no ano: ${money(c.yearRevenueCents)} de ${money(c.limitCents)} do teto do MEI (${bps(c.usedBps, 0)}).`, MARGIN, 9, fonts.regular, MUTED)
      y -= 14
    }
    y -= 14
  }

  // Notas fiscais
  ensure(60)
  text('Notas fiscais emitidas', MARGIN, 13, fonts.semi)
  y -= 18
  if (month.invoices.length === 0) {
    text('Nenhuma nota marcada como emitida nas tarefas deste mês.', MARGIN, 10, fonts.regular, MUTED)
    y -= 16
  } else {
    for (const n of month.invoices) {
      ensure(18)
      text(fit(n.clientName ?? n.title, fonts.regular, 10, width * 0.55), MARGIN, 10, fonts.regular)
      text(fmtDate(n.dueOn), MARGIN + width * 0.6, 10, fonts.regular, MUTED)
      const ref = n.reference ? `NF ${n.reference}` : 'sem número'
      page.drawText(ref, { x: MARGIN + width - fonts.semi.widthOfTextAtSize(ref, 10), y, size: 10, font: fonts.semi, color: INK })
      y -= 15
      rule()
    }
  }
  y -= 18

  // Extrato PJ
  ensure(60)
  text('Extrato da conta PJ', MARGIN, 13, fonts.semi)
  y -= 14
  text(`${month.totals.count} lançamentos · entradas ${money(month.totals.inCents)} · saídas ${money(Math.abs(month.totals.outCents))}`, MARGIN, 9, fonts.regular, MUTED)
  y -= 18
  const cols = { date: MARGIN, desc: MARGIN + 52, tag: MARGIN + 260, client: MARGIN + 360, value: MARGIN + width }
  const header = () => {
    text('Data', cols.date, 8.5, fonts.semi, MUTED)
    text('Descrição', cols.desc, 8.5, fonts.semi, MUTED)
    text('TAG', cols.tag, 8.5, fonts.semi, MUTED)
    text('Cliente', cols.client, 8.5, fonts.semi, MUTED)
    page.drawText('Valor', { x: cols.value - fonts.semi.widthOfTextAtSize('Valor', 8.5), y, size: 8.5, font: fonts.semi, color: MUTED })
    y -= 14
  }
  header()
  for (const t of month.transactions) {
    if (y - 14 < MARGIN) {
      newPage()
      header()
    }
    text(fmtDate(t.postedOn), cols.date, 9, fonts.regular)
    text(fit(`${t.description}${t.pending ? ' (pendente)' : ''}`, fonts.regular, 9, cols.tag - cols.desc - 8), cols.desc, 9, fonts.regular)
    text(fit(t.categoryName ?? '-', fonts.regular, 9, cols.client - cols.tag - 8), cols.tag, 9, fonts.regular, MUTED)
    text(fit(t.clientName ?? '-', fonts.regular, 9, cols.value - cols.client - 70), cols.client, 9, fonts.regular, MUTED)
    const v = money(t.amountCents)
    page.drawText(v, { x: cols.value - fonts.semi.widthOfTextAtSize(v, 9), y, size: 9, font: fonts.semi, color: INK })
    y -= 13
    rule()
  }

  // Rodapé em todas as páginas
  const pages = doc.getPages()
  pages.forEach((p, i) => {
    const footer = `Gerado pelo BOB Finanças em ${new Date().toLocaleDateString('pt-BR')} · página ${i + 1} de ${pages.length}`
    p.drawText(footer, { x: MARGIN, y: 24, size: 7.5, font: fonts.regular, color: MUTED })
  })
  return doc.save()
}
