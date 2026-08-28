# Spec: Investimentos

Status: implementado

## Objetivo
Uma carteira cuja posição é sempre derivada dos aportes reais (nunca um
saldo guardado), com alocação por classe, uma nota de qualidade por ativo
que decide quem recebe o próximo aporte dentro da classe, uma reserva de
emergência que tem prioridade sobre qualquer investimento, e cotação de
mercado real para ações e FIIs via BRAPI.

## Histórias de usuário
- Como usuário, eu quero que a posição (quantidade, preço médio, valor de
  mercado) seja sempre recalculada do histórico de aportes, para que
  corrigir um aporte antigo corrija a carteira inteira.
- Como usuário, eu quero definir uma meta de alocação por classe (%) e ver
  o desvio atual.
- Como usuário, eu quero responder um questionário de critérios por ativo
  (Diagrama do Cerrado) e que a nota resultante decida quanto desse ativo
  recebe dentro do aporte da classe.
- Como usuário, eu quero que nenhum aporte novo vá para investimento
  enquanto a reserva de emergência (Nx meu custo de vida) não estiver
  completa.
- Como usuário, eu quero atualizar a cotação de uma ação/FII com um clique,
  sem digitar o preço manualmente.
- Como usuário, eu quero que o aporte sugerido dentro de uma classe se
  espalhe entre setores diferentes, não sempre no ativo de maior nota — e
  que o valor sugerido dê para comprar pelo menos uma cota inteira do ativo,
  nunca uma fração que não existe para comprar.
- Como usuário, eu quero corrigir o nome, o código (ticker) ou a classe de
  um ativo já cadastrado, no mesmo lugar onde registro a cotação.

## Modelo de dados
- `assets` — nome, ticker, classe, `countsTowardReserve`.
- `assetTrades` — compra/venda/provento; é a única fonte de quantidade e
  capital aportado.
- `assetValuations` — marcação a mercado por data; sem cotação, o custo
  médio é a referência (honesta, não escondida).
- `investmentGoals`, `targetAllocations` — meta de valor/data e meta de
  alocação por classe.
- `criteria`, `assetCriteriaAnswers` — banco de perguntas por classe e
  resposta sim/não por ativo ("Diagrama do Cerrado").
