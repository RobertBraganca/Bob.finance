# Spec: Metas do mês

Status: implementado

## Objetivo
Meta de receita e teto de gasto (geral e por categoria) por mês, com
histórico que não se reescreve quando a meta do mês atual muda.

## Histórias de usuário
- Como usuário, eu quero definir uma meta de receita e um teto de gasto por
  mês, e ver se bati a meta só depois que o mês fecha.
- Como usuário, eu quero um teto por categoria (ex. Alimentação), somando
  automaticamente as subcategorias.
- Como usuário, eu quero copiar o orçamento de um mês para o próximo sem
  redigitar tudo.
- Como usuário, eu quero uma sugestão de teto baseada no meu histórico real.

## Modelo de dados
- `monthlyGoals` — meta de receita e teto geral, uma linha por `period`
  (`YYYY-MM`).
- `categoryCaps` — teto por categoria, também por período.

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/goals/:period` | GET/PUT | Meta do mês |
| `/goals/:period/caps/:categoryId` | PUT/DELETE | Teto por categoria |
| `/goals/:period/copy-from/:source` | POST | Copia orçamento de outro período |
| `/goals/:period/suggestions` | GET | Sugestão de teto pelo histórico |
| `/goals-history` | GET | Série de 6 meses + sequência de acertos |

## Regras de negócio
- **Meta guardada por mês, nunca reescrita retroativamente.** Mudar a meta
  de agosto não altera o histórico de julho — é o que faz a "sequência de
  acertos" significar algo real.
- **Teto na categoria-mãe soma o gasto das categorias-filhas** automaticamente.
- **"Bateu a meta" só é avaliado em mês fechado** — mês corrente sempre
  mostra progresso, nunca um veredito prematuro.
- **Sem meta definida → estado é `no_target`**, nunca tratado como zero (zero
  seria uma meta batida por padrão, o que é falso).
- Sugestão de teto vem da média do histórico real da categoria, não de um
  número redondo arbitrário.

## UI
`Goals.tsx`: card de meta de receita/teto geral, tabela de tetos por
categoria, histórico de 6 meses com sequência de acertos, botão "copiar do
mês anterior".

## Casos de borda
- Copiar de um mês sem orçamento definido: nada para copiar, erro claro.
- Categoria com teto mas sem nenhum gasto no mês: 0% de uso, não "sem
  dado".

## Fora de escopo
- Meta de investimento — isso é `specs/investments` (`investmentGoals`,
  tabela diferente e semântica diferente: meta de valor acumulado, não teto
  de gasto).

## Meta de receita em número de projetos (Status: implementado)

### Histórias de usuário
- Como profissional criativo, eu quero ver quanto falta da minha meta de
  receita do mês traduzido em "quantos projetos parecidos com os que eu
  cotei recentemente", não só em reais.

### Modelo de dados
Nenhuma tabela nova. Cruza `monthlyGoals.incomeTargetCents` menos
`actual.incomeCents` (já calculado por `getPeriodProgress`, ver acima) com
o histórico de `projectQuotes.recommendedPriceCents`
(`specs/project-pricing`).

### Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/goals/:period/gap-in-projects` | GET | `{gapCents, averageQuoteCents, projectsNeeded, sampleSize}` |

### Regras de negócio
- **`averageQuoteCents`** = média das últimas N cotações salvas
  (`projectQuotes`, default N = 5, configurável), não de todo o histórico —
  um ticket médio de 2 anos atrás não representa o que o usuário cobra
  hoje.
- **`projectsNeeded`** = `Math.ceil(gapCents / averageQuoteCents)`, sempre
  arredondado para cima — "1,7 projeto" não é uma coisa que se fecha, então
  a resposta honesta é "2 projetos", nunca uma fração.
- **Sem cotação salva ainda** (`sampleSize === 0`): endpoint devolve
  `averageQuoteCents: null` e `projectsNeeded: null`, nunca um valor
  inventado — a tela mostra só o gap em reais, sem a tradução em projetos.
