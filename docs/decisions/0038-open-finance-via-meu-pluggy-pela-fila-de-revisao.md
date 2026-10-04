# 0038. Open Finance via Meu Pluggy, sempre pela fila de revisão da importação

Status: aceita; o item 2 (tudo pela fila) foi substituído pela 0039 (entrada direta do que não tem dúvida)

## Contexto
O PRD (seção 8) punha Open Finance fora de escopo, e a spec
`open-finance-sync` existia só como desenho, parada pelo custo recorrente de
um agregador certificado. Em 03/10/2026 o usuário abriu uma conta no **Meu
Pluggy**, que dá acesso pela API às próprias contas, de graça e sem prazo,
para uso pessoal: até 5 conexões, todas do mesmo titular, sem uso comercial,
sincronizadas pela Pluggy uma vez por dia.

Medido no mesmo dia, com as contas reais:
- Os 4 bancos usados conectaram (Nubank PF, Nubank PJ, Inter, PicPay),
  inclusive a conta PJ (CNPJ). A Pluggy guarda 12 meses.
- A descrição que a Pluggy devolve não é igual à do CSV do mesmo banco
  ("Compra no débito|JIM.COM…" contra o texto do extrato), então o
  `dedupeHash` do CSV não reconhece a mesma transação vinda das duas fontes.
- A Nubank traz cada aplicação e resgate automático das caixinhas
  ("Aplicação RDB", "Resgate RDB"), que o CSV não traz.
- As datas vêm com horário real em UTC: 24 de 124 transações de setembro da
  Nubank PF caem entre 0h e 3h UTC, ainda o dia anterior no Brasil.
- O endpoint `GET /transactions` responde 410; só a v2 (cursor) funciona.

## Decisão
1. **Provedor: Meu Pluggy**, com `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET`
   só no servidor (`.env` local e segredo das Edge Functions), nunca no
   bundle do navegador.
2. **A sincronização só produz um lote de importação** (`import_batches` +
   `staged_transactions`), igual a um CSV, pela mesma função `stageRows`:
   mesma sugestão de TAG, mesma checagem de duplicado e de lançamento
   manual equivalente, mesma tela de revisão. Nada entra no ledger sem o
   usuário confirmar (PRD seção 4, "Nada entra sem revisão").
3. **Daqui pra frente.** Ao ligar uma conta, o corte (`sync_from`) é o dia do
   último extrato CSV dela. O histórico que veio por CSV, com as edições e
   TAGs do usuário, fica intacto. O próprio dia de corte, coberto pelas duas
   fontes, passa por uma checagem extra de **mesma data e mesmo valor** contra
   o ledger, e cada lançamento do ledger casa com no máximo uma linha nova.
4. **Identidade pela Pluggy.** Cada transação guarda o id do provedor
   (`external_id`, único no ledger). Uma transação já gravada ou num lote em
   revisão nunca volta; um lote descartado libera as linhas dele para a
   próxima sincronização. Entre linhas do provedor, o hash não marca
   duplicado: dois resgates iguais no mesmo dia são dois eventos.
5. **Caixinhas entram como investimento**, com a TAG "Investimentos /
   Aportes" ou "Investimentos / Resgates" pelo sinal, para não contarem como
   receita nem despesa e para o saldo da conta bater com o do banco.
6. **Datas no fuso de São Paulo**, nunca o dia em UTC.
7. **Fase 1: só contas correntes.** Ligar um cartão é recusado com uma
   mensagem. Transações `PENDING` ficam de fora até o banco confirmar.

## Alternativas consideradas
- **Substituir os últimos 12 meses de CSV pela Pluggy.** Mais completo, mas
  apagaria as edições manuais e TAGs do período e mexeria em números já
  conferidos. Recusada pelo usuário.
- **Gravar direto no ledger.** Mais rápido, mas fere "nada entra sem
  revisão" e tornaria um erro de mapeamento do provedor invisível.
- **Deduplicar só pelo hash.** Não pega a sobreposição com o CSV (descrições
  diferentes) e marca como duplicados eventos reais repetidos.
- **Agregadores pagos (Pluggy comercial, Belvo).** Desnecessários para uso
  pessoal; voltam a ser a rota se o app virar produto com assinatura, porque
  o Meu Pluggy não permite uso comercial.

## Consequências
- O PRD deixa de pôr Open Finance fora de escopo (seção 8).
- **Cartões ficam para uma fase própria**: exigem decidir como a compra no
  cartão e o pagamento da fatura convivem sem contar a mesma despesa duas
  vezes, além das parcelas (`creditCardMetadata`).
- A sincronização é manual (botão em Contas e bancos). Uma rotina automática
  diária fica para depois; a Pluggy já atualiza os dados uma vez por dia.
- Uso comercial do app exige migrar para o plano pago da Pluggy.
