import type { ReactNode } from 'react'

/**
 * Bento de duas colunas, com linhas alinhadas e conteúdo elástico.
 *
 * Histórico, porque a decisão foi tomada duas vezes: até 01/09/2026 este
 * componente media a altura de cada filho e escrevia `grid-row: span <px>`
 * sobre um `grid-auto-rows: 1px`, produzindo masonry de verdade. Masonry
 * empacota mais (medido: 1070px contra 1204px na mesma amostra, 11% mais
 * denso), mas paga com o alinhamento: dos seis pares de cards vizinhos,
 * só UM ficava com o topo alinhado, e os oito cards caíam em sete alturas
 * de topo diferentes. Numa tela que se lê escaneando, é o ritmo que se
 * perde.
 *
 * A escolha (01/09/2026) foi o inverso: a linha alinha, e o CONTEÚDO estica
 * para ocupar a altura que a linha tem. Isso resolve a queixa original —
 * "cards com espaço vazio" — na causa certa. O vazio não vinha da altura da
 * linha; vinha de um gráfico com `min-height` fixo dentro de um card alto.
 * Com o conteúdo elástico, o mesmo gráfico foi de 96px para 208px: a sobra
 * virou resolução vertical do dado em vez de espaço morto.
 *
 * O que faz o card esticar é `.chart` (e `.card__fill`, para o resto) em
 * `components.css` — não há mais nada de JavaScript aqui, nem
 * ResizeObserver, nem MutationObserver, nem reflow a cada carga de dado.
 *
 * As larguras (`col-*`) seguem as de sempre: até 6 é metade, acima de 6 é a
 * linha inteira (`base.css`).
 */
export function Bento({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="bento" style={style}>
      {children}
    </div>
  )
}
