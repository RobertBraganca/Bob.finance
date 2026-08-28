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
