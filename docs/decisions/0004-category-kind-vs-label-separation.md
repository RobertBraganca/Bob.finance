# 0004. `kind` da categoria decide a contabilidade; o nome é só para o humano

Status: aceita

## Contexto
Uma transferência PJ → PF é, para o usuário, "pró-labore" — um rótulo que
importa para rastrear quanto ele tirou da empresa. Mas se essa transferência
for categorizada com `kind: income`, ela conta como receita na visão
combinada de todas as contas. Como o cliente já pagou a PJ (isso já contou
como receita uma vez), o repasse PJ → PF contando como receita de novo
dobra o número: uma vez quando o cliente paga, outra quando a empresa repassa
para a pessoa. Isso foi um bug real nesta base (~R$6.534,81 de receita de
agosto que na verdade eram R$3.460,20) — descoberto quando o usuário
estranhou o número e pediu para investigar.

## Decisão
Toda categoria tem um `kind` (`income` | `expense` | `transfer` |
`investment`) que decide se ela soma nos totais e como — independente do
nome que o usuário vê. "Transferências / Pró-labore" tem `kind: transfer`,
não `income`: o nome continua dizendo a verdade sobre o que é o dinheiro
(pró-labore), mas a contabilidade não conta a mesma entrada de caixa duas
vezes.

Padrão geral: **o nome de uma categoria é para o humano; o `kind` é para a
matemática.** Uma categoria pode (e deve, quando fizer sentido) ter um nome
específico e descritivo mesmo quando seu `kind` é genérico (`transfer`).

## Alternativas consideradas
- **Renomear para algo genérico tipo "Transferência interna":** resolveria a
  dupla contagem, mas perde a informação de que aquele fluxo específico É o
  pró-labore — informação que o usuário quer para acompanhar quanto retira
  da empresa por mês.
- **Um campo booleano `countsAsIncome` separado do nome, mas manter
  `kind: income`:** redundante com o que `kind` já faz; adicionaria um
  segundo lugar para o mesmo tipo de decisão.

## Consequências
- Ao criar uma categoria nova, decidir o `kind` correto é mais importante
  que escolher um nome bonito — um nome errado confunde uma pessoa lendo a
  tela; um `kind` errado corrompe um total.
- `590 lançamentos históricos` precisaram de recategorização em massa
  (`POST /rules/recategorize`) quando esta regra foi corrigida — uma
  correção de `kind` em uma regra existente deveria sempre considerar
  recategorizar o histórico, não só lançamentos futuros.
