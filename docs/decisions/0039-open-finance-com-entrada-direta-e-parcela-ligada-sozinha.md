# 0039. Open Finance com entrada direta e parcela ligada sozinha

Status: aceita (substitui o item 2 da 0038)

## Contexto
A 0038 mandava toda transação do Meu Pluggy para a fila de revisão de
Importar, como um CSV. Na prática, a maioria das linhas de uma sincronização
não tem dúvida nenhuma, e revisar uma por uma virou o gargalo: o usuário pediu
em 04/10/2026 que as transações claras entrem direto, deixando na fila só as
duplicadas ou parecidas com algo já lançado, e que a revisão de TAG fique com
ele, depois.

No mesmo pedido: o pagamento de uma dívida deveria baixar a parcela sozinho.
Isso já existia como sugestão no Painel (mesma conta, mesmo valor, até 15 dias
da parcela pendente), confirmada à mão.

## Decisão
1. **Entrada direta.** Na sincronização, uma linha entra direto no ledger
   quando: não é duplicada (hash, id do provedor, ou mesma data e valor no dia
   de corte), não parece um lançamento manual (mesmo valor, até 15 dias), não
   sugere quitação de dívida e tem no máximo uma parcela pendente candidata. O
   resto fica no lote, na fila, como antes. São dois lotes: o de entrada
   direta (já confirmado) e o de revisão, para que "desfazer" e "descartar"
   continuem valendo cada um para a sua metade.
2. **Conferência depois.** O que entrou direto fica com `needs_review = true`
   e aparece em "Entradas automáticas" (Painel, e Lançamentos com
   `?revisar=1`). Sai da lista ao marcar como conferida, ao dar TAG ou ao
   editar o lançamento. Entra com a TAG sugerida pelas regras, ou sem TAG.
3. **Parcela ligada sozinha**, em Open Finance **e CSV**: ao gravar, uma linha
   com exatamente uma parcela pendente candidata (previsão ou dívida) é ligada
   a ela. A pendência sai, o mês fica atendido, o lançamento real guarda a
   previsão/dívida e o mês, e numa dívida o pagamento é registrado (com a
   marca `lançamento #id`), o saldo é medido e a dívida fecha se era a última
   parcela. Duas ou mais candidatas, ou duas linhas disputando a mesma
   parcela: nada é ligado, a sugestão do Painel continua.
4. **Quitação só confirmada.** Um pagamento com o valor do saldo devedor de
   uma dívida ativa paga pela mesma conta (até 3% de diferença, por causa do
   desconto de antecipação) fica na fila com a opção "registrar como
   quitação". Marcada, ao gravar a dívida fecha na data do pagamento e as
   parcelas pendentes saem.
5. **Desfazer desfaz tudo.** Desfazer uma importação devolve a parcela
   pendente, apaga o pagamento de dívida que a ligação gravou e reabre a
   dívida se ela tinha fechado por causa dele.
6. **Sincronização diária.** Um `pg_cron` chama `/ledger/cron/bank-sync` às
   22:00 de Brasília, autorizado só por `BANK_SYNC_CRON_SECRET` (o resto da
   `ledger` continua exigindo o usuário admin). O botão manual continua.
   Começou às 07:00 e passou para as 22:00 em 05/10/2026: a Pluggy atualiza
   cada conexão entre 17h e 21h, então às 22:00 o dia já entra no mesmo dia.

## Alternativas consideradas
- **Tudo direto, revisão só de TAG.** Duplicados entrariam e precisariam ser
  caçados depois; o custo de um duplicado no saldo é maior que o de uma linha
  a mais na fila.
- **Um lote só, com parte confirmada.** Desfazer apagaria também o que nunca
  foi confirmado; dois lotes mantêm as duas ações honestas.
- **Quitação automática.** Coincidência de valor é mais provável num valor
  grande e redondo, e fechar uma dívida por engano some com as parcelas.
  Recusada pelo usuário.

## Consequências
- O PRD (seção 4) passa a dizer "nada duvidoso entra sem revisão".
- Contas de cartão e investimentos do Meu Pluggy continuam fora (0038), à
  espera da ligação cartão ↔ fatura.
- Para valer em produção: aplicar as migrações `20261004120000` e
  `20261004121000`, publicar `ledger` e `insights`, e criar o segredo nas
  Edge Functions e no Vault.
