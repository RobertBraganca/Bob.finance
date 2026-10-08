import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import regularUrl from '../assets/fonts/Barlow-Regular.ttf?url'
import semiBoldUrl from '../assets/fonts/Barlow-SemiBold.ttf?url'
import blackUrl from '../assets/fonts/Barlow-Black.ttf?url'
import { lineTotalCents } from '@shared/proposals'
import { bps, date as fmtDate, money } from './format'
import { formatDocument, formatQuantity, type IssuerSettings, type ProposalDetail } from '../pages/proposals/types'

/**
 * PDF do orçamento (decisions/0040, specs/service-proposals), montado no
 * navegador. Este módulo só é carregado no primeiro "Compartilhar" (import
 * dinâmico), com `pdf-lib` e as mesmas fontes Barlow da tela, para o cliente
 * receber o documento com a mesma cara do app.
 */

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 51 // 18 mm
const INK = rgb(0.035, 0.035, 0.043)
const MUTED = rgb(0.443, 0.443, 0.478)
const LINE = rgb(0.894, 0.894, 0.906)
const BRAND = rgb(1, 0, 0)
const SOFT = rgb(0.957, 0.957, 0.961)

type Fonts = { regular: PDFFont; semi: PDFFont; black: PDFFont }
export type PdfLogo = { bytes: ArrayBuffer; type: 'png' | 'jpg' }

async function fetchBytes(url: string) {
  return (await fetch(url)).arrayBuffer()
}

