# Spec: Plano de compra de imóvel

Status: implementado com desvios (07/10/2026; ver "Desvios")

## Objetivo
Responder "quando eu consigo comprar um imóvel de R$ X sem me descapitalizar"
e, quando a compra acontece, levar o financiamento para Dívidas com as
parcelas certas (regressivas no SAC, fixas no Price) no fluxo de caixa.

Simulação, nunca recomendação (decisions/0010): a tela mostra o mês em que o
dinheiro cobre entrada + custos + reserva, a parcela e o peso dela na renda.
Nenhum texto diz "pode comprar" ou "deveria".

## Histórias de usuário
- Como pessoa juntando para um imóvel, eu quero simular preço, entrada e
  financiamento para saber em que mês terei o dinheiro necessário.
- Como quem não quer ficar sem caixa, eu quero que o dinheiro necessário já
  inclua a reserva de emergência recalculada com a parcela nova.
- Como quem compara bancos, eu quero ver SAC e Price lado a lado (1ª e última
  parcela, juros totais).
- Como quem decidiu seguir, eu quero transformar a simulação num plano
  acompanhado com os ativos que separei para o imóvel.
- Como quem comprou, eu quero informar os números do contrato e ver a dívida
  e as parcelas futuras aparecerem sozinhas.

## Duas portas, uma conta
1. **Calculadora "Imóvel"** em Investimentos › Calculadoras (`&calc=imovel`):
   simulação pura, nada gravado. Botão "Usar meus dados" preenche reserva,
   custo de vida e renda a partir do app.
2. **Plano de imóvel**: uma meta de investimento com propósito
   `buy_property` e um registro `property_plans` ligado a ela. Nasce do botão
   "Criar plano de imóvel" da calculadora e aparece na aba Metas no lugar da
   projeção genérica.

As duas usam as mesmas funções puras de `shared/propertyPlan.ts` (espelhada
em `supabase/functions/_shared/core/propertyPlan.ts`).

## Modelo de dados

### `property_plans` (nova)
| coluna | tipo | padrão | o que é |
|---|---|---|---|
| id | bigint pk | | |
| goal_id | bigint not null unique → investment_goals(id) on delete cascade | | a meta dona do plano |
| price_cents | bigint not null | | preço do imóvel hoje |
| appreciation_bps | int not null | 400 | valorização ao ano enquanto junta (4%) |
| down_payment_bps | int not null | 2000 | entrada, de 500 a 10000 (5% a 100%) |
| costs | jsonb not null | ver abaixo | custos da compra |
| other_resources_cents | bigint not null | 0 | FGTS ou outro dinheiro fora da carteira |
| financing_rate_bps | int not null | 1100 | taxa efetiva ao ano do financiamento |
| term_months | int not null | 360 | prazo, de 12 a 420 |
| system | enum `amortization_system` ('sac','price') | 'sac' | sistema preferido |
| monthly_fees_cents | bigint not null | 0 | seguros (MIP/DFI) e taxa de administração por mês |
| income_override_cents | bigint null | | renda informada; nulo usa a renda típica do app |
| income_limit_bps | int not null | 3000 | limite de comprometimento da renda (30%) |
| expense_relief_cents | bigint not null | 0 | gasto que some depois da compra (ex.: aluguel) |
| status | enum `property_plan_status` ('planning','purchased') | 'planning' | |
| debt_id | bigint null → debts(id) on delete set null | | a dívida criada na compra |
| asset_id | bigint null → assets(id) on delete set null | | o imóvel registrado no Imobilizado na compra |
| purchased_on | text null | | data da compra |
| created_at / updated_at | text | now | |

`costs` é uma lista `[{ label, kind: 'pct' | 'fixed', value }]`, com `value` em
bps quando `pct` e em centavos quando `fixed`. Padrão:
`[{ITBI, pct, 300}, {Escritura e registro, pct, 150}, {Avaliação do banco, fixed, 350000}]`.
O usuário edita, remove e acrescenta itens (mudança, móveis, reforma).

