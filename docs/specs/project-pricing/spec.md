# Spec: Precificação de projetos

Status: implementado

## Objetivo
Responder "quanto cobrar por este projeto" a partir do custo real do
usuário (o mesmo ponto de equilíbrio já calculado em `specs/motor-financeiro`)
e de parâmetros do projeto específico, sem nunca dizer "cobre X" como fato
objetivo — o sistema calcula um cenário hipotético, o usuário decide o
preço.

## Histórias de usuário
- Como profissional criativo, eu quero saber meu valor-hora real,
  considerando meus custos, pró-labore, impostos e margem, sem recalcular
  isso à mão toda vez que um cliente pede orçamento.
- Como usuário, eu quero informar horas estimadas, complexidade, urgência,
  porte do cliente e direitos de uso de um projeto e ver o preço mínimo
  (nunca cobrar abaixo disso), o preço recomendado e uma referência premium,
  como três pontos de ancoragem para negociar, não como três opções que o
  sistema me diz para escolher.
- Como usuário, eu quero que os multiplicadores de complexidade, urgência,
  porte e direitos de uso sejam configuráveis por mim, não uma tabela fixa
  no código, porque o que é "projeto complexo" varia por área de atuação.
- Como usuário, eu quero guardar o histórico de cotações simuladas, para
  comparar o que calculei desta vez com o que calculei da última vez para
  um projeto parecido.

## Modelo de dados
- `pricingSettings` — singleton (id sempre 1, mesmo padrão de
  `financialEngineSettings`/`financialHealthSettings`): horas disponíveis
  por mês (default 176 = 22 dias × 8h) e percentual de aproveitamento
  faturável (default 60%, ver Regras de negócio). Não guarda custo,
  pró-labore, imposto ou margem — esses continuam vindo de
  `financialEngineSettings` (ver `decisions/0012`).
- `pricingMultiplierOptions` — banco editável por dimensão (`complexity`,
  `urgency`, `client_size`, `usage_rights`), cada linha com rótulo,
  descrição, multiplicador (bps) e ordem — mesmo padrão de `criteria`
  (banco de perguntas do Diagrama do Cerrado): o usuário pode editar,
  desativar ou adicionar uma opção nova em qualquer dimensão. Seed inicial
  com os valores da Calculadora de Freelas (ver `decisions/0012`), como
  sugestão, não como constante travada.
