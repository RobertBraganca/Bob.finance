# Backlog de ideias — levantamento de 07/09/2026

Status: rascunho para decisão. Nenhum item aqui foi implementado — é o
material para o usuário confirmar direção antes de qualquer código, seguindo
o mesmo formato de `<execution_task>` usado no resto do projeto. Cada item
foi investigado contra o código REAL antes de ser escrito (três agentes de
exploração, 07/09/2026), então "o que já existe" abaixo é fato, não suposição.

Dois itens vieram de um pedido direto do usuário (log de uso, evolução da
dívida); os demais são inspirados nas telas de um app concorrente (imagens
01-08 anexadas na conversa) e foram traduzidos para o modelo de dados e o
design system JÁ existentes neste projeto — nenhuma cor, fonte ou padrão de
componente novo é proposto onde um equivalente já existe.

## Nota de segurança

Uma chave de API (`sk-aAZqumC05BMIqOPzIQKPtpuSKCwfpBlQ`, rotulada "API app
Pierri finance") foi colada em texto puro na conversa que originou este
documento. Ela não foi usada, gravada em nenhum arquivo nem transmitida para
lugar nenhum por este agente — mas já está exposta no histórico da conversa.
Trate-a como comprometida: revogue/gire essa chave no painel do app de
origem assim que possível.

## Análise de uso real (usage_events, 28/08 a 07/09/2026, 1.018 eventos)

| Tela | Visitas | Ações |
|---|---|---|
| Visão geral | 277 | 0 |
| Lançamentos | 142 | 0 |
| Diário | 72 | 0 |
| Saúde financeira | 55 | 0 |
| Investimentos | 53 | 2 |
| DRE | 46 | 0 |
| Patrimônio | 46 | 0 |
| Motor financeiro | 43 | 0 |
| Precificação | 39 | 4 |
| Endividamento | 31 | 1 |
| Metas do mês | 29 | 0 |
| Receita de parceiros | 17 | 0 |
| Aposentadoria | 13 | 0 |
| Categorias | 10 | 0 |
| Importar | 7 | 6 |
| Cartões | 6 | 0 |
| Configurações | 3 | 0 |

Visão geral e Lançamentos são de longe as telas mais usadas — coerente com
os itens 1, 7 e 8 abaixo mirando exatamente essas duas.

Achado incômodo no caminho, fora do escopo deste backlog mas vale registro:
**107 erros `http_401` na function `insights`**, quase todos em `/meta`,
concentrados em sessões que ficam abertas de um dia para o outro — é a
mesma corrida de largada entre o token do Supabase terminar de carregar e a
primeira leva de queries disparar, já tratada no cliente (`retry: 1` do
QueryClient) e sem impacto real percebido, não um bug novo. Um único
`http_546` em `/partners` no dia 07/09 é ruído isolado (código de status
não-padrão vindo de algum lugar da cadeia de proxy), não investigado a
fundo.

---

## Ordem sugerida por esforço

| # | Item | Esforço | Por quê |
|---|---|---|---|
| 1 | Evolução da dívida (gráfico) | **P** | Dado já existe, já sai da API, nunca foi lido pelo front — é 90% trabalho de tela |
| 2 | Ritmo de gastos (gráfico) | **P/M** | Agregação diária já existe no servidor, comentada explicitamente para este uso |
| 3 | Mapa de calor (gráfico) | **P/M** | Mesma agregação diária do item 2; só falta o componente visual, que não existe ainda |
| 4 | Sistema de filtros (Lançamentos) | **M** | Metade dos controles já existe; falta ordenação, um seletor de categoria de verdade, e decidir o que "oculto" significa |
| 5 | Categorias (visão por gasto) | **M** | `CategoryRing` já existe e já é usado no Dashboard; falta só a página dedicada com navegação por mês |
| 6 | Parcelamentos | **M/G** | Os números já existem em `cash_flow_forecasts`; falta uma função de agregação nova e uma tela inteira |
| 7 | Cartões (atualização) | **G** | "Fatura atual" não existe como conceito no back hoje — é a peça que falta antes de qualquer UI nova |
| 8 | Assinaturas (detecção automática) | **G** | Não existe detecção de recorrência por padrão de transação hoje, só previsão manual — é a feature mais nova de verdade deste lote |

---

## 1. Endividamento: gráfico de evolução do saldo

### Pedido original
"Endividamento não mostra o ponto onde eu estava e compara com a dívida
atual, seria interessante ter esse comparativo em gráfico para entender o
quanto a dívida era o valor dela de acordo com os pagamentos das parcelas."

### O que já existe
- `debtTrend()` (`server/src/services/debt.ts:805-826`) já calcula a série
  histórica de saldo total (soma de todas as dívidas ativas, por data de
  snapshot) — exatamente o número que falta na tela.
- **Já está na resposta de `GET /debts`** (`server/src/routes/insights.ts:246-251`,
  campo `trend`) — mas `src/pages/Debt.tsx` nunca lê `data.trend`. O dado
  chega ao navegador e é descartado.
- `NetWorthHistoryChart` (`src/components/charts/NetWorthHistoryChart.tsx`)
  é o padrão visual pronto para copiar: `{period, valorCents}[]` num
  `LineChart` dentro de `ChartFrame`, com eixo em `axisMoney` e tabela de
  apoio — mesma forma do problema, só trocando `period`/`netWorthCents` por
  `asOf`/`balanceCents`.

### O que falta
Só a tela: um novo card "Evolução da dívida" (span 12), encaixando logo
depois de "Trajetória até a quitação" e antes da "Fila de conciliação"
(ordem atual do Bento em `Debt.tsx:239-513`), lendo `data.trend` e
renderizando com o mesmo padrão de `NetWorthHistoryChart`.

### Decisão em aberto — importante
`debt_snapshots` só ganha uma linha nova quando o usuário clica
"Registrar saldo de hoje" no modal de edição (`Debt.tsx:837-848`) — **pagar
uma parcela não grava snapshot nenhum**. Para a maioria dos usuários a série
vai ter só 1 ponto (o principal na criação da dívida) a menos que a pessoa
registre saldo manualmente com frequência. Duas saídas possíveis, não
mutuamente exclusivas:
- (a) Deixar como está e aceitar que o gráfico só fica rico para quem
  registra saldo manualmente — o número mostrado nunca mente, só é raso.
- (b) Estender `recordPayment`/`recordSnapshot` (`debt.ts`) para também
  gravar um snapshot automático a cada pagamento confirmado, usando o saldo
  já derivado menos o valor pago — isso POPULARIA o gráfico sozinho, sem
  ação extra do usuário, e é coerente com "derivação em vez de saldo
  guardado" (o snapshot continua sendo uma MEDIÇÃO, não uma segunda fonte de
  verdade).

