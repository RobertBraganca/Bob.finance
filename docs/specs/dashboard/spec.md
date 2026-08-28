# Spec: Painel (Dashboard)

Status: implementado

## Objetivo
Uma tela só, com o resultado do período selecionado e tudo que cruza com
ele — cartão, pendência, fluxo entre contas — sem precisar abrir outra tela
para montar o quadro completo.

## Histórias de usuário
- Como usuário, eu quero ver entradas, saídas e resultado do período
  selecionado, comparado com o período anterior.
- Como usuário, eu quero ver limite disponível de cada cartão sem abrir o
  app do banco.
- Como usuário, eu quero ver quanto já está confirmado para entrar/sair no
  período mesmo antes de postar no banco.
- Como usuário, eu quero saber quanto de uma transferência interna não
  achou par (perna solta), porque isso geralmente indica extrato faltando.
- Como usuário, eu quero ver de qual conta o dinheiro saiu e em qual entrou,
  com a espessura do caminho proporcional ao valor, para enxergar o
  pareamento em si e não apenas o total que cada conta movimentou.

## Modelo de dados
Lê de `transactions` (via `services/analytics.ts`), `creditCards` +
`creditCardSnapshots`, e `cashFlowForecasts` materializados em
`transactions` (`pending = true`). Não escreve nada além do que os
componentes filhos (pendência, conciliação) já escrevem por conta própria.

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/dashboard` | GET | `{from, to, accountId?}` → totais, deltas vs. período anterior, série mensal, quebra por categoria (entradas e saídas), fluxo acumulado, maiores saídas |
| `/analytics/flows` | GET | Grafo de transferência entre contas próprias, pareado por valor+data — ignora o filtro de conta (não haveria nada para desenhar) |
| `/credit-cards` | GET | Ver `specs/credit-cards` |
| `/cash-flow/pending`, `/cash-flow/reconciliation-candidates` | GET | Ver `specs/cash-flow-reconciliation` |

## Regras de negócio
- **Todo total exclui `pending = 1`** — nunca conta uma pendência como
  realizado.
- **Delta vs. período anterior** compara contra a janela imediatamente
  anterior de mesma duração, não contra o mesmo mês do ano anterior.
- **Cartões de crédito ignoram o filtro de período** — limite e ciclo são
  um fato de "agora", não do passado.
- **O seletor de período** (`RangeFilter` → `PeriodPickerPopover`,
  `src/components/shell/Shell.tsx` / `src/components/ui/PeriodPickerPopover.tsx`)
  é global, único e o mesmo componente em Dashboard, Lançamentos e DRE —
  nenhuma tela reimplementa sua própria versão. Um gatilho compacto abre um
  popup com atalhos (3m/6m/12m/ano/máximo/personalizado) e uma grade de
  mês/ano para escolher qualquer mês específico, não só o atual. Mudar o
  período aqui move todo painel da tela, nunca um filtro isolado dentro de
  um card. Todo preset (exceto personalizado) tem `to` no máximo "hoje"
  (nenhum olha para o futuro).
- **O gráfico diário (`IncomeExpenseChart`) ativa para qualquer período de
  até 31 dias, não só o atalho "mês atual".** Correção sobre um bug
  confirmado: o backend (`dailySeries`, `services/analytics.ts`) já
  calcula a série diária para qualquer intervalo curto; o front-end não
  deveria checar `range.preset === 'mtd'`, e sim o tamanho real do
  intervalo (`daily.length > 0` já basta, o backend só preenche esse campo
  quando o intervalo cabe). Escolher um mês específico pela grade do
  seletor (não o atalho) deve mostrar a mesma granularidade diária que o
  mês atual mostra.
- **"Máximo" tem dois significados diferentes no app, cada um correto no
  próprio contexto, mas com o mesmo rótulo.** No seletor principal
  (`RangeProvider`), "Máximo" é todo o histórico do ledger (do primeiro
  lançamento até hoje). Nos cards de pendência (`forwardBoundsFor`),
  "Máximo" é 24 meses **à frente** a partir de hoje — pendência é sempre
  sobre o futuro, então o mesmo rótulo aponta para uma direção oposta.
  Confirmado como fonte real de confusão num teste de uso: o rótulo
  exibido no card de pendência para essa janela é "Todo o horizonte à
  frente", nunca "Máximo" — só o texto muda, o valor interno do preset
  (`'max'`) continua o mesmo, e o `PeriodPickerPopover` principal não é
  afetado.
- **"Fluxo entre contas" é um Sankey de duas colunas.** Cada conta pode
  aparecer duas vezes, uma como origem e uma como destino, mesmo sendo a
  mesma conta. Isso não é enfeite: neste ledger todo par de contas que
  movimenta dinheiro movimenta nos dois sentidos (a PJ repassa para a PF, a
  PF eventualmente devolve), então um nó por conta produziria um ciclo em
  cada par e nenhum layout de Sankey ordena um grafo cíclico. Com duas
  colunas o grafo é acíclico por construção. A cor segue a conta, então a
  mesma conta tem a mesma cor nos dois lados; o rótulo repetido é o que
  identifica, não a cor. Antes disso a tela era um radar de entradas x
  saídas por conta, que comparava formas mas não conseguia mostrar o
  pareamento, que é justamente o que esta feature descreve.
- **Perna sem par não entra no diagrama.** Sem contraparte ela não tem
  direção, logo não tem aresta. Ela continua na lista "Ver pernas sem par" e
  no resumo textual, que reporta o valor pareado e o não pareado lado a
  lado. O radar anterior somava as pernas sem par nos totais por conta;
  um diagrama de "de onde para onde" não tem como fazer isso honestamente.
- **A soma das arestas é sempre igual ao total pareado do resumo textual** —
  as duas representações leem o mesmo `internalCents`, nunca dois cálculos
  paralelos. Coberto em `scripts/verify.ts` (módulo 12).
- **Cards de pendência não seguem o `from` do período selecionado** — eles
  olham para a frente a partir de hoje (`forwardBoundsFor`), porque
  "pendente" é sobre o que ainda vai acontecer, não sobre o passado; o
  preset escolhido decide só a largura da janela (mês atual → 1 mês à
  frente, 12m → 12 meses à frente, etc.). Uma pendência mais antiga que
  nunca foi resolvida continua aparecendo, marcada como atrasada — ver
  `specs/cash-flow-reconciliation`.

## UI
`Dashboard.tsx`. Ordem da grade: KPI hero (resultado do período) → Entradas
/ Saídas → Contas → Cartões de crédito → conciliação sugerida → pendências
(receita, despesa) → gráfico entradas x saídas → anéis de categoria
(entrada e saída) → resultado acumulado → maiores saídas → fluxo entre
contas (Sankey, `AccountFlowSankey.tsx`, sobre o grafo puro de
`shared/accountFlowGraph.ts`) → aviso de lançamento sem categoria (se
houver). O card "Contas" tem, por linha, um ícone de balança que abre a
mesma "Conferência de saldo" de `specs/settings-accounts-profiles`
(`decisions/0018`) e um lápis que abre o mesmo editor de conta (nome,
instituição, tipo — sem saldo, que não se edita mais direto) — os dois
sem precisar sair do painel.

## Casos de borda
- Sem nenhum dado importado: tela de "primeiro passo" (`FirstRun`), não um
  dashboard vazio com zeros.
- Nenhuma pendência no período: card mostra R$ 0,00, não desaparece — o
  usuário precisa saber que olhou e não há nada, não adivinhar se o card
  carregou.

## Fora de escopo
- Edição de lançamento direto do dashboard — isso é `Lançamentos`
  (`Transactions.tsx`).
- Meta de gasto por categoria — isso é `specs/monthly-goals`.

## "Modo mês" (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero um resumo do mês corrente numa faixa só —
  receita, gasto, investimento, dívida, reserva, cada um com sua meta ao
  lado — para não abrir 4 telas diferentes para saber se o mês está indo
  bem.

### Modelo de dados
Nenhuma tabela nova, nenhum endpoint novo. Composição no frontend de
respostas que já existem: `getPeriodProgress` (receita e gasto, ver
`specs/monthly-goals`), `investmentGoals`/aportes do mês (`specs/investments`),
parcelas pagas de dívida do mês (`specs/debt`), progresso da reserva
(`specs/investments`, "reserva de emergência").

### Regras de negócio
- **O card segue o seletor de período global (`useRange()`), sempre, sem
  substituir o mês por outro.** Correção sobre a primeira implementação,
  que lia `meta.ledger.max`/`today` direto e ignorava o mesmo `period` que
  todo outro card do Painel já respeita. Uma segunda correção, também
  incorreta, recuava um mês sempre que o fim do período selecionado caía
  no mês corrente ("mesma regra de comprometimento de renda de
  `specs/debt`") — isso quebrava o card na visão padrão do Painel (6
  meses, terminando hoje): "Modo mês" sempre mostrava o mês **anterior**
  ao atual, silenciosamente, mesmo sem o usuário ter escolhido isso.
  Confirmado como bug num teste de uso real. A regra certa é a de
  `specs/monthly-goals` ("mês corrente sempre mostra progresso, nunca um
  veredito prematuro"), não a de `specs/debt` (que existe para uma
  proporção que fica enganosa com dado parcial, o que não é o caso aqui):
  "Modo mês" mostra exatamente o mês do fim do período selecionado, com um
  qualificador "em andamento" no subtítulo quando esse mês ainda não
  fechou — nunca troca de mês por conta própria.
- **Status do mês** é derivado, não gravado: "No caminho" quando nenhuma das
  cinco linhas está fora da faixa configurada no Radar de risco
  (`specs/financial-health`) para aquele indicador; "Atenção" quando pelo
  menos uma está. Reusa os mesmos thresholds do radar — não introduz um
  segundo conjunto de limites configuráveis para a mesma decisão.
- **Nenhuma meta configurada em nenhuma das cinco linhas**: card mostra os
  valores realizados sem barra de progresso comparativa, sem inventar meta
  nem esconder a linha.
- Continua Observação — "você está 8% abaixo do ritmo esperado de gastos" é
  uma leitura do mesmo `pace` já usado em `specs/daily-ledger`, não um
  cálculo novo.

### UI
Card no topo do Painel, faixa horizontal com as cinco linhas (receita,
gasto, investimento, dívida, reserva), cada uma com valor realizado / meta
e uma barra curta; selo de status (`No caminho`/`Atenção`) à direita,
seguindo o mesmo par de cores do Radar de risco. **Barra colorida por
estado** (verde dentro/acima da meta, amarelo perto do limite, vermelho
fora), revertendo a barra neutra da primeira implementação — confirmado
por uso real que o sinal visual faz falta aqui, mesmo repetindo um pouco o
Health Score. O estado de cada linha não é um limite novo: Receita e Gasto
reusam `targetState`/`capState` de `specs/monthly-goals` (expostos em
`progress.income.state`/`progress.spend.state` de `GET /goals/:period`);
Investimento, Dívida e Reserva reusam a mesma `targetState` a partir de
`services/financialEngine.ts` (`Destination.state`, `GET
/financial-engine/available`) — o mesmo vocabulário de cinco estados
(`met`/`on_track`/`at_risk`/`missed`/`no_target`) em toda a linha, nunca um
segundo cálculo de "isso está bom ou ruim" inventado só para este card.
Cor nunca é o único sinal: sempre acompanhada de ícone,
mesma regra do resto do app (ver README, seção "Design").

Fora do vocabulário de metas/período (`GoalState`, acima), duas outras
famílias de barra têm cada uma um único classificador compartilhado em
`src/components/ui/index.tsx`, para que o mesmo % sempre leia a mesma cor
em toda tela que mostra esse tipo de indicador: `capUsageState` (uso
contra um limite rígido — cartões de crédito, tanto no Slab do Dashboard
quanto no modal de limite de `CreditCards.tsx`) e `targetProgressState`
(progresso acumulado até uma meta sem conceito de ritmo mensal — a
Reserva de emergência em `Investments.tsx`). Os indicadores da Saúde
financeira são a única exceção deliberada: ficam sempre neutros por
design (ver o comentário no topo de `FinancialHealth.tsx`), porque
colorir um número que o usuário nunca configurou como meta seria o
produto julgando, não evidenciando (`decisions/0010`).

### Casos de borda
- Mês corrente sem nenhum dado ainda (dia 1, nada lançado): todas as
  barras em zero, card presente, não escondido até haver dado.
