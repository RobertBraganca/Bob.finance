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