Recomendação: (b) é o que faz esta feature valer a pena de verdade — sem
ela, o gráfico nasce quase sempre vazio.

---

## 2. Ritmo de gastos (gráfico)

### Referência
Linha vermelha sólida = gasto acumulado dia a dia do mês atual; linha cinza
tracejada = mesmo acumulado do mês anterior; selo "+R$X vs mês anterior".

### O que já existe
- `analytics.ts` já tem `dailySeries()` (linhas 317-343) — gasto por dia,
  com um comentário que já antecipa exatamente isto: *"Daily spend — feeds
  the calendar heatmap and the pace comparison."* Alguém já projetou este
  dado para este uso, só nunca construiu a tela.
- Exposto via `GET /analytics/daily` (`insights.ts:115-158`), já consumido
  por `Daily.tsx` (página Diário) — mas ali vira comparação contra um TETO
  de gastos configurado, não contra o mês anterior.

### O que falta
- Um acumulado (soma corrida) não existe ainda — é uma transformação no
  cliente (`reduce`) sobre a série diária de hoje, mais uma segunda chamada
  de `dailySeries` para o mês anterior.
- Nenhum gráfico do projeto tem hoje o padrão "sólido este período / tracejado
  período anterior, mesmo eixo relativo (dia 1 a N)" — o mais próximo é
  `ProfitabilityChart.tsx` (linha tracejada para o CDI vs sólida para a
  carteira), útil como referência de como o `strokeDasharray` já é usado no
  projeto, mas é benchmark-vs-carteira, não período-vs-período.

