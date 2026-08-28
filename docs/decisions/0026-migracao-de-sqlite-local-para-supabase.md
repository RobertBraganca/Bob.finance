# 0026. Migração de SQLite local para Supabase (Postgres) como fonte real

Status: aceita — reverte parte de `decisions` original de 19/08/2026

## Contexto
Em 19/08/2026, ao escopar o app, o usuário escolheu deliberadamente
**SQLite local em disco** sobre **Next.js + Supabase** e sobre
IndexedDB só no navegador — decisão registrada como "requisito
assentado", não default meu, especificamente para manter os extratos
financeiros só na máquina. Em 27/08/2026 o usuário revisitou essa
decisão por conta própria e pediu a migração completa para um projeto
Supabase que ele já criou — confirmado explicitamente (não uma
sugestão minha): Supabase substitui o SQLite por completo, vira a fonte
real, não uma réplica/backup paralelo.

Isso não é o "self-hosted em servidor dedicado depois" já antecipado
em 21/08/2026 (`financas-app-locked-decisions`, memória) — aquele
cenário era explicitamente "servidor próprio, não SaaS de terceiro".
Este é o SaaS de terceiro que a decisão original tinha rejeitado
nomeadamente. Registrado aqui como o que de fato aconteceu, não
escondido atrás da decisão antiga.

## Por que isso é maior que trocar a connection string
Levantamento no código antes de qualquer mudança: **16 arquivos, 227
pontos de chamada** usando a API síncrona do `better-sqlite3`
(`.all()`, `.get()`, `.run()` sem `await`, sem `Promise`) —
`server/src/services/*.ts` inteiro e `routes/ledger.ts`. Um driver
Postgres (`postgres-js`, ou o cliente do Supabase) é assíncrono por
natureza — cada um desses 227 pontos precisa de `await`, e cada função
que hoje retorna um valor direto vira `async` e propaga `Promise` para
cima na cadeia de chamada (muitos serviços chamam outros serviços
diretamente, não só por rota HTTP). Além disso:
- **Backup** (`decisions/0014`) é inteiro construído em cima de
  `VACUUM INTO` do SQLite — não existe no Postgres; precisa de um
  mecanismo novo (Supabase tem backup gerenciado próprio, mas o
  snapshot-antes-de-toda-migração deste projeto foi pensado para um
  arquivo único, não para um serviço gerenciado externo).
- **Migrações Drizzle** já eram pensadas com portabilidade Postgres em
  mente (memória antiga já registrava isso), mas o dialeto SQL
  específico (`AUTOINCREMENT`, tipos, `PRAGMA`) precisa de tradução —
  não é automático.
- **`npm run verify`** (546 checks) roda contra um banco SQLite
  descartável recriado a cada execução em milissegundos; against
  Supabase isso vira uma escolha real (banco de teste dedicado no
  Supabase? Docker Postgres local para verify, Supabase só em prod?) —
  precisa de decisão própria antes de a suíte inteira parar de servir
  como rede de segurança.

## Decisão
Migração completa, faseada — não um "big bang" que troca tudo de uma
vez sem como validar no meio do caminho:

1. **Fase 1 — conexão e schema**: MCP do Supabase autenticado pelo
   usuário (fora do meu controle — é login da conta dele); tradução do
   schema Drizzle SQLite → Postgres; aplicar no projeto Supabase real
   SEM migrar dado nenhum ainda.
2. **Fase 2 — migração de dados**: exportar o SQLite real
   (`data/finance.db`, com os 8.500+ lançamentos reais) e importar no
   Supabase, com verificação de contagem/soma por tabela batendo dos
   dois lados antes de considerar concluído.
3. **Fase 3 — reescrita do client**: trocar `server/src/db/client.ts`
   de `better-sqlite3` para o driver Postgres; converter os 227 pontos
   de chamada síncronos para `async`/`await`, arquivo por arquivo, com
   `npm run typecheck` limpo a cada arquivo — não uma reescrita
   silenciosa de tudo de uma vez.
