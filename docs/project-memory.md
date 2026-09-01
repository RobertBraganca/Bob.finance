# Memória de revisão do projeto

Lida e atualizada por `docs/PROJECT_REVIEWER.md` a cada sessão de revisão.
Condensada, não um log — edite em vez de só adicionar. Última atualização:
2026-08-29 (avaliação de um documento externo de feedback de usuário +
correção dos bugs confirmados + duas features novas — ver seção de
recomendações abaixo).

## Trabalho concorrente em outra sessão (observado, não desta sessão)

Em 28/08/2026, durante esta mesma janela, outra sessão (outro chat/agente,
não este) executou `decisions/0031` — migração de toda a camada de UI para
shadcn/ui + Tailwind + Tabler Icons, página por página, faseada. Progresso
ao fim desta janela (parece parada, sem commit novo há um tempo, mas pode
retomar a qualquer momento): Fase 0/1 (base + primitivos), Fase 2
(Sidebar), Fase 3 (Skeleton), Fase 4 (Resizable no Painel — commitada e
depois revertida), Fase 5 com 7 páginas commitadas (`Categories.tsx`,
`CreditCards.tsx`, `Daily.tsx`, `FinancialEngine.tsx`, `FinancialHealth.tsx`
+ `SimulatorModal`, `Goals.tsx`, `Import.tsx`). **Se uma próxima revisão
encontrar `src/components/ui/*` ou qualquer página muito diferente do que
este documento descreve, comece por `decisions/0031` e o histórico de
commits recentes, não assuma que é dado desatualizado.**

**Achado de auditoria (28/08/2026, revisão de acompanhamento)**: as páginas
"migradas" da Fase 5 na verdade só trocaram `Modal`→`Dialog`, inputs e (em
Categories/Import) `Tabs` para os primitivos reais do shadcn — `Card`,
`Button`, `Slab`, `StatTile` etc. continuam vindo do barrel antigo
(`components/ui/index.tsx`, CSS `.card`/`.card__head` legado) em TODAS as
páginas checadas. Consequência: `components/ui/card.tsx`, `badge.tsx`,
`select.tsx`, `popover.tsx` (instalados na Fase 1) estão sem nenhum import
em `src/` — código morto desde então. Não é bug (nenhuma página mistura
Modal-antigo com Dialog-novo, por exemplo — a divisão é limpa por
primitivo), mas é uma lacuna real entre "commitada como migrada" e
"realmente terminada": a Fase 6 (desligar `base.css`/`components.css`,
ligar o Preflight do Tailwind) não pode acontecer com segurança enquanto
Card/Button nunca migraram de fato. Vale avisar quem retomar o trabalho.

Consequência prática confirmada nesta sessão: pedir uma mudança que toque
várias páginas ao mesmo tempo que essa migração está ativa é arriscado — em
um momento desta janela `src/pages/Import.tsx` ficou com um erro de sintaxe
(tag JSX não fechada) por estar no meio de uma edição da outra sessão,
quebrando o servidor de dev para qualquer rota até ela terminar de salvar.
Nenhuma ação foi tomada sobre isso (não é problema desta sessão) — só
registrado como prova de que o cuidado de não tocar página em migração é
real, não hipotético. Ao planejar a próxima rodada de mudanças de UI,
**checar `git log --oneline | grep shadcn` e `git status` antes de tocar
qualquer arquivo em `src/pages/` ou `src/components/`**, não assumir que o
estado descrito aqui ainda reflete o momento atual.

## Estado arquitetural atual

- **Dado**: Postgres via Supabase (projeto `ubgsgzlvugjbzyzbufel`, "BOB.FINANÇA"),
  não mais SQLite local. Migração completa em 3 fases (`decisions/0026`):
  schema (32 tabelas, 25 enums, 8 triggers, 89 índices, RLS ligada em todas
  sem policy), dado (8.500+ lançamentos reais, contagem/soma verificada),
  client (`server/src/db/client.ts` em `postgres-js`, 227 pontos convertidos
  para `async`/`await`). SQLite local (`data/finance.db`) só existe como
  backup pré-corte, não é mais lido pelo app.
- **Serving**: Supabase Edge Functions (Hono/Deno), não mais só Fastify.
  Fastify (`server/src/routes/*`, `server/src/services/*`) só roda em
  localhost/dev — nunca foi hospedado em produção. Rotas portadas para
  `supabase/functions/<nome>/index.ts` com lógica duplicada (não
  compartilhada por referência) em `supabase/functions/_shared/`:
  - `pricing` (prova de conceito) — 15 rotas, verificadas ao vivo.
  - `insights` (~70 rotas: dashboard, analytics, goals, debts, credit-cards,
    financial-health, financial-engine, investments, cash-flow) — verificadas
    ao vivo, GET completo + 5 pontos de fan-out concorrente corrigidos para
    sequencial (ver dívida técnica abaixo).
  - `ledger` (accounts, profiles, imports, categories, rules, transactions) —
    GETs verificados ao vivo; fluxo de upload/commit de CSV NÃO exercitado ao
    vivo ainda.
  - **Não portado**: `backups.ts`, `simulate.ts` — únicos dois arquivos de
    rota restantes. Enquanto isso, essas duas áreas são inacessíveis a partir
    do frontend publicado (só funcionam contra o servidor Fastify local).
  - `src/lib/api.ts` roteia por prefixo: `/pricing` → function `pricing`,
    `LEDGER_PREFIXES` (`/accounts`, `/profiles`, `/imports`, `/categories`,
    `/rules`, `/transactions`) → function `ledger`, resto → `insights`
    (fallback) quando `VITE_SUPABASE_URL` está configurado; senão cai no
    proxy `/api` do Vite (dev local).
- **Frontend**: React 19 + Vite, publicado no Vercel. `docs/architecture.md`
  e `README.md` ainda descrevem a arquitetura pré-migração (SQLite,
  "sem nuvem") — **documentação sabidamente desatualizada**, registrado como
  consequência aberta em `decisions/0026`.
- Modelo de dados, camadas e padrões estruturais recorrentes (derivação em
  vez de saldo guardado, materialização idempotente, sugestão nunca
  automática, `kind` separa contabilidade de rótulo, perfil de banco é dado)
  — ver `docs/architecture.md`, ainda válidos independente da migração de
  storage/serving.

## Dívida técnica conhecida

