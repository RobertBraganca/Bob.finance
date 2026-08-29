# Spec: Conciliação de fluxo de caixa

Status: implementado

## Objetivo
Deixar receita/despesa futura já confirmada (cliente recorrente, parcela já
acordada) visível para fluxo de caixa, unificada ao ledger real — e casar
essa pendência com o lançamento real quando ele chega, sem nunca duplicar
nem aplicar a conciliação sozinha.

## Histórias de usuário
- Como freelancer, eu quero registrar um cliente fixo recorrente (valor,
  conta esperada, categoria) e ver esse valor projetado nos próximos meses
  sem lançar manualmente todo mês.
- Como usuário, eu quero registrar um valor parcelado já acordado (ex.
  projeto fechado em N parcelas) e ver as parcelas futuras, informando a
  data de pagamento real, não só o mês.
- Como usuário, eu quero que o app sugira quando uma pendência e um
  lançamento real do extrato são a mesma coisa, mas só aplicar a
  conciliação quando eu confirmar com um clique — e poder dizer "não é a
  mesma coisa" para parar de ver aquela sugestão específica.
- Como usuário, eu quero editar uma pendência já materializada (data, valor,
  conta, categoria) sem precisar excluir e recriar.
- Como usuário, eu quero marcar uma pendência como paga/recebida
  diretamente, para dinheiro que nunca vai aparecer num extrato importado
  (ex. recebimento em espécie).
- Como usuário, eu quero que uma pendência esquecida de um mês anterior
  continue aparecendo (marcada como atrasada) no mês seguinte, em vez de
  simplesmente sair da tela porque o período mudou.

## Modelo de dados
- `cashFlowForecasts` — template recorrente (`kind: 'recurring'`, sem fim)
  ou parcelado (`kind: 'installment'`, `installmentCount` fixo), com conta e
  categoria esperadas.
- `transactions` — a materialização grava linhas reais com `pending = true`
  e `forecastId` (ou `debtId`, ver `specs/debt`) apontando para o template.
  Não existe tabela de "previsão" separada (ver `decisions/0003`).
  `occurrencePeriod` (`YYYY-MM`) fixa qual ocorrência do template aquela
  linha preenche, independente da `postedOn` — que o usuário pode editar
  livremente (ex. corrigir a data real de pagamento) sem que a próxima
  materialização confunda "a data mudou" com "essa ocorrência nunca foi
  preenchida" e recrie uma duplicata para o mês esvaziado. A unicidade de
  `(forecastId, occurrencePeriod)` é garantida por um índice único parcial
  no banco (`txn_forecast_occurrence_uq`, `where forecast_id is not null`),
  não só pela checagem em memória que `materialize()` já fazia — duas
  chamadas concorrentes (duas abas, um retry) que vissem "período ausente"
  antes de qualquer INSERT confirmar podiam duplicar a mesma pendência;
  `onConflictDoNothing` no insert é a garantia real agora, a checagem em
  memória continua só como filtro barato (achado da revisão de
  28/08/2026, ver `docs/project-memory.md`). O equivalente para dívida
  (`debtId`, `txn_debt_occurrence_uq`) segue a mesma regra — ver
  `specs/debt`.