4. **Fase 4 — backup e verify**: decidir e implementar o equivalente
   de `decisions/0014` para Postgres/Supabase antes de considerar a
   rede de segurança restabelecida; decidir onde `npm run verify` roda
   contra o quê.
5. **Fase 5 — corte**: só depois das quatro fases acima validadas, o
   SQLite deixa de ser lido pelo app em produção. O arquivo local não é
   apagado neste momento — vira o próprio backup pré-corte.

Cada fase é um passo revisável, não uma sequência que só pode ser
julgada no final.

## Alternativas consideradas
- **Trocar tudo de uma vez, sem fases:** descartada — 227 pontos de
  chamada síncronos, dado financeiro real, e nenhuma forma de validar
  no meio do caminho tornam isso um risco desproporcional ao ganho de
  velocidade.
- **Manter SQLite como fallback permanente, Supabase só quando
  disponível:** descartada pelo usuário — o pedido explícito foi
  substituição, não um caminho duplo permanente (isso também
  multiplicaria a superfície de bugs: toda query precisaria funcionar
  nos dois dialetos para sempre).

## Fase 1 — concluída (28/08/2026)
Aplicada no projeto Supabase real (`ubgsgzlvugjbzyzbufel`, "BOB.FINANÇA")
via `supabase db push`, CLI já autenticado localmente — não precisou
esperar o MCP terminar de conectar. Três migrações:
`supabase/migrations/20260828001941_initial_schema.sql` (schema
completo: 32 tabelas, 25 enums, 3 funções, 8 triggers, 89 índices, RLS
habilitada em toda tabela sem policy nenhuma para anon/authenticated),
`20260828002409_fix_singleton_id_default.sql` e
`20260828002605_fix_function_search_path.sql` — as duas últimas
corrigindo bugs reais encontrados testando a primeira, não parte do
plano original:

- **Bug real 1**: as 4 tabelas singleton usavam `generated always as
  identity` para a PK. Uma sequence nunca desfaz o próprio avanço em
  rollback de transação — a primeira tentativa de insert que falhasse
  por qualquer motivo já empurraria a sequence para 2, e a `check (id =
  1)` travaria QUALQUER insert dali em diante, permanentemente.
  Corrigido trocando por `default 1` (constante, sem sequence) nas 4
  tabelas. Encontrado testando o próprio trigger de singleton antes de
  reportar a fase como concluída.
- **Bug real 2**: `supabase db advisors` (rodado como o skill do
  Supabase manda depois de qualquer mudança de schema) apontou
  `search_path` mutável nas 3 funções próprias — corrigido com
  `search_path = ''` e chamadas internas qualificadas
  (`public.now_iso()`, `public.%I` no SQL dinâmico do
  `enforce_singleton`). Um achado pré-existente do próprio Supabase
  (`rls_auto_enable`, um event trigger da plataforma que nada aqui
  criou) foi deixado como está — é infraestrutura gerenciada pelo
  Supabase, não parte desta migração.

Verificado direto no banco real (não só "a migração rodou sem erro"):
32 tabelas, 25 enums, 8 triggers próprios, RLS ligada nas 32 tabelas,
os dois triggers customizados testados com insert/update reais
(criados e apagados depois, banco limpo).

## Fase 2 — concluída (28/08/2026)
Todas as 32 tabelas exportadas de `data/finance.db` (real, com backup
v20 tirado antes de qualquer coisa) e carregadas no Supabase via
`supabase db query --linked --file`, em lotes por arquivo (a API de
upload do CLI rejeita arquivo grande demais — tabelas com milhares de
linhas viraram vários arquivos, não um só). Ordem de dependência de FK
respeitada; todo `id` preservado exatamente (`overriding system value`
+ `setval` no fim de cada tabela), para toda referência entre tabelas
continuar batendo.

**Um bug real encontrado migrando o dado de verdade, não coberto pelos
testes da Fase 1**: `asset_class_kind` faltava dois valores
(`treasury`, `etf_intl`) — a lista usada na migração inicial veio do
comentário em `schema.ts`, que estava desatualizado; a fonte de
verdade real é `ASSET_CLASSES` em `services/investments.ts`, com 10
valores, não 8. Todo insert em `assets`/`criteria`/`target_allocations`
envolvendo Tesouro Direto ou ETF Internacional falhava, e por
transação atômica isso derrubou junto `asset_trades`,
`asset_valuations` e `asset_criteria_answers` (violação de FK em
cascata, não bugs próprios). Corrigido com uma nova migração
(`ALTER TYPE ... ADD VALUE`) e reaplicado.