| Item | Status | Onde |
|---|---|---|
| **`npm run verify` está quebrado, não só desatualizado** — `client.ts` não lê mais `FINANCE_DB`, `seed()` é `async` mas chamado sem `await` em `verify.ts:65`, ~30 chamadas síncronas `.all()/.get()/.run()` continuam no arquivo, `verify-backup.ts` importa `better-sqlite3` direto | **Aberta, severidade alta** — a rede de segurança de 546 checks não roda como está, e se rodasse à força bateria contra o Supabase real, não um banco descartável | `scripts/verify.ts`, `scripts/verify-backup.ts`, excluídos do `tsconfig` |
| **`backups`/`simulate` estão quebrados em produção, não só "não portados"** — `src/lib/api.ts` roteia qualquer caminho não reconhecido para a function `insights`, que não registra essas rotas; `Settings.tsx` (`BackupsCard`) engole o erro/404 e mostra "Nenhum backup ainda" em vez de erro | **Aberta, severidade alta** — confirmado por 3 agentes independentes (código, frontend, regra de negócio) | `src/lib/api.ts`, `src/pages/Settings.tsx:278-312`, `src/components/ui/SimulatorModal.tsx`, ausência de `supabase/functions/{backups,simulate}` |
| `createSnapshot`/`restoreSnapshot` (Fase 4) são stubs que falham sempre, em qualquer caminho | Aberta, sem dono/prazo | `server/src/db/backup.ts:92-167` |
| Fase 5 (corte oficial do SQLite) | Bloqueada pela Fase 4 | `decisions/0026` |
| `README.md`/`docs/architecture.md`/`docs/PRD.md` continuam descrevendo SQLite/Fastify como arquitetura atual — confirmado via `git log`: nenhum dos três foi tocado desde o commit inicial, apesar de 6 commits grandes terem trocado essa camada inteira | Aberta, sabida (consequência já prevista em `decisions/0026`) | — |
| Fan-out concorrente (`Promise.all`) trava sob pooler de transação sem erro/timeout — 5 rotas já corrigidas para sequencial; **6 services em `_shared/` ainda usam `Promise.all` e nunca foram exercitados ao vivo sob o pooler**: `analytics.ts`, `creditCards.ts`, `criteria.ts`, `debt.ts`, `dre.ts`, `investments.ts` | Risco sistêmico aberto, agora com a lista concreta de suspeitos | `supabase/functions/_shared/services/*` |
| `ledger.ts` monta SQL direto na rota (accounts, perfis de importador) em vez de delegar a um `services/`, duplicado nas duas árvores | Nova, média severidade | `server/src/routes/ledger.ts:18-130`, `supabase/functions/ledger/index.ts:37-134` |
| Regex de data/período (`\d{4}-\d{2}(-\d{2})?`) duplicado inline em 30+ pontos em vez de um schema Zod compartilhado em `core/` | Nova, média severidade | `insights.ts`, `ledger.ts`, `pricing.ts`, `simulate.ts` |
| ~~`skipped_occurrences_uq` e `target_alloc_uq` tinham o mesmo defeito que `txn_forecast_occurrence_uq`~~ | **Resolvida (28/08/2026)** — migração `20260828233823`: cada uma virou dois índices únicos parciais (`skipped_occurrences_forecast_uq`/`skipped_occurrences_debt_uq`; `target_alloc_goal_uq`/`target_alloc_global_uq`). Testado ao vivo contra o banco real dentro de uma transação com `ROLLBACK` (`insert` duplicado de propósito) — a constraint disparou (`23505 duplicate key`), confirmado sem resíduo depois. `setTargetAllocation`'s concorrência sob `READ COMMITTED` (delete-then-insert, não upsert) segue como risco teórico separado, não coberto por este fix — index agora impede o dado duplicado de existir, mas não torna a operação atômica sob duas chamadas simultâneas. | `server/src/db/schema.ts`, `supabase/functions/_shared/db/schema.ts`, `supabase/migrations/20260828233823_fix_null_defeated_unique_indexes.sql` |
| Migração shadcn/ui "Fase 5": páginas commitadas como migradas só trocaram Modal→Dialog/inputs/Tabs — Card/Button/Slab continuam no barrel antigo, 4 primitivos instalados na Fase 1 (`card.tsx`, `badge.tsx`, `select.tsx`, `popover.tsx`) são código morto sem nenhum import | Nova, não é bug (nenhuma mistura old/new numa mesma página), mas bloqueia a Fase 6 (desligar CSS legado) até ser corrigida | `src/pages/{Categories,CreditCards,FinancialHealth}.tsx`, `src/components/ui/{card,badge,select,popover}.tsx` |
| ~~`transactions.forecast_id`/`debt_id` sem unique constraint em `(forecast_id, occurrence_period)`~~ | **Resolvida (28/08/2026)** — índices únicos parciais `txn_forecast_occurrence_uq`/`txn_debt_occurrence_uq` criados (migração `20260828163633`), `materialize()`/`materializeDebtInstallments()` (nas duas árvores) usam `onConflictDoNothing` como guarda real; checagem em memória (`existing`/`existingPeriods`) mantida só como filtro barato. Zero linhas violando a constraint antes de criar (checado ao vivo). | `server/src/db/schema.ts`, `supabase/functions/_shared/db/schema.ts`, `services/cashFlow.ts`, `services/debt.ts` (ambas as árvores), `supabase/migrations/20260828163633_source_quote_link_and_occurrence_unique_indexes.sql` |
| ~~`projectQuotes` aprovado sem link (`sourceQuoteId`) na transação gerada~~ | **Resolvida (28/08/2026)** — coluna nullable `transactions.source_quote_id` (FK `on delete set null`) adicionada, `approveQuote` (ambas as árvores) já grava o vínculo via `createTransaction`. | `schema.ts`, `services/transactions.ts` (`ManualEntry.sourceQuoteId`), `services/pricing.ts:approveQuote` (ambas as árvores) |
| Promoção automática de regra de categorização (3 confirmações) contradiz o texto literal do PRD §4 ("nada se aplica sozinho") mesmo sendo uma exceção documentada no spec de import-and-categorization — PRD e spec discordam entre si | Nova | `docs/PRD.md` §4 vs `docs/specs/import-and-categorization/spec.md:58`, `services/categorization.ts:84-157` |
| Nenhum log de auditoria (antes/depois) em escritas financeiras consequentes — `deletePayment` apaga sem rastro, `updateTransaction`/`updateDebt` só atualizam `updatedAt` | Nova | `services/debt.ts:611`, `services/transactions.ts:312`, `services/debt.ts:536` |
| Sem rastreamento de taxa de correção/aceitação de sugestão de categorização — zero sinal se a auto-categorização está funcionando | Nova (insumo para produto, não bug) | — |
| `_shared/` é cópia verbatim de `server/src/services/*`, não compartilhada por referência — risco de divergência silenciosa | Risco aceito (constraint do Deno); **auditado nesta sessão: 12 services continuam byte-idênticos, só `financialHealth`/`goals`/`financialEngine` divergem, e de forma deliberada/documentada (sequencial vs `Promise.all`)** | `supabase/functions/_shared/` vs `server/src/services/` |
| `simulator.ts` (Simulador de decisões, ADR 0016) não existe em nenhuma Edge Function — feature ausente da produção, não só divergente | Nova, mesma raiz do item de `backups`/`simulate` acima | `supabase/functions/` (ausente) |

## Operacional: `supabase db push`/`migration list`/`migration repair` não conectam neste ambiente

Esta sessão (e, pelo padrão encontrado, sessões anteriores também — a
migração `20260828113852_add_usage_events` já estava nesse mesmo estado)
não conseguem abrir a conexão Postgres direta que `db push`/`migration
list`/`migration repair` exigem (`LegacyDbConnectError` mesmo com
`SUPABASE_DB_PASSWORD` correto lido do `.env` sem interferência do shell)
— provavelmente a rede deste ambiente só permite saída HTTPS, não TCP
direto na porta do pooler. `supabase db query --linked` (via API de
management, HTTPS) funciona normalmente para leitura E para aplicar DDL.
**Padrão a seguir**: aplicar a migração com `supabase db query --linked
--file <arquivo.sql>`, depois registrar manualmente em
`supabase_migrations.schema_migrations` (`insert ... on conflict (version)
do nothing`, mesmas colunas `version`/`name`/`statements`) para que um
`db push` futuro, rodado de algum lugar com conectividade direta, não
tente reaplicar e falhe com "já existe". Antes de qualquer `create unique
index`, checar por linhas que já violariam a constraint com uma query de
`group by ... having count(*) > 1` — criar direto sem checar arrisca falhar
contra dado real.

