# 0016. Simulador de decisões reusa funções de produção, nunca persiste

Status: aceita

## Contexto
Uma avaliação de roadmap propôs um "simulador de decisões" ("e se eu
comprar X?", "e se eu quitar esta dívida?") que mostrasse impacto em
Health Score, Runway e disponível para alocação. É a primeira área do
produto cuja razão de existir é inteiramente a categoria Simulação da
taxonomia do `decisions/0010` — as outras áreas produzem Observação e
Projeção como resultado principal e tocam Simulação de forma incidental
(ex. o cenário acelerado de `specs/debt`).

Duas perguntas de arquitetura precisavam de resposta antes de existir um
spec: a simulação recalcula os mesmos números com uma segunda fórmula, ou
reusa as funções que já produzem Health Score/Runway/disponível? E o
resultado de uma simulação é descartável ou vale guardar?

## Decisão
- **Reusa, nunca duplica.** Toda leitura usada pelo simulador é a mesma
  função que já serve `/financial-health/score`, `/financial-health/runway`
  e `/motor-financeiro/disponivel`, chamada com um insumo hipoteticamente
  ajustado — nunca uma segunda implementação da mesma fórmula. Isso é a
  extensão natural de "derivar, nunca guardar" (PRD seção 4): se derivar
  sempre da mesma fonte evita dessincronia entre telas, reusar a mesma
  função evita dessincronia entre o número real e o número simulado da
  mesma métrica.
- **Nunca persiste.** Uma simulação não é lançamento, não é meta, não é
  configuração — é uma pergunta e uma resposta, descartada depois de
  respondida. Não existe tabela `simulations` nem histórico.
- **Escopo de v1 travado em dois tipos de hipótese** (gasto único, quitação
  de dívida) — os dois exemplos que a própria avaliação de roadmap deu, e
  os dois que reusam mecanismo já existente (saldo de conta, reserva,
  projeção de dívida) sem precisar compor com `cashFlowForecasts`
  hipotético, que é uma complexidade maior.

## Alternativas consideradas
- **Persistir cada simulação rodada** (para o usuário comparar depois):
  descartada nesta versão — abriria a pergunta de "isso é dado real ou
  hipotético" em toda leitura que trata `transactions`/tabelas de meta como
  fonte de verdade; mais seguro nascer sem persistência e adicionar depois,
  com spec próprio, se a necessidade aparecer.
- **Simular também decisão de investimento** (comprar/vender um ativo
  específico): descartada — colidiria de frente com a regra "nunca sugere
  vender" do Diagrama do Cerrado (`specs/investments`); simular uma venda
  legitimaria na interface exatamente o que aquela área se recusa a
  sugerir.

## Consequências
- Novo `docs/specs/decision-simulator/spec.md`.
- Cada função reaproveitada (`healthScore`, `runway`,
  `disponivelParaAlocacao`) pode precisar de um parâmetro de override que
  não existe hoje — mesmo padrão que `financialEngine.breakEven` já usa.
  Adicionar esse parâmetro é parte da implementação, verificado função por
  função na execução, não assumido de antemão.
- Simulação de novo compromisso mensal recorrente e simulação de venda de
  investimento ficam fora de escopo, registradas no spec como extensão
  futura, não esquecidas.