**Verificação, não só "rodou sem erro"**:
- Contagem de linha exata, tabela por tabela, todas as 32 — nenhuma
  divergência.
- Soma de `amount_cents` de `transactions` (1.669.302) e
  `staged_transactions` (606.599) idêntica nos dois bancos.
- Zero violação de integridade referencial (`category_id`,
  `account_id`, `forecast_id`, `debt_id` de `transactions`, checados
  contra as tabelas que referenciam).
- Amostragem de descrições com aspas simples, acento e `R$` (dollar-
  quoting) — preservadas exatamente, sem corrupção.
- `supabase db advisors` rodado de novo depois da carga: nenhum
  achado novo além do `rls_auto_enable` pré-existente (infraestrutura
  do próprio Supabase, não desta migração).

Arquivos de dado gerados (`supabase/_migration-data/`, cópia
temporária dos dados reais em texto puro) apagados depois da
verificação — não fazem parte do histórico de migração do Supabase,
eram só o meio de carregar os dados.

Fases 3-5 (reescrita do client, backup/verify, corte) continuam
pendentes.

## Fase 3 — concluída (28/08/2026)
`server/src/db/client.ts` reescrito para `postgres-js` +
`drizzle-orm/postgres-js` (session pooler, porta 5432). Todos os 227
pontos síncronos identificados nos 16 arquivos — mais `db/seed.ts`,
`db/migrate.ts`, `db/backup.ts` e 6 scripts avulsos — convertidos para
`async`/`await`, arquivo por arquivo, com `npm run typecheck` limpo a
cada lote (ordem de dependência: `analytics`/`benchmarks`/`categories`/
`categorization`/`creditCards`/`criteria` primeiro; depois `debt`/
`transfers`/`investments`; depois `cashFlow`/`dre`; depois
`transactions`; depois o ciclo `goals`↔`pricing`↔`financialEngine`↔
`financialHealth` — mutuamente dependente, convertido como uma unidade;
depois `imports`/`simulator`/`quotes`; por fim as rotas Fastify e o
bootstrap do banco).

`server/src/db/migrate.ts` (migrator SQLite do Drizzle) e a parte de
schema de `db/backup.ts`/`db/seed.ts` que dependiam dele foram
removidas — o schema agora só é gerenciado por `supabase db push`
(CLI), nunca pelo app no boot.

**Bugs reais encontrados testando contra o Postgres ao vivo, não pelo
typecheck** (typecheck limpo não prova comportamento correto — só
testar contra dado real prova):

- **Ordem de avaliação de módulos ESM**: `.env` era carregado em
  `index.ts`, mas todo import é avaliado antes do próprio código do
  módulo importador rodar — `db/client.ts` tentava ler
  `process.env.SUPABASE_DB_*` antes de `index.ts` chegar a carregar o
  `.env`. Corrigido carregando o `.env` dentro do próprio
  `db/client.ts`.
- **`bigint`/`numeric` do Postgres voltam como `string` por padrão** no
  `postgres-js` (para não perder precisão em valores fora do range
  seguro de `Number`) — colunas tipadas do Drizzle já corrigem isso
  sozinhas (`PgBigInt53.mapFromDriverValue` sempre chama `Number()`),
  mas as várias queries de agregação em SQL cru (`db.execute(sql\`...\`)`
  usadas em `analytics.ts`, `categories.ts`, `debt.ts`, `cashFlow.ts`,
  `transactions.ts` etc.) não passam por essa camada — todo `count(*)`
  e `sum(coluna bigint)` chegava como string, corrompendo silenciosamente
  aritmética posterior (`sum + row.amount` concatenando texto em vez de
  somar). Corrigido registrando um parser de tipo para os OIDs 20
  (int8) e 1700 (numeric) na conexão, convertendo para `Number` —
  seguro aqui porque todo valor monetário é centavos, bem dentro de
  `Number.MAX_SAFE_INTEGER`.