## Segurança — estado registrado (não repetir a investigação do zero na próxima revisão)

- **Resolvida (29/08/2026, `decisions/0033`)**: ~~sem autenticação
  nenhuma~~ — `pricing`, `insights`, `ledger` agora exigem uma sessão
  Supabase Auth válida (`_shared/auth.ts`, `requireAdmin`), checada contra
  o servidor de Auth (não só decodificação local), e o `user.id` precisa
  bater com `ADMIN_USER_ID` fixo no código. Frontend ganhou tela de login
  (`src/pages/Login.tsx`, `src/lib/auth.tsx`) e `App.tsx` não renderiza
  nada do app sem sessão. Verificado ao vivo contra o projeto real: as três
  funções devolvem 401 sem `Authorization` e com token inválido — **o
  caminho de sucesso (login de verdade) não foi testado nesta sessão**, só
  o usuário tem a senha.
- RLS continua ligada em todas as tabelas mas sem policy nenhuma, e
  continua contornada (conexão direta via `postgres-js`, não via
  PostgREST) — a proteção real agora é o middleware acima, não RLS. Não
  mudou, só deixou de ser a única linha de defesa.
- Cadastro público de conta na API do Supabase Auth continua tecnicamente
  possível (a plataforma permite por padrão; o app só não expõe tela para
  isso) — não é brecha de acesso a dado (`requireAdmin` rejeita qualquer
  UID que não seja o admin), só ruído. Desligar "Allow new users to
  sign up" no painel (Authentication → Providers → Email) fecha isso,
  deliberadamente não automatizado — ver `decisions/0033`, "Consequências".
- **Fastify (`server/src/routes/*`) não ganhou este middleware** — nunca
  teve rota exposta em produção, continua sem.
- Upload de CSV na Edge Function não tem limite de tamanho de corpo (Fastify
  tinha 25MB via `bodyLimit`, o lado Hono não tem equivalente) — risco de
  custo/DoS, correção simples.
- Sem rate limiting em lugar nenhum — gap confirmado, não misterioso.
- Segredos limpos: nada hardcoded, `.env` fora do git, nomeação `APPDB_*`
  já contorna o corte de prefixo `SUPABASE_` da plataforma.
- Não verificado nesta rodada (sem acesso): CVEs de dependências via
  `npm audit`/rede; configuração de Deployment Protection no painel da
  Vercel (poderia ser um controle de acesso real complementar).

## Recomendações anteriores e resultado

**29/08/2026 — avaliação de um documento externo de feedback (usuário
testou o app por ~10h e escreveu um PDF de observações)**. Cada ponto foi
verificado contra o código antes de agir — vários já estavam implementados
(cores consistentes de Meter, reajuste de saldo, status de precificação),
um era mal-entendido (granularidade diária do gráfico), um era esclarecido
sem ser bug (divergência do preset "Máximo"). Dos confirmados como reais:

- **Escopo de edição de dívida no Painel (adotada, implementada)**:
  `listPending` (`services/cashFlow.ts`, as duas árvores) nunca devolvia
  `debtId` — só `forecastId` — então o modal de editar/excluir pendência no
  Painel (`Dashboard.tsx`) nunca perguntava o escopo (`only`/
  `this_and_future`/`all`) para uma parcela de dívida, só para forecast.
  Mesmo bug em dois pontos (editar e excluir). A mesma tela em Lançamentos
  já funcionava certo. Corrigido nos dois pontos; `debt.ts`'s
  `MATERIALIZE_HORIZON_MONTHS` também corrigido de 6 para 24, defasado
  desde `decisions/0028` (que só atualizou `cashFlow.ts`).
- **Sobra de aporte não alocada, ramo "fecha todo gap" (adotada,
  implementada)**: `decisions/0022` já tinha corrigido a redistribuição em
  rodadas para o ramo "aporte não fecha todo gap"; o ramo do peso-alvo
  (`decisions/0019`, quando fecha e sobra) fazia uma única passada, sem
  repasse — mesmo defeito, nunca corrigido ali. Aplicado o mesmo algoritmo
  de rodadas. Reproduz exatamente a queixa do usuário (R$38 mil de aporte,
  ~R$8 mil parado).
- **BRAPI para fundos/cripto/Tesouro**: usuário confirmou que não vale a
  pena agora (exige plano pago da BRAPI) — não implementado, mantido como
  limitação deliberada (`decisions/0006`), não dívida técnica.
- **Impacto do aporte na meta, aba Aportar (nova feature, implementada)**:
  pedido do usuário — ao informar um valor de aporte, mostrar por meta
  ativa quanto isso adianta a conclusão e quanto cobre do gap de hoje.
  Reusa `goalProjection` com um `extraContributionCents` opcional (nunca
  uma segunda fórmula), novo campo `contributionShareOfGapBps`. Ver
  `docs/specs/investments/spec.md`, seção "Impacto do aporte na meta".
  Verificado ao vivo: meta "Consolidar 5k em reserva" com aporte de R$2.000
  mostrou "alcança em set/26, em vez de out/26" e "cobre 62% do que falta".
- **Valor fechado vs. recomendado na aprovação de cotação (nova feature,
  implementada)**: pedido do usuário — aprovar pode registrar um valor
  diferente do recomendado (negociação). `projectQuotes.actualPriceCents`
  (nullable, backfilado para cotações já aprovadas = o recomendado, já que
  foi o que de fato virou lançamento na época). `approveQuote` aceita
  `actualPriceCents` opcional; sem ele, comportamento idêntico a antes.
  Coluna "Fechado por" na tabela de histórico. Verificado ao vivo: modal
  pré-preenche com o recomendado, editável.
- **Formulário de pagamento de dívida (`DebtPaymentModal`) — não
  "corrigido"**: na investigação, esse modal não é o mesmo tipo de entrada
  que o formulário compartilhado (`TransactionForm`) — registra um evento
  em `debtPayments` (parcela paga/novo uso), não necessariamente um
  lançamento em `transactions`. Forçar categoria/conta nele sem também
  fazê-lo criar um lançamento real seria adicionar campos que não
  significam nada ali. Decisão: não mexer sem antes decidir com o usuário
  se `debtPayments` deveria sempre gerar um lançamento real (mudança maior,
  risco de duplicar contagem com a reconciliação que já existe) — deixado
  em aberto, não implementado.
- **Login via Supabase (sem Auth completo) + usuário admin**: pedido pelo
  usuário, ainda não iniciado — escopo exato (proteger rotas já, ou só
  preparar a tela?) foi levado de volta para o usuário antes de mexer,
  dado o tamanho do raio de impacto (toda a postura de segurança hoje
  registrada como "sem autenticação, RLS decorativo" assume isso).

