# 0031. Migração da camada de UI para shadcn/ui + Tailwind CSS + Tabler Icons

Status: aceita (em andamento — Fase 0 concluída)

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
