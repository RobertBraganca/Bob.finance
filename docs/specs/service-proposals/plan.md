# Plano de implementação: orçamentos de serviço

Especificação: `docs/specs/service-proposals/spec.md` (aprovada em 05/10/2026).
Decisão: `docs/decisions/0040`.

Cada etapa termina compilando (`tsc -p tsconfig.json`, `tsc -b
tsconfig.build.json`) e, quando toca o servidor, com os espelhos Node/Deno
idênticos exceto imports. Nada é commitado sem pedido.

## Etapa 1: banco
1. `server/src/db/schema.ts` (+ espelho `_shared/db/schema.ts`):
   - enum `proposal_status` (`draft`, `sent`, `approved`, `rejected`);
   - `service_proposals`, `service_proposal_items`, `proposal_issuer_settings`
     (singleton `id = 1`, mesmo padrão de `pricing_settings`);
   - `transactions.source_proposal_id` (FK `set null`) + índice.
2. Migração `supabase/migrations/20261005150000_service_proposals.sql`:
   - enum, tabelas, sequência para `number` (`default nextval`), índices;
   - linha inicial de `proposal_issuer_settings` (`default_validity_days = 15`);
   - bucket privado `proposal-assets` e políticas em `storage.objects` só para
     o `ADMIN_USER_ID` (select, insert, update, delete).
3. **Ponto de autorização**: aplicar a migração no banco real (só tabelas e
   colunas novas; nenhuma linha existente muda).

## Etapa 2: contas puras
1. `shared/proposals.ts`: `lineTotal`, `proposalTotals`
   (`{ subtotal, discount, total, itemCount }`), `splitInstallments`,
   `validUntil(createdAt, validityDays)`, `formatProposalNumber`.
2. Espelho `supabase/functions/_shared/core/proposals.ts`.
3. Script temporário `tsx` com os casos de borda (desconto 0 e 100%,
   quantidade 12,5, 3 parcelas de R$ 100,00, total zero); apagado depois.

## Etapa 3: serviço e rotas
1. `server/src/services/proposals.ts` (+ espelho): `list`, `summary`, `get`,
   `create`, `update` (substitui itens; recusa itens/desconto se aprovado),
   `duplicate`, `setStatus` (regra de sair de aprovado), `markSent`,
   `approve`, `remove`, `itemSuggestions`, `getIssuer`, `updateIssuer`.
   Erros de regra como `PricingError` (mesmo tratamento das cotações).
2. `ManualEntry.sourceProposalId` em `services/transactions.ts` (+ espelho).
3. Rotas `/pricing/proposals...` e `/pricing/proposal-issuer` em
   `server/src/routes/pricing.ts` e `supabase/functions/pricing/index.ts`,
   com zod.

## Etapa 4: ligação automática estendida (0039)
Em `services/cashFlow.ts` (+ espelho):
- `pendingScheduleCandidates`: inclui pendências com `source_proposal_id`;
- `linkToSchedule`: caso orçamento (apaga a pendência, grava
  `source_proposal_id` e a TAG no lançamento real);
- `unlinkFromSchedule`: recria a pendência de orçamento;
- `revertBatch` (em `imports.ts`): considera `source_proposal_id` ao desfazer.

## Etapa 5: telas
1. `src/pages/Pricing.tsx`: abas no cabeçalho com `?aba=` (Orçamentos padrão,
   Cotações, Parâmetros), botão primário conforme a aba.
2. `src/pages/proposals/`:
   - `ProposalsTab.tsx`: KPIs, busca, filtro/ordem no endereço, tabela
     `table--stack-mobile table--stack-compact`, estado vazio;
   - `ProposalFilterModal.tsx`;
   - `ProposalFormPage.tsx` (novo e editar) com aviso de saída sem salvar;
   - `ServiceItemModal.tsx` (sugestões, − e + na quantidade);
   - `QuotePickerModal.tsx` (trazer de uma cotação);
   - `ProposalDetailPage.tsx` (ações por status);
   - `ApproveProposalModal.tsx`;
   - `ProposalStatusBadge.tsx`.
3. Rotas em `src/App.tsx`: `/precificacao/orcamentos/novo`,
   `/precificacao/orcamentos/:id`, `/precificacao/orcamentos/:id/editar`
   (lazy, mesma regra de perfil Pessoal → redireciona).
4. Parâmetros: card "Dados do orçamento" com envio da logo pelo cliente
   Supabase (`storage.from('proposal-assets')`), prévia por URL assinada.
5. Invalidação: criar, editar, duplicar e compartilhar recarregam só as
   chaves `proposals*`; aprovar, mudar status e excluir mexem em receitas,
   então recarregam tudo (`invalidateQueries()`), como as cotações.

## Etapa 6: PDF e compartilhar
1. `npm install pdf-lib @pdf-lib/fontkit`.
2. `src/lib/proposalPdf.ts`: monta o A4 (cabeçalho com logo e emissor,
   tabela com quebra de página, totais, condições, rodapé paginado),
   carregado por `import()` só no Compartilhar.
3. `src/lib/shareFile.ts`: `navigator.canShare({ files })` → share; senão
   download; devolve `shared | downloaded | cancelled`.
4. Detalhe: Compartilhar gera, compartilha e, se não foi cancelado e o
   orçamento era rascunho, chama `mark-sent`.

## Etapa 7: verificação e documentação
1. `tsc` (projeto e build), `vite build`, `check-contrast`, detector
   Impeccable nas telas novas, `deno check` de `pricing` e `ledger`
   (os 5 erros antigos de `csv/*` não contam), comparação dos espelhos.
2. Navegador, computador e 375px: lista, filtro, formulário vazio, janela de
   serviço, detalhe, Parâmetros (só leitura).
3. **Ponto de autorização**: fluxo completo com um orçamento "[teste]"
   (criar, PDF, aprovar com receitas pendentes, voltar status, excluir),
   apagando tudo no fim.
4. Spec com status "implementado", decisão 0040 "aceita".
5. Entregar: arquivos alterados, o que publicar (migração já aplicada;
   deploy de `pricing` e `ledger`).