Primeira revisão completa, 2026-08-28 (ver relatório entregue ao usuário na
sessão). Ações já executadas na mesma sessão, como resultado direto da
revisão:

- **Backup e recuperação pausado (adotada)**: `decisions/0032` — `<BackupsCard
  />`/`RestoreModal` removidos de `src/pages/Settings.tsx` (typecheck limpo
  depois), spec marcado "em pausa". Backend (`server/src/routes/backups.ts`,
  `server/src/db/backup.ts`) deixado dormente, não apagado — reversível via
  git quando a Fase 4 do `decisions/0026` for retomada.
- **Open Finance como evolução futura (adotada, sem código)**:
  `docs/specs/open-finance-sync/spec.md` escrito com status "proposto —
  não iniciado", desenhando conexão via agregador terceiro (Pluggy/Belvo/
  Quanto, categoria de solução, não escolha feita) alimentando o pipeline
  de staging já existente (mesma revisão/dedupe/categorização do CSV, sem
  fluxo paralelo). Adiado só por custo recorrente do agregador, registrado
  como motivo explícito, não limitação técnica.
- **`sourceQuoteId` + índices únicos de ocorrência (adotada, implementada)**:
  ver linhas "Resolvida" na tabela de dívida técnica acima — migração
  `20260828163633` aplicada no banco real via `supabase db query --linked`
  (ver nota operacional acima sobre por que não via `db push`), código
  ajustado nas duas árvores, typecheck limpo, specs de
  `project-pricing`/`cash-flow-reconciliation` atualizados no mesmo
  commit lógico.
- **Polimento de UX (adotado, implementado, 28/08/2026)**:
  - `CreditCards.tsx` (`SnapshotModal`) — `Meter` de uso de limite ganhou
    texto/percentual ao lado (era o único `Meter` do app sem isso).
  - `DateRangePopover.tsx`/`PeriodPickerPopover.tsx` — extraído
    `usePopoverDismiss` (outside-click + Escape) e `DateRangeFields` (par
    De/Até + Cancelar/Aplicar), que os dois arquivos duplicavam quase byte
    a byte. Import via `PeriodPickerPopover` → `DateRangePopover`.
  - `Transactions.tsx` — botão "Exportar CSV" (todo o filtro atual, não só
    a página de 100 visível — uma segunda chamada com `limit = total`),
    `;` como delimitador + BOM UTF-8 (Excel pt-BR). Primeira área com
    exportação; DRE/outras podem seguir o mesmo padrão depois.
  - Typecheck limpo (`tsc` server e frontend) depois de cada mudança.
  - `csvField` corrigido para neutralizar CSV/formula injection (prefixo
    `'` em valor iniciando com `=/+/-/@`) — achado na revisão de
    acompanhamento (abaixo), corrigido na hora por ser bug em código desta
    própria sessão, não um item para decidir depois.
- **Índices únicos de `skipped_occurrences`/`target_allocations` corrigidos
  (adotado, implementado, 28/08/2026)**: ver linha "Resolvida" na tabela de
  dívida técnica acima — mesmo padrão do fix de `transactions`, testado ao
  vivo com `BEGIN`/insert duplicado/`ROLLBACK` contra o banco real antes de
  considerar concluído. Specs de `cash-flow-reconciliation` e `investments`
  atualizados.
- **Preço premium na Precificação (adotado, implementado, 28/08/2026)**:
  avaliado a partir do BOB.OS (`calculadora-freelas`, `layer3.ts`) —
  `premiumPriceCents = recommendedPriceCents × 1,3`, terceiro ponto de
  ancoragem, nunca um preço que `approveQuote` aceita (aprovação continua
  sempre no recomendado). Migração `20260828231005` aplicada no banco real
  (coluna aditiva, backfill determinístico a partir do recomendado já
  congelado, depois `not null`), `services/pricing.ts` e
  `_shared/services/pricing.ts` mantidos idênticos (`diff` conferido),
  `Pricing.tsx` mostra o valor em todos os pontos onde mínimo/recomendado
  já apareciam (simulação, salvar cotação, histórico, edição). Verificado
  ao vivo: R$ 572,11 × 1,3 = R$ 743,74 na tabela de histórico real.
  `docs/specs/project-pricing/spec.md` atualizado.
- **Rollout de `isError` nos `EmptyState` movidos por query (adotado,
  implementado, 28/08/2026)**: com a migração shadcn/ui parada e sem
  arquivo em edição no momento, o fix per-página que antes estava adiado
  foi executado — 24 sites de `<EmptyState>` corrigidos em 12 arquivos
  (`Dashboard.tsx` 3, `Debt.tsx` 2, `Investments.tsx` 4, `Pricing.tsx` 1,
  `FinancialHealth.tsx` 4, `FinancialEngine.tsx` 3, `Categories.tsx` 2,
  `Goals.tsx` 1, `Daily.tsx` 1, `Transactions.tsx` 1, `Import.tsx` 1,
  `Settings.tsx` 1) — cada um mapeado à `useQuery` real que alimenta
  aquele estado vazio, mostrando "Falha ao carregar" em vez do texto de
  vazio genérico quando `isError`. `Dre.tsx` e `CreditCards.tsx` não
  tiveram nada a corrigir (o primeiro só alcança o `EmptyState` depois de
  `isSuccess`, o segundo não usa `EmptyState` nesse ponto). Alguns
  `EmptyState` foram deliberadamente pulados por não serem dirigidos por
  query (filtro local, mutation) — cada arquivo tem a lista completa no
  histórico desta sessão. Typecheck limpo, `git diff --stat` conferido
  arquivo a arquivo. **Ainda não corrigido**: estados presos em
  `SkeletonLines`/loading infinito quando a query que os alimenta falha
  (achado várias vezes pelos próprios agentes como fora do escopo desta
  rodada — ex. `FinancialHealth.tsx` `score`, `Investments.tsx`
  `CriteriaModal`, `Dre.tsx` inteiro) — mesmo problema, componente
  diferente (`SkeletonLines` em vez de `EmptyState`), boa próxima fatia.
- **Erro global de GET vira toast (adotado, implementado, 28/08/2026)**:
  em vez do rollout página a página (arriscado enquanto `decisions/0031`
  reescreve página por página), o ponto único `request()` em
  `src/lib/api.ts` agora emite um toast de erro para toda falha de GET
  (`!init?.method` distingue GET de mutation) via um bus module-level
  (`src/lib/toastBus.ts`, `emitToast`/`subscribeToast` — `api.ts` não é
  componente React, não pode chamar `useToast()` direto). `ToastProvider`
  (`components/ui/index.tsx`) assina o bus uma vez. Cooldown de 4s evita
  empilhar um toast por query quando várias falham juntas (ex. backend
  inteiro fora). Mutations mantêm seu próprio `onError` — não duplicado.
  Verificado ao vivo (toast aparece, segundo toast imediato é suprimido,
  zero arquivo de página tocado nesta etapa). Complementado depois pelo
  rollout de `isError` por `EmptyState` (linha acima) — os dois juntos
  cobrem o achado original quase por completo; falta só o `SkeletonLines`
  preso em loading infinito citado acima.
