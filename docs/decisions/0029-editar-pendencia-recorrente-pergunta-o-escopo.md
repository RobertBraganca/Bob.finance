# 0029. Editar uma pendência recorrente pergunta o escopo (mesmo padrão da exclusão)

Status: aceita

## Contexto
Usuário pediu, explicitamente (28/08/2026): ao editar a transação de um
mês vinculada a uma previsão recorrente ou dívida que ainda tem
lançamentos futuros, o sistema deveria perguntar se a edição vale só
para aquela ocorrência, para aquela e as futuras, ou para todas já
lançadas — nomeando literalmente as mesmas três opções que
`decisions/0020` já usa para EXCLUSÃO (`PendingScopeModal`,
`'only' | 'this_and_future' | 'all'`). Antes desta decisão, editar
qualquer ocorrência (via `PATCH /transactions/:id`) só tocava aquela
linha; um reajuste de salário exigia editar cada mês já lançado um por
um, e o modelo da previsão continuava com o valor antigo.

Duas perguntas de escopo foram feitas antes de implementar, ambas
confirmadas:
1. **"Esta e as futuras"/"Todas" também atualizam o MODELO** (a
   previsão ou a dívida), não só as linhas já materializadas — sem
   isso, o horizonte de 24 meses (`decisions/0028`) voltaria a
   materializar com o valor antigo assim que passasse dos meses já
   corrigidos manualmente.
2. **Vale tanto para previsões recorrentes quanto para parcelas de
   dívida** — o mecanismo de exclusão já unifica os dois hoje
   (`forecastId` ou `debtId`), então editar do mesmo jeito mantém os
   dois caminhos consistentes.

## Decisão
`updateTransaction(id, patch, scope)` (`server/src/services/
transactions.ts`) ganha um terceiro parâmetro, mesmo tipo
`PendingDeleteScope` já usado pela exclusão. A ocorrência editada
sempre é atualizada, como antes (`scope` não muda esse comportamento).
Quando `scope !== 'only'` e a linha tem `forecastId` ou `debtId`:

1. **Campos que propagam**: só `description`, `amountCents` e
   `accountId` — os únicos que fazem sentido como atributo do MODELO.
   `postedOn` e `notes` nunca propagam (cada ocorrência tem o próprio
   dia; nota é sempre desta ocorrência) — mesmo com escopo "todas",
   só a linha editada muda de data.
2. **O modelo é atualizado primeiro**: `cash_flow_forecasts.
   description/amount_cents/account_id` (previsão) ou `debts.name/
   scheduled_payment_cents/account_id` (dívida — `scheduledPaymentCents`
   sempre positivo, o mesmo sinal que `syncMaterializedRows` já usa).
3. **Depois, as demais ocorrências ainda pendentes** (`pending =
   true`, excluindo a própria linha editada) do mesmo template:
   `this_and_future` filtra por período >= o da ocorrência editada;
   `all` não filtra por período. **Diferente do sync automático
   (`syncMaterializedRows`, disparado ao editar o modelo direto)**,
   esta cascata explícita ignora `manuallyEdited` — o usuário está
   pedindo deliberadamente para sobrescrever tudo no escopo escolhido,
   não é uma sincronização silenciosa de fundo.

UI: novo `PendingEditScopeModal` (`components/ui/index.tsx`), irmão do
`PendingScopeModal` já existente — a mesma pergunta, texto de editar em
vez de excluir, deixando explícito que "esta e as futuras"/"todas"
também mudam o modelo. Só aparece quando a edição de fato muda
descrição/valor/conta (mudar só data ou categoria segue direto, sem
pergunta — nada a propagar). Ligado nos dois lugares onde uma
pendência é editada: `EditTransactionModal` (Lançamentos) e
`EditPendingModal` (cartão de pendências do Painel).

Verificado ao vivo: previsão recorrente de teste com 24 ocorrências
materializadas (2026-08 a 2028-07); editada a de 2026-10 com escopo
`this_and_future` e valor novo — 2026-08/09 continuaram com o valor
antigo, 2026-10 em diante (23 linhas) foram para o valor novo, e o
modelo da previsão também.

## Alternativas consideradas
- **Não tocar o modelo, só as linhas já lançadas**: descartada pelo
  usuário — deixaria o horizonte de 24 meses voltando a materializar
  com o valor antigo passado o ponto já corrigido manualmente.
- **Restringir a previsões, excluir dívida**: descartada pelo usuário
  — o mecanismo de exclusão já trata os dois iguais; separar edição
  criaria uma inconsistência nova.
- **Propagar também `postedOn`**: descartada — cada ocorrência tem seu
  próprio dia de vencimento por natureza; forçar todas as futuras para
  a MESMA data da editada seria um comportamento surpreendente e
  quase certamente não o que o usuário quer ao só corrigir um valor.

## Consequências
- Uma assimetria pré-existente permanece, não introduzida por esta
  mudança: `listPending` (o endpoint que alimenta o cartão de
  pendências do Painel) nunca fez `join` com `debts` nem devolve
  `debtId` — então uma parcela de dívida editada a partir do Painel
  não aciona o modal de escopo (só via `forecastId`). Editar a partir
  de Lançamentos já funciona para os dois, porque aquela lista sempre
  trouxe `debtId`. Corrigir isso no Painel é um passo separado, não
  parte deste pedido.
- `cascadeToTemplate` (nova função privada em `transactions.ts`) só é
  chamada quando `scope !== 'only'` e algum campo propagável de fato
  mudou — uma edição de escopo amplo sem mudança real de valor/
  descrição/conta é um no-op silencioso, não um erro.
