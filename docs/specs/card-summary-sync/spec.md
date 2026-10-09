# Spec: Resumo dos cartões pelo Open Finance

Status: implementado (08/10/2026) · parte 1 de 2 (a parte 2 é `specs/debt-v2`) · os quatro cartões ligados e sincronizados em 09/10/2026

## Objetivo
Trazer do Meu Pluggy, para cada cartão de crédito, o **resumo** que o
Endividamento precisa: limite, limite disponível, faturas (atual e
próximas, com encargos) e as parcelas futuras somadas por mês. **Nenhuma
compra é lançada no extrato**: nenhum total de gasto do app muda
(decisão do usuário, 08/10/2026).

## Histórias de usuário
- Como quem usa cartão, quero ver o limite usado e a fatura de cada cartão
  sem digitar o saldo à mão.
- Como quem parcela, quero saber quanto já está comprometido nos próximos
  meses pelas parcelas do cartão.
- Como quem paga juros, quero saber quanto de encargos (juros, IOF, multa)
  cada fatura cobrou.

## O que a Pluggy entrega (a confirmar contra a API ao implementar)
- `GET /accounts?itemId=`: conta `type = CREDIT` com `creditData`
  (`creditLimit`, `availableCreditLimit`, `balanceCloseDate`,
  `balanceDueDate`, `minimumPayment`).
- `GET /bills?accountId=`: faturas (`dueDate`, `totalAmount`,
  `minimumPaymentAmount`, `financeCharges[]` com tipo e valor).
- `GET /transactions?accountId=` da conta de cartão: compras com
  `creditCardMetadata` (`installmentNumber`, `totalInstallments`,
  `totalAmount`, `purchaseDate`, `billId`).
Se algum campo não vier como descrito, a implementação registra o desvio
aqui antes de seguir.

## Modelo de dados
- **`card_connections`** (nova): `credit_card_id` → `credit_cards`
  (cascade), `provider_item_id`, `provider_account_id` (único),
  `last_synced_at`, `last_error`. Um cartão do app liga a uma conta de
  cartão da Pluggy, no máximo.
- **`card_bills`** (nova): `credit_card_id`, `provider_bill_id` (único),
  `due_date`, `total_cents`, `minimum_cents`, `finance_charges_cents` e
  `finance_charges` (jsonb com o detalhe por tipo), `synced_at`.
- **`card_months`** (nova, ver Desvios): por cartão e mês, o lançado, o
  projetado de parcelas e os encargos; recalculada a cada sincronização.
- **`credit_cards`**: o limite passa a vir da Pluggy quando ligado
  (`credit_limit_cents` atualizado), e o disponível entra como
  `credit_card_snapshots` do dia (o mesmo histórico medido de hoje).

## Regras
- **Ligação**: em Ajustes › Open Finance, a conta de cartão descoberta
  deixa de ser recusada e pode ser ligada a um cartão do app (não a uma
  conta corrente).
- **Sincronização**: a rotina diária de hoje (22:00) passa também pelos
  cartões ligados: atualiza limite e disponível, grava as faturas (as
  fechadas dos últimos 12 meses e a aberta) e refaz a previsão de parcelas.
- **Parcelas futuras**: para cada compra parcelada com
  `installmentNumber < totalInstallments`, as parcelas que faltam caem nos
  meses das próximas faturas (uma por mês, valor = `totalAmount ÷
  totalInstallments`, ajuste de centavos na última). Soma por mês.
- **Encargos**: soma de `financeCharges` por fatura; é o "custo do cartão"
  em reais que o Endividamento mostra.
- **Sem lançamentos**: compras do cartão não viram `transactions`. O
  pagamento da fatura continua saindo da conta corrente como hoje.
- Erros da Pluggy ficam em `card_connections.last_error`, como nas contas
  correntes; o cartão continua com o último dado medido.

## Contrato de API
- Rotas de conexão existentes (`/bank-connections`, no `ledger`) aceitam
  ligar uma conta `CREDIT` a um `creditCardId`.
- `GET /credit-cards` passa a trazer, por cartão: `source` ('pluggy' |
  'manual'), `lastSyncedAt`, `openBill`, `nextBills` (até 3) e
  `futureInstallments` (próximos 12 meses).

## Fora de escopo
- Lançar compras do cartão no extrato (etapa futura, com o tratamento do
  pagamento da fatura como transferência).
- Cartões de outros agregadores; webhooks.

## Verificação
Ligar um cartão real e sincronizar com autorização (é dado real, só
leitura na Pluggy); conferir limite, fatura aberta e parcelas futuras
contra o app do banco; nenhum total do Painel ou do Orçamento muda.

## Desvios da implementação