- **Ainda deliberadamente NÃO feito** (depende da Sidebar, que
  `decisions/0031` ainda está reescrevendo — checar commits "Fase N" antes
  de assumir que terminou): undo pós-exclusão; busca/comando global e
  badge de vencimento na navegação.
- Recomendações de código ainda pendentes (não implementadas nesta sessão,
  aguardando priorização do usuário):
  - Consertar `scripts/verify.ts`/`verify-backup.ts` (env var errada, `await`
    faltando, API síncrona obsoleta) antes de confiar na suíte de novo.
  - Decidir/registrar em ADR a contradição entre PRD §4 e o spec de
    import-and-categorization sobre a promoção automática de regra.
- Testar ao vivo sob o pooler de transação os 6 services de `_shared/` que
  ainda usam `Promise.all` (`analytics`, `creditCards`, `criteria`, `debt`,
  `dre`, `investments`) antes de assumir que só as 5 rotas já corrigidas
  esgotam o risco.

## Regras de negócio em vigor (baseline)

Ver `docs/PRD.md` seção 4 ("Princípios de produto") como fonte de verdade:
fonte única de verdade (`transactions`), derivar nunca guardar, staging antes
de commit em toda importação, sugestão nunca é aplicação automática, dinheiro
sempre inteiro em centavos, pt-BR sem travessão, "evidenciar nunca prescrever"
(toda métrica derivada é Observação/Projeção/Simulação, nunca Recomendação).
Padrões estruturais recorrentes em `docs/architecture.md` (ver seção
"Padrões que se repetem entre áreas"). ADRs individuais em `docs/decisions/`
são a fonte de verdade para qualquer decisão pontual — checar lá antes de
assumir que uma escolha ainda vale.

## Padrões recorrentes de bug (observar em revisões futuras)

Todos encontrados durante a migração Supabase (`decisions/0026`), portanto
concentrados em código novo (`supabase/functions/`, `server/src/db/client.ts`)
— mas o padrão em si pode reaparecer em qualquer código async novo:

- **Promise não esperada dentro de objeto literal ou teste de verdade**
  (`return { settings: pricing.getSettings() }` sem `await`, ou
  `if (!quote)` onde `quote` é uma Promise) — TypeScript não acusa. Apareceu
  4+ vezes em `pricing.ts`/`simulate.ts` antes de ser auditado
  sistematicamente. Vale grep por `return {.*:.*\(` sem `await` em qualquer
  handler async novo.
- **`bigint`/`numeric` do Postgres voltam como `string`** em queries SQL cru
  (`db.execute(sql\`...\`)`) — colunas tipadas do Drizzle já corrigem, SQL cru
  não. Corrigido com parser de tipo nos OIDs 20/1700, mas qualquer query SQL
  cru nova precisa desse parser já estar registrado na conexão que ela usa
  (client Node e client Deno são conexões separadas).
- **Ordem de avaliação de import ESM**: código que lê `process.env`/
  `Deno.env` no nível de módulo de um arquivo importado roda antes do
  arquivo que carrega `.env` executar, se a ordem de import não garantir
  isso.
- **Limite de conexão do pooler**: fan-out concorrente (`Promise.all`) pode
  estourar o teto de conexões do pooler (session: 15 clientes; transação:
  trava sem erro em vez de rejeitar) — ver linha de dívida técnica acima.

## Rodada de correções — teste manual pós-login (29/08/2026)

Feedback do usuário testando o app já com login real em produção:

- **Toast falso de "não autenticado" no primeiro carregamento**: `api.ts`
  disparava `emitToast` em QUALQUER 401, mesmo quando era só a corrida
  normal de largada entre `AuthProvider` terminar `getSession()` e a
  primeira leva de queries do Painel disparar sem token ainda — o
  `retry: 1` do QueryClient já resolvia sozinho ~1s depois, mas o toast já
  tinha assustado o usuário por um erro que na prática nunca ficou sem
  dado. Corrigido: só alarma um 401 que chegou com token de verdade
  (sessão morta), não um sem token nenhum. Ver `src/lib/api.ts`.
- **Exportar CSV falhava acima de 2000 lançamentos**: `Transactions.tsx`
  pedia `limit: total` numa chamada só; o schema do endpoint
  (`ledger/index.ts`, `.max(2000)`) rejeitava qualquer filtro com mais
  linhas que isso — o que é rotina neste ledger de ~8 mil lançamentos reais
  ao exportar um período largo. Corrigido: exportação agora pagina em
  blocos de 2000.
- **Dropdown cortado + tabela sempre com scroll interno**: `.table-wrap`
  tinha `max-height: 620px; overflow: auto` fixo em TODA tabela do app,
  independente de quantas linhas ela realmente tem — além de gerar barra
  de rolagem redundante numa tabela curta, qualquer `Select`/dropdown
  aberto perto do fim de uma linha era cortado por esse overflow (um
  `position: absolute` é sempre clipado pelo ancestral mais próximo com
  overflow non-visible, mesmo posicionado relativo a outro ancestral mais
  interno). Corrigido em duas frentes: `.table-wrap` só rola no eixo X por
  padrão agora (telas com lista realmente longa — Daily, Import — optam
  por um teto vertical via `style` inline, não dependem mais do default);
  e o painel do `DropdownSelect` (`Dropdown.tsx`) passou a ser portado via
  `createPortal` pra `document.body`, posicionado em `fixed` a partir do
  retângulo real do anchor (recalculado em scroll/resize) — nunca mais
  clipado por overflow de nenhum ancestral (tabela ou modal). z-index do
  painel subiu pra 90 (acima de `.overlay` 60 e `.toasts` 80) porque, uma
  vez portado pra body, ele compete no stacking context da raiz, não mais
  dentro do modal que o contém.
- **Cores de categoria expandidas de 4 para 6**: `Categories.tsx` PALETTE
  e `CategoryRing.tsx` MAX_SEGMENTS foram de 4 para 6 — 2 hues novas
  (anil `#1c93b0`, âmbar `#a8721f`) validadas com o script do skill de
  dataviz (`validate_palette.js`) contra os dois surfaces do app
  (`#ffffff`/`#080808`), mantendo vermelho/amarelo reservados para status.
  As 4 cores originais (identidade BOB.OS) ficaram como estavam.
- **"Sobra em aportes" (unallocatedCents > 0) — investigado, não é bug**:
  revisão do código (`investments.ts`, `suggestContribution`) confirma que
  a redistribuição em rodadas (corrigida em 29/08/2026, ver seção anterior
  "Padrões recorrentes de bug" / `decisions/0022`/`0019`) já cobre os dois
  ramos (fecha todo gap e sobra vs. não fecha todo gap) — `unallocatedCents`
  só fica positivo quando NENHUMA classe elegível consegue absorver mais:
  ou toda classe com meta definida já está no alvo, ou os ativos restantes
  não têm nota de resistência respondida. A mensagem que a tela mostra já
  é exatamente essa explicação. Se o usuário via R$ 7.285,21 sem destino,
  o caminho é o próprio usuário: definir meta pra mais uma classe, ou
  responder critérios de mais ativos — não uma correção de código aqui.
- **Travessão em texto de usuário**: regra "pt-BR sem travessão" (linha
  339 acima) valia só na intenção — vários textos de UI (títulos, toasts,
  hints) acumularam "—" ao longo das sessões. Varredura feita em `src/`
  (comentários de código, deliberadamente, NÃO foram tocados — são
  documentação pra dev, não "texto do projeto" do ponto de vista do
  usuário).