RLS habilitado sem políticas, como as demais tabelas.

### `assets.goal_id` (nova coluna)
`bigint null → investment_goals(id) on delete set null`, com índice. Um ativo
pertence a no máximo uma meta. Um ativo marcado como reserva
(`counts_toward_reserve`) não pode ter `goal_id`, e vice-versa: o servidor
recusa com 409 e a mensagem "Este ativo já conta para a reserva" ou
"Este ativo já está separado para a meta X". Assim entrada e reserva nunca
contam o mesmo dinheiro.

`goalProjection` passa a usar a soma dos ativos ligados quando a meta tem
algum ativo ligado; meta sem ativo ligado continua igual a hoje (carteira
negociável inteira). Nesta versão só o plano de imóvel oferece a tela de
ligar ativos; a decisão geral sobre metas que dividem a carteira continua
em aberto (segunda etapa de Investimentos).

### `debts` (duas colunas novas)
- `amortization` enum `amortization_system` null. Nulo = comportamento de
  hoje (parcela fixa `scheduled_payment_cents`, pagamento inteiro abate o
  saldo). `sac` ou `price` = contrato amortizado, regras abaixo.
- `monthly_fees_cents` bigint not null default 0: seguros e taxas somados a
  cada parcela de um contrato amortizado.

Nenhuma dívida existente muda: todas ficam com `amortization` nulo.

## Regras de negócio

Todas as funções abaixo são puras, em `shared/propertyPlan.ts`, com centavos
inteiros e taxa mensal `monthlyRateOf(bps)` de `core/money` (equivalência
`(1+a)^(1/12) − 1`, a mesma de Dívidas e das Calculadoras).

### Cronograma de amortização
`amortizationSchedule({ principalCents, rateBps, termMonths, system })` →
lista de `{ k, paymentCents, interestCents, amortizationCents, balanceCents }`.
- **SAC**: amortização fixa `principal / n` (a última absorve o
  arredondamento); juros = saldo anterior × i; parcela = amortização + juros.
- **Price**: parcela fixa `P × i / (1 − (1+i)^−n)` (com `i = 0`, `P / n`);
  juros = saldo × i; amortização = parcela − juros; a última zera o saldo.
- Resumo: 1ª parcela, última parcela, juros totais, total pago.
- Seguros e taxas (`monthly_fees_cents`) somam a cada parcela no valor
  exibido e no lançamento, mas não entram nos juros nem na amortização.

### Dinheiro necessário no mês m
Com `price(m) = price × (1 + g)^(m/12)`:
- entrada(m) = price(m) × down_payment
- custos(m) = Σ itens `pct` × price(m) + Σ itens `fixed` (fixos não corrigem)
- financiado(m) = price(m) − entrada(m)
- parcela1(m) = 1ª parcela do sistema escolhido sobre financiado(m) + taxas
- reservaAlvo(m) = (custoDeVida − expense_relief + parcela1(m)) × múltiplo
- faltaReserva(m) = max(0, reservaAlvo(m) − reservaAtual)
- **necessário(m) = max(0, entrada(m) + custos(m) + faltaReserva(m) − other_resources)**

Custo de vida, múltiplo e reserva atual vêm de `reserveStatus()` (Investimentos
› reserva). A reserva atual não cresce na projeção: o que faltar nela sai do
dinheiro do imóvel, por isso entra no necessário.

### Dinheiro juntado no mês m
- Plano: `V(0)` = valor de mercado dos ativos ligados à meta; calculadora:
  "Quanto já tem".
- `V(m) = V(m−1) × (1 + r) + aporte`, com `r = monthlyRateOf(expectedReturnBps)`
  e o aporte mensal da meta (os mesmos campos da meta genérica).

