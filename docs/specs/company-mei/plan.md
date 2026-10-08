# Plano de implementação: Minha empresa (MEI)

Especificação: `docs/specs/company-mei/spec.md` (aprovada em 08/10/2026).
Decisão: `docs/decisions/0043`.

Cada etapa termina compilando (`tsc -p tsconfig.json`, `tsc -b
tsconfig.build.json`) e, quando toca o servidor, com os espelhos Node/Deno
idênticos exceto imports. Nada é commitado sem pedido. Um ponto de
autorização: aplicar a migração (etapa 1). Tudo o mais é leitura; a
configuração (DAS, colchão, teto) só grava quando você salvar na tela.

## Etapa 1: banco
1. `financial_engine_settings` (+ espelho do schema): `das_monthly_cents`
   (null), `pj_cushion_months` (numeric, default 2),
   `mei_annual_limit_cents` (default 8100000), `das_category_ids` (jsonb
   null).
2. Migração `supabase/migrations/20261008120000_company_mei.sql` (versão
   depois da `20261007190000` já aplicada por outra sessão).
3. **Ponto de autorização**: aplicar no banco real (colunas com default ou
   nulas; nenhuma linha muda de valor).

## Etapa 2: contas puras
1. `shared/company.ts` (+ espelho `_shared/core/company.ts`, reexport em
   `server/src/core/company.ts`):
   - `fixedMonthlyCost(months)` (mediana de custos + DAS, só meses com
     movimento);
   - `withdrawable({ cash, dasDue, pending, fixedMonthly, cushionMonths })`
     → possível, colchão, falta;
   - `ceilingProjection({ yearRevenue, monthlyRevenues, limit, period })` →
     ritmo (3 meses fechados), projeção de dezembro, % e mês em que atinge;
   - `cascade({ revenue, das, costs, withdrawals })`;
   - `isDasCategory(name, dreGroup)` (detecção padrão por nome normalizado).
2. Script temporário com os casos da spec (sem histórico, falta de colchão,
   teto atingido antes de dezembro, virada do ano, retirada maior que o
   lucro); apagado depois.

## Etapa 3: serviço e rotas
1. `server/src/services/company.ts` (+ espelho):
   - `pjWithdrawals(from, to)` por mês (saídas da PJ pareadas com entrada
     pessoal não-receita, menos o inverso);
   - `companySettings()` / `saveCompanySettings()` (com o último DAS pago
     como sugestão);
   - `companyOverview(period)`: saldo da PJ (`accountBalances`), pendentes
     da PJ no mês (`listPending`), faturamento/DAS/custos por mês (uma
     consulta agrupada, 12 meses + ano civil), retiradas, gastos pessoais
     do Orçamento (`budgetFor`) e custo de vida (`reserveStatus`).
2. `server/src/services/budget.ts`: o repasse da renda passa a usar
   `pjWithdrawals` (mesmo número de hoje para quem não tem PF → PJ;
   conferir setembro e outubro antes/depois).
3. `/analytics/dre` aceita `scope=personal` (soma das contas pessoais) para
   o "Detalhe por TAG" do PF.
4. Rotas `/company/overview` e `/company/settings` em `insights` (Node +
   Deno); `deno check` em `insights` e `ledger`.

## Etapa 4: telas
1. `src/pages/company/`:
   - `CompanyPage.tsx` (rota `/dre`, título "Minha empresa", seletor de mês);
   - `WithdrawableCard.tsx` (destaque do mês corrente; "Ficou na empresa"
     em mês passado), `CeilingCard.tsx`, `CoverageCard.tsx`,
     `CascadeCard.tsx` (degraus clicáveis para Lançamentos);
   - `CompanySettingsModal.tsx` (DAS mensal, meses de colchão, teto, TAGs de
     DAS).
2. `src/components/charts/CompanyCharts.tsx`: 12 meses (faturamento em
   barras, retiradas e gastos em linha), com `ChartFrame` e tabela.
3. `src/pages/Dre.tsx`: a página antiga vira as seções recolhidas "Detalhe
   por TAG" (PF com todas as contas pessoais) e "DRE contábil", exportadas
   para a `CompanyPage`.
4. Menu e títulos: "Minha empresa" (`Shell.tsx`, `App.tsx`).

## Etapa 5: verificação
1. Build, `tsc`, detector do impeccable, espelhos.
2. Navegador (desktop e 375px, claro e escuro), só leitura: outubro
   (mês corrente) e setembro; cascata conferida com os Lançamentos da PJ;
   retiradas iguais ao repasse da reconciliação; Orçamento com a mesma
   renda de antes; Ajustar aberto e fechado sem salvar.
3. Spec com status e desvios, ADR 0043 aceita, `docs/project-memory.md`;
   lembrar de publicar `insights` (e `ledger` se `_shared` de transações
   mudar).
