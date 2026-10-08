# 0042. Orçamento por grupos de % da renda, unificado com as Metas do mês

Status: aceita (07/10/2026; implementada conforme `specs/budget-groups`)

## Contexto
Em 07/10/2026 o usuário trouxe telas de referência de um orçamento por
grupos: seis grupos (Custos Fixos, Conforto, Prazeres, Conhecimento, Metas,
Liberdade Financeira), cada um com um % da renda, previsto, gasto e
restante. O app já tinha Metas do mês (`specs/monthly-goals`): meta de
receita, teto geral e teto por TAG em reais, guardados por mês.

Os grupos não substituem as TAGs: cortam na transversal (Supermercado é
custo fixo, Restaurante é prazer, Aporte não é gasto).

## Decisão
1. **Uma tela, "Orçamento"**: grupos com % no topo; meta de receita, teto
   geral e tetos por TAG continuam abaixo, como detalhe.
2. **Grupo pela TAG**: cada TAG (ou sub-TAG) pertence a um grupo; filha herda
   da mãe. Classificação, não meta: não é versionada.
3. **Renda base** = receitas confirmadas do mês nas contas pessoais (todas
   menos a conta PJ do Motor) mais o repasse PJ → PF lançado como
   transferência. No mês corrente, até a renda entrar, o previsto usa a
   renda típica e avisa.
4. **Grupos de aporte**: Metas mede compras em ativos separados para uma
   meta (decisions/0041); Liberdade Financeira mede as demais compras,
   inclusive a reserva de emergência. Aportar não é gasto.
5. **Grupos editáveis** a partir de uma semente com os seis do método.
6. **% versionados por mês** (`budget_plans.effective_period`): mudar vale
   do mês corrente em diante; o passado guarda o seu.
7. **Ponto de partida**: os % do método, com o histórico real de 6 meses ao
   lado e a opção de usá-lo.

## Alternativas consideradas
- **Substituir os tetos por TAG**: perderia um controle que já existe e é
  mais fino.
- **Telas separadas**: duas noções de "meta de gasto" sem relação entre si.
- **Grupo por lançamento**: mais preciso, mas um campo a mais para revisar
  em todo lançamento.
- **Base na meta de receita ou só na renda típica**: estável, mas não
  responde "quanto do que entrou este mês foi para cada grupo".

## Consequências
- Nova tabela de grupos e de planos, duas colunas em `categories`.
- O rótulo do menu muda de "Metas do mês" para "Orçamento"; o endereço
  `/metas` continua.
- Lançamentos ganham o filtro por grupo.