### Mês da compra
Primeiro `m` entre 0 e 600 com `V(m) ≥ necessário(m)`. Sem esse mês, o
resultado é "não alcança em 50 anos" e a tela mostra quanto falta no mês 600.

### Teste da renda
- renda = `income_override_cents` ou a renda típica do app
  (`typicalMonthlyIncomeCents` de `debtOverview`, mediana de 6 meses).
- comprometimento = parcela1(mCompra) ÷ renda, comparado a `income_limit_bps`.
- Maior imóvel pela regra: com `L = renda × limite − taxas`,
  SAC `F = L / (1/n + i)`, Price `F = L × (1 − (1+i)^−n) / i`;
  `maiorPreço = F / (1 − down_payment)`.
- Sem renda conhecida (zero meses com lançamento e sem valor informado), o
  teste não aparece; no lugar, "Informe a renda para ver o peso da parcela".
- Texto de evidência, nunca ordem: "A 1ª parcela levaria 34% da renda; o
  limite que você definiu é 30%."

### Meta sincronizada
Ao salvar o plano, a meta recebe `targetValueCents = necessário(0)` (o valor
de hoje) e `targetDate` = dia 28 do mês da compra (mesma convenção das Calculadoras) (ou nulo se não
alcança), para listas que leem só a meta (planejador de aporte) continuarem
coerentes.

### Contratos amortizados em Dívidas (`amortization` não nulo)
- **Parcela k** (0 = a parcela de `opened_on`):
  `amortizationSchedule(...)[k].paymentCents + monthly_fees_cents`, calculada
  sobre `principal_cents`, `apr_bps`, `installment_count`. `scheduled_payment_cents`
  guarda a 1ª parcela (com taxas), para as telas que mostram "parcela".
- `materializeDebtInstallments` e a atualização de pendências não editadas
  usam o valor da parcela k de cada período, não um valor único.
- O saldo vem do cronograma: com N parcelas pagas (`debt_payments` do tipo
  `payment`), o saldo é o `balanceCents` da parcela N do cronograma (o
  principal, com N = 0). `recordPaymentSnapshot` grava esse valor ao
  registrar um pagamento, e `deletePayment` / `undoLinkedDebtPayment` gravam
  o saldo recalculado ao desfazer (hoje o desfazer não devolve o saldo; no
  contrato amortizado devolve). Assim só a amortização sai do saldo, nunca
  os juros e as taxas. "Registrar saldo de hoje" manual continua possível e
  vale até o próximo pagamento.
  Com `amortization` nulo, segue abatendo o pagamento inteiro (como hoje).
- `projectPaydown`: no SAC a parcela de cada mês é
  `principal / n + juros do mês`; no Price, a parcela fixa. Aporte extra
  continua indo para a dívida-alvo da estratégia.
- A ligação automática com o extrato (decisions/0039) já compara pelo valor
  de cada pendência, então parcelas de valores diferentes funcionam sem
  mudança.
- Formulário de dívida: quando o tipo é "Financiamento", aparecem
  "Sistema de amortização" (Sem sistema / SAC / Price) e "Seguros e taxas
  mensais". Com SAC ou Price, o campo de parcela fica calculado (somente
  leitura) a partir de saldo, taxa e prazo.

### Concretizar a compra
`POST /investments/property-plans/:goalId/purchase`, em uma transação:
1. Cria a dívida: tipo `financing`, nome "Financiamento: <nome da meta>",
   `principal` = valor financiado informado, `apr_bps`, `installment_count`,
   `amortization`, `monthly_fees_cents`, `due_day`, `account_id`,
   `institution`, `opened_on` = mês da 1ª parcela.