## Otimização de performance (29/08/2026) — code splitting + N+1

Usuário pediu formas de acelerar carregamento inicial, troca de tela,
cálculo e busca. Dois pontos concretos, achados por medição (não palpite):
build de produção com um bundle JS único (`vite build`) e leitura de
código em `investments.ts`.

- **Code splitting por rota** (`src/App.tsx`): as 14 telas eram import
  estático — um bundle único de 1.428 KB (402 KB gzip) carregava inteiro
  mesmo pra quem só abre o Painel. Cada página virou `lazy(() =>
  import(...).then(m => ({default: m.XPage})))` (export nomeado, não
  default — por isso o `.then`), com um `<Suspense>` genérico
  (`RouteFallback`, reusa `PageSkeleton` já existente) em volta de
  `<Routes>`. `LoginPage` continua import estático de propósito: é a
  única coisa que precisa carregar antes de saber se existe sessão.
  Resultado medido: entry chunk caiu pra 699 KB (210 KB gzip) — quase
  metade — e cada tela (mais o Recharts que ela usa, via `frame.tsx`,
  ~316 KB/95 KB gzip, compartilhado entre telas com gráfico) só baixa na
  primeira visita, ficando em cache do navegador depois. Ainda dá pra
  cortar mais separando vendor (React/Recharts) do código do app via
  `build.rollupOptions.output.manualChunks` — não feito, é refinamento
  de cache de longo prazo, não o ganho principal.
- **N+1 em `suggestContribution`** (`investments.ts`, espelhado em
  `server/src/services/` e `supabase/functions/_shared/services/`):
  a função chamava `positions()` (JOIN+GROUP BY sobre TODOS os trades da
  carteira, mais uma busca de notas) uma vez pro total (resultado
  descartado) e MAIS UMA VEZ por classe de ativo dentro do
  `assetAllocationWithinClass`, dentro de um `Promise.all` — N classes =
  N+1 leituras idênticas da carteira inteira. `assetAllocationWithinClass`
  ganhou um 3º parâmetro opcional `preloaded?: {allRows, classTargetBps}`
  (callers standalone — rota de UI, `scripts/verify.ts` — continuam se
  virando sozinhos sem passar nada) e passou a reusar a nota já anexada
  em cada `Position` em vez de reconsultar `notesForAssets` da fatia da
  classe. `suggestContribution` agora busca `positions()` uma única vez e
  repassa pra cada classe do `Promise.all`. Não mexido: `reserveStatus()`
  também chama `positions()` internamente e é usada standalone em 6+
  lugares (rotas, `financialHealth.ts`, `financialEngine.ts`) — juntar
  isso é um refactor à parte, maior que o N+1 pontual pedido aqui.

## Termômetro mensal (29/08/2026) — avisos dispensáveis na Visão geral

