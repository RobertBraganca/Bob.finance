# Plano de implementação: orçamento por grupos

Especificação: `docs/specs/budget-groups/spec.md` (aprovada em 07/10/2026).
Decisão: `docs/decisions/0042`.

Cada etapa termina compilando (`tsc -p tsconfig.json`, `tsc -b
tsconfig.build.json`) e, quando toca o servidor, com os espelhos Node/Deno
idênticos exceto imports. Nada é commitado sem pedido. Dois pontos de
autorização: aplicar a migração (etapa 1) e gravar configuração real
(plano de % e ligações de TAG) no teste da etapa 6.

## Etapa 1: banco
1. `server/src/db/schema.ts` (+ espelho `_shared/db/schema.ts`):
   - enum `budget_group_source` (`categories`, `goal_contributions`,
     `other_contributions`);
   - `budget_groups`, `budget_plans` (`effective_period` único);
   - `categories.budget_group_id` (FK `set null`) + índice, e
     `categories.budget_excluded` (default false).
2. Migração `supabase/migrations/20261007180000_budget_groups.sql`: enum,
   tabelas, colunas, índices, RLS habilitado sem políticas. Sem semente na
   migração: os seis grupos nascem na primeira leitura (spec).
3. **Ponto de autorização**: aplicar no banco real (tabelas novas e colunas
   nulas/default; nenhuma linha existente muda).

## Etapa 2: contas puras
1. `shared/budget.ts` (+ espelho `_shared/core/budget.ts`, reexport em
   `server/src/core/budget.ts`):
   - `METHOD_SEED` (os seis grupos com source e % do método);
   - `effectiveGroupOf(categoryId, categories)` com herança da mãe e
     `budget_excluded`;
   - `planFor(period, plans)` (maior `effective_period ≤ period`, senão o
     primeiro);
   - `budgetIncome({ receivedCents, typicalCents, isCurrentMonth })`;
   - `groupLines({ incomeCents, plan, groups, actuals, pending, counts })`
     → previsto, restante, uso;
   - `historyShares(months)` (média ponderada pela renda) e
     `normalizeTo10000(values)` (arredondamento que soma exatamente 10000);
   - `suggestGroup(categoryName, parentName)` (mapa da proposta inicial,
     nomes normalizados sem acento).
2. Script temporário `tsx` com os casos: herança mãe/filha, excluída,
   plano vigente antes/depois do primeiro, renda estimada vs recebida,
   normalização somando 10000, sugestão das TAGs reais; apagado depois.

## Etapa 3: serviço e rotas
1. `server/src/services/budget.ts` (+ espelho):
   - `ensureSeed()` (cria os seis grupos se a tabela estiver vazia);
   - `personalAccountIds()` (todas menos `financial_engine_settings.pj_account_id`);
   - `monthIncome(period)` (receitas confirmadas nas contas pessoais +
     `proLaboreFor` quando o repasse é transferência) e `typicalIncome`
     (mediana de 6 meses fechados, mesmas contas);
   - `groupActuals(period)`: despesas por grupo efetivo (uma consulta
     agrupada por `category_id`, resolvida em memória com
     `effectiveGroupOf`), pendentes por grupo, compras em ativos com e sem
     `goal_id` (`asset_trades` buy, fora `illiquid`), contagens;
   - `budgetFor(period)`, `budgetSettings()`, `createGroup`, `updateGroup`,
     `savePlan` (valida soma 10000, grupo ativo, um grupo por fonte de
     aporte), `saveCategoryGroups`.
   - `proLaboreFor` passa a ser exportado de `financialEngine.ts` (hoje é
     interno), sem mudar o comportamento.
2. Rotas da spec em `server/src/routes/insights.ts` +
   `supabase/functions/insights/index.ts`, zod com as mesmas faixas.
3. Filtro `budgetGroupId` / `budgetGroup=none` em `listTransactions`
   (`server/src/services/transactions.ts` + espelho) e na rota
   `GET /transactions` (`server/src/routes/ledger.ts` +
   `supabase/functions/ledger/index.ts`), resolvendo os ids de TAG do grupo
   no servidor e limitando às contas pessoais.
4. `deno check` em `insights` e `ledger`.

## Etapa 4: telas
1. `src/pages/budget/`:
   - `BudgetOverview.tsx`: os três KPIs e a grade de cards dos grupos (com
     "Sem grupo"), lendo `/budget/:period`, com `LoadError` e esqueleto;
   - `BudgetGroupCard.tsx`;
   - `BudgetSettingsPage.tsx` (`/metas/ajustar`): abas "Percentuais" e
     "TAGs dos grupos";
   - `AllocationDonut.tsx` (meio-círculo, `ChartFrame`, tabela e legenda);
   - `AllocationRow.tsx` (controle deslizante + campo de %, valor em R$,
     "seu histórico");
   - `CategoryGroupList.tsx` (seletor por TAG, "Herdar da mãe", "Fora do
     orçamento", marca "sugerido").
2. `src/pages/Goals.tsx`: `BudgetOverview` no topo; o conteúdo de hoje
   abaixo, com título "Detalhe por TAG"; botão "Ajustar orçamento" no
   cabeçalho.
3. `src/App.tsx` (rota `/metas/ajustar`, título "Orçamento") e
   `src/components/shell/Shell.tsx` (rótulo "Orçamento"); link no Perfil.
4. `src/pages/Transactions.tsx`: lê `?grupo=<id|none>` e envia
   `budgetGroupId`, com o chip do filtro ativo e "Limpar".
5. CSS em `src/styles/components.css` só para o que faltar (grade de
   cards, controle deslizante com a cor do grupo, meio-círculo).

## Etapa 5: verificação técnica
1. Build, `tsc`, detector do impeccable nos arquivos novos, espelhos.
2. Navegador só leitura (desktop e 375px, claro e escuro): Orçamento do mês
   corrente e de setembro; a soma de cada card bate com os Lançamentos
   filtrados por `?grupo=`; Ajustar aberto e fechado sem salvar.

## Etapa 6: configuração real (com autorização)
1. **Ponto de autorização**: salvar as ligações de TAG propostas (revisadas
   por você) e um primeiro plano de %; conferir os cards; mostrar como
   desfazer (o plano do mês é substituível e as ligações voltam a "Herdar").
2. Spec com status "implementado" (ou "Desvios"), ADR 0042 aceita,
   `docs/project-memory.md` atualizado; lembrar de publicar `insights` e
   `ledger`.
