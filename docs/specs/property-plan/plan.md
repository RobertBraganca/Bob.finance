# Plano de implementação: plano de compra de imóvel

Especificação: `docs/specs/property-plan/spec.md` (aprovada em 07/10/2026).
Decisão: `docs/decisions/0041`.

Cada etapa termina compilando (`tsc -p tsconfig.json`, `tsc -b
tsconfig.build.json`) e, quando toca o servidor, com os espelhos Node/Deno
idênticos exceto imports. Nada é commitado sem pedido. Dois pontos de
autorização: aplicar a migração (etapa 1) e o teste que grava no banco real
(etapa 7).

## Etapa 1: banco
1. `server/src/db/schema.ts` (+ espelho `_shared/db/schema.ts`):
   - enums `amortization_system` (`sac`, `price`) e `property_plan_status`
     (`planning`, `purchased`);
   - `debts.amortization` (enum, nulo) e `debts.monthly_fees_cents`
     (default 0);
   - `assets.goal_id` (FK `investment_goals`, `set null`) + índice;
   - `property_plans` com as colunas da spec (`goal_id` único, cascade;
     `debt_id` e `asset_id` com `set null`; `costs` jsonb com o padrão).
2. Migração `supabase/migrations/20261007120000_property_plan.sql`: enums,
   colunas, tabela, índices, RLS habilitado sem políticas.
3. **Ponto de autorização**: aplicar no banco real (só colunas com default
   ou nulas e uma tabela nova; nenhuma linha existente muda de valor).
   Registrar em `supabase_migrations.schema_migrations`.

## Etapa 2: contas puras
1. `shared/propertyPlan.ts`:
   - `amortizationSchedule({ principalCents, rateBps, termMonths, system })`;
   - `scheduleSummary(schedule)` → 1ª, última, juros totais, total pago;
   - `installmentAt(debtLike, k)` e `balanceAfter(debtLike, paidCount)` (usadas
     por Dívidas);
   - `costsAt(costs, priceCents)`, `needAt(inputs, m)` (com o detalhamento
     entrada / custos / falta da reserva / outros recursos);
   - `projectPlan(inputs)` → `{ purchaseMonth, needSeries, savedSeries,
     breakdown, sac, price, incomeTest, maxPriceByIncome }`, com séries já
     afinadas para gráfico (mesmo `chartPoints` das Calculadoras);
   - `DEFAULT_COSTS` e as faixas de validação, exportadas para zod e telas.
2. Espelho `supabase/functions/_shared/core/propertyPlan.ts` e reexport em
   `server/src/core/`.
3. Script temporário `tsx` com os casos da spec (SAC e Price em R$ 400 mil,
   11% a.a., 360 meses; taxa 0; entrada 100%; já alcançado; inalcançável;
   maior preço pela regra), apagado depois.

## Etapa 3: dívidas amortizadas
1. `server/src/services/debt.ts` (+ espelho):
   - `DebtInput` ganha `amortization`, `monthlyFeesCents` e `openedOn`
     opcional; com sistema, `scheduledPaymentCents` é a 1ª parcela calculada;
   - `materializeDebtInstallments` e `syncMaterializedRows`: valor por
     período = `installmentAt(debt, k)` quando há sistema;
   - `recordPaymentSnapshot`, `deletePayment`, `undoLinkedDebtPayment`:
     com sistema, saldo = `balanceAfter(debt, parcelas pagas)`;
   - `projectPaydown`: no SAC, parcela do mês = amortização fixa + juros.
   O ramo `amortization = null` não muda em nada.
2. Rotas `POST/PATCH /debts` (`server/src/routes/insights.ts` + espelho
   `supabase/functions/insights/index.ts`): campos novos no zod.
3. `src/pages/Debt.tsx` (`DebtModal`): com tipo Financiamento, "Sistema de
   amortização" e "Seguros e taxas mensais"; parcela calculada somente
   leitura com SAC ou Price.
4. Conferência de não regressão, só leitura: `listDebts()` e
   `paydownComparison()` antes e depois, no banco real, devem sair
   idênticos.

## Etapa 4: ativos ligados à meta
1. `server/src/services/investments.ts` (+ espelho):
   - `goalProjection`: soma dos ativos ligados quando houver; senão, como hoje;
   - exclusividade com a reserva no `PATCH /investments/assets/:id`
     (`countsTowardReserve`) e no novo `PUT .../assets` (409 com a mensagem
     da spec).
2. `GET /investments` passa `propertyPlan: { status } | null` em cada meta.

## Etapa 5: serviço e rotas do plano
1. `server/src/services/propertyPlans.ts` (+ espelho): `planDefaults`,
   `getPlan`, `createPlan` (meta `buy_property` + plano + ativos, numa
   transação), `updatePlan` (resincroniza `targetValueCents` e
   `targetDate` com `projectPlan`), `setPlanAssets`, `purchase`
   (transação: dívida, materialização, imobilizado com `createAsset` +
   compra de quantidade 1 + `recordValuation`, plano comprado, meta inativa,
   ativos soltos; nome do bem único com sufixo).
2. Rotas da spec em `insights.ts` + `supabase/functions/insights/index.ts`.
3. `deno check` em `insights` e `ledger`.

## Etapa 6: telas
1. `src/components/charts/PropertyCharts.tsx`: `AccumulationChart` (juntado ×
   necessário, marca do cruzamento) e `DebtBalanceChart` (saldo SAC × Price),
   com `ChartFrame`, tabela e nota.
2. `src/pages/property/`:
   - `PropertyPlanFields.tsx`: os grupos de campos da spec (inclui a lista
     de custos editável), usado pela calculadora e pela edição do plano;
   - `PropertyResults.tsx`: KPIs, gráficos, tabela SAC × Price, linha da
     renda;
   - `CreatePlanModal.tsx`, `PlanAssetsModal.tsx`, `EditPlanModal.tsx`,
     `PurchaseModal.tsx` (com a caixa do Imobilizado);
   - `PropertyPlanView.tsx`: a visão do plano na aba Metas, com "Dinheiro do
     imóvel" e "O que falta hoje".
3. `src/pages/calculators/CalculatorsTab.tsx`: 4ª opção "Imóvel"
   (`&calc=imovel`) com "Usar meus dados".
4. `src/pages/Investments.tsx` (`GoalsEnvironment`): meta com plano mostra
   `PropertyPlanView`; "Criar plano" navega para `?aba=metas` com a meta
   selecionada.
5. CSS em `src/styles/components.css` só para o que não existir (lista de
   custos, barras de cobertura).

## Etapa 7: verificação e documentação
1. Build, `tsc`, detector do impeccable nos arquivos novos, diffs Node/Deno.
2. Navegador (desktop e 375px, claro e escuro), só leitura: calculadora com
   os números do script da etapa 2, "Usar meus dados", janelas abertas e
   fechadas com Cancelar.
3. **Ponto de autorização**: com dado `[teste]`, criar plano, ligar um ativo
   de teste, concretizar a compra; conferir parcelas decrescentes em Dívidas
   e no fluxo de caixa, o bem no Imobilizado e o patrimônio líquido; remover
   tudo ao final e relatar o que foi criado e apagado.
4. Spec com status "implementado" (ou "Desvios"), ADR 0041 marcada como
   implementada, `docs/project-memory.md` atualizado.
5. Lembrar o usuário de publicar `insights` e `ledger`.