Usuário pediu avisos temporários tipo "você está gastando mais que o
previsto", cor verde/amarelo/vermelho, usando o componente `Alert` do
shadcn/ui (não `AlertDialog` — é modal, cansaria num app pra abrir todo
dia). Achado ao investigar: a lógica pesada (estado on_track/at_risk/
exceeded, `paceCents`, tetos por categoria) **já existia inteira** em
`goals.ts` desde `specs/monthly-goals` — não foi feature do zero, foi
vitrine de dado já calculado. Ver `specs/monthly-goals` ("Termômetro
mensal") para o detalhe completo: novo endpoint `/home/banners`, novo
componente `src/components/ui/alert.tsx` (3 variantes extras — good/
warning/critical — coloridas via `color-mix()` contra os tokens
`--status-*`, adaptando sozinho a claro/escuro), dispensa por
localStorage (só do dia, não "para sempre"). Distinto do "Modo mês"
existente (`specs/dashboard`) — aquele é um card fixo sempre visível,
isto são avisos específicos e temporários.

**Divergência deliberada Node vs. Deno**: `homeBanners()` roda
`Promise.all` no server (`server/src/services/goals.ts`), mas
sequencial no Deno (`supabase/functions/_shared/services/goals.ts`) —
mesmo achado já documentado acima ("Promise.all sob o pooler de
transação da Edge Function pode travar sem erro"), aplicado
preventivamente aqui porque esta rota roda a cada carregamento do
Painel (mais frequente que `goals-history`, que já tinha essa correção).

## Estudo de viabilidade de 14+1 candidatas (29/08/2026) e primeira leva implementada (30/08/2026)

Usuário pediu um estudo de viabilidade formal (`docs/PROJECT_REVIEWER.md`
como papel) de 15 ideias candidatas, sem implementar — depois pediu pra
seguir com implementação na ordem do ranking sugerido. Achados que valem
lembrar (a análise completa de cada candidata, incluindo as ainda não
implementadas, não está condensada aqui — está no histórico da conversa,
condensar se algum dia virar spec):

- **Achado recorrente mais valioso**: várias candidatas pediam mecanismo
  mais caro do que o necessário porque assumiam que "histórico" =
  "snapshot persistido". Pelo menos 3 vezes (`healthScoreHistory`,
  recordes do motor financeiro, patrimônio histórico) o mecanismo certo já
  existe e é grátis: reusar a função de UM período, sem alterá-la, num
  loop sequencial sobre vários períodos (mesmo padrão de
  `goalHistory`/`homeBanners`) — nunca persistir nada. Antes de propor uma
  tabela nova pra "ver evolução de X", checar se X já é derivável do
  histórico de `transactions` para qualquer data passada.
- **[1] Sequência do Diário, [3] Histórico do Health Score, [6] Simulador
  no Painel, [12] Ativo ilíquido/imobilizado, [15] Sugestão de match
  manual×CSV** — implementados. Todos Baixo custo confirmado na prática,
  nenhum precisou de decisão de princípio nova.
- **[2] Loop de revisão de pendências** — investigado, **já estava
  100% resolvido**: `ReconciliationCard` (Dashboard.tsx) já é visível por
  padrão, já lista cada pendência com confirmar/descartar, e já
  `return null` quando zerado. Não construído — seria trabalho
  redundante. A metade da candidata sobre regras aprendidas (promoção
  automática em 3 hits, sem ação de "confirmar cedo") ficou fora de
  escopo por ambiguidade não resolvida, não por já estar pronta.
- **Bloqueio de infra, não de código**: a CLI do Supabase perdeu
  autenticação no meio da sessão (token expirado após muitas horas) —
  bloqueou migração/deploy até o usuário rodar `supabase login`
  manualmente. Nenhum dado foi perdido; só pausou a aplicação de
  migrações já escritas e testadas. Vale lembrar em sessões longas: se
  `supabase db query`/`projects list` devolver 401 sem motivo aparente,
  é isso, não um bug de código.
- **`illiquid` como novo valor de enum** (`asset_class_kind`) confirmou
  que `asset_valuations` nunca distinguiu cotação BRAPI de valor manual —
  qualquer classe fora de `stocks`/`fii` já era 100% manual desde sempre;
  a "nova classe" foi só um valor de enum + label + ícone, não um
  mecanismo novo.
- **`possibleManualMatchId`/`replaceManualMatch`** (`staged_transactions`)
  é o primeiro mecanismo de sugestão desta sessão que, ao ser confirmado
  pelo usuário, EXCLUI uma transação existente (o lançamento manual) como
  parte do commit — precedente novo a lembrar se outra sugestão de
  "substituir" aparecer: o padrão é sinalizar no staging, nunca aplicar
  sozinho, e só agir no commit explícito.

### Segunda leva (30/08/2026): [5] e [10]

- **[5] Recordes do motor financeiro** — implementado
  (`financialEngineRecords()`), mesmo padrão de loop sequencial dos itens
  anteriores pro "maior disponível"; "dias desde o último saldo negativo"
  usa uma window function SQL (soma corrida do saldo de abertura + delta
  diário), não um loop em código.
- **[10] Retrofit de `investmentGoals` → vocabulário `GoalState`** —
  implementado, mas **não** como planejado no estudo original. A ideia era
  reusar `targetState()` (goals.ts) direto; investigando de novo na hora
  de implementar, ficou claro que `targetState()` mede "atual vs. 85% do
  alvo final" sem noção de tempo restante — errado pra uma meta de anos
  (ficaria "at_risk" quase sempre, mesmo no ritmo certo). Reescrito como
  uma classificação NOVA e PRÓPRIA pra este domínio (`goalProjection`'s
  `state`), que usa a trajetória projetada real (`onTrack`/`reachedMonth`
  já existentes) e só EXPRESSA o resultado no mesmo union type
  `GoalState`/`MeterState` pra badge/cor consistente — nunca a fórmula de
  `targetState()`. Lição: "unificar vocabulário de estado entre domínios"
  e "unificar a fórmula entre domínios" são coisas diferentes; a segunda
  pode ser um erro mesmo quando a primeira é uma boa ideia. Corrigiu de
  quebra uma inconsistência real que já existia (Meter mostrava "no
  ritmo" verde pra meta sem data-alvo, badge ao lado já mostrava "sem
  meta" — agora os dois usam o mesmo `state`).
- O motor genérico de milestones completo (unificação AND/OR entre
  `monthlyGoals`/`investmentGoals`/`targetAllocations`) continua não
  implementado — o achado acima é mais um motivo pra tratar essa versão
  ampla com cautela extra: se até um retrofit de DOIS sistemas já
  escondia uma incompatibilidade de fórmula, um motor genérico de TRÊS
  provavelmente esconde mais.

### Terceira leva (31/08/2026): [8]

- **[8] Patrimônio líquido histórico** — implementado
  (`financialHealth.ts#netWorthHistory`, `GET
  /financial-health/net-worth-history`). O ponto em aberto do estudo original
  ("`positions()` suporta corte de data?") foi resolvido estendendo
  `investments.positions(asOfDate?)` e `analytics.accountBalances(asOfDate?)`
  com um parâmetro opcional (fragmento SQL condicional no join/subquery de
  cotação; omitido, comportamento idêntico a antes) — mesmo espírito de
  não criar uma segunda função paralela "posições no passado", igual ao
  precedente de `possibleManualMatchId` do item [15]. Lado da dívida reusa
  `debt.debtTrend()` direto (já é histórico de verdade), com forward-fill até
  a data de corte de cada mês. Mesmo padrão sequencial (nunca `Promise.all`)
  das demais séries desta leva. UI: `NetWorthHistoryChart`, card "Evolução do
  patrimônio líquido" logo abaixo de "Patrimônio consolidado" em
  `FinancialHealth.tsx`.

### Quarta leva (31/08/2026): [7]

- **[7] Checklist de fechamento mensal** — implementado
  (`monthlyClosing.ts#closingChecklist`, `GET/POST
  /financial-health/closing-checklist`). O estudo original apontou que não
  existe precedente de "revisado" em nenhuma área do app — decisão tomada
  na hora de implementar (sem novo round de perguntas, autorização já dada
  para prosseguir com #7 e #8): dividir os itens em DERIVADOS (nunca
  guardados — categorização, conciliação, Diário, cada um recomputado do
  período pedido) e UM item MANUAL ("DRE do mês revisada"), que é o único
  julgamento humano real e o único que persiste algo
  (`monthly_closing_reviews`, existência de linha por período = revisado,
  mesmo padrão de `skipped_occurrences`: chave em `period`, sem FK,
  `on conflict do nothing` no insert). UI: card "Checklist de fechamento
  mensal" em `FinancialHealth.tsx`, logo após "Composição do score" —
  cada item derivado mostra um detalhe textual (`"3 sem categoria"` etc.),
  o item manual vira um botão "Marcar como revisada"/"Desmarcar revisão".
  Precisou de uma tabela nova (única desta leva de #7/#8) — migração
  `20260831000000_add_monthly_closing_reviews.sql`, aplicada e registrada
  em `schema_migrations` do jeito manual já documentado nesta sessão
  (`supabase db push` não conecta neste ambiente).

## ADRs de desbloqueio — Monte Carlo, Decumulação, Dívida×Patrimônio + exercício do motor genérico (01/09/2026)

Três dos quatro itens que ficaram bloqueados por princípio no estudo de
viabilidade original (29/08/2026) agora têm ADR redigido, seguindo o
formato dos ADRs existentes (`decisions/0003`, `0010`, `0016` usados como
referência de estrutura):

- **[9] Monte Carlo** → `decisions/0034-monte-carlo-e-simulacao-com-piso-minimo-de-dados.md`.
  Classificação travada em Simulação (nunca Projeção), piso de 24 meses de
  retorno mensal por CLASSE de ativo antes de rodar (abaixo disso, "dado
  insuficiente para simular esta classe" em vez de rodar mesmo assim).
  Desbloqueado de PRINCÍPIO, mas continua bloqueado de DADO: nenhuma classe
  do produto atinge 24 meses hoje (histórico real de cotação começa em
  28/08/2026, dia da migração pra Supabase) — não é trabalho pendente, é
  espera natural pelo uso contínuo do app.
- **[13] Decumulação/aposentadoria** → `decisions/0035-decumulacao-e-extensao-do-simulador-de-decisoes.md`.
  Extensão direta do `decisions/0016` (Simulador de decisões), não um
  princípio novo: nunca calcula "quanto retirar", só mostra a consequência
  de um valor de retirada que o usuário propõe, reusando o núcleo de
  composição de `goalProjection` com o sinal do fluxo invertido. Desbloqueado
  para virar spec (terceiro tipo de hipótese em
  `specs/decision-simulator`, ao lado dos dois já travados pelo 0016).
- **[14] Dívida × patrimônio** → `decisions/0036-divida-e-patrimonio-lado-a-lado-sem-hierarquia.md`.
  Dois números lado a lado (juros da dívida vs. retorno da carteira), sem
  hierarquia visual nem frase que implique "priorize A sobre B" — tabela de
  frase proibida/permitida incluída no ADR. Resolve por extensão o framing
  emocional do "Termômetro de Prosperidade" (Efeito do Progresso Dotado) de
  uma avaliação anterior: fica formalmente FORA do produto, não adiado — é
  uma feature diferente (engajamento emocional), não uma versão mais simples
  da comparação neutra que entra. Desbloqueado para virar spec.
- **[10] Motor genérico completo** — não recebeu ADR, recebeu exercício de
  design primeiro: `design-exercises/motor-generico-de-metas.md`. Tabela
  comparativa com dado real dos três domínios (`monthlyGoals`,
  `investmentGoals`, `targetAllocations`) mostrou que cada um tem uma forma
  diferente de "alvo" (absoluto-pra-cima, absoluto-pra-baixo,
  relativo-ao-todo), pelo menos três fórmulas diferentes de "no ritmo" (e
  uma quarta ausência total de fórmula em `targetAllocations`), dimensão de
  tempo obrigatória/opcional/inexistente, e ausência de meta tratada como
  estado explícito ou omissão silenciosa dependendo do domínio. Conclusão:
  **não vale a pena generalizar a fórmula além do retrofit pontual já
  feito** — resultado válido do exercício, não uma falha dele. Só o
  vocabulário de saída (`GoalState`/`MeterState`) continua valendo unificar,
  e isso já foi feito para dois dos três domínios. Fica registrada como
  possível extensão pequena (não decidida): dar a `targetAllocations` um
  badge de estado próprio por faixas de `driftBps`, nunca compartilhando
  fórmula com os outros dois.

## Decumulação implementada + achado: Simulador não tinha Edge Function (01/09/2026)

Com o ADR 0035 pronto, implementado como terceiro tipo de hipótese do
Simulador (`POST /simulate/decumulation`, `simulator.ts#simulateDecumulation`).
Núcleo de composição extraído de `goalProjection` para uma função própria
exportada (`investments.ts#compoundStep`), reusada por ambos com o sinal do
fluxo invertido na retirada — nenhuma segunda fórmula de juros compostos.
UI: `SimulatorModal.tsx` ganhou a aba "Decumulação", trocando a tabela de
deltas (antes/depois) pelas outras duas por um gráfico de área da série
projetada, com o mês de esgotamento marcado por uma `ReferenceLine`.

**Achado ao implementar**: `services/simulator.ts` e `routes/simulate.ts`
nunca tinham sido portados para uma Edge Function (`src/lib/api.ts` já
documentava isso: "routes not yet ported... simulate") — ou seja, o
Simulador inteiro (os dois tipos já existentes, gasto único e quitação de
dívida, construídos antes nesta mesma sessão) só funcionava no Fastify
local, retornando 404 em qualquer build implantado com
`VITE_SUPABASE_URL` configurado. Corrigido junto: `simulator.ts` espelhado
para `supabase/functions/_shared/services/simulator.ts`, e as três rotas
`/simulate/*` adicionadas à Edge Function `insights` (que já é o fallback
de `functionFor()` para qualquer rota sem prefixo próprio, então nenhuma
mudança de roteamento foi necessária no frontend além de atualizar o
comentário em `api.ts`).

## Visualização dedicada para ativos imobilizados (01/09/2026)

`IlliquidAssetsCard` (`src/pages/Investments.tsx`), pedido com referência
visual em prints de apps de patrimônio externos. Detalhes em
`specs/investments`. Nota de processo: o destaque visual inicial (só os
tokens de `.slab--accent`, fundo/borda) ficou quase imperceptível ao lado
de um card comum quando checado visualmente lado a lado (renderização
estática do CSS já compilado, sem precisar de login) — a correção foi
somar uma faixa lateral de 3px na cor da marca (`var(--brand)`), que já é
a cor de ação primária do app em outros lugares, não uma cor de status.
Vale lembrar disso da próxima vez que uma tarefa pedir "destaque": os
tokens de accent existentes no design system são sutis de propósito
(pensados pra web, não pra essa comparação lado a lado específica) e podem
precisar de reforço quando o pedido é para um elemento se diferenciar de
vizinhos parecidos, não só ganhar uma variação sutil de tom.

## Termômetro de gastos — heatmap de calendário no Diário (01/09/2026)

`DailyHeatmap` (`src/components/charts/DailyHeatmap.tsx`), pedido com uma
referência de JSX de uma biblioteca de componentes não identificada
(`HeatmapInteractionProvider`/`HeatmapCells`/etc. — busca web não achou a
origem; tratado como referência de DESIGN, não como pacote a instalar).
Construído com Recharts+SVG à mão, no mesmo sistema de design do resto do
app: rampa sequencial (`theme.sequential`, um hue só, claro→escuro),
nenhuma nova paleta (reusa a rampa já validada de `chartTheme.ts`). Mesma
série de `daily.data.days` que já alimenta "Intensidade por dia"
(`SpendAreaChart`) — não é dado novo, é uma segunda leitura por dia da
semana em vez de por dia do mês. Nota de contexto: "Intensidade por dia"
já FOI um heatmap de calendário antes (`SpendHeatmap`), trocado por uma
curva contínua a pedido do usuário em 29/08/2026 — o pedido de hoje não é
reverter aquilo, é ADICIONAR a leitura por dia-da-semana como um segundo
gráfico, ao lado da curva, não no lugar dela.

Aritmética de data em UTC puro (`Date.UTC`/`getUTCDay`), nunca
`new Date(isoString)` local — evita o dia deslizar num fuso horário
positivo (o app roda em produção só pra um usuário no Brasil, mas a
função não deveria depender disso pra estar certa). Rastreei a lógica de
semanas manualmente contra agosto/2026 (começa num sábado, 31 dias, 6
semanas de calendário) antes de confiar no resultado, em vez de só rodar e
olhar. Verificação visual feita via HTML estático servindo o CSS já
compilado (mesmo truque do card de imobilizado) — dev server local não
loga sem as credenciais do usuário.

## Anéis de progresso da alocação — "Ring Chart - Thick Rings" (01/09/2026)

`AllocationRings` (`InvestmentCharts.tsx`, card "Progresso da alocação" em
`Investments.tsx`), pedido com uma referência JSX de `RingChart`/`Ring`/
`RingCenter`. Diferente do heatmap: esta busca ACHOU a origem real (Bklit
UI, `pnpm dlx shadcn@latest add @bklit/ring-chart`), mas ela puxa
`@visx/shape @visx/group @visx/responsive motion` como dependência —
pacotes novos, fora do padrão Recharts-only já estabelecido no app pra
todo gráfico até aqui. Decisão: construir com a técnica de anel de
progresso que `CategoryRing` já usa (Pie de 2 fatias por anel, Recharts
puro), sem instalar nada novo — mesmo critério aplicado ao heatmap do
Diário, agora consolidado como padrão da sessão: uma referência visual
externa vira ESPECIFICAÇÃO DE DESIGN a reproduzir no sistema existente,
não uma ordem de instalar o pacote literal, a menos que o usuário peça a
biblioteca especificamente (nunca pediu, só mostrou o resultado visual).
Vale a mesma régua se aparecer uma terceira referência assim.

Geometria conferida por cálculo manual (raios de cada anel concêntrico
pra `size=220, strokeWidth=16, ringGap=6, 4 anéis`) antes de considerar
pronto, sem renderizar de fato — verificação visual completa (abrir no
navegador) ficou de fora desta vez porque é SVG gerado pelo Recharts em
tempo de execução, não algo que dá pra aproximar com HTML/CSS estático
como fiz pro card de imobilizado e pro heatmap.