- `skippedOccurrences` — `(forecastId | debtId, period)` que o usuário
  excluiu explicitamente de uma pendência materializada. Sem isso, excluir
  uma pendência pareceria não funcionar: a próxima materialização recriaria
  a mesma linha, porque só sabia dizer "existe uma linha para este
  período?", nunca "o usuário decidiu que este período não é para
  materializar". Unicidade garantida por dois índices únicos parciais,
  `skipped_occurrences_forecast_uq`/`skipped_occurrences_debt_uq`
  (`where forecast_id/debt_id is not null`) — um único índice não parcial
  sobre `(forecastId, debtId, period)` nunca dispararia de verdade, porque
  toda linha real tem exatamente uma das duas colunas `NULL` e Postgres
  nunca considera dois `NULL` iguais (achado da revisão de 28/08/2026,
  corrigido na mesma sessão que corrigiu o mesmo defeito em
  `txn_forecast_occurrence_uq`/`txn_debt_occurrence_uq` acima).

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/cash-flow/forecasts` | GET | Materializa o horizonte rolante antes de listar, depois devolve os templates |
| `/cash-flow/forecasts` | POST/PATCH/DELETE | CRUD do template; toda escrita re-materializa E sincroniza os campos (valor, conta, categoria, dia de vencimento) de qualquer ocorrência já materializada e ainda pendente que o usuário não editou manualmente — não só as futuras (ver `decisions/0017`) |
| `/cash-flow/pending` | GET | `{flow, from, to}` → pendências com `postedOn <= to` (sem piso em `from`) — uma pendência mais antiga que o período aparece igual, com `isOverdue: true` |
| `/cash-flow/pending/:id` | PATCH | Edita data, descrição, valor, conta, categoria de uma pendência já materializada |
| `/cash-flow/pending/:id` | DELETE | `{scope?: 'only' \| 'this_and_future' \| 'all'}`, default `'only'` — remove uma pendência que não vai mais acontecer; se vinculada a um template com mais de uma ocorrência pendente, o front pergunta o escopo antes de chamar (ver `decisions/0020`). `'only'` grava em `skippedOccurrences`; `'this_and_future'` remove esta e as futuras e fixa `endPeriod` no template; `'all'` desativa o template inteiro, sem apagar ocorrências já confirmadas |
| `/cash-flow/pending/:id/settle` | POST | Marca como paga/recebida diretamente, sem esperar um lançamento real do extrato — vira uma linha real (`pending = false`); se vinculada a uma dívida, também registra `debtPayments` |
| `/cash-flow/reconciliation-candidates` | GET | Sugestões de match (nunca aplicadas sozinhas), já excluindo pares descartados |
| `/cash-flow/reconciliation-candidates/dismiss` | POST | `{pendingId, matchId}` — descarta um par sugerido permanentemente, sem confirmar nem excluir nada |
| `/cash-flow/pending/:id/confirm-match` | POST | Único jeito de aplicar uma conciliação — sempre um clique explícito; se vinculada a uma dívida, também registra `debtPayments` |

## Regras de negócio
- **Materialização é idempotente** e cobre um horizonte rolante de 6 meses
  (`MATERIALIZE_HORIZON_MONTHS`) — chamar de novo nunca duplica uma
  ocorrência já materializada para o mesmo período, mesmo que o usuário já
  tenha editado a data daquela ocorrência (rastreada por `occurrencePeriod`,
  não por `postedOn`).
- **Editar o template propaga para o que já foi materializado — exceto a
  ocorrência que o usuário já editou manualmente.** Antes, só ocorrências
  futuras (ainda não geradas) recebiam a mudança — um valor editado no
  template continuava mostrando o valor antigo em toda pendência já
  existente, o que parecia "a edição não salvou". O PATCH do template
  passou a atualizar cada linha ainda pendente vinculada a ele, mas isso
  criou um bug simétrico, confirmado num teste de uso real: editar
  qualquer campo do template também sobrescrevia a data que o usuário já
  tinha movido à mão numa ocorrência específica. `transactions.manuallyEdited`
  (`decisions/0017`) resolve isso — uma ocorrência marcada como editada
  manualmente para de receber sincronização automática do template,
  porque o usuário já assumiu como autoridade sobre aquela ocorrência
  específica.
- **Excluir uma pendência vinculada a um template grava o período em
  `skippedOccurrences`.** Sem isso, a próxima materialização recriava a
  mesma pendência — excluir parecia não funcionar.
- **Pendência não desaparece ao virar o período — ela atrasa.**
  `GET /cash-flow/pending` só limita pelo fim do período (`to`); qualquer
  pendência mais antiga continua na lista, marcada `isOverdue`, para nunca
  sumir de vista sem o usuário decidir excluir ou resolver.
- **Toda agregação exclui `pending = 1` por padrão** — uma pendência nunca
  infla um resultado já fechado (ver `decisions/0003`).
- **Conciliação é sempre sugestão:** mesma conta + mesmo valor exato + data
  dentro de ±15 dias. Confirmar substitui a pendência pelo lançamento real
  (apaga a pendência, transferindo `forecastId`/`debtId` para o lançamento
  real antes); nunca acontece sem o clique do usuário — essa foi uma
  escolha explícita do usuário sobre a recomendação inicial (que seria
  conciliar automaticamente com alta confiança). Descartar um par
  (`dismiss`) é o oposto de confirmar: registra que aquele par específico
  não é a mesma coisa, sem tocar em nenhum lançamento.
- **Confirmar ou marcar como paga uma pendência vinculada a uma dívida
  também grava em `debtPayments`** — a tela de Endividamento e os cards de
  pendência sempre concordam sobre quantas parcelas já foram pagas.
- **O card de pendência no dashboard mostra só o valor total**, com uma
  janela sempre olhando para a frente a partir de hoje (ver
  `forwardBoundsFor` — os presets do seletor global decidem só a largura da
  janela, nunca o ponto de partida), mais qualquer atrasado. Não uma lista
  por padrão (ver `specs/dashboard`).

## UI
Dois cards no Dashboard ("Receitas pendentes", "Despesas pendentes") com
valor total + aviso "Atrasado" quando há pendência de período anterior +
botões "Novo" (pede a data de pagamento específica, não só o mês) e "Ver
lançamentos" (abre o detalhamento em modal, com editar/marcar como
paga/excluir por linha, e badge "Atrasado" na linha correspondente). Card de
"Possíveis conciliações" (aparece só quando há candidato) mostra só a
descrição da pendência, o período previsto e a data real — não o texto bruto
do lançamento do banco — com botões "É o mesmo" e um "x" para descartar por
par sugerido.

## Casos de borda
- Pendência atrasada nunca resolvida: continua aparecendo, marcada
  `isOverdue`, em todo período seguinte até o usuário excluir, marcar como
  paga ou conciliar — nada a expira automaticamente.
- Editar a data de uma pendência para outro mês: a pendência se move
  visualmente, mas o mês de origem continua contando como preenchido
  (`occurrencePeriod` não muda) — não gera uma pendência duplicada no mês de
  onde ela saiu.

## Fora de escopo
- Conciliação automática sem confirmação — decisão explícita do usuário,
  registrada em `decisions/0003`.
- Notificação quando uma pendência conciliar — todo dado é pull, nunca push
  (ver PRD, seção 8).

## Visibilidade além do horizonte (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero cadastrar um template cuja primeira ocorrência é
  daqui a mais de 6 meses (ex. um salário que sobe de valor quando um
  parcelamento em andamento termina) e ver que ele foi salvo, mesmo antes
  de gerar qualquer pendência real.

### Modelo de dados
Nenhuma tabela nova. `pendingOccurrences()` (`services/cashFlow.ts`) já
sabe calcular a próxima ocorrência de qualquer template — só nunca expõe
esse cálculo quando o resultado está fora do horizonte de materialização.

### Regras de negócio
- **`GET /cash-flow/forecasts` devolve `nextOccurrencePeriod` para todo
  template ativo**, calculado mesmo quando está além do horizonte rolante
  de 6 meses (`MATERIALIZE_HORIZON_MONTHS`) — não é a mesma coisa que
  materializar uma linha em `transactions`, é só expor a data prevista.
- **Confirmado como causa real de confusão**: um template criado com a
  primeira ocorrência além do horizonte hoje não produz nenhuma linha em
  lugar nenhum, o que é indistinguível de "não salvou" — e já gerou
  cadastro duplicado num teste de uso real por esse motivo exato.

### UI
`GET /cash-flow/forecasts` já devolvia `nextOccurrencePeriod` desde a
primeira rodada desta seção, mas nenhuma tela chegou a consumir essa
rota — o único retorno visível era um toast de um segundo no momento de
salvar. Isso não bastou: **a mesma confusão se repetiu** (25/08/2026,
duas tentativas de recadastro por não achar a previsão salva em lugar
nenhum), exatamente como o parágrafo acima já tinha previsto — porque
"a lista de templates" nunca foi de fato construída, só especificada.

Corrigido consumindo `GET /cash-flow/forecasts` dentro do próprio "Ver
lançamentos" (`PendingListModal`, `src/pages/Dashboard.tsx`): toda
previsão ativa cujo `nextOccurrencePeriod` ainda não tem nenhuma
pendência materializada (`forecastId` correspondente em `rows`) aparece
numa segunda tabela, "Previsões que ainda não aparecem no histórico",
com descrição, "primeira ocorrência: mês/ano", valor e um botão para
remover a previsão inteira (não uma pendência avulsa — usa `DELETE
/cash-flow/forecasts/:id`). O card em si ganha um aviso contando quantas
previsões estão nesse estado, e o botão "Ver lançamentos" passa a
aparecer mesmo com zero pendências reais, se houver alguma previsão
"invisível" para mostrar. Ver `decisions/0024`.
