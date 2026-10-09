# 0044. Endividamento v2, com o resumo dos cartões pelo Open Finance

Status: aceita (08/10/2026; implementada em `specs/card-summary-sync` e `specs/debt-v2`, com os desvios anotados lá)

## Contexto
A revisão de 08/10/2026 mostrou que Endividamento responde "quanto devo nas
dívidas cadastradas", não "estou me endividando": o cartão (R$ 2.501 de
limite usado, PicPay em 87%) não aparecia, a renda comprometida dividia
pelo faturamento bruto e a parcela das dívidas sumia do Orçamento. O
usuário pediu o cartão junto, a data livre, o custo em reais e a
renegociação, com os dados do cartão vindos do Meu Pluggy.

## Decisão
1. **Duas partes, nesta ordem**: primeiro sincronizar o **resumo** dos
   cartões (limite, disponível, faturas com encargos, parcelas futuras por
   mês); depois o Endividamento v2 que o lê.
2. **Sem lançar compras do cartão**: nenhum total de gasto do app muda.
   Lançar compras fica para depois, com o pagamento da fatura tratado como
   transferência.
3. **Dívida = contratos + limite usado** dos cartões; comprometimento sobre
   a renda típica **pessoal** (a do Orçamento).
4. **Renegociação registrada e simulada**, com a dívida de origem encerrada
   como "renegociada".
5. **Parcelas com TAG** (padrão Financeiro › Empréstimos) para entrarem no
   Orçamento.

## Alternativas consideradas
- **Usar só o limite medido à mão**: menor, mas sem faturas futuras nem
  encargos.
- **Lançar as compras já**: Orçamento mais completo, mas muda todos os
  totais do app e exige separar pagamento de fatura.
- **Grupo próprio "Dívidas" no Orçamento**: o usuário preferiu a TAG
  padrão.

## Consequências
- Três tabelas novas para cartões e duas colunas + uma tabela em dívidas.
- A rotina diária de Open Finance passa também pelos cartões.
- Publicar `ledger` e `insights`.
