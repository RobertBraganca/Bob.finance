# Spec: Backup e recuperação

Status: em pausa — ver `decisions/0032`. Removido da UI em 28/08/2026:
o backend nunca foi portado da migração SQLite→Postgres (`decisions/0026`,
Fase 4 pendente) e a tela chegou a mascarar a falha em produção como "nenhum
backup ainda". O desenho abaixo continua sendo o alvo para quando a Fase 4
for retomada — não descreve o estado atual do produto.

## Objetivo
Garantir que o dado atual nunca se perde numa migração ou num ajuste
malsucedido, e que recuperar um estado anterior seja um comando (ou um
clique), não uma cópia de arquivo feita à mão e sem índice — que é como o
projeto opera hoje (sete `data/finance.db.bak-*` criados manualmente antes
de migrações de risco anteriores).

## Histórias de usuário
- Como usuário, eu quero que o sistema guarde uma cópia do banco antes de
  aplicar qualquer migração de schema, sem eu precisar lembrar de fazer
  isso à mão.
- Como usuário, eu quero poder pedir um backup manual a qualquer momento,
  antes de importar um extrato grande ou fazer uma edição em massa que me
  deixe inseguro.
- Como usuário, eu quero ver uma lista dos backups existentes (quando,
  por quê, qual versão) para escolher qual restaurar, em vez de adivinhar
  pelo nome do arquivo.
- Como usuário, eu quero que restaurar um backup nunca aconteça sem eu
  confirmar explicitamente, e que o estado atual (mesmo que eu esteja
  restaurando por engano) nunca seja perdido no processo.

## Modelo de dados
Nenhuma tabela nova em `finance.db` — o índice de backups vive
deliberadamente fora do banco que protege (ver `decisions/0014`).

- `data/backups/` — diretório novo, um arquivo `.db` por snapshot,
  nomeado `financeiro-v<versão>-<timestamp>[-<rótulo>].db`.
- `data/backups/manifest.json` — lista JSON, uma entrada por snapshot:
  `{version, timestampIso, label, trigger, filePath, sizeBytes}`.
  `trigger` é um de `'migration' | 'manual' | 'pre-restore'`.
- `data/backups/.last-migration-marker.json` — hash do
  `server/drizzle/meta/_journal.json` na última migração aplicada com
  sucesso; existe só para decidir se há migração pendente, não é
  histórico e não aparece na UI.

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/backups` | GET | Lista o manifesto (mais recente primeiro) |
| `/backups` | POST | `{label?}` → cria um snapshot manual (`trigger: 'manual'`) |
| `/backups/:version/restore` | POST | `{confirm: true}` → restaura; sem `confirm: true` retorna 400 explicando o que falta |

Não existe rota de exclusão de backup na v1 — apagar um snapshot é uma
operação de arquivo local, não uma ação do produto (ver Fora de escopo).

## Regras de negócio
- **Snapshot automático só roda quando há migração pendente.** O gatilho
  compara o hash de `server/drizzle/meta/_journal.json` contra
  `.last-migration-marker.json`; migração já aplicada (marcador bate) não
  gera snapshot novo, mesmo que o servidor reinicie várias vezes no mesmo
  dia — ver `decisions/0014` para o porquê de não usar todo boot como
  gatilho.
- **Snapshot é sempre `VACUUM INTO`, nunca cópia de arquivo direta** — o
  banco roda em WAL (`server/src/db/client.ts`), e `VACUUM INTO` garante um
  arquivo único e consistente sem depender de copiar `-wal`/`-shm` junto.
- **Versão é sequencial e nunca reutilizada**, mesmo depois de um prune
  manual — a versão identifica um momento específico do histórico, apagar
  um backup antigo não deveria liberar o número dele para outro snapshot.
- **Restaurar sempre cria um `pre-restore` do estado atual primeiro**,
  incondicionalmente, mesmo que o usuário tenha certeza que quer descartar
  o estado atual — é a mesma regra de "nada destrutivo sem uma saída",
  aplicada a arquivo em vez de lançamento.
- **Restaurar exige confirmação explícita no corpo da requisição**
  (`confirm: true`) — nunca uma query string ou header, para que um
  clique acidental em link não dispare a restauração.
- **Depois de restaurar**, o servidor precisa reabrir a conexão com o
  banco (o processo Node mantém um handle aberto do arquivo antigo) — a UI
  informa que é necessário reiniciar `npm run dev` depois de um restore,
  não tenta reconectar em memória.

## UI
Nova seção "Backups" em `Settings.tsx` (`Contas e bancos`, mesma tela que
já tem outras configurações de infraestrutura do app): lista do manifesto
(versão, quando, rótulo, tamanho), botão "Fazer backup agora", botão
"Restaurar" por linha que abre confirmação explícita (nunca um clique
único) explicando que o estado atual será salvo antes de qualquer coisa
ser sobrescrita.

## Casos de borda
- Nenhum backup ainda existe (`manifest.json` não existe ou está vazio):
  lista vazia explícita, com a explicação de que o primeiro backup roda
  automaticamente na próxima migração, ou pode ser pedido manualmente
  agora.
- Espaço em disco insuficiente para o `VACUUM INTO`: a chamada falha com
  erro do próprio SQLite; o snapshot automático de pré-migração aborta a
  migração também (não faz sentido migrar sem rede de segurança), com
  mensagem clara no log de boot.
- Dois processos Node tentando escrever `manifest.json` ao mesmo tempo:
  fora de escopo real (app de um usuário só, um processo por vez), mas a
  escrita usa arquivo temporário + rename atômico por padrão de higiene,
  não `JSON.stringify` direto sobre o arquivo final.

## Fora de escopo
- Prune automático de backups antigos — apagar é sempre um comando manual
  explícito (`npm run db:backup:prune`), nunca automático nem parte desta
  API (ver `decisions/0014`, alternativas consideradas).
- Backup incremental ou diferencial — cada snapshot é um arquivo completo;
  o app é local-first e o banco de trabalho hoje tem ~17MB, incremental
  seria complexidade sem necessidade real neste tamanho.
- Sincronização de backups para nuvem ou outro dispositivo — contradiz a
  seção 6 do PRD ("sem nuvem, sem telemetria"). O usuário é livre para
  copiar `data/backups/` para onde quiser, por fora do produto.
- Migração dos sete `.bak-*` manuais já existentes para o formato novo —
  continuam válidos como estão.
