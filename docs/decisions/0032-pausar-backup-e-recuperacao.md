# 0032. Pausar Backup e recuperação (UI e API) até redesenho para Postgres

Status: aceita

## Contexto
`docs/specs/backup-and-recovery/spec.md` foi desenhado e implementado
inteiramente contra SQLite (`VACUUM INTO`, arquivo único, WAL), antes da
migração para Supabase (`decisions/0026`). Essa migração deixou
`createSnapshot`/`restoreSnapshot` como stubs que sempre falham
(`server/src/db/backup.ts`), pendentes de um redesenho para Postgres
registrado como Fase 4 em `decisions/0026` — sem dono nem prazo até hoje.

Além disso, a rota `/backups` nunca foi portada para Edge Functions.
`src/lib/api.ts` roteia qualquer caminho não reconhecido para a function
`insights`, que não registra `/backups/*` — em produção a chamada cai num
404 da function errada, não num erro claro.

A revisão geral do projeto de 28/08/2026 encontrou que
`Settings.tsx` (`BackupsCard`) não checava o estado de erro dessa query —
o 404 virava silenciosamente `rows = []`, e a tela mostrava "Nenhum backup
ainda" como se a chamada tivesse funcionado e o resultado fosse vazio. Isso
é pior que não ter a feature: passa segurança falsa exatamente na única
tela cujo propósito é dar segurança. Diante disso, o usuário decidiu não
absorver agora o custo do redesenho da Fase 4 e eliminar a etapa por
enquanto.

## Decisão
Remover a seção "Backups" da tela de Configurações
(`src/pages/Settings.tsx`) — mudança de front-end apenas. O código de
backend (`server/src/routes/backups.ts`, `server/src/db/backup.ts`) e o
spec permanecem no repositório, dormentes, não apagados — o histórico do
git preserva o componente removido (`BackupsCard`/`RestoreModal`) para
quando a Fase 4 for retomada. Nenhuma Edge Function é criada para
`/backups`; a rota continua inexistente em produção, agora sem uma UI que
finja o contrário.

## Alternativas consideradas
- **Terminar o redesenho da Fase 4 agora** (client Postgres + snapshot via
  `supabase db dump`/mecanismo equivalente, mais a rota portada): descartada
  por ora — o usuário optou explicitamente por não absorver esse custo
  neste momento, não por decisão técnica.
- **Manter a UI, mas com aviso "recurso indisponível"**: descartada — mais
  honesto remover a entrada até a feature voltar a existir de verdade do que
  manter uma tela permanentemente se desculpando por algo que nunca vai
  funcionar enquanto a Fase 4 não acontecer.

## Consequências
- Sem rede de backup automatizada dentro do produto até este ADR ser
  revertido. Snapshot manual do banco Supabase via linha de comando
  (`supabase db dump --linked`, já usado durante a própria migração
  original, ver `decisions/0026`) continua disponível fora do produto, por
  fora desta decisão.
- `docs/specs/backup-and-recovery/spec.md` marcado "em pausa" (não
  apagado) — continua descrevendo o desenho ao qual a feature deveria
  voltar quando a Fase 4 for retomada, não o estado atual do produto.
- Reverter esta decisão é: reimplementar a Fase 4 contra Postgres, portar
  `/backups` para uma Edge Function, e reintroduzir `<BackupsCard />` em
  `Settings.tsx` a partir do histórico do git.
