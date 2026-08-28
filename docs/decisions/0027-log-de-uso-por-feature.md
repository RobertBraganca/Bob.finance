# 0027. Log de uso por feature (tela aberta, ação-chave, erro)

Status: aceita

## Contexto
Usuário pediu, explicitamente: "adiciona logs em todas as features para
acompanhar os resultados individuais de uso e trabalhar melhorias
contínuas de UX e UI" (28/08/2026). Antes desta decisão, o app não
registrava uso nenhum — qualquer melhoria de UX teria que se basear só
em relato manual do próprio usuário, não em dado real de qual tela abre
mais, onde erro aparece com mais frequência.

Perguntado antes de implementar (três decisões de escopo, todas
confirmadas pelo usuário):
1. **Onde o log fica**: tabela própria no Supabase — não um serviço de
   analytics de terceiro (PostHog/Plausible). Dado de uso continua
   100% dentro do próprio projeto, sem depender de conta externa nem
   mandar nada pra fora do Supabase já usado para o dado financeiro.
2. **Granularidade**: página aberta + ações-chave — não rastreamento
   exaustivo de clique a clique. Cada tela conta como um evento de
   visão; cada feature tem no máximo uma ou duas ações representativas
   (a que "conclui" a tarefa da tela), não toda mutation existente.
3. **Erros**: sim, entram no mesmo log — validação, falha de rede, rota
   ainda não portada (ver `decisions/0026`) são todos sinal direto de
   fricção de UX, exatamente o que o pedido original queria capturar.

## Decisão
Uma tabela nova, `usage_events` (migração
`20260828113852_add_usage_events.sql`): `session_id` (aleatório,
gerado no navegador via `localStorage`, nunca é identidade de
usuário — só agrupa eventos da mesma aba), `feature`, `kind`
(`view`/`action`/`error`), `name`, `detail` (jsonb livre, mas nenhum
callsite guarda descrição/valor de lançamento ali — só o nome da ação
e IDs). RLS ligada, sem policy pra anon/authenticated — mesma postura
de toda outra tabela deste schema (acesso real é só via Edge Function
com a conexão de serviço, nunca PostgREST direto).

Uma Edge Function nova, `telemetry` (`POST /telemetry/events`), mesmo
padrão Hono/Deno de `decisions/0026`. `src/lib/telemetry.ts` no
frontend: fire-and-forget (nunca lança, nunca bloqueia a ação real —
uma falha de rede aqui não pode virar bug em cima de outra coisa).

**Views**: uma única chamada em `App.tsx` (`usePageViewTelemetry`,
`useLocation` do react-router), mapeando path → feature
(`FEATURE_BY_PATH`). Cobre as 13 telas sem precisar instrumentar cada
`pages/*.tsx` uma por uma.

**Erros**: um único ponto em `src/lib/api.ts#request` — toda chamada de
API passa por ali, então um `telemetry.error(...)` logo antes do
`throw new ApiError(...)` cobre qualquer erro de qualquer feature sem
precisar anotar cada callsite. `feature` vem da mesma função
`functionFor(path)` que já decide pra qual Edge Function a chamada vai
(reaproveitada, não duplicada).

**Ações-chave** (uma por feature, escolhida como "a que conclui a
tarefa da tela", não a lista inteira de mutations): cotação salva e
cotação aprovada (`pricing`), CSV commitado (`import`), dívida criada
(`debt`), lançamento manual criado (`transactions`), trade registrado
(`investments`), meta salva (`goals`), cartão criado (`credit-cards`).

## Alternativas consideradas
- **PostHog/Plausible**: descartada pelo usuário — mantém tudo dentro
  do próprio Supabase, sem conta externa nem mais um serviço pra
  autenticar e manter.
- **Rastreamento exaustivo (todo clique, tempo por tela)**: descartada
  pelo usuário — mais volume pra revisar, mais superfície de código
  pra manter, sem ganho claro sobre "página aberta + ação-chave" pro
  objetivo declarado (melhoria contínua de UX, não replay de sessão).
- **Instrumentar cada página individualmente para views**: descartada
  — `App.tsx` já centraliza toda navegação via `react-router`; repetir
  a mesma chamada em 13 arquivos seria puro código a mais pelo mesmo
  resultado.
- **Anotar cada catch de erro individualmente**: descartada pelo mesmo
  motivo — `api.ts#request` já é o único ponto por onde todo erro de
  API passa.

## Consequências
- Nenhuma tela de revisão foi construída nesta rodada — o pedido foi
  "adiciona logs", não um dashboard. Consulta por enquanto é via SQL
  direto (`supabase db query --linked "select feature, kind, count(*)
  from usage_events group by feature, kind"`) ou o SQL Editor do
  próprio Supabase. Uma tela de revisão fica como próximo passo natural
  se o usuário pedir.
- `detail` (jsonb) é deliberadamente livre — cada novo callsite decide
  o que faz sentido guardar, mas nenhum já escrito guarda conteúdo
  financeiro (descrição de lançamento, valor exato) — só o nome do
  evento e contadores/IDs.
- Ações-chave cobrem só 7 das 13 features — as que fazem sentido como
  "uma ação que conclui a tarefa" (criar/aprovar/registrar algo).
  Páginas majoritariamente de leitura (Dashboard, DRE, Diário, Saúde
  financeira, Motor financeiro, Configurações) ficam só com o evento de
  `view`, por decisão, não por lacuna — não há uma "ação-chave" clara
  ali além de abrir a tela.
