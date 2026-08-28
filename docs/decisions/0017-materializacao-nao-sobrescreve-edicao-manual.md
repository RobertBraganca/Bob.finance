# 0017. Materialização nunca sobrescreve o que o usuário já editou à mão

Status: aceita

## Contexto
`architecture.md` já promete que `occurrencePeriod` "fixa qual ocorrência
de um `cashFlowForecast` ou `debt` uma linha materializada preenche,
independente da `postedOn` editável pelo usuário". O código não cumpre
essa promessa: `syncMaterializedRows` (`services/debt.ts` e, com a mesma
forma, `services/cashFlow.ts`) roda depois de **qualquer** edição do
template (dívida ou forecast) e recalcula `postedOn`, `description`,
`amountCents` de toda parcela ainda pendente a partir de
`occurrencePeriod` + o dado atual do template — sem checar se o usuário já
tinha movido aquela parcela especificamente.

Confirmado por um teste de uso real: editar o valor programado de uma
dívida, depois de já ter movido a data de uma parcela pendente, devolve
essa parcela para a data "de fábrica", como se a edição manual nunca
tivesse acontecido. O mesmo mecanismo, com o mesmo formato, existe em
`cashFlow.ts` para `cashFlowForecasts` — qualquer pendência de cliente
fixo ou parcela combinada sofre o mesmo problema quando o template é
editado depois.

## Decisão
Cada linha materializada e ainda pendente ganha um campo
`materializedFieldsCents: text (json) | null` — não, mais simples:
**um único booleano por linha**, `manuallyEdited: integer (mode: boolean)
default(false)`, em `transactions`. Ele vira `true` a primeira vez que o
usuário edita `postedOn`, `description` ou `amountCents` de uma linha
pendente vinculada a `forecastId` ou `debtId` (via `PATCH
/transactions/:id`, o endpoint que já existe para isso). A partir daí,
`syncMaterializedRows` **pula** essa linha inteira — não just o campo
editado, a linha toda — porque uma vez que o usuário interveio, o
template deixa de ser autoridade sobre aquela ocorrência específica.

Isso é o inverso de uma correção "campo a campo" (guardar qual dos três
campos foi editado e só pular aquele) porque seria mais frágil: uma linha
que o usuário já tocou é, na prática, uma exceção conhecida — tratar o
template como autoridade parcial sobre ela abriria margem para
inconsistência pior que a atual.

## Alternativas consideradas
- **Só recalcular `postedOn` quando `dueDay`/`installmentCount` mudarem
  de verdade, ignorando edições de outros campos:** descartada — ainda
  sobrescreveria a data numa dívida cuja parcela paga mudou de valor E de
  data no mesmo lote de edições do usuário, que é exatamente o cenário
  reportado.
- **Guardar um snapshot do valor "de fábrica" e comparar antes de
  sobrescrever:** descartada por ser mais complexa sem ganho real sobre um
  booleano simples — o objetivo é "não mexa no que já foi mexido", não
  "detecte automaticamente se algo mudou".

## Consequências
- Migração: `manuallyEdited` boolean em `transactions`, default `false`;
  linhas existentes continuam `false` (comportamento de hoje preservado
  para o histórico já materializado).
- `PATCH /transactions/:id`: ao editar `postedOn`, `description` ou
  `amountCents` de uma linha com `pending = true` e (`forecastId` ou
  `debtId`) não nulo, grava `manuallyEdited = true`.
- `syncMaterializedRows` (debt.ts e cashFlow.ts): filtra
  `manuallyEdited = false` antes de reescrever.
- `specs/debt` e `specs/cash-flow-reconciliation` documentam a regra.
- A UI ganha um pequeno indicador (ex. ícone) na parcela editada
  manualmente, para o usuário saber que ela não vai mais seguir o template
  automaticamente — sem isso, a exceção fica invisível e parece
  inconsistência do sistema da próxima vez que o template mudar.