2. Materializa as parcelas.
3. Plano: `status = purchased`, `debt_id`, `purchased_on`.
4. Meta: `active = false`; ativos ligados ficam com `goal_id` nulo.
5. Se "Registrar o imóvel no Patrimônio" estiver marcado (padrão), cria o
   bem pelo mesmo caminho de qualquer imobilizado de hoje:
   - ativo da classe `illiquid` (Imobilizado), nome informado (padrão
     "Imóvel: <nome da meta>"; se o nome já existir, o servidor acrescenta
     " (2)", " (3)"...);
   - uma compra de quantidade 1 pelo **valor de compra** na data da compra;
   - uma avaliação (`asset_valuations`) com o mesmo valor e data, para o bem
     já nascer com "último valor informado";
   - `property_plans.asset_id` aponta para ele.
   O bem entra no patrimônio líquido e fica fora da carteira, das metas e da
   rentabilidade (regra da classe `illiquid`). Patrimônio passa a mostrar o
   imóvel no Imobilizado e o financiamento nas dívidas, então o patrimônio
   líquido sobe pelo valor do imóvel e desce pelo saldo devedor.
   Reavaliar o imóvel depois é manual, como os outros bens imobilizados.
Nada é lançado sobre a entrada e os custos: o resgate dos ativos o usuário
registra como hoje. A janela diz isso com uma frase.

## Contrato de API
Todas no `insights` (onde moram as rotas de Investimentos e Dívidas).

| Rota | Método | Entrada | Saída |
|---|---|---|---|
| `/investments/property-plans/defaults` | GET | | `{ reserve: { currentCents, livingCostCents, multiple }, typicalIncomeCents, incomeSampleMonths }` |
| `/investments/property-plans/:goalId` | GET | | `{ goal, plan, linkedAssets, availableAssets, defaults }` (`availableAssets` = negociáveis, não arquivados, sem reserva, sem outra meta) |
| `/investments/property-plans` | POST | `{ goal: { name, monthlyContributionCents, expectedReturnBps }, plan, assetIds? }` | `{ goalId }` — cria meta `buy_property` + plano |
| `/investments/property-plans/:goalId` | PATCH | `{ goal?, plan? }` | plano atualizado (resincroniza a meta) |
| `/investments/property-plans/:goalId/assets` | PUT | `{ assetIds: number[] }` | lista ligada; 409 se algum é reserva ou de outra meta |
| `/investments/property-plans/:goalId/purchase` | POST | `{ purchasePriceCents, purchasedOn (YYYY-MM-DD), financedCents, rateBps, termMonths, system, monthlyFeesCents, firstDueOn (YYYY-MM-DD), accountId, institution?, registerAsset (padrão true), assetName? }` | `{ debtId, assetId \| null }`; 409 se já comprado; 400 se financiado > valor de compra |
| `/debts`, `/debts/:id` | POST/PATCH | + `amortization?`, `monthlyFeesCents?` | como hoje |

`GET /investments` passa a trazer, em cada meta, `propertyPlan: { status } | null`
para a aba Metas saber qual visão mostrar. Validação em zod, mesmas faixas da
tabela de dados.

## UI

### Calculadora "Imóvel" (4ª opção em Calculadoras)
Mesmo layout das outras (`calc-layout`: entrada à esquerda, resultado à direita).
Campos em grupos com título curto:
- **Imóvel**: preço; valorização ao ano.
- **Entrada e custos**: entrada (%) com dica "Bancos costumam financiar até
  80% do valor"; lista de custos editável (rótulo, % ou R$, remover,
  "Adicionar custo").
- **Financiamento**: taxa ao ano (com equivalente ao mês, igual às outras
  calculadoras); prazo em anos; seguros e taxas por mês; FGTS e outros.
- **Seu dinheiro**: quanto já tem; aporte mensal; rendimento ao ano.
- **Segurança**: custo de vida; múltiplo da reserva; reserva atual; gasto que
  some depois da compra; renda; limite da renda (%).
- "Usar meus dados" preenche reserva atual, custo de vida, múltiplo e renda
  de `/property-plans/defaults`; "Usar minha carteira" fica como nas outras.