- `projectQuotes` — histórico de simulações: rótulo/nome do cliente (texto
  livre — sem tabela de cliente ainda, ver Fora de escopo), horas
  estimadas, id de cada opção de multiplicador escolhida, custos diretos
  informados (JSON, `{label, amountCents}[]`), e os quatro números de saída
  (`horaBaseCents`, `precoMinimoCents`, `precoRecomendadoCents`,
  `premiumPriceCents`) congelados no momento da simulação — não
  recalculados depois, porque uma cotação enviada a um cliente não deveria
  mudar de valor se o usuário editar seus custos mensais na semana
  seguinte. `premiumPriceCents` foi adicionado em 28/08/2026, avaliado a
  partir do projeto BOB.OS (`calculadora-freelas`, que já calcula o mesmo
  terceiro ponto) — coluna aditiva, backfilada para cotações já existentes
  a partir do `recommendedPriceCents` já congelado (função determinística,
  não um novo cálculo sobre dado histórico).

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/pricing/settings` | GET/PUT | Horas disponíveis e percentual faturável |
| `/pricing/multipliers` | GET | Lista por dimensão, agrupado |
| `/pricing/multipliers/:id` | POST/PATCH/DELETE | CRUD de uma opção |
| `/pricing/simulate` | POST | `{estimatedHours, directCosts[], complexityId, urgencyId, clientSizeId, usageRightsId, extraMarginBps?}` → preço mínimo, recomendado, premium, `premissas` — não grava nada |
| `/pricing/quotes` | GET/POST | Lista histórico / grava uma simulação como cotação |
| `/pricing/quotes/:id` | GET/PATCH/DELETE | Editar rótulo, excluir |

`/pricing/simulate` nunca grava — é puramente Simulação (ADR 0010). Só
`/pricing/quotes` (POST) persiste, e persiste os números já calculados, não
os parâmetros para recalcular depois (ver Modelo de dados).

## Regras de negócio
- **Hora base = ponto de equilíbrio líquido de imposto ÷ horas faturáveis
  do mês.** Ponto de equilíbrio líquido = `breakEvenCents` de
  `/motor-financeiro/ponto-equilibrio` menos a linha `taxes` da mesma
  resposta (o motor já expõe as duas separadamente) — nunca um número
  recalculado à parte, para não haver dois "quanto eu preciso faturar"
  divergentes no produto (ver `decisions/0012`). Horas faturáveis = horas
  disponíveis × percentual de aproveitamento faturável — o percentual
  existe porque nenhum profissional fatura 100% das horas do mês (tempo de
  prospecção, administração, revisão não cobrada); default 60%, editável.
- **Preço mínimo nunca é reescrito pelos multiplicadores.** Preço mínimo =
  horas estimadas do projeto × hora base, sem nenhum multiplicador —
  mesmo que a combinação de multiplicadores empurre o preço "recomendado"
  abaixo disso (ex. porte pequeno + urgência baixa), o mínimo é sempre
  exibido como piso técnico e nunca substituído por um valor mais baixo.
- **Preço recomendado = (preço mínimo + custos diretos) × complexidade ×
  urgência × porte do cliente × direitos de uso, com gross-up da mesma
  alíquota de `financialEngineSettings.taxRateBps`** (`preço ÷ (1 −
  alíquota)`, o mesmo formato já usado no ponto de equilíbrio — o imposto é
  embutido no preço cobrado do cliente, nunca descontado do que o
  profissional pretendia receber), mais margem extra opcional do próprio
  projeto (`extraMarginBps`, distinta da margem mensal já embutida na hora
  base).
- **Preço premium = preço recomendado × 1,3 — só um terceiro ponto de
  ancoragem, nunca um quarto preço que a aprovação aceita.** `approveQuote`
  continua gerando o lançamento de receita sempre em `recommendedPriceCents`;
  o premium existe só para o usuário ter uma referência de até onde puxar
  numa negociação, sem o sistema sugerir ativamente que ele cobre mais
  (mesmo princípio de "evidenciar, nunca prescrever" do PRD §4).
- **Nenhum multiplicador é obrigatório ter todas as opções preenchidas** —
  uma dimensão sem nenhuma opção ativa (usuário apagou todas) usa
  multiplicador neutro (1.0×) para aquela dimensão, nunca bloqueia o
  cálculo.
- **`premissas` obrigatório**, com cada termo (hora base, horas faturáveis,
  cada multiplicador aplicado com seu rótulo, alíquota, margem extra) —
  mesmo contrato de memória de cálculo do ADR 0010.
- **Nenhuma copy em segunda pessoa imperativa** ("cobre pelo menos",
  "aumente sua margem") — o padrão é o mesmo já usado em
  `specs/motor-financeiro`: "considerando os parâmetros configurados, o
  preço mínimo é R$X e o recomendado é R$Y".

## UI
`Pricing.tsx` (rota `/precificacao`, grupo "Planejar" da navegação, ao lado
de "Motor financeiro"): formulário de simulação (horas, custos diretos,
quatro seletores de multiplicador), resultado com preço mínimo, recomendado
e premium lado a lado, disclosure "como calculamos" com a `premissas`,
botão "salvar como cotação". Tela de configuração (`/pricing/settings` +
CRUD de `/pricing/multipliers`) segue o mesmo padrão de edição em lista já
usado em `Categories.tsx` para regras.

## Casos de borda
- `financialEngineSettings` nunca configurado (custos/pró-labore/imposto
  todos no default): hora base ainda calcula, mas a UI mostra o mesmo aviso
  de "premissas em default, não configurado" que `specs/motor-financeiro`
  já usa nos componentes do ponto de equilíbrio.
- Ponto de equilíbrio do mês é zero ou negativo (faturamento já cobre tudo
  sem margem): hora base pode ficar muito baixa; exibida como está, sem
  piso arbitrário — é ao usuário ajustar pró-labore/margem em
  `specs/motor-financeiro`, não a esta tela inventar um mínimo.

## Fora de escopo
- Autenticação, planos, CRM, geração de contrato, envio de e-mail — tudo
  isso existe na Calculadora de Freelas (`BOB.OS/calculadora-freelas`)
  porque é um SaaS multiusuário; este app é local-first de um usuário só,
  nada disso se aplica.
- Benchmark de mercado (tabela ADEGRAF) comparando o preço calculado com a
  média do mercado — precisa de curadoria de dados que este app não tem
  mecanismo para manter. Pode voltar como extensão futura, com spec
  próprio.
- Vínculo com cliente/projeto cadastrado — `projectQuotes.clientLabel` é
  texto livre até `specs/client-projects` existir (proposta em aberto, sem
  spec ainda).
- Conversão automática de uma cotação aprovada num **template recorrente**
  de fluxo de caixa (`cashFlowForecasts`) — natural quando
  `specs/client-projects` existir, fora de escopo enquanto não existe. Não
  confundir com a conversão em lançamento único da extensão abaixo, que já
  não depende disso.
- "Preço premium" como terceiro número de ancoragem comercial (ver
  `decisions/0012`, alternativas consideradas) — descartado por não ter
  base de cálculo auditável.

## Status de acompanhamento e aprovação (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero acompanhar cada orçamento por um status (rascunho,
  enviado, em revisão, em ajuste, reprovado, aprovado).
- Como usuário, eu quero que aprovar um orçamento pergunte a conta e a data
  de pagamento e crie o lançamento de receita correspondente, sem eu
  precisar duplicar a informação em Lançamentos.

### Modelo de dados
`projectQuotes` ganha `status: text default('draft')`, um dos
`'draft' | 'sent' | 'in_review' | 'needs_changes' | 'rejected' | 'approved'`.
`actualPriceCents` (nullable, adicionado 29/08/2026) guarda o valor de fato
negociado com o cliente na aprovação, quando diferente do recomendado — sem
ele, aprovar usa o recomendado, exatamente como antes. Nunca um valor solto:
é sempre o mesmo que virou o lançamento real (bloqueado de editar depois,
mesma regra que já trava horas/multiplicadores pós-aprovação).

### Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/pricing/quotes/:id/status` | PATCH | `{status}` — muda o status |
| `/pricing/quotes/:id/approve` | POST | `{accountId, paidOn, actualPriceCents?}` → cria a `transaction` de receita (no valor de `actualPriceCents` se informado, senão `recommendedPriceCents`) e move `status` para `'approved'` na mesma chamada |

