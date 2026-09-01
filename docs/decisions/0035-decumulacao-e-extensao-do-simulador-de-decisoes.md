# 0035. Decumulação/aposentadoria é extensão do Simulador de decisões, nunca calcula taxa de retirada

Status: aceita

## Contexto
A candidata #13 do estudo de viabilidade de features (29/08/2026) propõe um
módulo de decumulação: a fase em que o patrimônio para de crescer por aporte
e passa a ser consumido por retirada mensal, típica de planejamento de
aposentadoria. A avaliação anterior identificou o risco central: qualquer
"taxa segura de retirada" que o sistema calcule e devolva como saída
("você pode retirar R$X/mês") é uma recomendação financeira personalizada,
mesmo com matemática correta por trás, e cruza direto a fronteira que a
seção 8 do PRD marca como fora de escopo, a mesma fronteira que o
`decisions/0010` já formalizou para o resto da camada de inteligência
financeira.

Este não é um problema novo no produto. O `decisions/0016` já resolveu
exatamente esta classe de risco para o Simulador de decisões: a resposta lá
foi nunca calcular "o que fazer", só mostrar a consequência de uma hipótese
que o próprio usuário propõe. Decumulação é um domínio novo, mas o formato
do risco é idêntico ao que motivou aquele ADR.

## Decisão
Decumulação é uma extensão direta do padrão já estabelecido pelo
`decisions/0016`, não um princípio novo:

- **O sistema nunca calcula "quanto você pode retirar".** Não existe
  endpoint, botão ou tela cuja saída seja um valor de retirada mensal
  sugerido, recomendado ou "seguro". A única direção permitida é o inverso:
  o usuário propõe um valor de retirada mensal e um horizonte, o sistema
  responde com a consequência.
- **Consequência, não recomendação.** A resposta é sempre no formato "se
  você retirar R$X/mês a partir de Y, dado o retorno médio configurado, o
  patrimônio projetado esgota em Z" (ou "não esgota dentro do horizonte
  simulado", quando aplicável) — Simulação pura na taxonomia do
  `decisions/0010`, mesma classificação e mesmo motivo do próprio
  `decisions/0016`.
- **Reusa, nunca duplica.** Segue a primeira regra do `decisions/0016`: a
  projeção de patrimônio sob retirada reusa a mesma função de projeção
  composta já usada por `goalProjection` (`investments.ts`), com o sinal do
  fluxo mensal invertido (retirada em vez de aporte), não uma segunda
  fórmula de juros compostos escrita à parte para este domínio.
- **Nunca persiste.** Mesma segunda regra do `decisions/0016`: um cenário de
  decumulação não é meta, não é configuração, é uma pergunta e uma
  resposta descartada depois de respondida. Não existe tabela de plano de
  aposentadoria.

## Alternativas consideradas
- **Calcular uma "taxa segura de retirada" (ex. regra dos 4%) e mostrar como
  sugestão inicial, editável pelo usuário:** descartada. Mesmo rotulada como
  "sugestão" e mesmo editável depois, o sistema já teria computado e
  exibido um número de retirada recomendado antes de qualquer input do
  usuário — a mesma prescrição, só com um passo extra de edição opcional
  depois dela já ter sido dita.
- **Tratar decumulação como princípio novo, com seu próprio ADR
  independente do `decisions/0016`:** descartada — o risco e a solução são
  estruturalmente idênticos ao que aquele ADR já resolveu; redigir um
  princípio novo do zero obscureceria que isto é a mesma regra aplicada a
  um domínio novo, não uma segunda regra.

## Consequências
- Novo bloco em `docs/specs/decision-simulator/spec.md` (não um spec novo
  separado) descrevendo o terceiro tipo de hipótese: retirada mensal sobre
  patrimônio de investimento, ao lado dos dois já travados pelo
  `decisions/0016` (gasto único, quitação de dívida) — o "escopo de v1
  travado em dois tipos" daquele ADR passa a três, mesma disciplina de
  escopo explícito, não implícito.
- `investments.ts#goalProjection` (ou uma função irmã que reusa seu núcleo
  de composição) precisa aceitar um fluxo mensal negativo como insumo
  hipotético, verificado na implementação função por função, mesmo padrão
  que o `decisions/0016` já registrou como consequência para os dois tipos
  de hipótese existentes.
- Qualquer copy futura desta feature passa pelo mesmo checklist do
  `decisions/0010`: a frase se encaixa em Simulação? Se aparecer qualquer
  formulação que soe como "o valor recomendado de retirada é X", é uma
  regressão a esta decisão, não uma variação de copy aceitável.
