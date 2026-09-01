# Spec: Motor financeiro (alocação do disponível, ponto de equilíbrio)

Status: implementado

## Objetivo
Cruzar Metas, Dívida, Investimentos e DRE para responder quanto do saldo
ainda não está comprometido com nenhuma meta, e qual faturamento cobriria
tudo o que já está configurado, sem nunca dizer ao usuário o que fazer com a
diferença (ver `decisions/0010`).

## Histórias de usuário
- Como usuário, eu quero ver quanto do meu saldo disponível ainda não está
  comprometido com nenhuma meta configurada, e como esse valor se compara ao
  que falta para cada meta (reserva, investimento, dívida), sem que o
  sistema diga o que fazer com a diferença.
- Como usuário, eu quero ver qual seria meu ponto de equilíbrio de
  faturamento no mês, dado meus custos PJ, pró-labore, impostos e metas de
  investimento/reserva já configurados, para saber se o que já faturei é
  suficiente.

## Modelo de dados
Camada de leitura pura, nenhuma tabela nova. Lê de:
- `transactions` filtrado por `accountId` (PJ/PF, mesmo mecanismo de
  `specs/dre`), para saldo consolidado e custos PJ realizados.
- `cashFlowForecasts` materializados em `transactions` (`pending = true`,
  ver `specs/cash-flow-reconciliation`), para compromissos futuros
  confirmados.
- `creditCards`, `creditCardSnapshots` (ver `specs/credit-cards`), para
  fatura provisionada do ciclo atual.