/** Quebra um texto em linhas que cabem em `maxWidth`; respeita quebras de linha do usuário. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) current = candidate
      else {
        if (current) lines.push(current)
        current = word
      }
    }
    if (current) lines.push(current)
  }
  return lines
}

export async function buildProposalPdf(proposal: ProposalDetail, issuer: IssuerSettings, logo?: PdfLogo | null): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setTitle(`Orçamento ${proposal.numberLabel} - ${proposal.title}`)
  doc.setAuthor(issuer.businessName ?? '')
  const [regularBytes, semiBytes, blackBytes] = await Promise.all([fetchBytes(regularUrl), fetchBytes(semiBoldUrl), fetchBytes(blackUrl)])
  const fonts: Fonts = {
    regular: await doc.embedFont(regularBytes, { subset: true }),
    semi: await doc.embedFont(semiBytes, { subset: true }),
    black: await doc.embedFont(blackBytes, { subset: true }),
  }
  let logoImage: PDFImage | null = null
  if (logo) {
    try {
      logoImage = logo.type === 'png' ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes)
    } catch {
      logoImage = null
    }
  }

  const width = A4[0] - MARGIN * 2
  let page: PDFPage = doc.addPage(A4)
  let y = A4[1] - MARGIN

  const text = (value: string, x: number, at: number, font: PDFFont, size: number, color = INK) =>
    page.drawText(value, { x, y: at, size, font, color })
  const right = (value: string, xRight: number, at: number, font: PDFFont, size: number, color = INK) =>
    text(value, xRight - font.widthOfTextAtSize(value, size), at, font, size, color)

  /* ---- Cabeçalho: logo à esquerda, emissor à direita ---------------- */
  let headerHeight = 0
  if (logoImage) {
    const scale = Math.min(140 / logoImage.width, 48 / logoImage.height, 1)
    const w = logoImage.width * scale
    const h = logoImage.height * scale
    page.drawImage(logoImage, { x: MARGIN, y: y - h, width: w, height: h })
    headerHeight = h
  }
  const issuerLines = [
    issuer.document ? formatDocument(issuer.document) : null,
    [issuer.email, issuer.phone].filter(Boolean).join(' · ') || null,
  ].filter((l): l is string => !!l)
  let iy = y - 12
  if (issuer.businessName) {
    right(issuer.businessName, A4[0] - MARGIN, iy, fonts.semi, 12)
    iy -= 15
  }
  for (const line of issuerLines) {
    right(line, A4[0] - MARGIN, iy, fonts.regular, 9, MUTED)
    iy -= 12
  }
  y = Math.min(y - headerHeight, iy) - 14
  page.drawRectangle({ x: MARGIN, y, width, height: 2, color: BRAND })
  y -= 28

  /* ---- Título e dados do orçamento -------------------------------- */
  text(`ORÇAMENTO ${proposal.numberLabel}`, MARGIN, y, fonts.semi, 9, MUTED)
  y -= 24
  for (const line of wrap(proposal.title, fonts.black, 20, width)) {
    text(line, MARGIN, y, fonts.black, 20)
    y -= 24
  }
  y -= 6
  const meta: Array<[string, string]> = [
    ['Cliente', proposal.clientLabel],
    ['Emissão', fmtDate(proposal.createdAt.slice(0, 10))],
    ['Válido até', fmtDate(proposal.validUntil)],
  ]
  const colWidth = width / meta.length
  meta.forEach(([label, value], i) => {
    text(label.toUpperCase(), MARGIN + i * colWidth, y, fonts.semi, 8, MUTED)
    const valueLines = wrap(value, fonts.semi, 11, colWidth - 12)
    valueLines.slice(0, 2).forEach((line, j) => text(line, MARGIN + i * colWidth, y - 15 - j * 13, fonts.semi, 11))
  })
  y -= 50

  /* ---- Tabela de serviços ------------------------------------------ */
  const cols = { qty: MARGIN + width * 0.62, unit: MARGIN + width * 0.8, total: A4[0] - MARGIN }
  const titleWidth = width * 0.56
  const tableHeader = () => {
    page.drawRectangle({ x: MARGIN, y: y - 6, width, height: 22, color: SOFT })
    text('SERVIÇO', MARGIN + 8, y + 1, fonts.semi, 8, MUTED)
    right('QTD.', cols.qty, y + 1, fonts.semi, 8, MUTED)
    right('UNITÁRIO', cols.unit, y + 1, fonts.semi, 8, MUTED)
    right('TOTAL', cols.total - 8, y + 1, fonts.semi, 8, MUTED)
    y -= 26
  }
  const ensure = (needed: number) => {
    if (y - needed < MARGIN + 30) {
      page = doc.addPage(A4)
      y = A4[1] - MARGIN
      tableHeader()
    }
  }
  tableHeader()
  for (const item of proposal.items) {
    const titleLines = wrap(item.title, fonts.semi, 10.5, titleWidth)
    const descLines = item.description ? wrap(item.description, fonts.regular, 8.5, titleWidth) : []
    // 18 de folga: o fio entre linhas cai no meio dela, longe do texto das duas.
    const rowHeight = titleLines.length * 13 + descLines.length * 11 + 18
    ensure(rowHeight)
    const top = y
    titleLines.forEach((line, i) => text(line, MARGIN + 8, top - i * 13, fonts.semi, 10.5))
    descLines.forEach((line, i) => text(line, MARGIN + 8, top - titleLines.length * 13 - i * 11, fonts.regular, 8.5, MUTED))
    right(formatQuantity(item.quantity), cols.qty, top, fonts.regular, 10)
    right(money(item.unitPriceCents), cols.unit, top, fonts.regular, 10)
    right(money(lineTotalCents(item)), cols.total - 8, top, fonts.semi, 10.5)
    y -= rowHeight
    page.drawLine({ start: { x: MARGIN, y: y + 15 }, end: { x: A4[0] - MARGIN, y: y + 15 }, thickness: 0.6, color: LINE })
  }

  /* ---- Totais ------------------------------------------------------- */
  ensure(90)
  y -= 10
  const labelX = MARGIN + width * 0.55
  right('Subtotal', labelX + 110, y, fonts.regular, 10, MUTED)
  right(money(proposal.subtotalCents), cols.total - 8, y, fonts.regular, 10)
  y -= 16
  if (proposal.discountCents > 0) {
    right(`Desconto (${bps(proposal.discountBps, 1)})`, labelX + 110, y, fonts.regular, 10, MUTED)
    right(`- ${money(proposal.discountCents)}`, cols.total - 8, y, fonts.regular, 10)
    y -= 16
  }
  y -= 4
  page.drawRectangle({ x: labelX, y: y - 12, width: A4[0] - MARGIN - labelX, height: 30, color: INK })
  text('INVESTIMENTO TOTAL', labelX + 10, y - 1, fonts.semi, 8.5, rgb(0.8, 0.8, 0.82))
  right(money(proposal.totalCents), cols.total - 8, y - 3, fonts.black, 15, rgb(1, 1, 1))
  y -= 44

  /* ---- Condições e observações -------------------------------------- */
  const block = (label: string, body: string) => {
    const lines = wrap(body, fonts.regular, 9.5, width)
    ensure(18 + lines.length * 13)
    text(label.toUpperCase(), MARGIN, y, fonts.semi, 8, MUTED)
    y -= 14
    lines.forEach((line) => {
      text(line, MARGIN, y, fonts.regular, 9.5)
      y -= 13
    })
    y -= 10
  }
  const payment = [
    proposal.installments > 1 ? `Em ${proposal.installments} parcelas.` : null,
    proposal.paymentTerms,
  ]
    .filter(Boolean)
    .join(' ')
  if (payment) block('Condições de pagamento', payment)
  if (proposal.deliveryTerms) block('Prazo de entrega', proposal.deliveryTerms)
  if (proposal.notes) block('Observações', proposal.notes)

  /* ---- Rodapé em todas as páginas ----------------------------------- */
  const pages = doc.getPages()
  pages.forEach((p, i) => {
    const footer = [issuer.businessName, `Orçamento ${proposal.numberLabel}`].filter(Boolean).join(' · ')
    p.drawText(footer, { x: MARGIN, y: MARGIN - 20, size: 8, font: fonts.regular, color: MUTED })
    const label = `Página ${i + 1} de ${pages.length}`
    p.drawText(label, {
      x: A4[0] - MARGIN - fonts.regular.widthOfTextAtSize(label, 8),
      y: MARGIN - 20,
      size: 8,
      font: fonts.regular,
      color: MUTED,
    })
  })

  return doc.save()
}

/** `Orcamento-0001-Solucoes-Tecnologicas-Beta.pdf`: sem acento nem espaço, para qualquer app de mensagem. */
export function proposalFileName(proposal: Pick<ProposalDetail, 'number' | 'clientLabel'>): string {
  const client = proposal.clientLabel
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `Orcamento-${String(proposal.number).padStart(4, '0')}${client ? `-${client}` : ''}.pdf`
}