### Onde colocar
Card novo no Dashboard (Visão geral), coerente com o pedido anterior desta
mesma conversa de "a Home tem muito número e texto, falta um gráfico de
abertura" — este é candidato natural a esse gráfico de abertura.

---

## 3. Mapa de calor (gráfico)

### Referência
Grade semanal (linhas D-S-T-Q-Q-S-S), cada dia sombreado pela intensidade do
gasto, tooltip com data + total + nº de transações, legenda "Menos → Mais",
selo "maior gasto".

### O que já existe
- A MESMA `dailySeries()` do item 2 — o comentário já citado confirma que
  esse dado foi pensado desde o início para alimentar um mapa de calor.
  Nenhuma chamada nova ao servidor é necessária.

### O que falta
- Nenhum componente de calendário/grade existe no projeto hoje (busca em
  `src/components/` por "heatmap"/"calendar"/grade-de-7-colunas não achou
  nada, só um comentário de CSS mencionando "heatmap" como estilo de card
  futuro, `src/styles/tokens.css`). Este é o único item do lote que exige um
  tipo de gráfico genuinamente novo — nenhum padrão visual do projeto cobre
  "grade de dias sombreada por intensidade".
- Precisa de paleta sequencial — o projeto já tem uma (`--seq-*` em
  `tokens.css`, usada em `chartTheme.ts`'s `sequential`), que é exatamente o
  tipo de escala que este mapa de calor pede. Reusar essa escala, não
  inventar uma nova.

### Onde colocar
Mesmo candidato do item 2 — Dashboard ou uma aba dedicada em Diário/
Lançamentos.

---

## 4. Sistema de filtros (Lançamentos)

### Referência
Uma barra horizontal: conta, tipo de transação, ordenação, categoria (chip),
toggle "mostrar ocultos", "limpar filtros".

### O que já existe hoje em `Transactions.tsx`
| Controle | Onde | Situação |
|---|---|---|
| Intervalo de datas | `RangeFilter` (`Shell.tsx`) | existe |
| Conta | `FilterSelect` dentro do mesmo `RangeFilter` | existe, mas embutido no filtro de período, não solto na barra de Lançamentos |
| Direção (Entrada/Saída/Transferência) | `Segmented`, linha 345-357 | existe |
| Busca por texto | `TextInput`, linha 336-343 | existe |
| "Só sem categoria" | checkbox simples, linha 358-369 | existe |
| Categoria | badge removível (só aparece se veio de navegação por URL) | **não é um seletor** — só mostra e limpa, não permite ESCOLHER uma categoria ali |
| Ordenação | nenhuma | **não existe** — nem no cliente nem na query do servidor |
| Ocultar/mostrar ocultos | nenhum | **não existe nenhum conceito de "transação oculta"** hoje — só existe arquivamento de CONTA (`Settings.tsx`), não de lançamento |
| Limpar filtros | nenhum | **não existe** |

`FilterSelect`/`Dropdown.tsx` já são os primitivos corretos para qualquer
controle novo — o próprio comentário do arquivo já os declara como "o
controle canônico para todo dropdown que ESCOPA uma visão."

### Decisão em aberto — importante
**"Mostrar ocultos" pede um conceito que não existe no modelo de dados.** Antes
de construir esse toggle, decidir o que "oculto" significa neste app:
- (a) Um lançamento pode ser marcado "oculto" manualmente pelo usuário (ex.
  uma transferência interna que ele não quer ver no dia a dia) — exigiria
  uma coluna nova em `transactions` (`hidden boolean default false`).
- (b) "Oculto" na verdade quer dizer "de uma conta arquivada" — nesse caso o
  conceito já existe (`accounts.archived`), e o toggle só precisa mudar o
  filtro de conta que `listTransactions` já aplica.

Sem essa decisão, construir o toggle é adivinhar um requisito.

### Sugestão de ordenação
Dado que não existe nenhuma hoje: adicionar `sort` (`date_desc` padrão,
`date_asc`, `amount_desc`, `amount_asc`) tanto na query do cliente quanto no
`ORDER BY` de `listTransactions` (`server/src/services/transactions.ts`) —
mudança pequena e sem ambiguidade, ao contrário do toggle de ocultos.

---

## 5. Categorias — visão por gasto (nova)

### Referência
Anel de rosca + total do mês + lista de categorias-pai, cada uma com valor e
barra de participação, navegação por mês (< Setembro de 2026 >).

### O que já existe
- `src/pages/Categories.tsx` hoje é **só gestão de regras/hierarquia**
  (abas Árvore / Regras / Aprendizado) — confirmado, zero número de gasto,
  zero anel, zero navegação por mês.
- `CategoryRing` (`src/components/charts/CategoryRing.tsx`) já é exatamente
  o anel + lista ranqueada da referência, e já roda em produção — usado
  duas vezes no Dashboard (`income-by-category`/`expense-by-category`,
  `Dashboard.tsx:385-403`).

### O que falta
Uma tela nova (ou aba nova dentro de Categorias) que:
- Reusa `CategoryRing` como está.
- Troca o range picker atual (mês/trimestre/custom, o `RangeFilter` de
  sempre) por um stepper de UM mês só (`<` / `Setembro de 2026` / `>`) —
  mais perto do `PeriodNav` já usado em Diário/Metas/Motor financeiro do que
  do `RangeFilter` completo, já que aqui a pergunta é sempre "este mês",
  nunca um intervalo arbitrário.

Esforço concentrado quase todo na tela; o motor de cálculo já existe.

---

## 6. Parcelamentos

### Referência
Lista de compras parceladas com contagem em-andamento/finalizadas, valor
total/pago/restante, barra de progresso por compra (ex. "12/12x, R$119,67/
mês"), toggle Em andamento/Finalizadas, "mostrar ocultos".

### O que já existe
- `cash_flow_forecasts` (kind `installment`) já guarda tudo que os números
  da referência pedem: `installmentCount`, `installmentsRealized`,
  `amountCents` (valor da parcela), `startPeriod` — não falta nenhum campo
  novo no schema.
- `listForecasts()` (`cashFlow.ts:33-40`) já lista toda previsão ativa, de
  qualquer kind, com a próxima ocorrência — é o ponto de partida natural.
- `listPending()` já computa um rótulo `"2/3"` por OCORRÊNCIA pendente
  (`cashFlow.ts:343-348`), hoje só usado como sufixo de texto numa linha do
  widget de pendentes do Dashboard (`Dashboard.tsx:1324-1328`) — não como
  agregado por compra inteira.
- Precedente visual já existe: `Debt.tsx` já mostra `"X / Y"` parcelas pagas
  para dívidas — o mesmo padrão de badge/contador, só que para
  `cashFlowForecasts` em vez de `debts`.

### O que falta
- Uma função nova (`cashFlow.ts` ou `investments.ts`, a decidir) que agregue
  por forecast de kind `installment`: total (`amountCents × installmentCount`),
  pago (`amountCents × installmentsRealized`), restante, e status
  em-andamento/finalizado (`installmentsRealized >= installmentCount`).
- Uma tela nova (`src/pages/Parcelamentos.tsx` ou aba dentro de Lançamentos)
  com o toggle Em andamento/Finalizadas e a barra de progresso por linha
  (reusar `Meter`, já usado em Debt/Metas/Investimentos).

### Decisão em aberto
"Mostrar ocultos" aqui provavelmente significa "parcelamentos cujo forecast
foi desativado" (`cashFlowForecasts.active = false`) — mais simples que o
caso equivalente do item 4, porque esse campo já existe.

---

## 7. Cartões — atualização

### Referência
Hero "Fatura atual", lista de cartões com bandeira/nome/final, "fatura
estimada" com aviso de atraso de sincronização, barra de limite usado/
disponível, gráfico de faturas passadas por mês.

### O que já existe
- `src/pages/CreditCards.tsx` hoje: um hero "Limite disponível" (soma de
  todos os cartões) + uma tabela "Cartões cadastrados" (fechamento,
  vencimento, limite usado%). **Nenhuma fatura atual, nenhum histórico de
  fatura por mês.**
- `credit_card_snapshots` guarda só `availableLimitCents` por data — não
  guarda gasto/fatura.

### O que falta — e por que é o item mais caro do lote
O comentário do próprio `creditCards.ts` já admite o buraco: *"gasto por
compra ainda não é separado do extrato da conta corrente"* — ou seja,
**não existe hoje nenhuma ligação entre uma transação e o cartão de crédito
que a originou.** Sem essa ligação:
- Não dá para calcular "fatura atual" (soma do que foi gasto NESTE cartão
  desde o último fechamento) sem antes decidir COMO uma transação de CSV
  aponta para um cartão específico.
- Não dá para montar o gráfico de faturas passadas por mês sem a mesma
  ligação, aplicada retroativamente ao histórico já importado.

Este item precisa de uma decisão de modelagem ANTES de qualquer tela: como
uma linha de `transactions` (hoje só ligada a `accountId`) passa a também
poder se ligar a um `creditCardId`? Provável caminho — mesmo padrão já usado
para dívida/previsão/parceiro (`debtId`, `forecastId`, `partnerPlatformId`,
todos FK anuláveis em `transactions`): um `creditCardId` anulável, preenchido
manualmente ao categorizar, ou por uma regra (conta = conta que paga a
fatura de um cartão específico + descrição bate um padrão).

### Nota sobre a referência
A frase do concorrente ("compras após X podem levar 1-3 dias via Open
Finance") não tem equivalente aqui — este app não tem nenhuma integração
bancária ao vivo (confirmado, busca por "open finance"/Belvo/Pluggy no
projeto inteiro não achou nada); tudo é importação de CSV. O aviso
equivalente aqui seria sobre atraso de IMPORTAÇÃO, não de sincronização
bancária — vale reescrever a frase, não traduzir literalmente.

---

## 8. Assinaturas — detecção automática

### Referência
Tela vazia até haver "pelo menos 2 pagamentos registrados" do mesmo serviço
(Netflix, Spotify etc.), momento em que o app detecta sozinho e passa a
rastrear como assinatura.

### O que já existe
- **Nada faz detecção de recorrência por padrão de transação hoje.** Toda
  recorrência do app é DECLARADA pelo usuário (`cashFlowForecasts.kind =
  'recurring'`) — nunca inferida do histórico.
- `categoryMemory`/`categoryRules` (o motor de aprendizado que já existe
  para categorização) rastreia assinatura de descrição (`merchantSignature`,
  primeiros dois tokens normalizados) e uma CONTAGEM de acertos — mas não
  guarda valor nem data de cada ocorrência, só o total de vezes que a regra
  bateu. Não tem os dois sinais que detectar uma assinatura de verdade
  exige: estabilidade de VALOR entre ocorrências e regularidade de
  INTERVALO (~30 dias) entre elas.

### O que falta
Este é o único item do lote que é uma feature genuinamente nova de
back-end, não uma extensão de algo que já existe:
- Uma rotina que agrupe transações confirmadas por assinatura de descrição
  (reusando `merchantSignature`, já existente), e para cada grupo com 2+
  ocorrências, meça se o valor varia pouco (ex. dentro de 5%) E se o
  intervalo entre datas é regular (ex. 28-31 dias) — só aí sugerir "isto
  parece uma assinatura".
- Seguindo o princípio já estabelecido no projeto (decisions/0003, "sugestão
  nunca é aplicação automática"): a detecção vira uma SUGESTÃO revisável,
  nunca cria um `cashFlowForecasts` sozinha sem confirmação do usuário —
  mesmo padrão da fila de conciliação já construída em Endividamento.

### Decisão em aberto
Vale medir primeiro, contra o extrato real do usuário, quantos casos
genuínos de assinatura recorrente existem hoje (Netflix/Spotify/iCloud
etc.) antes de construir a detecção — se forem poucos, o retorno do
esforço pode não compensar frente aos outros itens deste backlog.

---

## Como usar este documento

Cada seção acima já tem contexto, grounding e decisões em aberto suficientes
para virar um `<execution_task>` próprio no formato usado neste projeto,
assim que o usuário confirmar quais itens quer atacar e em que ordem, e
responder as perguntas em aberto (snapshot automático de dívida, o que
"oculto" significa, e o modelo de ligação transação-cartão).
