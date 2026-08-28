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
