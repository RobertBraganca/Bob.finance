# 0014. Snapshot versionado antes de toda migração, restauração nunca automática

Status: aceita

## Contexto
O app já roda contra um único arquivo SQLite de trabalho (`data/finance.db`,
PRD seção 4, "uma fonte de verdade") e sofreu, nesta mesma sessão de
revisão, uma mudança de schema real (a Parte 3 do prompt de execução em
andamento adiciona `pricingSettings`, `pricingMultiplierOptions` e
`projectQuotes`). A memória deste projeto já registra que uma migração de
coluna numa tabela referenciada por FK pode gerar um `DROP TABLE` que falha
contra dado real (ver nota "Drizzle SQLite FK migration footgun").

A única rede de segurança que existe hoje é manual: sete arquivos
`data/finance.db.bak-<timestamp>[-rótulo]` criados à mão antes de migrações
arriscadas anteriores (`pre-benchmarks`, `pre-sector`, `pre-dueday`,
`pre-debtid-dismissals`, `pre-skipped-occurrences`). Isso funciona, mas
depende de lembrar de rodar o comando manual antes de cada ajuste — e o
próprio nome desses arquivos, sem um índice central, torna "qual backup
corresponde a qual estado do schema" uma pergunta que só a memória de quem
rodou o comando responde.

## Decisão
Um mecanismo automático substitui a disciplina manual, com quatro peças:

1. **Snapshot automático só quando há migração pendente.** `runMigrations()`
   (chamada em todo boot do servidor, `server/src/index.ts`) hoje reaplica
   o migrator do Drizzle a cada boot, o que é idempotente mas não dá para
   usar como gatilho direto de backup (viraria um backup por boot, ruído,
   não sinal). O gatilho correto é comparar o conteúdo de
   `server/drizzle/meta/_journal.json` contra um marcador do que já foi
   migrado com sucesso (`data/backups/.last-migration-marker.json`,
   guardando o hash do journal na última migração bem-sucedida) — só quando
   o journal muda é que existe migração nova, e só então roda o snapshot,
   antes do migrator.
2. **Snapshot é um arquivo único, consistente, via `VACUUM INTO`.** O banco
   roda em WAL (`server/src/db/client.ts`), então uma cópia de arquivo
   ingênua do `.db` sozinho pode faltar dado ainda só no `-wal`. `VACUUM
   INTO '<caminho>'` (suportado pelo SQLite embutido no better-sqlite3)
   produz um arquivo único autocontido direto da conexão viva, sem precisar
   copiar `-wal`/`-shm` nem fazer checkpoint manual antes.
3. **Metadado do backup vive fora do banco que ele protege.** Um
   `data/backups/manifest.json` (lista JSON, mesmo padrão de arquivo de
   configuração já usado em `data/regras-locais.json`) registra, por
   entrada: número de versão sequencial, timestamp, rótulo (o que motivou
   o snapshot), caminho do arquivo, tamanho em bytes. Fica fora do SQLite
   de propósito — se o motivo do restore for justamente um banco
   corrompido, o índice de "quais backups existem" não pode depender de
   abrir esse mesmo banco para ser lido.
4. **Restauração nunca é automática, e sempre faz backup do estado atual
   primeiro.** Restaurar uma versão antiga é uma ação destrutiva sobre o
   banco de trabalho — mesmo princípio de "sugestão nunca é aplicação
   automática" (PRD seção 4) aplicado a uma operação de arquivo em vez de
   um lançamento: precisa de confirmação explícita (`--yes` ou prompt
   interativo), e sempre cria um snapshot rotulado `pre-restore` do estado
   atual antes de sobrescrever nada — mesmo se esse estado atual for "mais
   novo e melhor" do que o que está sendo restaurado, porque o script não
   tem como saber isso.

## Alternativas consideradas
- **Backup a cada boot do servidor:** descartada — a maioria dos boots não
  tem migração pendente (o migrator já é idempotente), e um snapshot por
  boot encheria `data/backups/` de cópias identicas sem nenhum sinal novo.
- **Guardar o manifesto de backups como uma tabela dentro do próprio
  `finance.db`:** descartada — contradiz o próprio motivo de existir um
  backup (recuperar de um banco corrompido ou perdido não pode depender de
  conseguir abrir esse mesmo banco para saber quais backups existem).
- **Copiar o arquivo `.db` diretamente (`fs.copyFileSync`) em vez de
  `VACUUM INTO`:** descartada — em modo WAL, o arquivo principal por si só
  pode não refletir transações ainda só no `-wal`; copiar os três arquivos
  (`.db`, `-wal`, `-shm`) juntos funciona, mas é mais frágil (a cópia
  precisa ser atômica entre os três) do que pedir ao próprio SQLite um
  snapshot consistente.
- **Prune automático de backups antigos:** descartada por ora — apagar
  backup é uma ação destrutiva como qualquer outra, e nenhuma ação
  destrutiva deste produto acontece sem confirmação explícita. Fica como
  comando manual (`npm run db:backup:prune`), nunca automático.

## Consequências
- Novo `docs/specs/backup-and-recovery/spec.md`.
- `data/backups/` (novo diretório) e `data/backups/manifest.json` (novo
  arquivo). `.gitignore` ganha uma linha para o diretório, por consistência
  com o resto de `data/`, mesmo este projeto não sendo hoje um repositório
  git.
- `server/src/db/migrate.ts` ganha a checagem de journal + chamada de
  snapshot antes de `migrate()`.
- Novos scripts: `npm run db:backup` (manual, sob demanda), `npm run
  db:restore -- <versão>` (lista se chamado sem argumento), `npm run
  db:backup:prune -- --keep N` (manual).
- Os sete `.bak-*` manuais existentes em `data/` não precisam ser
  migrados para o novo formato — continuam válidos como estão, o mecanismo
  novo só vale a partir de agora.
