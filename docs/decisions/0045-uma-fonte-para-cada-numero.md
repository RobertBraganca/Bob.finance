# 0045. Uma fonte para cada número: Saúde, Diário e Patrimônio leem as telas donas

Status: aceita (09/10/2026; implementada em `specs/personal-picture`, com os desvios anotados lá)

## Contexto
A revisão de 09/10/2026 achou três versões do comprometimento de renda (1,9%
e 55,5% na Saúde, 19,9% no Endividamento), dois tetos de gasto (Metas do mês
e o plano do Orçamento), três custos de vida, um patrimônio sem os cartões e
com o caixa da PJ dentro, e a renegociação do PicPay contada duas vezes
(como dívida e como parcelamento na fatura). Cada tela tinha nascido antes da
tela dona do número e nunca foi religada.

## Decisão
- Cada número tem uma tela dona: renda, custo de vida e teto no Orçamento;
  dívida e comprometimento no Endividamento; retirável na Minha empresa;
  reserva em Investimentos. Saúde, Diário e Patrimônio só leem.
- Patrimônio é pessoal; a empresa aparece à parte.
- Uma dívida pode ser "paga na fatura do cartão": conta uma vez, não gera
  pendência na conta, e a parcela entra no Orçamento pela TAG.
- Liquidez sai do score.
- Evolução de score e patrimônio por foto mensal gravada daqui em diante; o
  passado fica reconstruído e marcado.

## Consequências
- Os números da Saúde vão mudar (o comprometimento sobe; o score muda de
  composição). O teto antigo de Metas do mês deixa de ser lido por estas telas.
- Uma tabela nova (`monthly_snapshots`) e uma coluna (`debts.paid_via_card_id`).
- O histórico só fica fiel a partir do primeiro mês com foto.
