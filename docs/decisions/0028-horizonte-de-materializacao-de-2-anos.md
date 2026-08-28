# 0028. Horizonte de materialização de pendências sobe de 6 para 24 meses

Status: aceita

## Contexto
Usuário pediu, explicitamente (28/08/2026): poder lançar receitas
futuras recorrentes fixas (ex. salário) e acompanhar, no período
máximo, quanto já foi realizado x quanto está pendente — visualizando
"pelo menos até o ano de 2028", ou seja, dois anos à frente de hoje.

Investigação encontrou a causa raiz do porquê isso não funcionava: uma
previsão recorrente (`cash_flow_forecasts`) só vira uma linha real e
visível em `transactions` (`pending = true`) quando materializada, e
`MATERIALIZE_HORIZON_MONTHS` (`services/cashFlow.ts`) estava fixo em
**6 meses**. O filtro "Máximo" da UI (`forwardBoundsFor`,
`src/lib/store.tsx`) já buscava até 24 meses à frente — mas não havia
o que encontrar além do 6º mês, porque a linha simplesmente não
existia ainda. `decisions/0024` já tinha resolvido metade do problema
(uma previsão além do horizonte não "some sem aviso", aparece numa
lista separada em "Ver lançamentos"), mas isso é um aviso, não a
pendência real rastreável que o usuário pediu.

## Decisão
`MATERIALIZE_HORIZON_MONTHS` sobe de 6 para 24. Nenhuma outra mudança
de código: `materializeAll()` já processa um forecast de cada vez, em
loop sequencial (não `Promise.all`), então o horizonte maior não
reintroduz o problema de concorrência de `decisions/0026` — só produz
mais linhas, uma de cada vez, como já fazia.

Verificado ao vivo: uma previsão recorrente de teste (salário,
R$5.000, todo dia 5, a partir de 2026-08) materializou exatamente 24
ocorrências mensais, de 2026-08 a 2028-07, na primeira chamada a
`GET /cash-flow/pending`.

## Alternativas consideradas
- **Horizonte diferente por direção (receita 24 meses, despesa
  continua em 6)**: descartada — o pedido foi especificamente sobre
  receita, mas nada no mecanismo distingue direção hoje, e uma
  assimetria arbitrária confundiria mais do que ajudaria. Se surgir um
  motivo real para despesas ficarem num horizonte menor, isso vira uma
  decisão própria depois.
- **Uma projeção calculada só para exibição, sem materializar linha
  real em `transactions`** (ex. um endpoint que soma "o que a previsão
  renderia" sem gravar nada): descartada — o pedido do usuário foi
  "lançar as receitas futuras", não só visualizar uma projeção; a
  arquitetura já existente (materializar em `transactions`,
  `pending = true`, nunca contar em totais fechados) já entrega
  exatamente "lançado e rastreável, mas não contaminando o realizado"
  sem precisar de um segundo mecanismo paralelo.
- **Horizonte maior que 24 meses** (ex. 36, cobrindo "até 2028"
  contado do fim do ano em vez do mês corrente): descartada — o
  usuário pediu literalmente "período de dois anos", que 24 meses
  atende exatamente.

## Consequências
- Cada previsão recorrente ativa agora materializa até 24 linhas
  (antes, até 6) na primeira vez que `/cash-flow/pending` ou
  `/cash-flow/forecasts` é chamado depois da mudança — um aumento real,
  mas trivial em escala pessoal (uma dúzia de previsões ativas, no
  máximo, não milhares).
- **Risco já existente, agora numa janela maior**: cada ocorrência
  materializa com o valor do modelo NO MOMENTO da materialização,
  congelado dali em diante (`materialize()` só insere ocorrências que
  ainda não existem, nunca atualiza uma já criada). Se o valor do
  salário mudar (reajuste) depois que os 24 meses já foram
  materializados, os meses futuros já materializados ficam com o valor
  antigo — precisam de edição manual, um por um, pela mesma tela que já
  edita qualquer pendência hoje. Isso já era verdade com 6 meses; a
  mudança só amplia a janela onde pode acontecer, não introduz um
  comportamento novo.
- `FAR_FUTURE_HORIZON_MONTHS` (60 meses, usado só para computar "qual a
  próxima ocorrência" de uma previsão nova, decisions/0020) continua
  sem alteração — já era mais generoso que os 24 meses novos.
