# 0022. Aporte redistribui sobra de uma classe travada entre as classes ainda abaixo da meta

Status: aceita

## Contexto
Teste de uso real (10h de QA manual) expôs um caso que nem o ADR 0013 nem
o ADR 0019 cobrem: um aporte de R$ 38 mil contra uma carteira cujos gaps
somam mais que o aporte (ou seja, `closesEveryGap = false`, o ADR 0019
nem chega a ativar) deixou cerca de R$ 8 mil parados em `unallocatedCents`,
mesmo com outras classes ainda claramente abaixo da própria meta.

Causa raiz: o nível 1 (`services/investments.ts`, `suggestContribution`)
calcula a fatia de cada classe (`classAlloc`) proporcional ao gap sobre o
total do aporte, **uma única vez**, e nunca reconsidera essa fatia depois.
Quando uma classe recebe sua fatia mas os ativos elegíveis dela (nota
lançada, `rebalanceCents > 0`) não conseguem absorver tudo — porque a
soma das capacidades individuais é menor que a fatia proporcional —, o
que sobrou daquela fatia específica não é oferecido a nenhuma outra
classe que ainda tenha gap aberto. Ele cai direto em `unallocatedCents`,
mesmo com espaço real em outra classe.

Isso é diferente do caso do ADR 0019: lá, toda classe já está na própria
meta (gap zero em todas) e por isso não há "quem mais precisa" — aqui,
há uma classe com gap aberto e capacidade livre, mas o cálculo de fatia
único nunca chega a oferecer a ela.

## Decisão
O nível 1 passa a ser iterativo ("water-filling") só no ramo em que o
aporte NÃO fecha todo gap (`closesEveryGap = false`; o ramo em que fecha
continua devendo a cada classe exatamente seu `deltaCents`, sem mudança):

1. Para cada classe na fila, uma chamada de sondagem a
   `allocateAcrossSectors` com orçamento `min(deltaCents, dinheiro
   restante)` descobre a capacidade real dela — não pelo que os ativos
   *deveriam* absorver em teoria, mas pelo que sobra depois de respeitar
   preço por cota inteira, exatamente como o cálculo final já respeita.
2. O dinheiro se distribui em rodadas: a cada rodada, a fatia de cada
   classe ainda ativa é proporcional ao gap dela sobre o total do gap das
   classes ainda ativas; uma classe que bate no teto da própria
   capacidade sai da rodada seguinte, e o que ela não conseguiu absorver
   volta para o total a redistribuir entre as classes que ainda têm
   espaço na rodada seguinte.
3. Converge quando não há mais dinheiro a distribuir ou quando nenhuma
   classe ativa tem mais espaço — nesse ponto, e só nesse ponto, o
   restante é honestamente `unallocatedCents` (a mesma regra de sempre:
   nunca sugerir venda, nunca aportar num ativo de nota 0).
4. O nível 4 (ADR 0019) não muda: continua só existindo quando
   `closesEveryGap = true`, e continua operando sobre `targetBps`, não
   sobre gap — as duas cascatas resolvem problemas diferentes e não se
   sobrepõem.

## Alternativas consideradas
- **Redistribuir só uma vez (2 rodadas, não N):** descartada — com 4+
  classes configuradas, uma segunda classe travada na segunda rodada
  deixaria a mesma sobra sem destino de novo; o problema é genérico o
  bastante para exigir convergência real, não um número fixo de rodadas
  escolhido para o caso de teste específico.
- **Calcular a capacidade de cada classe uma vez, no início, e nunca
  reconsultar `allocateAcrossSectors`:** descartada — a capacidade real
  depende do preço por cota e do que já foi oferecido a essa classe;
  sondar com o orçamento certo (`min(deltaCents, sobra)`) é a única forma
  de saber a capacidade sem inventar uma segunda fórmula paralela à que já
  decide isso hoje (`allocateAcrossSectors`).
- **Deixar a sobra de uma classe travada ir direto para o nível 4
  (peso-alvo):** descartada — o nível 4 só faz sentido matematicamente
  quando todo gap fechou (divisão por peso, não por gap, porque gap é
  zero em todas); usar peso-alvo aqui empurraria dinheiro para uma classe
  já na meta ou além, contrariando o próprio ADR 0013.

## Consequências
- `suggestContribution` (`server/src/services/investments.ts`) ganha uma
  sondagem de capacidade por classe e um laço de rodadas no lugar do
  cálculo de fatia único, só no ramo `!closesEveryGap`.
- `specs/investments`, seção "Cascata de aporte", documenta a
  redistribuição por rodadas como parte do nível 1 (não um 5º nível — é
  uma correção de como o nível 1 já deveria ter funcionado).
- `scripts/verify.ts`: novo caso — aporte que não fecha todo gap, uma
  classe com gap grande mas poucos ativos elegíveis (capacidade menor
  que a fatia proporcional) e outra classe com gap aberto e capacidade
  de sobra, confirmando que a sobra da primeira chega à segunda em vez
  de cair em `unallocatedCents`.

## Adendo: bug irmão encontrado com dados reais, na mesma investigação
Testando este ADR contra o portfólio real (aporte de R$ 38.800), Tesouro
Direto e Cripto — cada um com 2 títulos pontuados, ambos sem setor
cadastrado (mesmo grupo "Sem setor") — ficavam de fora da sugestão por
completo, mesmo tendo capacidade real para receber uma fração pequena.
Causa: `allocateAcrossSectors` usava `emptyStreak < sectorKeys.length`
para decidir quando desistir, tratando "o primeiro item deste setor não
coube no orçamento" como "nenhum setor tem mais nada" — com um único
setor, um título caro sorteado primeiro (por ter o maior gap) já
zerava a sugestão inteira da classe, mesmo com um segundo título mais
barato, do mesmo setor, ainda na fila. Corrigido trocando essa contagem
por "quantos candidatos ainda não foram tentados" (`candidatesLeft`),
que só chega a zero quando cada título realmente já passou pela
tentativa — não quando o primeiro falha. Este bug é anterior a este ADR
(existia desde antes da cascata proporcional do ADR 0013) e afeta os
outros três níveis também, não só o novo laço de rodadas; coberto por
um caso dedicado em `scripts/verify.ts` (8h-3), com um ativo caro e um
barato no mesmo setor, provando que o segundo continua alcançável.