- `emergencyReserveSettings` — múltiplo (6x/12x/24x), janela de meses para
  custo de vida médio, override manual do custo de vida.

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/investments` | GET | Carteira completa: posições, alocação, classes, metas |
| `/investments/assets`, `/investments/trades` | POST/PATCH/DELETE | CRUD de ativo e lançamento |
| `/investments/assets/:id/valuation` | POST | Cotação manual |
| `/investments/assets/:id/refresh-quote`, `/investments/quotes/refresh-all` | POST | Cotação via BRAPI, ver `decisions/0006` |
| `/investments/summary`, `/investments/performance` | GET | KPI do período e série de evolução |
| `/investments/contribution-plan` | GET | Cascata de sugestão de aporte |
| `/investments/reserve` | GET/PUT | Status e configuração da reserva |
| `/investments/reserve/contribute` | POST | Aporte/retirada direto no ativo dedicado, ver `decisions/0005` |
| `/criteria`, `/investments/assets/:id/note`, `/investments/assets/:assetId/criteria/:criteriaId` | CRUD | "Diagrama do Cerrado" |
| `/investments/allocation`, `/investments/allocation/:assetClass` | PUT/GET | Meta por classe e detalhe dentro da classe |

## Regras de negócio
- **Posição é sempre derivada:** quantidade = compras − vendas; capital
  aportado = compras − vendas + taxas; preço médio ponderado inclui taxas.
- **Nota de resistência** = soma de respostas (+1 sim, −1 não), fixada entre
  0 e 10. Sem nenhuma resposta, a nota é `null` — nunca 0, porque 0
  penalizaria como se tivesse falhado em todos os critérios.
- **Cascata de aporte:** reserva de emergência primeiro (até completar a
  meta, 100% do aporte enquanto o gap não fecha). Depois, **todas** as
  classes abaixo da própria meta recebem uma fatia do restante na mesma
  rodada, proporcional a quanto cada uma está atrasada (`deltaCents` —
  meta menos valor atual), nunca uma classe saturada por completo antes de
  a próxima receber algo (ver `decisions/0013` — o rodízio sequencial
  anterior concentrava aporte pequeno numa única classe; o proporcional
  reparte entre todas as que precisam, e uma classe já na meta ou acima
  dela nunca aparece, porque sua fatia do total de gaps é zero). Se o
  aporte, depois da reserva, for maior ou igual à soma dos gaps de todas as
  classes elegíveis, cada uma recebe exatamente o seu gap — e o que sobrar
  depois disso **não fica parado**: distribui-se proporcional ao peso-alvo
  original de cada classe (`targetAllocations.targetBps`), já que com todo
  gap zerado não existe mais "quem está mais atrasado" pra desempatar (ver
  `decisions/0019`). Quando o aporte NÃO fecha todo gap, a fatia
  proporcional em si é redistribuída em rodadas (`decisions/0022`): se uma
  classe não consegue absorver a própria fatia (preço por cota grosso,
  poucos ativos elegíveis), a diferença volta para o total e se reparte de
  novo, proporcional ao gap, entre as classes que ainda têm gap aberto e
  espaço livre — nunca fica parada enquanto outra classe teria absorvido.
  Só vira `unallocatedCents` de verdade a fração que nenhuma classe
  elegível genuinamente consegue absorver mais (ex. nenhum ativo pontuado
  em nenhuma classe com gap, ou nenhuma comprando uma cota inteira) —
  nunca por falta de destino configurado.
  Dentro de cada classe, os ativos elegíveis seguem em rodízio **por
  setor** (não só por nota) — sem isso, o ativo de maior nota absorvia
  sozinho todo o aporte da classe antes de um segundo setor ser
  considerado; ativos sem setor conhecido (cotação nunca atualizada) dividem
  um grupo "Sem setor" único. Nunca sugere vender — só direciona dinheiro
  novo. Um ativo com nota 0 nunca é sugerido.
- **Sugestão de aporte é sempre em cotas inteiras** da última cotação
  conhecida — um valor sugerido menor que uma cota (ex. R$7 para uma cota de
  R$10) não é executável, então esse ativo fica de fora daquela rodada em
  vez de aparecer com um valor que ninguém consegue comprar. Sem cotação
  registrada, a sugestão cai de volta a um valor bruto (marcado "sem
  cotação"), já que não há como calcular quantas cotas ele compra.
- **Reserva de emergência tem prioridade absoluta:** enquanto o gap não
  fecha, 100% de qualquer aporte vai para ela antes de qualquer classe.
  Meta = custo de vida médio (real, ou override manual) × múltiplo.
- **Cotação BRAPI é sempre sequencial**, uma requisição por ticker — ver
  `decisions/0006`.
- **Reserva sem cotação:** o ativo dedicado da reserva (ver
  `decisions/0005`) tem cota fixa em R$1,00, nunca precisa de valuation.
- **A sugestão se executa por ativo** (`decisions/0023`): cada linha da
  cascata (classe → ativo) tem seu próprio botão "Comprar", que só
  registra o MESMO trade que a linha já descreve (`POST
  /investments/trades`, `kind: 'buy'`) — nenhum endpoint novo de
  "executar plano", porque a sugestão nunca é uma entidade persistida,
  é sempre recalculada a partir da carteira real a cada requisição. Uma
  data só (`tradedOn`, no topo do painel) vale para toda linha
  confirmada nessa sessão. Ativo sem cotação registra como 1 unidade
  valendo o `suggestedCents` da linha. Depois de confirmar uma linha, o
  painel recalcula com o MESMO valor de aporte digitado — a posição já
  mudou no banco, então o próximo cálculo do gap reflete isso sozinho.

## UI
`Investments.tsx`: aba Carteira (KPI, evolução, composição, reserva de
emergência, "Meus ativos" agrupado por classe com toggle de reserva e
cotação por linha), aba Aportar (planejador de cascata, mostrando quantas
cotas cada sugestão compra ao preço da última cotação), aba Metas. Um único
editor por ativo cobre nome/código/classe e o registro opcional de uma nova
cotação — duas ações que pareciam sobrepostas viraram um lápis só por
linha, não dois.

O card "Alocação por classe" (`AllocationChart`, barra do real com marca
vertical da meta) é só visual, nunca tem texto de ação. Ao lado dele, o card
que hoje se chama "Rebalanceamento sugerido" com texto "aportar/reduzir R$"
por classe é o que o ADR 0011 corrige: o Diagrama do Cerrado (ver seção
acima, "cascata de aporte") nunca sugere vender, então uma classe acima da
meta não deveria dizer "reduzir" nada, isso é a Recomendação que o
`decisions/0010` proíbe. O card correto, "Necessário para atingir a meta",
lista **só** as classes com `rebalanceCents > 0` (abaixo da meta), com a
frase no padrão Simulação já usado em `specs/motor-financeiro` ("R$X ainda
seria necessário aportar nesta classe para alcançar a meta configurada"),
nunca no imperativo. Uma classe já na meta ou acima simplesmente não
aparece na lista — silêncio, não "reduzir zero". Ver `decisions/0011`.

## Casos de borda
- Carteira vazia: tela de "cadastre o primeiro ativo", nunca um dashboard
  zerado.
- Aporte maior que o gap da reserva: reserva recebe só o que falta, nunca
  mais — o resto continua na cascata normal.
- Classe sem nenhum ativo pontuado: não aparece no plano de aporte, não
  inventa sugestão.

## Fora de escopo
- Execução de ordem de compra/venda numa corretora — o app registra o que
  já aconteceu, nunca executa.
- Cotação automática de cripto, fundos e Tesouro Direto — a BRAPI tem
  endpoints para as três (`/api/v2/crypto`, `/api/v2/funds/*`,
  `/api/v2/treasury/*`), mas exigem plano pago (Startup ou Pro), diferente
  da cotação de ações/FIIs já usada (`/api/quote/{ticker}`, gratuita).
  Decisão deliberada de continuar no plano Free — não é ausência de
  provedor, é custo recorrente que o resto do produto não tem.

## Desvio de alocação

### Histórias de usuário
- Como usuário, eu quero ver a diferença percentual entre minha alocação
  atual por classe de ativo e a política de alocação que eu mesmo
  configurei, para decidir sozinho o que fazer com isso.

### Modelo de dados
Nenhuma tabela nova. Lê `targetAllocations` (meta por classe, já existente)
contra a alocação atual derivada de `assetTrades`/`assetValuations` (mesmo
cálculo de posição já usado no restante deste spec).

### Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/investments/allocation-deviation` | GET | Por classe: percentual atual, percentual meta (`targetAllocations`), desvio em pontos percentuais |

Não retorna nenhum campo de "ativo sugerido" ou "ação recomendada" — o
endpoint só compara duas séries de percentual já existentes.

### Regras de negócio
Esta feature evidencia desvio entre carteira atual e política de alocação
definida pelo usuário. Não recomenda ativo, classe ou operação específica,
em conformidade com o `decisions/0010` e o Ofício-Circular CVM/SIN 2/2026,
que distingue esse tipo de relatório gerencial de atividade de consultoria
de valores mobiliários.

### UI
Tabela neutra (classe / atual / meta / desvio), sem ordenação por
"prioridade de correção" calculada pelo sistema, mesma regra de neutralidade
de ordem usada em `specs/motor-financeiro` para os destinos do disponível.

## Rentabilidade

### Histórias de usuário
- Como usuário, eu quero comparar a rentabilidade mensal da minha carteira
  (ou de uma classe específica) contra CDI, IPCA e os principais índices da
  bolsa, para saber se meu resultado bateu ou perdeu do que eu teria tido
  ficando nas referências óbvias.

### Modelo de dados
- `benchmarkReturns` — retorno mensal (bps) por código de referência
  (`CDI`, `IPCA`, `IBOV`, `IFIX`, `SMLL`, `IDIV`, `IVVB11`) e período
  (`YYYY-MM`), com a origem (`bcb` ou `brapi_etf`).

### Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/investments/profitability` | GET | `{assetClass?}` → retorno mensal da carteira, série de cada referência, tabela ano×mês |
| `/investments/benchmarks/refresh` | POST | Atualiza as séries (ver Regras de negócio) |

### Regras de negócio
- **CDI e IPCA vêm da série SGS do Banco Central** (`api.bcb.gov.br`, sem
  chave, séries 4390 e 433), sempre completos desde o primeiro refresh —
  essa é a segunda chamada de rede do produto além do BRAPI (ver PRD
  seção 6).
- **IBOV, IFIX, SMLL, IDIV e IVVB11 são aproximados por um ETF que
  replica cada índice**, cotado via BRAPI (mesmo provedor já usado para
  ativos, `decisions/0006`) — o app não tem acesso direto a esses índices,
  e o ETF é a aproximação pública mais próxima disponível sem corretora
  própria.
- **O plano gratuito do BRAPI só devolve uma janela de ~3 meses de
  histórico diário por chamada** — os códigos derivados de ETF nunca são
  "completados" de uma vez; cada refresh grava os meses completos que
  couberem na janela, e o histórico cresce aos poucos, um refresh por vez.
- **Atualização é sempre manual**, pelo botão "Atualizar cotações" — nunca
  automática em segundo plano, mesmo princípio de consentimento explícito
  usado para cotação de ativos.

### UI
Aba "Rentabilidade" em `Investments.tsx`: seletor de janela (12 meses, 2/5/10
anos, desde o início, período personalizado) e de classe de ativo, gráfico
de retorno mensal da carteira sobreposto a cada referência selecionada,
tabela ano×mês da mesma série.

### Casos de borda
- Nenhum refresh de benchmark ainda executado: série de referência vazia,
  gráfico mostra só a carteira, sem erro.
- `BRAPI_TOKEN` não configurado no `.env`: refresh dos códigos de ETF falha
  com mensagem clara; CDI/IPCA (BCB, sem chave) continuam funcionando.

## Extensões planejadas (Status: rascunho)

Duas lacunas encontradas ao comparar esta implementação com o método de
origem do Diagrama do Cerrado (Raul Sena) — nenhuma delas é um bug, são
regras do método original que este spec ainda não cobre. Nenhuma altera o
cálculo já implementado; ambas são aditivas.

- **Diversificação mínima antes do peso rígido.** O método recomenda ter
  pelo menos 10 ativos na carteira antes de aplicar o peso derivado da nota
  de forma rigorosa — com poucos ativos, uma nota alta concentra demais.
  Enquanto `assetCount < 10`, a cascata de aporte (`suggestContribution`)
  continuaria funcionando, mas a UI mostraria um aviso "diversificação
  mínima recomendada: X de 10 ativos" no lugar de tratar a sugestão como
  definitiva. Puramente informativo, nunca um bloqueio.
- **Idade da nota de resistência.** O método recomenda revisar as notas a
  cada 6-12 meses, não a cada aporte. `assetCriteriaAnswers.updatedAt` já
  guarda quando cada resposta foi marcada; falta só expor "nota respondida
  há N meses, considere revisar" por ativo na aba Meus ativos, quando
  `N > 6`. Nenhuma resposta expira ou é descartada automaticamente, é só um
  aviso.

## Aba "Lançamentos" e gráficos de carteira objetivo (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero uma lista dedicada dos meus aportes/vendas/proventos
  (`assetTrades`), sem precisar abrir o editor de cada ativo um a um.
- Como usuário, eu quero um gráfico comparando minha carteira atual com a
  carteira que a política de alocação (`targetAllocations`) descreve, lado a
  lado — não só a tabela que já existe.

### Modelo de dados
Nenhuma tabela nova. `assetTrades` já existe para a lista; `allocation()` já
devolve atual e meta por classe para o gráfico.

### UI
Nova aba "Lançamentos" em `Investments.tsx` (ao lado de Carteira/Aportar/
Metas/Rentabilidade): tabela de `assetTrades` com filtro por ativo e tipo
(compra/venda/provento), mesmo padrão de tabela já usado no resto do app.
Novo gráfico "Carteira atual × carteira objetivo" (duas séries de barra por
classe, mesmo dado de `allocation()` que já alimenta "Alocação por classe" —
uma segunda leitura visual do mesmo número, não um cálculo novo).

### Casos de borda
- Nenhum `assetTrade` ainda: estado vazio explícito, não aba ausente.

## Propósito da meta (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero rotular uma meta de aporte com um propósito
  (aposentadoria, comprar imóvel, independência financeira, educação dos
  filhos, viagem), para organizar e identificar minhas metas de aporte.

### Modelo de dados
- `investmentGoals.purpose` — texto livre entre os valores de
  `GOAL_PURPOSES` (`retirement`, `buy_property`, `financial_independence`,
  `children_education`, `travel`), opcional, `null` quando não definido.

  Deliberadamente excluído de `GOAL_PURPOSES`: "reserva de emergência" —
  já existe um mecanismo dedicado e prioritário para isso
  (`emergencyReserveSettings`, ver seção "Regras de negócio" acima); um
  propósito de meta com o mesmo nome duplicaria e confundiria com aquele.

### Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/investments` | GET | Resposta ganha `goalPurposes: {value, label}[]`, a lista de propósitos válidos |
| `/investments/goals` | POST | Aceita `purpose` opcional |
| `/investments/goals/:id` | PATCH | Aceita `purpose` opcional (`null` remove) |

### Regras de negócio
`purpose` é **só um rótulo organizador**, nunca lido por
`suggestContribution` nem por nenhum outro cálculo — ver `decisions/0010`
("evidenciar, nunca prescrever"). O app não deduz uma alocação por classe a
partir do propósito escolhido.

`targetAllocations` (e portanto `suggestContribution`) continua aceitando
um `goalId` no backend, mas essa variação nunca ganhou uma tela própria: um
card dedicado "Alocação-alvo desta meta" chegou a existir na aba Metas e foi
removido por ser redundante com o card "Alocação por classe" já existente na
aba Carteira, que cobre a mesma edição sem duplicar UI. A alocação-alvo
configurável pela interface continua sendo só a política padrão da carteira
(`goalId` nulo).

### UI
`GoalModal`: campo "Propósito (opcional)", pílulas (um só selecionável por
vez, clicar na já selecionada desmarca) para os 5 valores de
`GOAL_PURPOSES`; texto de apoio deixa explícito que o propósito só organiza,
nunca influencia o cálculo de aporte. `HeroFigure` da meta ativa mostra
`nome · rótulo do propósito` quando configurado.

### Casos de borda
- Trocar o propósito de uma meta não altera nem apaga nenhuma alocação já
  configurada — são dados independentes.