- `monthlyGoals`, `categoryCaps` (ver `specs/monthly-goals`), `debts` (ver
  `specs/debt`), `investmentGoals`, `emergencyReserveSettings` (ver
  `specs/investments`), para o valor já destinado a cada meta do mês.

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/motor-financeiro/disponivel` | GET | `{period}` → valor disponível para alocação, lista por destino configurado (reserva, investimento, dívida, livre) com meta/realizado/diferença, `premissas` com a origem de cada termo do cálculo |
| `/motor-financeiro/ponto-equilibrio` | GET | `{period}` → valor do ponto de equilíbrio de faturamento, composição linha a linha (custos PJ, pró-labore, impostos, investimento planejado, reserva planejada, margem), quanto já foi faturado no período, diferença |
| `/motor-financeiro/ponto-equilibrio/margem` | GET/PUT | Margem configurável pelo usuário, com default sugerido (default: 0%) |

## Regras de negócio
- **Disponível para alocação** = saldo consolidado − compromissos futuros
  confirmados (`cashFlowForecasts` pendentes) − limite de cartão
  comprometido (soma do limite usado de todos os cartões ativos, ver
  `specs/credit-cards`) − valor já destinado a metas do mês (soma do que já
  foi aportado/pago no período contra `investmentGoals`, `debts` e reserva
  de emergência). Cada termo referencia a tabela/spec de origem em
  `premissas`, isso é a memória de cálculo exigida pelo ADR 0010, não um
  adicional de UI. "Limite comprometido" e não "fatura do ciclo": o número
  soma parcelamento em andamento e saldo revolvente junto, porque o app não
  rastreia gasto por lançamento de cartão separado da conta vinculada —
  ver `decisions/0015` para o porquê de não fabricar uma separação que o
  dado não sustenta.
- **Por destino configurado** (reserva, investimento, dívida, livre): meta,
  já realizado no mês, diferença. A ordem de exibição é neutra (ordem
  configurada pelo usuário, ou alfabética por padrão), nunca ordenada por
  "urgência" calculada pelo sistema, isso seria uma forma disfarçada de
  prescrição.
- **Ponto de equilíbrio de faturamento** = custos PJ (realizado do mês,
  `transactions` filtrado por `accountId` PJ) + pró-labore configurado +
  impostos estimados (percentual configurável sobre faturamento) +
  investimentos planejados (`investmentGoals` do período) + reserva
  planejada (gap da meta da reserva, ver `specs/investments`) + margem
  configurada pelo usuário. Composição exibida linha a linha, não só o
  total.
- **Nenhum texto desta área usa "recomendação", "sugestão de investimento" ou
  verbo no imperativo dirigido à ação financeira do usuário** (ver
  `decisions/0010`). Toda frase de fechamento de card segue o padrão "se
  [ação hipotética], os valores acima seriam necessários para [objetivo
  configurado]", nunca "faça [ação]".
- Toda métrica desta área se classifica como Observação (disponível e
  realizado do mês) ou Simulação (ponto de equilíbrio como cenário
  hipotético de faturamento), nunca Recomendação.

## UI
Cartão "Disponível para alocação": valor no topo, tabela por destino (meta /
realizado / diferença) em ordem neutra, disclosure "como calculamos" com a
memória de cálculo. Cartão "Ponto de equilíbrio de faturamento": total no
topo, composição linha a linha abaixo, comparação com o faturamento já
realizado no período.

## Casos de borda
- Nenhuma meta configurada em nenhum destino: disponível para alocação é
  igual ao saldo consolidado menos compromissos e fatura, tabela por destino
  vazia, não card ausente.
- Faturamento do período já acima do ponto de equilíbrio: diferença exibida
  como positiva, sem elogio ou alerta qualitativo, é só um número.
- Custos PJ realizados ainda incompletos por importação pendente: valor
  parcial exibido com o mesmo aviso de "sem categoria"/pendência que o resto
  do app já usa, nunca escondido como se fosse definitivo.

## Recordes observacionais (Status: implementado, 30/08/2026)
`GET /financial-engine/records` (estudo de viabilidade #5, 29/08/2026):
"maior disponível já registrado" reusa `availableForAllocation(period)` sem
alterá-la, em loop sequencial sobre os últimos 24 meses (mesmo padrão de
`goalHistory`/`healthScoreHistory`, nenhuma tabela nova). "Dias desde o
último saldo negativo" é derivação diferente — soma corrida (SQL window
function) do saldo de abertura de todas as contas mais os lançamentos
confirmados dia a dia, uma query só, sem precisar materializar série em
código. Puramente Observação: nunca "cuidado, seu saldo está baixo", só o
fato histórico.

## Fora de escopo
- Qualquer recomendação de quanto ou onde alocar o disponível, ou de como
  atingir o ponto de equilíbrio, isso é o limite deste motor, ver
  `decisions/0010`.
- Execução de aporte, pagamento ou transferência a partir desta tela, isso é
  sempre feito nas telas de origem (`specs/investments`, `specs/debt`).

## Ponto de equilíbrio mínimo e com metas (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero ver dois números de faturamento de equilíbrio: o
  que cobre só os custos e o pró-labore, e o que também cobre minhas metas
  de investimento e reserva configuradas — hoje só vejo o segundo, e não
  sei quanto das duas linhas de meta pesa no total.

### Modelo de dados
Nenhuma tabela nova. Mesma função `breakEven`, chamada duas vezes com
parâmetros diferentes.

### Contrato de API
`/motor-financeiro/ponto-equilibrio` passa a devolver `minimoCents` (só
custos PJ, pró-labore e impostos) ao lado do `breakEvenCents` já existente
(que passa a ser explicitamente "com metas" na resposta, mesmo valor de
hoje, sem mudança de comportamento para quem já consome o campo).

### Regras de negócio
- **Mínimo** = a mesma composição de `breakEven`, com
  `reservePlannedCents: 0` e a linha de investimento planejado excluída
  (não zerada — excluída, porque uma linha com valor R$ 0,00 ainda apareceria
  na composição e sugeriria que a meta foi considerada e é zero, quando na
  verdade não foi considerada). Custos PJ, pró-labore e impostos continuam
  os mesmos.
- **Com metas** é o `breakEvenCents` já existente, sem mudança.
- **Nomenclatura deliberada:** nunca "meta ideal" nem "meta mínima" — a
  palavra "meta" já tem significado fixo em `specs/monthly-goals` (teto de
  gasto do mês) e reusá-la aqui para outra coisa criaria duas "metas"
  diferentes no mesmo produto. Os rótulos são "faturamento mínimo" e
  "faturamento com metas configuradas".

### UI
Os dois números lado a lado no cartão "Ponto de equilíbrio de
faturamento", com a diferença entre eles explicada como "quanto do
faturamento com metas é reserva e investimento planejados" — não um
segundo cartão.

### Casos de borda
- Nenhuma meta de investimento nem reserva planejada configurada: os dois
  números são iguais, exibidos como tal, não escondendo um dos dois.
