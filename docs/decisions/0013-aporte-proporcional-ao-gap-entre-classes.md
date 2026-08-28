# 0013. Aporte se distribui proporcional ao gap entre classes, nunca sequencial

Status: aceita

## Contexto
`suggestContribution` (`server/src/services/investments.ts`) hoje resolve o
nível 1 da cascata (classe) como um waterfall sequencial: ordena as classes
pelo quanto cada uma está abaixo da meta (`deltaCents`, maior primeiro) e
satura por completo a mais atrasada antes de sobrar dinheiro para a
segunda. Com um aporte pequeno frente aos gaps da carteira, isso significa
que só a classe mais atrasada recebe qualquer sugestão naquele mês.

Ao revisar isto com o usuário, junto de uma captura de tela de uma
ferramenta de referência do mesmo método (Diagrama do Cerrado, Raul Sena),
surgiu a observação de que o método deveria "direcionar todo o valor
disponível para os ativos com base nas porcentagens de alocação desejada em
cada categoria" — ou seja, todas as classes elegíveis recebem uma fatia do
aporte na mesma rodada, não uma de cada vez.

A captura em si, porém, tinha um problema concreto: a "Sugestão" ali era
`meta% × valor do aporte`, sem olhar o quanto a classe já tinha
(`Total%`) — o que fez uma classe já **acima** da própria meta continuar
recebendo dinheiro na sugestão. Isso reproduz, letra por letra, um bug já
listado no material de origem do usuário ("o valor é distribuído entre
todos os ativos, sem considerar o valor existente em carteira") — não é o
comportamento correto do método, é o defeito que o próprio usuário já tinha
identificado numa tentativa anterior.

Perguntado sobre qual dos dois integrar, o usuário escolheu explicitamente
uma terceira opção: distribuir **proporcional ao gap** (quanto falta para
a meta, não a meta em si) entre todas as classes elegíveis, na mesma
rodada — o que espalha o aporte como a observação original pedia, sem
reintroduzir o bug do print (uma classe com gap zero ou negativo nunca
recebe fatia, porque sua proporção do total de gaps é zero).

## Decisão
O nível 1 (classe) da cascata de aporte passa de sequencial para
proporcional-ao-gap-simultâneo:

- Sejam as classes com `deltaCents > 0` (abaixo da meta) e
  `totalDeltaCents` a soma de todos os `deltaCents` dessas classes.
- Se `totalDeltaCents <= remaining` (o aporte, depois da reserva, fecha
  todos os gaps): cada classe recebe exatamente o seu `deltaCents` —
  todos os gaps fecham nesta mesma rodada, e o que sobrar vira
  `unallocatedCents` (nenhuma classe já na meta recebe o excedente).
- Senão: cada classe recebe
  `round(deltaCents / totalDeltaCents * remaining)` — uma fatia
  proporcional a quão atrasada ela está, todas na mesma rodada. Por
  construção, nenhuma fatia excede o próprio `deltaCents` da classe
  (a proporção de um total menor que a soma nunca supera o termo
  individual).
- Dentro de cada classe, o rodízio por setor (`allocateAcrossSectors`,
  já verificado contra o método na revisão anterior) continua exatamente
  como está — ele resolve um problema diferente (diversificação entre
  ativos de mesma classe respeitando cotas inteiras), não o nível que
  este ADR corrige.
- Sobra de arredondamento (poucos centavos, inevitável ao dividir
  proporcionalmente em inteiros) e sobra que os ativos elegíveis de uma
  classe não conseguiram absorver continuam caindo em `unallocatedCents`,
  igual já acontecia antes — nenhuma redistribuição recursiva para outras
  classes nesta versão, para não complicar o cálculo por um valor tipicamente
  de poucos centavos.

## Alternativas consideradas
- **Manter o waterfall sequencial atual:** descartada porque concentra
  todo aporte pequeno numa única classe, o que o usuário identificou como
  não bater com sua leitura do método, e que a maioria dos meses (aporte
  menor que o maior gap da carteira) faria a distribuição parecer "tudo ou
  nada" por classe.
- **Reproduzir o comportamento do print (meta% × aporte, ignorando o valor
  atual):** descartada porque reintroduz o bug já documentado pelo próprio
  usuário — uma classe já acima da meta continuaria recebendo dinheiro, o
  que contraria "nunca sugere aportar em quem já passou da meta", regra já
  correta neste mesmo serviço para o nível de ativo dentro da classe.

## Consequências
- `suggestContribution`, nível classe: `classQueue` deixa de ser consumido
  sequencialmente; passa a calcular `totalDeltaCents` e alocar cada classe
  proporcionalmente numa única passada.
- `specs/investments/spec.md`, bullet "Cascata de aporte", atualizado para
  descrever o novo nível 1.
- `scripts/verify.ts`, módulo 7 (investimentos), precisa de um caso novo:
  aporte menor que a soma dos gaps de 2+ classes elegíveis resultando em
  sugestão para **todas** elas na mesma chamada, proporcional ao gap de
  cada uma — não só a mais atrasada.
- Nenhuma mudança de schema, nenhuma mudança de contrato de API
  (`ContributionPlan`/`ContributionClassSuggestion` continuam com os mesmos
  campos).