- **`CASE` comparando enum com texto**: `FLOW_KIND` (o `case when
  c.kind is null then ... else c.kind end` reusado em quase toda
  query de `analytics.ts`) falhava com "CASE types category_kind and
  text cannot be matched" — Postgres, ao contrário do SQLite, exige que
  os dois lados de um CASE resolvam pro mesmo tipo. Corrigido com
  `c.kind::text`.
- **Pool de conexões do session pooler**: o projeto Supabase limita a
  15 clientes simultâneos nesse pooler. As muitas conversões para
  `Promise.all` (paralelizando o que antes era sequencial por
  necessidade do SQLite síncrono) geravam picos de conexões
  concorrentes suficientes para estourar esse teto sozinhas. Corrigido
  limitando o pool do próprio app (`max: 5`) — excesso de queries
  concorrentes agora enfileira no lado do `postgres-js` em vez de
  estourar o limite do lado do Supabase.
- **Promise "perdida" dentro de objeto literal**: em `routes/pricing.ts`,
  vários handlers faziam `return { settings: pricing.getSettings() }`
  ou `const quote = pricing.getQuote(id); if (!quote) ...` sem `await`.
  O Fastify só espera automaticamente quando o HANDLER INTEIRO devolve
  a Promise diretamente — uma Promise dentro de uma propriedade de
  objeto, ou usada num teste de verdade (`if (!quote)`, sempre
  verdadeiro para qualquer Promise, mesmo resolvendo pra `null`), nunca
  é esperada. O TypeScript não acusa isso: `{ settings: Promise<T> }` é
  um tipo perfeitamente válido. Só apareceu testando de verdade (as
  respostas vinham como `{}` em vez do objeto real, e o 404 de "cotação
  não encontrada" nunca disparava). Corrigido com `await` em cada
  chamada; auditado o mesmo padrão em todas as outras rotas e nos
  services — nenhuma outra ocorrência.

**Verificação**: servidor de fato inicializado contra o projeto
Supabase real (não só typecheck), testado manualmente contra mais de
20 endpoints reais — dashboard, transações, investimentos, dívidas,
saúde financeira, motor financeiro, simulador, precificação, cartões,
metas, categorias, regras, importações, critérios, reserva de
emergência — todos devolvendo dado real e correto.

## Fase 4 — pendente (decisão em aberto)
`server/src/db/backup.ts` (snapshot via `VACUUM INTO`, restore via
fechar a conexão e sobrescrever o arquivo) e `scripts/verify.ts`/
`verify-backup.ts` (546+37 checks contra um SQLite descartável
recriado a cada execução) não têm equivalente direto no Postgres:

- Não há `pg_dump`/`psql` instalados nesta máquina, mas `supabase db
  dump --linked` empacota isso — viável para CRIAR um snapshot.
- RESTAURAR contra um Postgres compartilhado ao vivo é uma operação
  fundamentalmente mais arriscada que sobrescrever um arquivo SQLite
  local — precisa de desenho próprio antes de existir.
- `verify.ts` recriar um banco inteiro a cada execução (o que faz hoje
  com SQLite em milissegundos) não é viável nem seguro contra um
  projeto Supabase real.

`createSnapshot`/`restoreSnapshot` foram deixados como stubs que
falham alto (erro claro, não um no-op silencioso nem corrupção) até
essa decisão ser tomada. `db/reset.ts` (apaga o arquivo SQLite local)
ainda funciona sem alteração — só não apaga mais nada que o app leia.

## Fase 5 — pendente
Depende da Fase 4. Só depois de backup/verify redesenhados é que faz
sentido declarar o SQLite oficialmente fora do caminho de produção.

## Adendo (28/08/2026) — camada de serving vira Supabase Edge Functions
Depois da Fase 3, o app foi publicado no Vercel (`npm run build` do
frontend Vite, corrigido antes disso excluindo `scripts/verify.ts`/
`verify-backup.ts` do typecheck de build — os dois ficaram cheios de
erro de API síncrona obsoleta desde que a Fase 4 pausou, e o Vercel
nunca roda esses scripts mesmo). O deploy subiu, mas a tela travava em
"Carregando visão geral..." — causa raiz: **o backend Fastify nunca
tinha onde rodar em produção**. `src/lib/api.ts` chama `/api${path}`
relativo, que só funciona via o proxy do Vite (`vite.config.ts`,
dev-only) — não existe equivalente no build estático servido pelo
Vercel.

Isto é uma decisão nova, não prevista nas 5 fases originais (que
tratavam só da camada de dado, não de onde o servidor roda). Opções
levantadas: (a) manter Fastify e hospedar num serviço próprio (Railway/
Render/Fly), (b) reescrever como Next.js API routes no próprio Vercel,
(c) usar Supabase Edge Functions já que o banco já é Supabase. Usuário
escolheu explicitamente **(c)**: "Vamos utilizar o supabase para servir
como backend do projeto."

Isso implica reescrever a casca HTTP (Fastify → Deno/Edge Functions,
runtime diferente, sem Node) mantendo a lógica de negócio
(`services/*.ts`) intacta. Antes de comprometer as 5 rotas restantes,
foi feita investigação de viabilidade (pedida explicitamente pelo
usuário: "Faça a investigação de viabilidade primeiro") com uma função
descartável (`test-drizzle`, criada, testada, apagada) confirmando ao
vivo que `drizzle-orm/postgres-js` e `zod` funcionam sob Deno sem
alteração de código. Achados:
- Supavisor **modo transação** (porta 6543, `prepare: false`) é o
  indicado para Edge Functions — modo sessão (porta 5432, usado pelo
  Fastify) é para servidor persistente, não para muitas invocações
  curtas e concorrentes.
- Limites confirmados via doc oficial: 256MB memória, 2s CPU por
  requisição, 150s (free)/400s (pago) de duração de worker.
- `bigint`/`numeric` como `string` (mesmo bug da Fase 3) reproduz
  idêntico sob Deno — mesmo fix de `types` parser no client.

Com a viabilidade confirmada, o usuário aprovou começar por uma rota
como prova de conceito: **"Sim, começa pela pricing.ts"**.

### `pricing.ts` portado (28/08/2026) — prova de conceito concluída
`server/src/routes/pricing.ts` (Fastify, 15 rotas) portado para
`supabase/functions/pricing/index.ts` usando Hono. Toda a lógica de
negócio (`services/pricing.ts` e seu fechamento transitivo de 13
services) foi copiada verbatim para `supabase/functions/_shared/`, sem
mudança de conteúdo — só extensão `.ts` explícita em todo import
relativo (Deno exige, ao contrário da resolução em modo bundler do
Node/tsx/Vite). `_shared/db/client.ts` é uma versão nova do client
Postgres, específica para Deno: pooler de transação (porta 6543),
`Deno.env.get` em vez de `.env` (Deno não carrega arquivo `.env`
sozinho), variáveis de ambiente próprias (`APPDB_HOST/USER/PASSWORD/
NAME`, ver adiante o porquê do nome).

**Vantagem estrutural do Hono sobre o Fastify aqui**: `app.onError`
captura qualquer erro/rejeição lançado por qualquer rota — elimina de
raiz a classe inteira de bug "Promise sem `await` dentro de
try/catch" (ver Fase 3) que ainda apareceu 4 vezes a mais nesta mesma
`pricing.ts` e em `simulate.ts` durante o trabalho desta rodada (
`simulate`, `saveQuote`, `approveQuote` em pricing.ts;
`simulateDebtPayoff` em simulate.ts — corrigido, commit `effa9f9`). Sem
try/catch por rota, esse bug não tem mais onde se esconder daqui pra
frente.

**Bugs reais encontrados só ao vivo, não pelo deploy nem typecheck**:
- Import relativo sem extensão (`from '../db/client'`) não resolve no
  Deno — corrigido com regex de projeto inteiro adicionando `.ts` em
  todos os 17 arquivos de `_shared/`.
- `@supabase/functions-js/edge-runtime.d.ts` (import ambiente,
  necessário pro tipo de `Deno.serve`) falhava no bundler do deploy por
  não estar no import map — corrigido adicionando ao `deno.json`.
- **Secrets com prefixo `SUPABASE_` são silenciosamente cortados pela
  plataforma** (`SUPABASE_DB_HOST` vira `HOST` em `secrets list`) —
  reservado para os secrets injetados pela própria plataforma.
  Corrigido renomeando para nomes sem esse prefixo.
- **`--env-file` corrompe valor com caractere especial**: a senha do
  banco (com `$&#%@^*`) setada via `supabase secrets set --env-file`
  causava "password authentication failed" persistente — sobreviveu a
  duas rodadas de troca de nome de variável (afastando a hipótese de
  colisão de nome). Isolado por comparação com o único teste que já
  tinha funcionado (`test-drizzle`, senha setada como argumento direto
  de linha de comando, não por arquivo). Corrigido re-setando só a
  senha via `supabase secrets set APPDB_PASSWORD="valor"` diretamente —
  nomes sem caractere especial (`HOST`/`USER`/`NAME`) continuam seguros
  via `--env-file`.
- Um campo de debug temporário (`cause` do erro, ecoado na resposta
  500) foi adicionado só para contornar a falta de acesso a log nesta
  versão do CLI (`functions logs` não existe; `functions serve` precisa
  de Docker, ausente neste ambiente) — removido depois que a causa raiz
  foi isolada, antes de considerar o trabalho concluído (não é
  aceitável expor detalhe interno de erro em produção).

**Verificação ao vivo, todas as 15 rotas, contra o projeto Supabase
real** (não só "o deploy não deu erro"): `GET /settings`, `PUT
/settings`, `GET /multipliers`, `POST /multipliers` (criado, editado,
apagado — sem deixar resíduo), `POST /simulate`, `GET /quotes`, `POST
/quotes` (criado, status alterado, apagado — sem deixar resíduo), `GET
/quotes/:id`, `GET /quotes/999999` (404 correto), todas devolvendo dado
real e correto. `approveQuote` (que gera uma transação real) não foi
exercitado ao vivo deliberadamente — testá-lo criaria um lançamento
financeiro real; a lógica é idêntica à já verificada na Fase 3 contra
o Fastify.

**Ainda em aberto**: as outras 4 rotas (`insights.ts`, `ledger.ts`,
`backups.ts`, `simulate.ts`) não foram portadas — só começam com
aprovação explícita do usuário, uma de cada vez, como aconteceu aqui.
Frontend (`src/lib/api.ts`, `vite.config.ts`) ainda aponta pro proxy
dev-only — não atualizado até mais rotas estarem portadas. Postura de
autenticação da function (hoje `--no-verify-jwt`) ainda não decidida
para o caso de uso real com chave anon/publishable.

### `insights.ts` portado (28/08/2026) — a rota que a Visão geral usa
Depois do usuário reportar que a Visão geral publicada ainda não
carregava, investigação mostrou que ela depende de `insights.ts`
(`/dashboard`, `/analytics/*`, `/goals/*`, `/debts`, `/credit-cards`,
`/financial-health/*`, `/financial-engine/*`, `/investments/*`,
`/cash-flow/*`) — ~70 rotas em 1018 linhas, bem maior que as 15 de
`pricing.ts`. Usuário escolheu explicitamente portar o arquivo inteiro
de uma vez (não só o subconjunto que a Visão geral chama) diante da
opção de escopo apresentada.

Portado para `supabase/functions/insights/index.ts` (Hono), com o
mesmo padrão de `pricing.ts`. Diferença deliberada: as rotas de
`insights.ts` não tinham prefixo próprio no Fastify (registradas direto
sob `/api`, ao contrário de `pricing.ts` que já se prefixava sozinho
com `/pricing/`). Como o nome da function vira o primeiro segmento da
URL numa Edge Function, isso significa que essas rotas ganham aqui um
prefixo novo (`/insights/`) que não existia antes — decisão registrada
aqui, não um detalhe silencioso, e algo que o trabalho pendente de
atualizar `src/lib/api.ts` vai precisar respeitar. Também exigiu copiar
para `_shared/services/` os 3 services que `pricing.ts` não usava
(`benchmarks.ts`, `dre.ts`, `quotes.ts`) — `quotes.ts` e `benchmarks.ts`
usam `process.env.BRAPI_TOKEN`, trocado por `Deno.env.get(...)` (mesmo
ajuste do resto do fechamento).

**Achado real mais sério desta rodada, encontrado só ao vivo**: rotas
com fan-out concorrente pesado (`Promise.all` de várias chamadas, cada
uma às vezes com seu próprio fan-out por linha) **travam a requisição
para sempre — sem erro nenhum, sem timeout do lado do servidor** — sob
o pooler de transação (Supavisor, porta 6543) que este projeto usa
nas Edge Functions. Isolado testando `/debts`, `/investments`,
`/goals-history`, `/financial-health/{score,runway}` e
`/financial-engine/available` um por um: cada um travava
consistentemente, `curl --max-time` nunca retornava. Tentativas na
ordem testada, com o que cada uma realmente mudou:
- Subir `max` do client Postgres (1 → 5 → 10 → 20): resolveu `/debts` e
  `/investments` em 5, mas `/goals-history` (12 meses, cada um rodando
  sua própria `getPeriodProgress` de 5 queries) continuou travando até
  em 20 — prova de que o teto real está a montante, no próprio budget
  de conexão do pooler, não em `max` do lado do client.
- Adicionar `idle_timeout: 20` (o mesmo já usado no client Node desde a
  Fase 3, mas nunca copiado para o client Deno): resolveu o padrão de
  "rota que funcionava e passou a travar em toda tentativa depois de
  uma sessão de teste pesada" — sintoma batendo com o modo de falha
  documentado pelo próprio Supabase (socket ficando obsoleto entre
  invocações de uma instância reaproveitada, e o pool local do
  `postgres-js` não percebendo).
- Nenhuma das duas mudanças de configuração resolveu sozinha o
  fan-out mais profundo (`goals-history`, `financial-health/score`,
  `financial-health/runway`, `financial-engine/available`,
  `financial-health/risk-radar`) — só reescrever o fan-out concorrente
  como sequencial (um `await` de cada vez, em vez de `Promise.all`)
  resolveu de fato, confirmado com 3 rodadas completas sem falha contra
  as ~70 rotas depois do fix. Mais lento (soma da latência em vez do
  máximo), aceitável aqui porque nenhuma dessas rotas está num caminho
  onde essa diferença é perceptível.

Fix aplicado só em `supabase/functions/_shared/` (o service original em
`server/src/services/` não muda): o bug nunca reproduziu sob o pooler
de sessão do servidor Node (Fase 3 já validou esse exato padrão de
`Promise.all` ao vivo), então essa divergência entre as duas cópias é
deliberada, do mesmo jeito que `db/client.ts` já diverge por pooler/
porta/variáveis — não uma cópia desatualizada.

**Isto é um risco sistêmico, não só desses 5 pontos**: qualquer service
ainda não testado ao vivo com fan-out concorrente parecido pode ter o
mesmo problema à espera de aparecer. Não foi viável auditar as ~70
rotas uma por uma neste momento — o que existe é o que foi
efetivamente exercitado (3 rodadas completas, todas as rotas GET,
zero falha) mais os 5 pontos que travaram e foram corrigidos.

## Consequências
- Este ADR não implementa nada sozinho — é o registro da decisão e do
  plano faseado. Cada fase acima vira trabalho próprio, com sua própria
  verificação, à medida que o acesso ao Supabase (MCP autenticado) e a
  aprovação de cada fase acontecem.
- `financas-app-locked-decisions` (memória) precisa de atualização
  explícita: a escolha de 19/08 contra Supabase está revertida a
  partir de 27/08/2026, por decisão do próprio usuário.
- `README.md`, seção "Como está montado", vai precisar de reescrita
  quando a Fase 3 terminar — hoje descreve SQLite como a arquitetura
  atual.