Resultado:
- KPIs: **Compra possível em** (acento; "mês/ano · em N anos e M meses");
  **Dinheiro no dia da compra** (com o detalhamento entrada / custos /
  reserva / outros recursos); **1ª parcela** (sistema escolhido, com % da
  renda e o limite).
- Gráfico 1, "Até a compra": linha do dinheiro juntado e linha do necessário
  (que sobe com a valorização), marcando o mês em que se cruzam.
- Gráfico 2, "Depois da compra": saldo devedor SAC e Price no tempo.
- Tabela SAC × Price: 1ª parcela, última parcela, juros totais, total pago.
- Linha de evidência da renda e "maior imóvel pela regra dos X%".
- Ações: "Criar plano de imóvel" (abre janela com nome e, opcional, os ativos
  a separar; salva e leva para Metas com a meta selecionada).

### Plano na aba Metas
Meta com plano mostra a visão do plano no lugar da projeção genérica:
- os mesmos KPIs, gráficos e tabela, calculados com os dados vivos;
- card **Dinheiro do imóvel**: ativos ligados (valor de cada um) e
  "Escolher ativos" (lista com caixas de seleção; ativos de reserva aparecem
  desabilitados com o motivo);
- card **O que falta hoje**: entrada, custos e reserva, cada um com quanto
  já está coberto (barra), na ordem em que o dinheiro é consumido:
  custos, depois entrada, depois reserva;
- "Editar premissas" abre a mesma forma da calculadora numa janela;
- "Concretizar compra" abre a janela de compra.

### Janela "Concretizar compra"
Preenche com os valores projetados para hoje (valor de compra = preço
corrigido até hoje, financiado = valor de compra × (1 − entrada), taxa, prazo,
sistema, taxas). Campos: valor de compra do imóvel, data da compra, valor
financiado, taxa ao ano, prazo, sistema, seguros e taxas, data da 1ª parcela,
conta de débito, banco, e a caixa "Registrar o imóvel no Patrimônio
(Imobilizado)", marcada, com o nome do bem editável.
Mostra a 1ª e a última parcela do contrato informado antes de confirmar.
Botão "Registrar compra". Depois: aviso com links "Ver em Dívidas" e
"Ver em Patrimônio".

## Casos de borda
- Entrada 100%: sem financiamento; parcela 0; SAC/Price e teste da renda
  somem; necessário = preço + custos + falta da reserva.
- Taxa 0%: SAC e Price viram parcelas iguais `P/n`.
- Já alcançado hoje (`V(0) ≥ necessário(0)`): "Compra possível agora".
- Sem ativos ligados: `V(0) = 0`, o card convida a escolher ativos.
- Ativo ligado é arquivado: sai da soma (mesma regra das posições).
- Plano comprado: a meta some das ativas; a dívida é a casa do financiamento.
  Excluir a meta apaga o plano (cascade) e mantém a dívida e o bem
  imobilizado (são registros reais da compra).
- Valor financiado maior que o valor de compra: recusado (400).
- Editar a dívida depois (ex.: renegociação) recalcula as pendências não
  editadas a partir dos campos novos, como já acontece hoje.
- Renda típica sem meses com lançamento: teste oculto (ver regra).
- Valores muito altos: centavos em `bigint`; cálculo limitado a 600 meses
  de acumulação e 420 de financiamento.

## Fora de escopo
- Correção do saldo devedor por TR/IPCA (premissa: taxa constante).
- Regras de FGTS, MCMV, SFH/SFI, portabilidade e amortização extraordinária
  com escolha de reduzir prazo ou parcela.
- Valorização automática do imóvel depois da compra (o valor segue manual,
  como todo imobilizado).
- Esconder a compra do imóvel em Movimentações: ela segue a regra que valer
  para os demais imobilizados (decisão em aberto da segunda etapa).
- Lançar automaticamente o resgate dos ativos e o pagamento da entrada.
- Ligar ativos a metas que não são de imóvel (a tela fica para a decisão da
  segunda etapa; o dado já suporta).

