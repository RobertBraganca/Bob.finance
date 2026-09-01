import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

/**
 * Bento com empacotamento masonry real.
 *
 * O grid de 12 colunas sozinho não entrega o que "bento" promete: numa
 * linha, a altura é a do card mais alto, e as duas saídas do CSS puro são
 * ruins de jeitos opostos — `align-items: stretch` deixa o vazio DENTRO do
 * card curto (conteúdo grudado no topo), `align-items: start` deixa o vazio
 * na PÁGINA, embaixo dele. Ambas foram reclamadas em 01/09/2026, nessa
 * ordem.
 *
 * Masonry resolve: o card seguinte sobe e ocupa o buraco. `grid-template-
 * rows: masonry` ainda não é confiável em produção (só atrás de flag), então
 * a medida é feita aqui: cada filho vira `grid-row: span <altura em px>`
 * sobre um `grid-auto-rows: 1px`. O espaçamento vertical vem do
 * `margin-bottom` dos filhos (ver `.bento--masonry` em components.css), não
 * de `row-gap`, senão ele seria aplicado a cada uma das centenas de linhas
 * implícitas de 1px.
 *
 * As larguras (`col-*`) continuam sendo as autorais de sempre — masonry aqui
 * é só sobre a vertical.
 */
export function Bento({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement | null>(null)

  const layout = useCallback(() => {
    const grid = ref.current
    if (!grid) return

    // Uma coluna só (mobile, ou um bento estreito dentro de um card): não há
    // buraco lateral pra preencher, e forçar span de altura aqui só criaria
    // arredondamento desnecessário. Deixa o fluxo normal do grid.
    const styles = getComputedStyle(grid)
    const columns = styles.gridTemplateColumns.split(' ').length
    // O respiro vertical entra no span (`row-gap` é 0, ver base.css) e sai
    // do mesmo token do espaçamento horizontal, para os dois nunca
    // divergirem.
    const gap = Number.parseFloat(styles.columnGap) || 0

    for (const child of Array.from(grid.children) as HTMLElement[]) {
      if (columns <= 1) {
        if (child.style.gridRowEnd) child.style.gridRowEnd = ''
        continue
      }
      // `getBoundingClientRect` inclui o conteúdo real já renderizado
      // (gráficos, tabelas), que é justamente o que precisa ser medido —
      // `offsetHeight` arredondaria e acumularia erro linha a linha.
      const span = Math.ceil(child.getBoundingClientRect().height + gap)
      const next = `span ${span}`
      // Só escreve quando muda: escrever sempre realimenta o ResizeObserver
      // abaixo e vira laço infinito.
      if (child.style.gridRowEnd !== next) child.style.gridRowEnd = next
    }
  }, [])

  useLayoutEffect(() => {
    layout()
    const grid = ref.current
    if (!grid) return

    // Um observer para os filhos (conteúdo que cresce: gráfico que termina de
    // montar, tabela que carrega, card que expande) e um para o próprio grid
    // (mudança de largura, que muda quantas colunas cabem).
    const observer = new ResizeObserver(() => layout())
    observer.observe(grid)
    for (const child of Array.from(grid.children)) observer.observe(child)

    // Filhos que entram ou saem depois (card condicional, item de lista).
    const mutations = new MutationObserver(() => {
      for (const child of Array.from(grid.children)) observer.observe(child)
      layout()
    })
    mutations.observe(grid, { childList: true })

    return () => {
      observer.disconnect()
      mutations.disconnect()
    }
  }, [layout])

  // Fonte que termina de carregar remede tudo depois do primeiro layout.
  useEffect(() => {
    document.fonts?.ready.then(layout).catch(() => {})
  }, [layout])

  return (
    <div ref={ref} className="bento bento--masonry" style={style}>
      {children}
    </div>
  )
}
