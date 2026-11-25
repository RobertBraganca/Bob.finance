# Plano: Lista de compras (Mercado)

Spec: [spec.md](spec.md). Branch: `feat/lista-de-compras`.

Convenções que valem para todas as etapas (vistas no código em 25/11/2026):
- Código de servidor existe em **dois espelhos**: `server/src/**` (Node/tsx,
  Fastify local e testes) e `supabase/functions/_shared/**` (Deno). O espelho
  Deno é a mesma coisa com imports terminando em `.ts`.
- Conta pura usada pelo front e pelo servidor mora em `shared/grocery.ts`;
  `server/src/core/grocery.ts` só reexporta; `_shared/core/grocery.ts` é uma
  cópia idêntica (padrão de `propertyPlan`).
- Testes: `node:test` via `tsx --test scripts/grocery/*.test.ts`. Parte pura
  roda sempre; parte de banco só com `.env` e numa transação que sempre
  desfaz (padrão de `scripts/tasks/tasks.test.ts`).
- Toda tabela nova chama `select attach_data_version('…')` na migração.
- Deploy das funções é feito pelo usuário (`npm run deploy:fn -- ledger insights`).

## Etapa 1 — Migração e schema
1. Ler as versões mais recentes de `supabase_migrations.schema_migrations`
   (só leitura) e escolher um timestamp livre posterior.
2. `supabase/migrations/<ts>_grocery.sql`: enums `grocery_unit`,
   `grocery_trip_status`; tabelas `grocery_products`, `grocery_trips`,
   `grocery_trip_items`, `grocery_settings` como no spec; índice único
   parcial de compra ativa; único `(trip_id, product_id)`; único
   `transaction_id`; triggers `set_updated_at`; RLS habilitada sem policy;
   `attach_data_version` nas quatro.
3. Tabelas Drizzle em `server/src/db/schema.ts` e
   `_shared/db/schema.ts`.
4. Aplicar a migração no banco **com confirmação do usuário**.
5. `npm run typecheck`.

Pronto quando: tabelas existem, typecheck passa.

## Etapa 2 — Conta pura (TDD)
1. Escrever primeiro `scripts/grocery/calc.test.ts` cobrindo: `normalizeName`,
   subtotal (3 casas, arredondamento por item), previsto com `semPreco`, real
   com `marcadosSemPreco`, saldo do orçamento (sem teto, com e sem vínculo,
   modo casa usa previsto), índice da cesta (cesta fixa; quantidade diferente
   não muda o índice; produto ausente numa ponta; sem produto em comum →
   null; "N de M"), variação por produto, último preço com desempate,
   ordenação de candidatos a vínculo.
2. Implementar `shared/grocery.ts` até passar; reexport em
   `server/src/core/grocery.ts`; cópia em `_shared/core/grocery.ts`.
3. Script `test:grocery` no `package.json`.

Pronto quando: testes puros passam.

## Etapa 3 — Serviço
1. Testes de banco em `scripts/grocery/service.test.ts` (transação que desfaz):
   criar produto com nome repetido devolve o existente (e desarquiva);
   segunda compra ativa → erro; "repetir última" copia itens; PUT de item
   idempotente e `clientRev` antigo descartado; escrita em compra `done` →
   erro; mudar unidade com histórico → erro; candidatos a vínculo respeitam
   janela de datas, categoria e filhas, e excluem já vinculados; vínculo
   duplicado → erro; analytics com 2 compras devolve índice e ranking.
2. `server/src/services/grocery.ts` com `GroceryError` (vira 409/422 nas
   rotas). Orçamento reaproveita `getPeriodProgress(period).caps` de
   `services/goals.ts` (teto e gasto da categoria com filhas).
   Settings: na primeira leitura, sem `category_id`, procura categoria
   "Supermercado" por nome normalizado e grava.
3. Espelho Deno `_shared/services/grocery.ts` (leituras em sequência, nunca
   `Promise.all`, como os demais serviços da Edge).

Pronto quando: testes de banco passam localmente.

## Etapa 4 — Rotas
1. Fastify: `server/src/routes/grocery.ts` (todas as rotas do spec, com Zod)
   registrada em `server/src/index.ts`.
2. Edge `ledger/index.ts`: rotas `/grocery/**`; Edge `insights/index.ts`:
   `/grocery-insights/budget` e `/grocery-insights/analytics` (ficam no
   cache de resposta — só leem o banco).
3. `src/lib/api.ts`: `'/grocery'` em `LEDGER_PREFIXES` (o prefixo
   `/grocery-insights` não casa com `/grocery/` — conferir a comparação
   usada; se for `startsWith('/grocery')`, renomear para `/mercado-insights`
   ou ajustar a checagem para `p === x || p.startsWith(x + '/')`).
4. Smoke pelo Fastify local.

## Etapa 5 — Fila offline (TDD)
1. `src/lib/groceryQueue.ts`: fila pura (colapso por `tripId:productId`,
   `clientRev` crescente, reaplicar pendências sobre dados do servidor,
   ordem de envio, backoff 1s→30s) + adaptador `localStorage` em try/catch.
2. Testes em `scripts/grocery/queue.test.ts` (a parte pura não depende de
   React nem de DOM).

## Etapa 6 — Telas
`src/pages/grocery/`:
- `GroceryPage.tsx` (abas Lista / No mercado / Análise; abre na aba que
  corresponde ao status da compra ativa), rota `/mercado` em `App.tsx`,
  item "Mercado" no menu em `Shell.tsx` perto de Orçamento.
- `useGrocery.ts`: queries/mutations TanStack + integração com a fila;
  totais calculados com `@shared/grocery` sobre o cache.
- `ListTab.tsx`, `ShoppingTab.tsx`, `ItemSheet.tsx` (usa `ui/sheet.tsx`,
  `inputMode="decimal"`), `BudgetFooter.tsx`, `SyncIndicator.tsx`,
  `ProductPicker.tsx` (+ produto / item avulso), `FinishDialog.tsx`
  (data + vínculo), `AnalysisTab.tsx` com gráficos em
  `components/charts/` seguindo `chartTheme.ts`.
- Antes de desenhar: ler `docs/design-system-bob-finance.md`.

## Etapa 7 — Verificação e documentação
1. `npm run typecheck`, `npm run build`, `npm run test:grocery`.
2. Preview no navegador (celular 375px e desktop, claro e escuro): montar
   lista → começar → preencher e marcar → offline (DevTools) → marcar mais
   → online → concluir → vincular → Análise. Console sem erros.
3. Atualizar `docs/project-memory.md`, `docs/architecture.md` (tabelas
   novas) e "Desvios" do spec, se houver.
4. Commit, PR para `main` com "Depois do merge: `npm run deploy:fn -- ledger insights`".

## Etapa 8 — Carga histórica (quando os prints chegarem)
1. Extrair prints → `data/grocery-seed.json`; usuário revisa.
2. `scripts/grocery-seed.ts` idempotente (env via Node, nunca `source .env`).
3. Rodar com confirmação do usuário; conferir Análise.

## Ordem e dependências
1 → 2 → 3 → 4 → 6 → 7; a 5 depende só da 2 e pode ser feita junto da 3/4.
A 8 é independente e fica por último por escolha do usuário.
