# Plano de implementação: resumo dos cartões + Endividamento v2

Especificações: `docs/specs/card-summary-sync/spec.md` (parte 1) e
`docs/specs/debt-v2/spec.md` (parte 2), aprovadas em 08/10/2026.
Decisão: `docs/decisions/0044`.

Cada etapa termina compilando (`tsc -p tsconfig.json`, `tsc -b
tsconfig.build.json`) e, quando toca o servidor, com os espelhos Node/Deno
idênticos exceto imports. Nada é commitado sem pedido. Pontos de
autorização: as duas migrações (etapas 1 e 5), a primeira sincronização de
um cartão real (etapa 4) e as gravações reais da parte 2 (etapa 9).

Antes de cada migração: conferir `supabase_migrations.schema_migrations`
(há versões de outras sessões) e usar uma versão posterior à maior.

## Parte 1: resumo dos cartões

### Etapa 1: banco
- `card_connections`, `card_bills`, `card_installment_forecast` (spec),
  com RLS ligado e sem política.
- **Autorização**: aplicar a migração.

### Etapa 2: cliente Pluggy
- `server/src/services/pluggy.ts` (+ espelho): `listBills(accountId)` e
  os tipos `creditData`, `PluggyBill` e `creditCardMetadata`.
- Conferir os campos reais com uma chamada de leitura à API (só GET) antes
  de escrever o mapeamento; divergências vão para os desvios da spec.

### Etapa 3: serviço e rotas
- `server/src/services/cardSync.ts` (+ espelho):
  - `discover` passa a oferecer contas `CREDIT` para ligar a um cartão do
    app; `createCardConnection`, `deleteCardConnection`;
  - `syncCard(connectionId)`: limite e disponível (atualiza
    `credit_cards.credit_limit_cents` e grava `credit_card_snapshots` do
    dia), faturas (upsert por `provider_bill_id`), previsão de parcelas
    (apaga e regrava as do cartão);
  - `syncAll` da rotina diária chama também os cartões ligados.
- `server/src/services/creditCards.ts` (+ espelho): `listCards` traz
  `source`, `lastSyncedAt`, `openBill`, `nextBills`, `futureInstallments`.
- Rotas no `ledger` (conexões) e no `insights` (`/credit-cards`); `deno
  check` nos dois.
- Tela: em Ajustes › Open Finance, a conta de cartão aparece com "Ligar a
  um cartão"; em Cartões, a origem ("Meu Pluggy" ou "manual") e a última
  sincronização.

### Etapa 4: verificação da parte 1
- **Autorização**: ligar um cartão real e sincronizar (leitura na Pluggy,
  grava faturas e parcelas no app).
- Conferir limite, fatura aberta e parcelas futuras com o app do banco;
  Painel, Orçamento e Minha empresa com os mesmos totais de antes.

## Parte 2: Endividamento v2

### Etapa 5: banco
- `debts.category_id`, `debts.closed_reason`, `debt_renegotiations`; a
  migração preenche `category_id` das dívidas ativas e a TAG das pendências
  delas sem TAG ("Financeiro › Empréstimos" achada pelo nome).
- **Autorização**: aplicar (muda a TAG de pendências de dívida, que hoje
  estão sem TAG).

### Etapa 6: contas puras
- `shared/debt.ts` (+ espelho): calendário de 6 meses (parcelas pelo
  cronograma, fatura aberta e próximas, parcelas futuras do cartão),
  juros do mês e da parcela, juros de 12 meses (cronograma ou estimado),
  desconto e custo do acordo, comparação de proposta (reaproveita
  `amortizationSchedule` e `impliedMonthlyRate`).
- Script temporário com os casos da spec.

### Etapa 7: serviço e rotas
- `server/src/services/debt.ts` (+ espelho): TAG nas parcelas
  (`materializeDebtInstallments`, `syncMaterializedRows`), `closed_reason`,
  `useImpliedRate`, `registerRenegotiation`, e o overview v2 (com cartões
  de `listCards` e a renda típica pessoal do Orçamento).
- Rotas no `insights`; zod com `categoryId`.
- Conferir as dívidas atuais antes/depois (`listDebts`, projeções).

### Etapa 8: telas
- `src/pages/Debt.tsx` reorganizada nas seis seções da spec; novos
  componentes em `src/pages/debt/` (topo com cartões, calendário, custo,
  data livre, renegociação e simulador de proposta) e gráficos em
  `src/components/charts/DebtCharts.tsx`.
- `DebtModal`: TAG das parcelas e "este acordo renegocia".
- Sai o modal duplicado de "Simular quitação" e a composição de uma fatia.

### Etapa 9: verificação da parte 2
- Navegador (desktop e 375px, claro e escuro), só leitura: números do topo
  e do calendário conferidos com Cartões e com as pendências; Orçamento com
  as parcelas no grupo da TAG.
- **Autorização**: testar "Usar a taxa do contrato" e "Registrar acordo"
  (ou com dado `[teste]`, apagado ao final).
- Specs com status e desvios, ADR 0044 aceita, `docs/project-memory.md`;
  lembrar de publicar `ledger` e `insights`.