## Verificação
1. Testes das funções puras (`scripts/verify.ts` ou script dedicado):
   - SAC, R$ 400.000, 11% a.a., 360 meses: amortização R$ 1.111,11; 1ª
     parcela = 1.111,11 + 400.000 × i; última ≈ 1.111,11 × (1 + i); saldo final 0.
   - Price nos mesmos números: parcela constante, saldo final 0, soma das
     amortizações = principal.
   - Taxa 0, entrada 100%, alvo já alcançado, inalcançável.
   - Maior preço pela regra devolve parcela1 = limite × renda (± 1 centavo).
2. `npx tsc -b tsconfig.build.json`, `npm run build`, diff Node/Deno dos
   arquivos espelhados, `deno check` em `insights` e `ledger`.
3. Migração aplicada com autorização, registrada em
   `supabase_migrations.schema_migrations`.
4. No navegador (desktop e 375px, claro e escuro): calculadora com os
   números do teste 1; "Criar plano" com dado `[teste]`; ligar ativo;
   "Concretizar compra" com dado `[teste]` e conferir as pendências
   decrescentes em Dívidas e no fluxo de caixa, e o bem no Imobilizado de
   Patrimônio com o patrimônio líquido mudando por valor − financiado;
   remover tudo ao final.
   Com autorização explícita, porque grava no banco real.

## Para publicar
O usuário publica `insights` e `ledger` (`ledger` usa `cashFlow.ts`, que
chama `recordPaymentSnapshot` e `materializeDebtInstallments`):
`npx.cmd supabase functions deploy insights` e `... deploy ledger`.

## Desvios da implementação
- **Sem transação entre serviços.** `createPlan` e `purchase` usam
  compensação: se um passo falha depois de criar algo, o que foi criado é
  apagado (meta com o plano em cascata; dívida com as parcelas em
  cascata; bem imobilizado). Os serviços usam o `db` global, sem `tx`.
- **"Criar plano de imóvel" pede só o nome.** Os ativos se escolhem
  depois, na própria meta ("Escolher ativos"). "Quanto já tem" da
  calculadora não vai para o plano, que mede pelos ativos ligados.
- **Renda que veio de "Usar meus dados" não é fixada.** Se o campo ficou
  com a renda típica do app, o plano grava `income_override_cents` nulo e
  continua seguindo a renda do app.
- **"Registrar saldo de hoje" some em contrato amortizado.** Nesse
  formulário o campo de valor edita o principal do contrato (base do
  cronograma), não o saldo; o saldo vem do cronograma. O botão continua
  nas demais dívidas.
- **Arredondamento.** SAC distribui `P / n` sem sobra (a soma das
  amortizações dá o principal exato). No Price a parcela fixa é
  arredondada ao centavo e a última absorve o resíduo (R$ 3,97 num
  contrato de R$ 450 mil em 30 anos).
- **Gráfico "Até a compra" sem marca do mês da compra**: a série termina
  nesse mês, então o cruzamento é a ponta direita.
- **`GET /investments/property-plans/:goalId`** devolve também `inputs` e
  `projection` (calculados no servidor) e a lista `assets` com o motivo de
  bloqueio de cada ativo.

### Verificado em 07/10/2026
Contas puras por script; dívidas existentes idênticas antes e depois
(`listDebts`, `debtOverview`, três simulações de quitação); calculadora com
os números do script; fluxo completo com dado `[teste]` (plano, ativo
ligado, compra SAC de R$ 10 mil em 12 meses: 12 pendências de R$ 920,68 a
R$ 840,61; bem de R$ 15 mil no Imobilizado; pagamento abatendo só a
amortização e desfeito ao excluir), apagado ao final, com patrimônio,
dívidas e metas iguais ao estado anterior. Não verificado: a recusa 409
do servidor ao marcar como reserva um ativo já separado (a tela bloqueia
o caminho inverso).
