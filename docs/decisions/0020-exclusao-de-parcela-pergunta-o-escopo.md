# 0020. Excluir uma parcela de template pergunta o escopo, nunca assume

Status: aceita

## Contexto
Um teste de uso real (e a investigação de um caso real de salário
parcelado que sobe de valor depois de 5 meses) expôs duas lacunas
relacionadas na mesma área — templates recorrentes/parcelados
(`cashFlowForecasts`, `debts`) que materializam linhas em `transactions`:

1. **Excluir uma transação vinculada a um template hoje não pergunta nada
   sobre as outras ocorrências.** `DELETE /cash-flow/pending/:id` já
   remove uma ocorrência e grava `skippedOccurrences` (não recria), mas
   isso só cobre o fluxo específico do card de pendência — excluir pela
   tela genérica de Lançamentos (`specs/transactions-ledger`) não tem
   esse cuidado, e mesmo onde tem, nunca oferece "esta e as futuras" nem
   "todas", só "esta".
2. **Um template cuja primeira ocorrência começa além do horizonte rolante
   de materialização (6 meses) é completamente invisível** — nenhuma
   linha em `transactions`, nenhum aviso em lugar nenhum. Confirmado no
   caso real: um forecast de salário criado para começar em fevereiro de
   2027 (o mês em que outro parcelamento de 5 meses termina) não
   materializa nada até o horizonte rolante chegar perto dele, o que
   parece "não foi salvo" — e foi exatamente isso que gerou um cadastro
   duplicado no teste real (sem confirmação visual, pareceu que a
   primeira tentativa falhou).

## Decisão

### Exclusão com escopo
Toda exclusão de uma transação vinculada a `forecastId` ou `debtId`
oferece três opções, nunca decide sozinha:
- **Apenas esta** — remove a linha, grava em `skippedOccurrences`
  (comportamento já existente, generalizado para o endpoint genérico de
  Lançamentos).
- **Esta e as futuras** — remove esta e toda ocorrência futura já
  materializada e ainda pendente do mesmo template, e grava
  `endPeriod`/equivalente no template para não gerar mais nada depois
  deste ponto (o template continua existindo, só passa a ter fim).
- **Todas** — desativa o template inteiro (`active = false`), remove toda
  ocorrência futura ainda pendente; ocorrências passadas já confirmadas
  (`pending = false`) são histórico real do ledger e nunca são apagadas
  por esta ação, só desvinculadas do template continuar gerando novas.

A escolha só aparece quando existe mais de uma ocorrência pendente do
mesmo template — excluir a única pendência de um template pontual
(`kind: 'single'`) não precisa perguntar nada, não há "futuras" para
decidir.

### Visibilidade além do horizonte
Um template cuja próxima ocorrência é mais distante que o horizonte
rolante continua aparecendo na lista de gestão de templates
(`GET /cash-flow/forecasts`, `GET /debts`), com a data da próxima
ocorrência calculada e exibida — mesmo sem nenhuma linha materializada
ainda. "Sem lançamento pendente ainda, próxima ocorrência em fevereiro de
2027" é visível e correto; zero linhas E zero indicação de por quê não é
aceitável, porque não há como distinguir "cadastrado, só ainda distante"
de "não foi salvo".

## Alternativas consideradas
- **Materializar sempre a primeira ocorrência de um template novo,
  independente do horizonte:** descartada — quebraria a garantia de "o
  horizonte rolante nunca cria uma pendência longe demais para ser real",
  e um template criado hoje para daqui a 3 anos não deveria virar uma
  linha pendente imediatamente.
- **Aumentar o horizonte rolante para cobrir mais casos como este:**
  descartada — é um número arbitrário que sempre vai ter um caso na
  borda; o problema real é a falta de visibilidade do template em si, não
  o tamanho da janela de materialização.
- **Excluir sempre "esta e as futuras" por padrão, sem perguntar:**
  descartada — contraria "sugestão nunca é aplicação automática" (PRD
  seção 4) aplicado a uma ação destrutiva; o usuário pode querer excluir
  só uma ocorrência específica (ex. um mês que o cliente não pagou) sem
  encerrar o contrato inteiro.

## Consequências
- `specs/cash-flow-reconciliation` e `specs/debt` documentam o modal de
  escopo e a visibilidade além do horizonte.
- `specs/transactions-ledger` (Lançamentos) passa a detectar, antes de
  excluir, se algum id selecionado tem `forecastId`/`debtId` com mais de
  uma ocorrência pendente do mesmo template, e abre o modal de escopo
  nesse caso — em vez de excluir direto como faz para uma transação comum.
- Nenhuma tabela nova; `cashFlowForecasts.endPeriod` e
  `debts` já têm campos suficientes (`installmentCount`,
  `active`) para representar "esta e as futuras" e "todas".
