# 0011. Rebalanceamento nunca sugere reduzir

Status: aceita

## Contexto
O card "Rebalanceamento sugerido" em `Investments.tsx` (aba Carteira, ao
lado do gráfico "Alocação por classe") lista, por classe, um texto no
padrão "aportar R$X" ou "reduzir R$Y", derivado de `allocation()` em
`services/investments.ts` (`rebalanceCents`, positivo ou negativo).

Isso contradiz três documentos do próprio projeto ao mesmo tempo:

- O método de origem do Diagrama do Cerrado (Raul Sena, ver o material em
  anexo à revisão que motivou este ADR) é explícito: "eu NÃO acredito em
  vender ações para rebalancear, o que eu faço é utilizar meu aporte do mês
  para comprar as ações". A cascata de aporte já implementada
  (`suggestContribution`, ver `specs/investments`, "cascata de aporte") só
  direciona dinheiro novo — nunca sugere venda. O card com "reduzir" é a
  única superfície do produto que contradiz o próprio método que inspirou a
  feature.
- A extensão "Desvio de alocação" do mesmo spec já resolveu este exato
  problema para a tabela por classe: "não retorna nenhum campo de ativo
  sugerido ou ação recomendada". O card de rebalanceamento, criado antes
  dessa extensão, nunca foi revisado contra a mesma régua.
- `decisions/0010` (Evidenciar, nunca prescrever) classifica "reduzir R$Y"
  como Recomendação, a quarta categoria que o ADR deixa estruturalmente
  fora do produto, e cita o Ofício-Circular CVM/SIN 2/2026 como o motivo
  concreto de a linha importar para investimentos.

O usuário confirmou, ao revisar isto, que o gráfico de barras "Alocação por
classe" (`AllocationChart`) deve continuar como está — o problema não é o
gráfico, é o texto do card ao lado dele.

## Decisão
O card passa a se chamar "Necessário para atingir a meta" e lista somente
as classes com `rebalanceCents > 0` (abaixo da meta). Uma classe na meta ou
acima dela não aparece na lista — nunca com "reduzir R$0" nem qualquer
outro valor. A frase de cada linha segue o padrão Simulação já em uso em
`specs/motor-financeiro` ("R$X ainda seria necessário aportar nesta classe
para alcançar a meta configurada"), nunca o imperativo "aporte X".

O endpoint `/investments/allocation` mantém `rebalanceCents` no contrato
(o gráfico de barras precisa do desvio assinado para posicionar a marca da
meta), mas o card de texto ao lado dele filtra e reformula antes de
renderizar. Nenhuma mudança de schema ou de rota é necessária.

## Alternativas consideradas
- **Remover o card inteiro**, mantendo só o gráfico de barras e o
  `AllocationDeviationCard` (tabela neutra já existente): descartada porque
  perderia a única superfície que traduz o desvio em R$ — a
  `AllocationDeviationCard` mostra só pontos percentuais, e "quanto falta
  aportar em R$" é informação genuinamente útil que nenhum outro card
  oferece, distinta da tabela de desvio.
- **Manter "reduzir" mas trocar o verbo por algo mais neutro** (ex.
  "excesso de R$Y"): descartada porque mesmo sem o verbo no imperativo, o
  valor ainda comunicaria "isto deveria ser vendido", que é exatamente o
  giro de carteira que o método de origem identifica como o erro central do
  rebalanceamento tradicional.

## Consequências
- `Investments.tsx`: o card de "Rebalanceamento sugerido" (linhas ~563-598
  na versão revisada nesta sessão) é reescrito para filtrar por
  `rebalanceCents > 0` e trocar a string de exibição.
- Nenhuma migração de banco, nenhuma mudança de contrato de API.
- `specs/investments/spec.md` já foi atualizado para descrever o card
  corrigido antes da implementação, seguindo o processo de SDD do projeto
  (spec primeiro, código depois).
