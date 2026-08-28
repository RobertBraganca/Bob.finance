# 0021. Editar uma cotação recalcula os números; nada arrasta sozinha

Status: aceita

## Contexto
`projectQuotes` congela `hourlyBaseCents`/`minimumPriceCents`/`recommendedPriceCents`
no momento de cada simulação salva, de propósito (`decisions/0012`,
`specs/project-pricing`): uma cotação já enviada a um cliente não deveria
mudar de valor porque o usuário editou custos mensais na semana seguinte.
Hoje o único campo editável de uma cotação salva é `clientLabel` — não há
como corrigir horas, custos diretos ou multiplicadores depois de salvar,
mesmo quando o próprio usuário percebe um erro de digitação ou o cliente
pede um ajuste no escopo.

Precisa de uma decisão: "editar" quebra o princípio de número congelado, ou
os dois convivem?

## Decisão
Os dois convivem, porque resolvem tensões diferentes:

- **Congelado** protege contra deriva **passiva** — o resto do produto
  mudando por baixo (custos mensais, alíquota) sem o usuário tocar na
  cotação.
- **Editar** é uma ação **ativa e explícita** do próprio usuário sobre
  aquela cotação específica — não é a mesma coisa que deixar o valor
  flutuar sozinho.

`PATCH /pricing/quotes/:id` passa a aceitar todo campo de entrada
(`estimatedHours`, `directCosts`, as quatro opções de multiplicador,
`extraMarginBps`, além do já existente `clientLabel`). Qualquer edição que
toque um campo de cálculo roda `simulate()` de novo com os valores
mesclados (o que veio no patch, o que já existia na linha) e sobrescreve
os três números congelados — a cotação passa a refletir a hora base e o
ponto de equilíbrio de **agora**, não do momento em que foi criada
originalmente, e só porque o usuário pediu essa edição especificamente.

**Cotação já aprovada não recalcula.** Aprovar já criou um lançamento de
receita real com um valor específico (`decisions/pricing status`,
`specs/project-pricing` "Status de acompanhamento e aprovação"); mudar o
preço da cotação depois faria o número exibido divergir do que
efetivamente entrou no ledger. `clientLabel` continua editável mesmo
aprovada (é só um rótulo); qualquer campo de cálculo é bloqueado com
`PricingError`, mesmo tratamento de "aprovar duas vezes".

## Alternativas consideradas
- **Editar não recalcula, só sobrescreve os números diretamente
  informados pelo usuário:** descartada — abriria a porta para uma
  cotação com hora base, mínimo e recomendado inconsistentes entre si
  (ex. mínimo maior que recomendado), porque nada garantiria que os três
  continuassem obedecendo a mesma fórmula.
- **Criar uma cotação nova em vez de editar a existente:** descartada como
  única opção — já é possível hoje (nova simulação, "Salvar como
  cotação"); a lacuna real é que corrigir um erro na cotação #12 não
  deveria exigir apagar a #12 e recriar do zero, perdendo o histórico de
  quando ela foi originalmente criada.
- **Deixar editar mesmo depois de aprovada, com aviso:** descartada —
  "com aviso" ainda permite o descompasso; bloquear de verdade é mais
  simples e mais honesto do que confiar que o aviso será lido.

## Consequências
- `projectQuotes` ganha `updatedAt`, para distinguir "criada em" de
  "editada pela última vez em" no histórico.
- `services/pricing.ts`, `updateQuote`: aceita o superconjunto de
  `SimulateInput` mais `clientLabel`; recalcula só quando um campo de
  cálculo está presente no patch; lança `PricingError` se a cotação já
  está `approved` e o patch toca cálculo.
- `specs/project-pricing` documenta o novo contrato de
  `PATCH /pricing/quotes/:id` e a regra de bloqueio pós-aprovação.
- UI: `Pricing.tsx`, aba Histórico ganha um ícone de editar por linha,
  abrindo o mesmo formulário de simulação pré-preenchido com os valores
  salvos.