- **Meta do mês não configurada** (`no_target`, ver regra já existente
  desta área): mesmo estado, sem gap para traduzir.
- Continua Observação/Projeção, nunca prescrição de quanto cobrar — isso já
  é o limite de `specs/project-pricing`, este endpoint só divide dois
  números que já existem em outro lugar.

### UI
Linha adicional no card de meta de receita: "faltam R$X, aproximadamente N
projetos de R$Y (média das últimas 5 cotações)".

### Casos de borda
- `averageQuoteCents` igual a zero (cotações salvas com preço zerado, caso
  de borda de teste): endpoint recusa a divisão e devolve o mesmo estado de
  "sem base para calcular" já usado em outras divisões do produto.

## Termômetro mensal — avisos dispensáveis do Painel (Status: implementado, 29/08/2026)

### Histórias de usuário
- Como usuário, eu quero um aviso na Visão geral quando o mês está fugindo
  do planejado (estourou/está no ritmo de estourar um teto, uma categoria
  concentra boa parte do gasto, ou o mês está pior/melhor que o anterior)
  — sem precisar abrir Metas do mês pra descobrir sozinho.

### Modelo de dados
Nenhuma tabela nova. `homeBanners()` (`goals.ts`) compõe `getPeriodProgress`
do mês corrente e do mês anterior (já existentes acima) com
`categoryBreakdown` (`specs/dashboard`/`analytics.ts`, nível parent) do mês
corrente.

### Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/home/banners` | GET | `{banners: HomeBanner[]}` — dado bruto (cents/bps/nome), nunca a frase pronta; formatação de moeda/percentual é sempre client-side (`Dashboard.tsx`) |

### Regras de negócio
- **Nunca um veredito, sempre uma leitura do que já está acontecendo** —
  mesma régua desta spec ("mês corrente sempre mostra progresso, nunca
  veredito prematuro"). "No ritmo atual, você deve fechar o mês em X" é uma
  projeção (`spentCents` extrapolado pelos dias já decorridos do mês), não
  "você vai estourar".
- **No máximo 3 avisos ao mesmo tempo**, ordenados por severidade
  (crítico > atenção > positivo) — "aviso" implica exceção, um mural de 8
  cards seria ruído, não sinal.
- **No máximo 1 aviso de categoria com teto** (a mais grave, por % usado) —
  evita que 3 categorias apertadas virem 3 avisos repetindo a mesma
  notícia.
- **Concentração de categoria pula a categoria que já virou aviso de
  teto** (dedup por `categoryId`) — mesma notícia, duas vezes, é ruído.
- **Tendência compara a PROJEÇÃO de fechamento do mês corrente contra o
  total JÁ FECHADO do mês anterior**, nunca o gasto parcial de hoje contra
  o fechado do mês passado — comparar parcial-com-fechado faria todo início
  de mês parecer uma economia enorme.
- **Limites de "vira aviso" não são configuráveis** (concentração >= 40%,
  tendência +15%/-10%): abaixo disso é variação normal do dia a dia, não
  notícia — mesmo espírito de `AT_RISK_AT` (85%) já usado no resto desta
  spec.
- **Dispensar é só de HOJE** (localStorage do navegador, chave por data) —
  se o motivo do aviso continuar amanhã, ele volta. Nunca é "não mostrar
  isso de novo".
- Reusa o componente `Alert` do shadcn/ui (`src/components/ui/alert.tsx`),
  com 3 variantes novas (`good`/`warning`/`critical`) coloridas via
  `color-mix()` contra os tokens `--status-*` já existentes — adapta
  sozinho a claro/escuro, não duplica um segundo jogo de hex como o
  `.badge` legado faz.

### UI
Faixa de avisos no topo da Visão geral, acima do grid de cards
personalizável — diferente de "Modo mês" (`specs/dashboard`), que é um
card fixo sempre visível. Cada aviso tem um botão de dispensar (✕).

### Fora de escopo
- Notificação push/e-mail — isso exigiria infraestrutura nova (service
  worker, provedor de push); o termômetro de hoje só aparece quando o
  usuário já abriu o app.