### Regras de negócio
- **Aprovar cria um lançamento único de verdade** (`POST /transactions`
  internamente, `amountCents = actualPriceCents ?? recommendedPriceCents`,
  direção entrada, `source: 'manual'`), não um template recorrente — é a
  conversão simples
  que não depende de `specs/client-projects` existir. A transação gravada
  carrega `sourceQuoteId` apontando de volta para esta cotação (coluna
  nullable em `transactions`, `on delete set null`) — sem isso, editar ou
  apagar o lançamento depois deixava o orçamento aprovado sem nenhum jeito
  de saber que sua receita tinha sumido (achado da revisão de 28/08/2026,
  ver `docs/project-memory.md`).
- **Status é sempre editável manualmente** para trás e para frente (ex.
  "aprovado" pode voltar para "em ajuste" se o cliente pedir mudança
  depois) — nunca uma máquina de estado travada.
- Continua Observação/Simulação (`decisions/0010`) até o momento da
  aprovação; o lançamento criado ali vira fato real do ledger, como
  qualquer outro.

### UI
Seletor de status na lista de cotações (`Pricing.tsx`), botão "Aprovar"
que abre o mesmo formulário compacto (conta, data) usado em outras ações
do produto que criam lançamento a partir de outra tela.

### Casos de borda
- Aprovar uma cotação já aprovada: bloqueado, mensagem clara — evita
  lançamento duplicado.

## Editar uma cotação salva (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero corrigir horas, custos diretos ou multiplicadores
  de uma cotação já salva (ex. o cliente pediu um ajuste de escopo, ou eu
  errei um número), sem precisar apagar e recriar do zero.

### Modelo de dados
Nenhuma tabela nova. `projectQuotes` ganha `updatedAt` — distingue "criada
em" de "editada pela última vez em" no histórico.

### Contrato de API
`PATCH /pricing/quotes/:id` aceita, além de `clientLabel`, todo campo de
`SimulateInput` (`estimatedHours`, `directCosts`, os quatro ids de
multiplicador, `extraMarginBps`), qualquer subconjunto.

### Regras de negócio
- **Editar um campo de cálculo recalcula os três números congelados**,
  reusando `simulate()` — nunca uma segunda fórmula, nunca um número
  editado à mão que poderia ficar inconsistente com o resto (ver
  `decisions/0021`). O cálculo usa o ponto de equilíbrio e a alíquota de
  **agora**, não os de quando a cotação foi originalmente criada — é
  exatamente isso que "editar" significa aqui.
- **Cotação `approved` não recalcula.** Um campo de cálculo no patch de
  uma cotação já aprovada lança `PricingError` — aprovar já criou um
  lançamento de receita com um valor específico, e mudar o preço depois
  criaria divergência entre a cotação exibida e o que está no ledger.
  `clientLabel` continua editável mesmo aprovada.
- Editar só `clientLabel` nunca recalcula, mesmo numa cotação `approved` —
  só campos de cálculo disparam o bloqueio.

### UI
Ícone de editar por linha na tabela de "Cotações salvas" (`Pricing.tsx`),
abrindo o mesmo formulário de simulação já usado para criar, pré-preenchido
com os valores salvos; salvar chama `PATCH` em vez de `POST`.

### Casos de borda
- Editar uma cotação `approved` tentando mudar horas/custos/multiplicador:
  bloqueado com `PricingError`, mensagem explicando o motivo — mesmo
  tratamento de "aprovar duas vezes".
