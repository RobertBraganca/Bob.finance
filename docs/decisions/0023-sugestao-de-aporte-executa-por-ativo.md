# 0023. Sugestão de aporte se executa por ativo, um botão por linha

Status: aceita

## Contexto
A cascata de sugestão de aporte (`decisions/0013`, `0019`, `0022`) sempre
respondeu "para onde direcionar o dinheiro", nunca "como de fato investir
esse dinheiro". Só a fatia da reserva de emergência tinha um botão
("Aportar na reserva" → `ReserveContributeModal`, que já grava uma
transação real). Toda a lista por classe/ativo (Ações, FIIs, Tesouro
Direto, Cripto, Fundos) era só leitura: nenhum botão, nenhuma ação —
o usuário via exatamente quanto comprar de cada ativo e tinha que ir
registrar cada compra manualmente em outro lugar do app, repetindo à mão
os mesmos números que a tela já tinha calculado.

## Decisão
Cada linha de ativo na sugestão ganha o próprio botão de confirmação
("Comprar"), não um botão por classe nem um botão único para o plano
inteiro — escolha do usuário entre as três opções, para poder executar
só o que quer agora e deixar o resto pendente (ex.: pular um ativo
específico, ou comprar hoje só metade da lista e o resto depois de
revisar cotação).

- Reaproveita o endpoint que já existe (`POST /investments/trades`) —
  cada "Comprar" é exatamente a mesma chamada que criar um trade manual,
  com `assetId`, `quantity` e `unitPriceCents` vindos direto da sugestão
  (`kind: 'buy'`). Nenhum endpoint novo de "executar plano" foi criado:
  a sugestão sempre foi só matemática sobre posições reais, então
  "executar uma linha" é literalmente registrar o trade que a linha já
  descreve.
- Ativo sem cotação (`unitPriceCents === null`, fallback de
  `allocateAcrossSectors`) registra como `quantity: 1` com
  `unitPriceCents` igual ao `suggestedCents` da linha — uma "unidade"
  valendo o total sugerido, já que não há preço por cota para dividir.
- Uma única data (`tradedOn`) no topo do painel serve para toda compra
  confirmada nesta sessão, em vez de um campo de data por linha — a
  cascata inteira representa "o aporte de hoje", não compras espalhadas
  em datas diferentes.
- Depois de confirmar uma linha, o plano inteiro recalcula com o MESMO
  valor de aporte digitado (invalidação de query, igual ao que
  `ReserveContributeModal` já fazia) — não precisa de nenhuma
  contabilidade de "quanto já foi executado" no front: a posição do
  ativo já mudou no banco, então o próximo cálculo do gap já reflete
  isso sozinho, e o valor que sobra para as demais linhas ajusta por
  conta própria.

## Alternativas consideradas
- **Um botão só para o plano inteiro:** descartada pelo usuário —
  perderia a possibilidade de pular um ativo específico (ex. cotação
  desatualizada, ou o usuário simplesmente não quer aquele ativo hoje).
- **Um botão por classe:** descartada pelo usuário — ainda obrigaria a
  comprar todo-ou-nada dentro de uma classe (ex. as 14 ações sugeridas
  de uma vez), quando o ponto de pedir granularidade era justamente
  poder escolher ativo a ativo.
- **Um endpoint novo "executar plano completo":** descartada — o plano
  não é uma entidade persistida em lugar nenhum (é recalculado a cada
  requisição a partir da carteira real), então não há "plano" para
  referenciar num segundo endpoint; cada linha já é, por construção, os
  mesmos campos que `POST /investments/trades` espera.

## Consequências
- `src/pages/Investments.tsx` (`ContributionPlanner`): novo campo de
  data no topo, e cada linha de ativo (dentro do `.map` de
  `c.assets`) ganha um botão "Comprar" com sua própria `useMutation`
  chamando `POST /investments/trades`.
- `specs/investments`, seção "Cascata de aporte", documenta a execução
  por linha como parte da mesma feature, não uma 5ª camada nova.
- Nenhuma mudança de schema ou rota nova no backend — reaproveita
  `createTrade` e a validação que já existem.
