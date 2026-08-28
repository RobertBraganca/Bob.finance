# 0003. Pendências unificadas ao ledger; conciliação é sempre sugestão manual

Status: aceita

## Contexto
Um freelancer sabe de receita futura confirmada (cliente recorrente, parcela
já acordada) antes do banco postar o valor. Isso é útil para fluxo de caixa,
mas dois riscos concretos apareceram ao desenhar a feature: (1) se for uma
tabela separada de "previsão", ela pode divergir silenciosamente do ledger
real e nenhum painel confia nela; (2) quando o extrato real chega, o valor
pendente e o valor real são a mesma coisa duas vezes, se nada os casar.

## Decisão
Uma pendência é uma linha real em `transactions`, com `pending = true` — não
uma tabela separada, não uma "preview". Toda agregação (`totals`,
`monthlySeries`, `categoryBreakdown`, `accountBalances` etc.) filtra
`pending = 0` por padrão, então uma pendência nunca infla um resultado já
fechado. `listTransactions` (Lançamentos) NÃO filtra — pendente e real
coexistem visualmente ali, porque é o único lugar que precisa mostrar os
dois lados da mesma verdade.

Conciliação (achar que uma pendência e uma linha real são a mesma coisa) é
sempre uma sugestão: mesma conta + mesmo valor exato + data dentro de ±15
dias. Nunca aplicada sozinha — o usuário confirma com um clique
("`confirm-match`"), que então apaga a pendência em favor da linha real.

## Alternativas consideradas
- **Tabela de previsão separada (`cash_flow_projection`):** foi a primeira
  implementação, descartada porque poluía a Home com uma seção a mais e
  duplicava o conceito de "lançamento" em dois lugares diferentes do banco.
- **Conciliação automática (match de alta confiança aplica sozinho):** era a
  recomendação inicial. O usuário optou explicitamente por exigir
  confirmação manual em todos os casos — nenhum match é confiável o
  suficiente para apagar dado sem revisão humana, mesmo com janela de data
  e valor exatos.

## Consequências
- Toda query de totais precisa lembrar do filtro `pending = 0` — um
  esquecimento aqui infla silenciosamente um período (já aconteceu uma vez
  nesta base de código com `ledgerBounds`, corrigido).
- A tela de pendências no dashboard mostra só o valor total, sincronizado
  com o mesmo seletor de período do resto do painel (`from`/`to` idênticos
  aos das outras agregações — ver `specs/cash-flow-reconciliation/spec.md`).
  Como todo preset do app tem `to` no máximo "hoje", uma pendência datada no
  futuro só aparece no card quando o período selecionado já alcança aquele
  mês; isso é aceito como comportamento correto, não uma lacuna — quem quer
  ver a pendência antes disso a encontra em Lançamentos.
