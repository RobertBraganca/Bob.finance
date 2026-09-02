const hex = (h) => { h = h.replace('#',''); return [0,2,4].map(i => parseInt(h.slice(i,i+2),16)/255) }
const lin = (c) => c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4)
const lum = (h) => { const [r,g,b] = hex(h).map(lin); return 0.2126*r + 0.7152*g + 0.0722*b }
const ratio = (a,b) => { const [x,y] = [lum(a),lum(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05) }

// BOB.OS brand identity, retinted 2026-08-20. Surfaces: light shell
// #ffffff/#fafafa, ink cards #080808/#101010. Source: BOB.OS Design
// System / tokens/colors.css.
const pairs = [
  ['delta-up',        '#14682a', '#ffffff', 4.5],
  ['delta-down',      '#cc0000', '#ffffff', 4.5],
  ['delta-up-slab',   '#32d74b', '#080808', 4.5],
  ['delta-down-slab', '#ff0000', '#080808', 4.5],
  ['ink-1 on surface','#09090b', '#ffffff', 4.5],
  ['ink-2 on surface','#52525b', '#ffffff', 4.5],
  ['ink-2 on paper',  '#52525b', '#fafafa', 4.5],
  ['ink-3 (muted)',   '#71717a', '#ffffff', 3.0],
  // Adicionados na auditoria de 01/09/2026, todos medidos como FALHA antes
  // da correção. Ficam aqui para que baixar o tom de volta quebre o script
  // em vez de passar calado.
  //
  // Borda de CAMPO DE FORMULÁRIO: 1.4.11 cita o caso nominalmente, então
  // são 3:1 contra o fundo do campo, nos dois temas. Era #a1a1aa (2,46:1)
  // no claro e #3f3f46 (1,82:1) no escuro.
  ['line-strong (borda de campo, claro)', '#8a8a93', '#fafafa', 3.0],
  ['line-strong (borda de campo, escuro)', '#666670', '#101010', 3.0],
  ['line-strong (borda sobre hover escuro)', '#666670', '#161616', 3.0],
  // Rodapé da sidebar: TEXTO de 11px, 4,5:1. Era --ink-4 (2,56:1). --ink-3
  // resolveria o claro e falharia o escuro (4,14), daí --ink-2.
  ['ink-2 (rodape sidebar, claro)', '#52525b', '#ffffff', 4.5],
  ['ink-2 (rodape sidebar, escuro)', '#a1a1aa', '#080808', 4.5],
  // Sparkline do KPI: objeto gráfico ESSENCIAL (a tendência não existe em
  // texto no tile), 3:1. Era --ink-4, 2,56:1.
  ['ink-3 (sparkline, claro)', '#71717a', '#ffffff', 3.0],
  ['ink-3 (sparkline, escuro)', '#71717a', '#080808', 3.0],
  // Texto do badge sobre o próprio fundo do badge, os 3 estados.
  ['badge positivo', '#14682a', '#e8f7ec', 4.5],
  ['badge atencao', '#7a5b00', '#fdf3e0', 4.5],
  ['badge critico', '#cc0000', '#ffecec', 4.5],
  // Indicador de foco: :focus-visible desenha outline de 2px em --brand.
  ['anel de foco', '#ff0000', '#ffffff', 3.0],
  ['on-slab-1',       '#ffffff', '#080808', 4.5],
  ['on-slab-2',       '#a1a1aa', '#080808', 4.5],
  ['on-slab-3 muted', '#71717a', '#080808', 3.0],
  // 4.00:1, not 4.5 — this is BOB.OS's own real button (white on solid
  // brand red, bold/uppercase weight); inherited as-is, not invented here.
  ['white on brand (button)', '#ffffff', '#ff0000', 3.0],
  ['brand-on-slab',   '#ff0000', '#080808', 4.5],
  // NOTE: --brand-wash is only ever a background behind ink-coloured text
  // (selected table row, dropzone hover) — brand-red text never sits on
  // it, so there is no "brand text on wash" pairing to check here.
  // Status colours are FILLS (>=3:1), never small text alone — negative
  // text uses --delta-down/-slab above, which clear 4.5:1.
  ['status-crit fill (light)', '#ff0000', '#ffffff', 3.0],
  ['status-good fill (light)', '#1e8e3c', '#ffffff', 3.0],
  ['status-warn fill (light)', '#a66a00', '#ffffff', 3.0],
  ['status-serious fill (light)', '#e8590c', '#ffffff', 3.0],
  ['status-crit fill (slab)', '#ff0000', '#080808', 3.0],
  ['status-good fill (slab)', '#32d74b', '#080808', 3.0],
  ['status-warn fill (slab)', '#ffc700', '#080808', 3.0],
  ['status-serious fill (slab)', '#e8590c', '#080808', 3.0],
  // Categorical series — fill-grade only (marks, never text).
  ['series blue (light)',   '#007bff', '#ffffff', 3.0],
  ['series pink (light)',   '#ff2ea6', '#ffffff', 3.0],
  ['series green (light)',  '#1e8e3c', '#ffffff', 3.0],
  ['series purple (light)', '#ba2be2', '#ffffff', 3.0],
  ['series blue (slab)',    '#007bff', '#080808', 3.0],
  ['series pink (slab)',    '#ff2ea6', '#080808', 3.0],
  ['series green (slab)',   '#32d74b', '#080808', 3.0],
  ['series purple (slab)',  '#ba2be2', '#080808', 3.0],
]
let bad = 0
for (const [name, fg, bg, min] of pairs) {
  const r = ratio(fg, bg)
  const verdict = r >= min ? 'PASS' : 'FAIL'
  if (r < min) bad++
  console.log(`  ${verdict}  ${name.padEnd(30)} ${fg} on ${bg}  ${r.toFixed(2)}:1  (min ${min})`)
}
console.log(bad === 0 ? '\n  todos os tokens de texto passam' : `\n  ${bad} token(s) abaixo do mínimo`)