### O que a API realmente entrega (leitura de 08/10/2026, 4 cartões)
- `creditData.availableCreditLimit` vem **0** em dois cartões (Nubank PJ e
  PicPay) que têm limite livre; não é confiável sozinho. `balance` da conta
  de cartão é o saldo atual da fatura e bate com o "usado" medido à mão.
- `/bills` traz só as **12 faturas fechadas** (`dueDate`, `billClosingDate`,
  `totalAmount`, `minimumPaymentAmount`, `financeCharges[]`, `payments[]`);
  a fatura aberta e as futuras **não** vêm como fatura.
- `financeCharges[].type`: `LATE_PAYMENT_INTEREST`,
  `LATE_PAYMENT_REMUNERATIVE_INTEREST`, `LATE_PAYMENT_FEE` e `OTHER` (este
  com `additionalInfo` "Saldo...", que é saldo levado e não encargo).
- `creditCardMetadata` das compras: `billForecastDate` (mês da fatura em
  que cai), `billId`, `purchaseDate`, `paymentType` (`SINGLE` /
  `INSTALLMENT` / ausente) e, nas parceladas, `installmentNumber` e
  `totalInstallments`. Não há `totalAmount`. Parcelas futuras **não**
  existem como lançamento.

### Regras ajustadas
- **Limite usado**: `creditLimit − availableCreditLimit` quando o banco
  informa disponível > 0; senão o limite usado continua o último medido no
  app (não é sobrescrito por um 0) e a tela diz "disponível não informado
  pelo banco". O saldo atual (`balance`) é guardado sempre.
- **Fatura aberta e próximas**: soma das compras a partir do mês corrente
  (o que já está lançado para cair em cada fatura), mais as parcelas
  projetadas. O mês da fatura vem do **fechamento real** das faturas
  fechadas (`billClosingDate`, inclusive), mais um ciclo aberto um mês
  depois do último; `billForecastDate` só vale quando não há fatura que
  cubra a data. Motivo (primeira sincronização real, 08/10/2026): compras de
  agosto, que estavam numa fatura de setembro já paga, vieram com
  `billForecastDate` de outubro e multiplicavam a fatura aberta; pelo
  fechamento real ela ficou a poucos reais do `balance` do banco.
- **Pagamentos de fatura** (categoria `Credit card payment` ou descrição
  "Pagamento recebido") ficam fora da soma: não são compra nem crédito da
  fatura em que caem (sem isso, o mês do pagamento saía negativo).
- **Faturas fechadas**: o valor de cada uma é o `totalAmount` do banco, não a
  soma dos lançamentos. Atraso, saldo levado e acordos ("Saldo em atraso",
  "Crédito de atraso") fazem a soma divergir bastante do total da fatura.
  Para a fatura aberta vale o `balance`, **exceto** quando ele é igual ao
  limite usado (até R$ 1): em alguns bancos o `balance` é o total usado do
  cartão, não a fatura; aí a fatura aberta é a soma do ciclo aberto
  (lançado + parcelas projetadas).
- **Antecipação de parcelas**: o banco lança as parcelas que faltavam de uma
  vez com outra descrição ("ANTECIPACAO PARCELA 12/12" de uma "PARC SALDO
  TOT 6/12"). A compra (mesma data de compra e mesmo total de parcelas)
  termina na maior parcela lançada de qualquer descrição dela; sem isso o
  resumo projetava parcelas que já não existem.
- **Encargos de 12 meses** vêm do maior entre faturas e lançamentos. A lista
  `financeCharges` das faturas é bruta: o crédito de juros de uma
  antecipação ("AMORTIZACAO DE JUROS") não aparece nela, e o número das
  faturas fica acima do custo líquido. Em aberto.
- **Parcelas projetadas**: compras agrupadas por (`purchaseDate`,
  `totalInstallments`, descrição sem o "x/y"); da maior parcela já lançada
  em diante, as que faltam caem uma por mês, com o valor dessa parcela.
- **Encargos**: lançamentos de cartão cuja descrição ou
  `feeTypeAdditionalInfo` indica juros, IOF, multa, encargo, tarifa ou
  anuidade (estornos abatem), somados pelo mês da fatura. Encargo anulado
  pelo banco no mesmo dia por um crédito do mesmo valor ("Juros de dívida
  encerrada" + "Encerramento de dívida") não conta; das faturas
  fechadas, `financeCharges` exceto `OTHER`. Os dois são mostrados juntos
  só quando não se sobrepõem (por mês, vale o maior dos dois).
- **Tabelas**: `card_installment_forecast` vira `card_months`
  (`credit_card_id`, `period`, `posted_cents`, `projected_cents`,
  `charges_cents`, `installment_purchases`), recalculada a cada
  sincronização; `card_bills` guarda as fechadas como previsto.
