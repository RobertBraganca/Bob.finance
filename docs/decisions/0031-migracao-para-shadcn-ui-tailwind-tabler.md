# 0031. Migração da camada de UI para shadcn/ui + Tailwind CSS + Tabler Icons

Status: aceita (em andamento — Fases 0-3 concluídas)

## Contexto
Usuário pediu, explicitamente (28/08/2026): revisar todas as páginas e
telas do app e passar a usar shadcn/ui — nomeando três componentes
específicos como motivação (**Resizable** para o bento design do
Painel, **Sidebar** para o menu lateral, **Skeleton** para
carregamento) — e trocar o conjunto de ícones desenhado à mão por
**Tabler Icons**, uma biblioteca de ícones já discutida antes e posta
em standby.

Duas perguntas de escopo, confirmadas antes de implementar:
1. **Base técnica**: o projeto não tinha Tailwind CSS nem Radix UI —
   só CSS próprio (`tokens.css`/`base.css`/`components.css`). Adotar
   Tailwind no projeto foi escolhido em vez de usar só os primitivos
   Radix crus por cima do CSS existente (a segunda opção teria
   abandonado o CLI/atualizações do shadcn, na prática deixando de ser
   "usar o shadcn" como ele funciona).
2. **Escopo**: o sistema inteiro — Button/Card/Modal/Select/etc. e as
   14 páginas (12.510 linhas) — não só os 3 componentes citados.

Dado o tamanho (nova ferramenta de build + troca de toda a camada de
UI + 14 páginas), o trabalho foi sequenciado em fases verificáveis
(plano completo salvo em `.claude/plans` no momento da aprovação) —
este ADR registra a decisão e a Fase 0; fases seguintes ganham suas
próprias entradas de progresso aqui à medida que forem concluídas.

## Decisão

### Base UI: Base UI (não Radix, não Aria)
O CLI shadcn atual (v4.19) oferece três "sabores" de primitivo por
baixo (`--base radix|base|aria`) — o link que o usuário deu
(`ui.shadcn.com/docs/components/base/resizable`) apontava
especificamente pra variante **"base"** (Base UI, biblioteca headless
do time do MUI), então foi essa a escolha (`npx shadcn init --base
base`), não a Radix tradicional.

### Tailwind v4, Preflight desligado até o fim da migração
`@tailwindcss/vite` (plugin oficial, sem `postcss.config` manual).
`src/index.css` importa só `tailwindcss/theme` e `tailwindcss/utilities`
— **nunca** `tailwindcss/preflight` por enquanto: o reset do Tailwind
mudaria margem/box-sizing padrão de toda tag HTML de uma vez, antes de
qualquer página ter sido migrada pra verificar contra ele. Volta a ser
ligado só na fase final de limpeza, depois que `base.css` (o reset
atual) não for mais necessário em página nenhuma.

### Tokens existentes viram a fonte de verdade do tema shadcn
`tokens.css` continua a fonte de verdade — nada foi duplicado.
`src/index.css` mapeia as variáveis que shadcn espera
(`--background`, `--primary`, `--card`, `--sidebar-*`, `--chart-*`
etc.) para `var(--paper)`, `var(--brand)`, `var(--surface)` já
existentes, via `@theme inline` (mantém a referência viva, não
resolve um valor fixo em build). Consequência direta: **dark mode não
precisou de um segundo bloco `.dark { }`** (o que o preset padrão do
shadcn gera) — como cada variável nova é só um `var()` apontando pro
token antigo, e `tokens.css` já troca esses tokens sob
`:root[data-theme='dark']`, a troca de tema já propaga sozinha.
Verificado ao vivo: `--background`/`--foreground` resolvem
`#ffffff`/`#09090b` no claro e `#080808`/`#ffffff` no escuro, sem
nenhuma duplicação de cor.

`ThemeProvider` (`lib/theme.tsx`) ganhou um `classList.toggle('dark',
...)` além do `data-theme` já existente — cosmético pro sistema de
cores (que não depende disso), mas necessário pra qualquer componente
shadcn futuro que use a variante `dark:` do Tailwind diretamente em vez
de um token de cor.

### Ícones: Tabler, wrapper preservando a assinatura atual
`Icon.tsx` trocou de um `Record<string, svgPath>` desenhado à mão para
um `Record<string, TablerIcon>` — mesma assinatura de chamada
(`{name, size, strokeWidth, className}`) que os ~150+ pontos de uso
`<Icon name="..." />` já usavam, então nenhum call site precisou
mudar. `strokeWidth` (nome próprio deste componente, mantido) mapeia
pro `stroke` do Tabler. Duas entradas não têm glifo 1:1 no Tabler e
foram escolhidas por proximidade semântica (`landmark` →
`IconBuildingMonument`, não existe ícone "Landmark" no pacote); os
comentários que já existiam explicando reaproveitamentos de ícone
entre features (calculadora vs. alvo, medidor vs. balança etc.) foram
mantidos.

### `docs/decisions/0026`-style: fases, não big-bang
Fase 0 (esta) = fundação (Tailwind + `shadcn init` + Tabler) — zero
página tocada ainda, verificado sem nenhuma diferença visual (cores/
fontes/ícones idênticos ao anterior, testado nos dois temas). Fases 1+
(primitivos shadcn, Sidebar, Skeleton, Resizable, página por página)
continuam em sessões seguintes — plano completo com a ordem e os
critérios de cada fase está registrado em `.claude/plans/
crystalline-drifting-key.md` (aprovado nesta mesma sessão).

