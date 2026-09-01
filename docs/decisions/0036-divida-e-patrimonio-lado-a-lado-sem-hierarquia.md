# 0036. Dívida e patrimônio se comparam lado a lado, nunca em hierarquia

Status: aceita

## Contexto
A candidata #14 do estudo de viabilidade de features (29/08/2026) propõe uma
visualização que relaciona custo de dívida e retorno de investimento, para
responder "vale mais quitar a dívida ou continuar investindo?". A mesma
avaliação também levantou uma preocupação separada sobre o framing
comportamental do "Termômetro de Prosperidade" proposto numa avaliação
anterior, que usava o Efeito do Progresso Dotado (mostrar patrimônio já
construído como uma barra parcialmente preenchida, para gerar impulso
emocional de completar o resto) como mecanismo de engajamento.

Ao contrário das candidatas #9 e #13, o risco aqui não é de cálculo nem de
honestidade estatística. É de copy e enquadramento visual: comparar dois
números reais (juros da dívida vs. retorno médio da carteira) é legítimo e
já tem precedente no produto (Runway ao lado de Patrimônio consolidado,
`specs/financial-health`), mas a MANEIRA de comparar pode, sem nenhum
cálculo errado, empurrar uma decisão que o `decisions/0010` já definiu como
fora do produto.

## Decisão
A feature mostra os dois números lado a lado, no mesmo espírito de
composição já usado por Runway/Patrimônio consolidado: dois números
relacionados, mesma hierarquia visual, sem indicação de qual "vence". O
usuário compara; o produto não decide por ele.

**Regra explícita, além da taxonomia geral do `decisions/0010`:** nenhuma
frase gerada pelo sistema pode dizer ou implicar "priorize A sobre B",
incluindo formas indiretas onde a prescrição está disfarçada de constatação
matemática.

| Proibido (é recomendação disfarçada) | Permitido (é Observação/comparação) |
|---|---|
| "Quitar a dívida rende mais que investir agora." | "O juro desta dívida é de 18,5% ao ano. O retorno médio da sua carteira nos últimos 12 meses foi de 11,2% ao ano." |
| "Você deveria priorizar quitar o cartão antes de aportar." | "Quitar R$ 5.000 desta dívida hoje evitaria R$ 925 de juros nos próximos 12 meses, mantido o saldo atual. Aportar os mesmos R$ 5.000 na carteira, no ritmo de retorno dos últimos 12 meses, projetaria R$ 560 de ganho no mesmo período." |
| "O melhor uso do seu dinheiro agora é quitar dívida." | "Os dois números ao lado mostram o que cada opção representa no mesmo período; nenhum dos dois já inclui o que faz mais sentido para você." |
| "Essa dívida está 'comendo' seu patrimônio." (framing emocional de urgência) | "Esta dívida representa X% do seu patrimônio líquido atual." |

A tabela acima é referência de revisão, não exaustiva: qualquer frase nova
desta feature passa pelo mesmo teste, "isto é uma comparação de dois fatos
ou uma instrução de qual escolher", antes de entrar em produção.

**A versão com framing emocional do Termômetro de Prosperidade fica fora do
produto**, e não por ser "a versão mais simples" da mesma feature descartada
por polimento insuficiente. É uma feature DIFERENTE, com objetivo diferente:
o Efeito do Progresso Dotado existe para gerar engajamento via resposta
emocional (a barra parcialmente preenchida empurra a sensação de "estou
quase lá, preciso completar"), enquanto a versão que entra no produto existe
para gerar clareza de dado. Um mecanismo de engajamento emocional sobre
dinheiro real é, por definição, uma tentativa de influenciar decisão
financeira por um canal que não é o dado em si, o que colide com o mesmo
princípio de `decisions/0010` mesmo sem usar uma frase prescritiva.

## Alternativas consideradas
- **Mostrar um "vencedor" com destaque visual (cor, ícone, badge) mesmo sem
  frase prescritiva:** descartada — hierarquia visual entre os dois números
  é a mesma prescrição da tabela acima, só codificada em desenho em vez de
  texto. A regra desta decisão cobre layout tanto quanto copy.
- **Implementar o Termômetro de Prosperidade com framing emocional, mas com
  aviso de que é "só para motivação, não é conselho":** descartada pelo
  mesmo motivo do Monte Carlo (`decisions/0034`): o efeito psicológico do
  mecanismo já aconteceu antes do aviso ser lido, um aviso não desfaz o
  mecanismo de influência já disparado.
- **Deixar a comparação de fora do produto inteiramente, só mostrando os
  dois números em telas separadas:** descartada — a avaliação original
  identificou uma necessidade real (o usuário quer comparar as duas
  decisões), e telas separadas forçariam o usuário a fazer de cabeça uma
  comparação que os dois dados já respondem juntos; o precedente de
  Runway/Patrimônio consolidado já mostrou que compor dois números lado a
  lado, sem hierarquia, é possível sem cruzar a fronteira do
  `decisions/0010`.

## Consequências
- Novo bloco em `docs/specs/financial-health/spec.md` ou spec próprio (a
  decidir na implementação, seguindo o mesmo critério de escopo já usado
  para os demais indicadores desta área), descrevendo o card de comparação
  dívida vs. carteira.
- Toda revisão de copy desta feature específica usa a tabela proibido
  versus permitido acima como checklist adicional, empilhado sobre o
  checklist geral do `decisions/0010` (a frase se encaixa em Observação,
  Projeção ou Simulação).
- O Termômetro de Prosperidade com framing emocional fica formalmente fora
  de escopo do produto, não "adiado" — uma reintrodução futura exigiria um
  ADR novo revertendo esta decisão explicitamente, não uma implementação
  silenciosa via outra feature.
