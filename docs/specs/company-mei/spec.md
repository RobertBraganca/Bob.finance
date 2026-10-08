# Spec: Minha empresa (MEI)

Status: implementado com desvios (08/10/2026; ver "Desvios")

## Objetivo
Responder, para quem é a própria empresa como MEI, **"quanto posso tirar da
empresa este mês sem deixá-la sem colchão"**, e mostrar o caminho do
faturamento até o que ficou na empresa, o teto do MEI e se o que é retirado
cobre o custo de vida. Substitui a tela DRE (rota `/dre`, menu "Minha
empresa"); a DRE contábil continua dentro dela, recolhida.

Simulação e observação, nunca recomendação (decisions/0010): "se retirar até
R$ X, a PJ fica com o colchão de N meses", nunca "retire R$ X".

## Histórias de usuário
- Como MEI, quero saber quanto dá para retirar este mês sem a PJ ficar sem
  o DAS e sem o colchão que eu defini.
- Como MEI, quero ver o mês em cascata: faturamento, DAS, custos da
  empresa, retiradas e o que ficou.
- Como MEI, quero saber quanto já faturei no ano contra o teto do MEI e em
  que mês chegaria nele no ritmo atual.
- Como pessoa que vive do que retira, quero saber se as retiradas cobrem o
  meu custo de vida, e ver isso em 12 meses de renda irregular.

## Contas e conceitos
- **Conta PJ**: `financial_engine_settings.pj_account_id`. Sem ela, a tela
  mostra o estado "Escolha a conta da empresa" com link para Ajustes.
- **Contas pessoais**: todas as outras (mesma regra do Orçamento,
  `specs/budget-groups`).
- **Faturamento**: receitas confirmadas (`kind = 'income'`, não pendentes,
  não ignoradas) na conta PJ. Entra no teto do MEI. Inclui o fixo do
  estúdio (hoje com a TAG "Salário / Pró-labore").
- **DAS**: despesas na conta PJ com uma das TAGs de DAS (configuração,
  padrão: TAGs de despesa cujo nome normalizado contém "imposto" ou "das",
  ou com `dre_group = 'tax'`).
- **Custos da empresa**: as demais despesas confirmadas da conta PJ.
- **Retiradas**: saídas da conta PJ que pareiam (mesmo valor, até 1 dia)
  com uma entrada numa conta pessoal, menos o caminho inverso (PF → PJ),
  quando a entrada não está lançada como receita. Uma função só,
  `pjWithdrawals(from, to)`, usada por esta tela e pelo Orçamento (que
  hoje tem a sua consulta própria e passa a chamá-la).

## Regras de negócio

### Retirada possível (só no mês corrente)
- **Caixa da PJ hoje**: saldo da conta PJ (`accountBalances`).
- **DAS do mês a pagar**: o DAS mensal configurado, se nenhum lançamento de
  DAS confirmado apareceu na PJ no mês; senão 0.
- **Contas da PJ a pagar**: despesas pendentes na conta PJ com vencimento
  até o fim do mês (`listPending`).
- **Custo fixo mensal da PJ**: mediana dos 6 meses fechados de (custos da
  empresa + DAS), só meses com movimento na PJ; sem histórico, o DAS
  mensal.
- **Colchão** = meses de colchão (configuração, padrão 2) × custo fixo
  mensal da PJ.
- **Retirada possível** = caixa − DAS a pagar − contas a pagar − colchão.
  Negativa → mostra "abaixo do colchão em R$ Y" e a retirada possível 0.
- Já retirado no mês aparece ao lado ("já retirou R$ Z este mês"); a conta
  usa o caixa de hoje, que já é depois dessas retiradas.

### Cascata do mês (qualquer mês)
Faturamento − DAS − custos da empresa = **lucro do mês**; − retiradas =
**ficou na empresa**. Cada linha abre Lançamentos filtrado (conta PJ, mês e
TAG/tipo). No mês corrente o DAS mostra "previsto R$ X" enquanto não pago.

### Teto do MEI
- Faturado no ano civil até o mês, contra o teto anual (configuração,
  padrão R$ 81.000,00).
- Ritmo: média dos últimos 3 meses fechados. Projeção para dezembro =
  faturado + ritmo × meses restantes. Mês em que o teto seria atingido, se
  antes de dezembro.
- Texto de evidência: "No ritmo dos últimos 3 meses, o ano fecha em R$ X
  (Y% do teto)". Acima de 80% do teto projetado, o selo fica em atenção;
  acima de 100%, crítico. Nada de "você deve migrar".

### A retirada cobre o custo de vida?
- Retiradas do mês ÷ gastos do mês no Orçamento (`budgetFor(period)`,
  contas pessoais), em %.
- Ao lado, contra o custo de vida típico da reserva (`reserveStatus`).

### 12 meses
Por mês: faturamento, retiradas e gastos pessoais (Orçamento). Sem
projeção, só observado.

### Detalhe por TAG
As colunas de hoje (PJ e PF), com o PF somando todas as contas pessoais.

## Configuração (`financial_engine_settings`, colunas novas)
| coluna | tipo | padrão |
|---|---|---|
| `das_monthly_cents` | bigint null | nulo = o último DAS pago encontrado |
| `pj_cushion_months` | numeric not null | 2 |
| `mei_annual_limit_cents` | bigint not null | 8100000 |
| `das_category_ids` | jsonb null | nulo = detecção pelo nome / `dre_group` |

## Contrato de API (no `insights`)
| Rota | Método | Saída |
|---|---|---|
| `/company/overview?period=YYYY-MM` | GET | `{ period, isCurrent, pjAccount, withdrawable: { cashCents, dasDueCents, pendingCents, fixedMonthlyCents, cushionMonths, cushionCents, withdrawableCents, shortfallCents, withdrawnThisMonthCents } \| null, cascade: { revenueCents, dasCents, dasPending, costsCents, profitCents, withdrawalsCents, keptCents }, ceiling: { yearRevenueCents, limitCents, paceCents, projectedYearCents, projectedShareBps, reachesInPeriod }, coverage: { withdrawalsCents, personalSpentCents, coverageBps, livingCostCents }, series: [{ period, revenueCents, withdrawalsCents, personalSpentCents }], assumptions }` |
| `/company/settings` | GET/PUT | as quatro configurações; PUT valida faixas (meses 0–24, teto > 0) |

## UI
- Menu "Minha empresa" (rota `/dre`); título "Minha empresa"; período pelo
  seletor de mês da página.
- Topo: card de destaque "Retirada possível" (mês corrente) com as linhas
  da conta; em mês passado, o destaque é "Ficou na empresa".
- Ao lado: "Teto do MEI" (barra com faturado e projeção) e "Cobre o custo de
  vida?" (%).
- Cascata em degraus (barras horizontais ou lista com sinais), cada degrau
  clicável.
- Gráfico de 12 meses (barras de faturamento, linhas de retiradas e gastos).
- "Detalhe por TAG" e "DRE contábil" recolhidos ao fim.
- "Ajustar" abre a configuração (DAS mensal, meses de colchão, teto, TAGs
  de DAS).

## Casos de borda
- Sem conta PJ configurada: estado vazio com link para configurar.
- PJ sem histórico: custo fixo = DAS mensal; sem DAS configurado nem pago,
  0 com aviso "configure o DAS".
- Mês sem faturamento: cascata com zeros; teto segue o ano.
- Retirada maior que o lucro do mês: "ficou na empresa" negativo (usou o
  caixa de meses anteriores), dito em texto.
- Virada do ano: o teto zera em janeiro.

## Fora de escopo
- Regras de desenquadramento, ISS/ICMS por atividade, nota fiscal.
- Outros regimes (Simples ME, Lucro Presumido): a DRE contábil continua
  para quem precisar.
- Endividamento (spec própria, a seguir).

## Verificação
Contas puras (retirada possível, colchão, projeção do teto, mês do teto)
por script; migração com autorização; leitura de outubro e setembro
conferida contra Lançamentos da PJ; navegador desktop e 375px, claro e
escuro.

## Desvios da implementação
- **Período**: a tela usa o filtro de período global (como a DRE fazia) e o
  mês de referência é o do fim do período, limitado ao mês corrente. Assim o
  "Detalhe por TAG" abaixo e o topo nunca mostram meses diferentes.
- **Detalhe por TAG do PF**: uma coluna por conta pessoal (Nubank PF, Inter,
  PicPay...), em vez de uma coluna somada. `/analytics/dre` lê uma conta por
  vez, e somar exigiria mudar o `Range` de toda a camada de analytics.
- **Retiradas** moram em `server/src/services/withdrawals.ts` (com
  `accountScope`), usadas por `company.ts` e `budget.ts`; o Orçamento saiu
  idêntico antes e depois (julho a outubro). A DRE contábil e o Motor
  continuam com o pareamento de `accountFlows`.
- **Custos da empresa** são todas as despesas da conta PJ fora as TAGs de
  DAS; hoje a conta PJ tem gastos pessoais (mercado, restaurante, lazer),
  que aparecem como custo da empresa.
- **DAS em mês fechado** sem lançamento na PJ aparece como "não apareceu no
  extrato; previsto R$ X", sem entrar na conta do mês.

### Verificado em 08/10/2026
Contas puras por script (9 casos); migração aplicada; outubro: retirada
possível R$ 162,56 = 677,41 − 81,90 − 106,81 − 326,14, e "ficou na empresa"
R$ 672,94 igual à DRE contábil; setembro como mês fechado; Orçamento
inalterado; desktop e 375px sem vazamento; detector sem achados.