### Fase 1: primitivos base
`card dialog select input tabs tooltip badge skeleton popover` instalados
via `shadcn add`. Ícones `lucide-react` que vieram por padrão em `select`
e `dialog` foram trocados por Tabler (mesmo tratamento da Fase 0); a
dependência `lucide-react` foi removida do `package.json` — nada no
projeto a referencia. `TooltipProvider` adicionado na raiz (`main.tsx`),
exigido pelo componente `Tooltip`.

### Fase 2: Sidebar
`Shell.tsx` reescrito em cima de `SidebarProvider`/`Sidebar`/
`SidebarHeader`/`SidebarContent`/`SidebarGroup`/`SidebarMenu*`/
`SidebarFooter`/`SidebarRail` (shadcn `sidebar` + suas dependências
`sheet`, `separator`, `use-mobile`). Mesma navegação (`NAV`→
`NAV_SECTIONS`, agora agrupada por seção em vez de marcadores de grupo
soltos; `SETTINGS_NAV` idêntico) e mesmas rotas — nenhuma URL mudou.

Ganhos automáticos do componente shadcn, sem código extra:
- **Transição suave** ao recolher/expandir (`collapsible="icon"`) —
  o que a barra antiga não tinha (troca abrupta de uma CSS var).
- **Menu mobile vira um drawer de verdade** (`Sheet`), substituindo o
  dropdown vertical absoluto que a barra antiga desenhava à mão.
- Estado de expandido/recolhido passa a ser persistido via cookie
  (padrão do componente) em vez da chave `localStorage`
  `sidebar-collapsed` de antes — mesma ideia, mecanismo do shadcn.

`ThemeToggle` (claro/escuro) virou um item fixo no rodapé da sidebar
(sempre visível, com tooltip quando recolhida) em vez de existir em
dois lugares (dentro de Configurações quando expandida, isolado quando
recolhida) — um só lugar, sempre alcançável, em vez de duas
implementações do mesmo controle.

`App.tsx` envolve a árvore com `SidebarProvider`/`SidebarInset`; a
antiga `<div className="app">` (grid CSS de duas colunas) sai de uso.
Uma barra compacta (`md:hidden`) com o `SidebarTrigger` cobre a
abertura do menu em telas pequenas.

**CSS legado não removido nesta fase**: `.app`, `.sidebar*`, `.nav*`,
`.brandmark*` em `base.css` ficaram sem nenhum ponto de uso após a
reescrita, mas a remoção fica para a Fase 6 (limpeza final), como já
prevista no plano — reduz o tamanho do diff desta fase e mantém
reversibilidade caso a Sidebar nova precise de ajuste.

### Fase 3: Skeleton
O componente `Spinner` (texto "Carregando…" sozinho, sem forma) foi
removido; no lugar, quatro blocos reaproveitáveis em `components/ui`
sobre o `Skeleton` do shadcn: `SkeletonLines` (linhas de texto),
`SkeletonBlock` (um retângulo, pra área de gráfico/diagrama),
`SkeletonStats` (pares label+valor, pro formato de KPI) e `CardSkeleton`/
`PageSkeleton` (compõem os três anteriores dentro do `Card`/`.bento` já
existentes). Cada ponto de carregamento passou a usar o formato mais
parecido com o que aparece ali quando os dados chegam — texto pros
cards de lista, um bloco só pra diagramas (fluxo entre contas,
projeção de patrimônio), pares label+valor pros KPIs — em vez de um
retângulo genérico.

O Painel (maior superfície, 14 cards) ganhou um esqueleto que espelha
`DEFAULT_BENTO_LAYOUT` — mesma ordem e mesmos spans dos cards reais,
lidos diretamente da constante (sem duplicar a lista à mão), cada um
com o formato (`lines`/`stats`/`block`) que mais parece com o card
que ele antecede. As outras 9 páginas com um carregamento de página
inteira (Dre, CreditCards, Debt, Goals, FinancialHealth,
FinancialEngine, Import, Pricing, Investments — esta com 5 pontos
distintos, uma por aba) trocaram `EmptyState`/`Spinner` por
`SkeletonLines`/`SkeletonBlock` no mesmo lugar em que já estavam,
mantendo o `Card`/`Modal` que já os envolvia.

## Alternativas consideradas
- **Radix UI puro, sem Tailwind**: descartada pelo usuário — perderia
  o CLI e as atualizações do shadcn, na prática não seria "usar
  shadcn".
- **Só os 3 componentes citados, sistema atual intocado no resto**:
  descartada pelo usuário — escopo explícito é o sistema inteiro.
- **Ligar o Preflight do Tailwind já na Fase 0**: descartada — mudaria
  o reset de toda página de uma vez, inclusive as 13 ainda não
  migradas; adiado pra depois da última página migrada.
- **Duplicar cores no `:root`/`.dark` do jeito que o preset padrão do
  shadcn gera**: descartada — os tokens já existem e já trocam sob
  `data-theme`; duplicar criaria uma segunda fonte de verdade pra
  manter sincronizada.

## Consequências
- `@fontsource-variable/geist` (instalado pelo preset "Nova" do
  shadcn) foi removido — o app continua com Barlow Condensed/Inter/
  JetBrains Mono, os mesmos de sempre.
- `components.json`'s `iconLibrary` ficou como `"lucide"` (não é um
  valor suportado do CLI para "tabler") — só afeta o que `shadcn add`
  importaria de ícone POR PADRÃO num componente novo; qualquer import
  de ícone que aparecer assim em uma Fase futura é trocado à mão pelo
  Tabler no momento de adicionar aquele componente, não corrigido aqui
  antecipadamente.
- CSS final ficou ~20KB maior (utilities do Tailwind geradas, mesmo
  sem nenhuma página usar uma classe ainda) — esperado, cai
  naturalmente conforme mais Tailwind substitui CSS próprio nas fases
  seguintes.
