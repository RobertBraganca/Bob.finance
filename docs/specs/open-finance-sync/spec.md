# Spec: Sincronização via Open Finance

Status: proposto — desenho para implementação futura, não iniciado. Custo
recorrente de agregador terceiro (ver "Custo e viabilidade") é o único
motivo do adiamento; nada aqui é bloqueado tecnicamente. Escrito em
28/08/2026 durante uma revisão geral do projeto, para existir uma
arquitetura-alvo pronta quando o orçamento permitir, em vez de começar do
zero.

## Objetivo
Eliminar a necessidade de baixar extrato de cada banco manualmente e
subir como CSV — hoje a única porta de entrada de dado (`docs/PRD.md` §2,
§3) — sem duplicar a lógica de revisão, dedupe e categorização que já
existe e funciona para o CSV.

## Histórias de usuário
- Como usuário, eu quero conectar uma conta a um provedor de Open Finance
  uma vez e ter o extrato sincronizado automaticamente depois, sem baixar
  e subir arquivo toda vez.
- Como usuário, eu quero poder manter algumas contas em importação manual
  por CSV (ex. um banco sem suporte do agregador) enquanto outras já
  sincronizam sozinhas — não é tudo ou nada.
- Como usuário, eu quero que uma sincronização automática passe pela mesma
  revisão/staging de qualquer importação — nada entra direto no ledger sem
  eu conferir, exatamente como hoje.
- Como usuário, eu quero ver quando cada conta sincronizou pela última vez,
  e poder forçar uma sincronização manual se desconfiar que algo está
  desatualizado.
- Como usuário, eu quero que, se o consentimento expirar ou a conexão
  cair, o sistema me avise claramente e me deixe voltar a importar aquele
  banco por CSV sem fricção, em vez de silenciosamente parar de atualizar.

## Modelo de dados
Duas tabelas novas, sem alterar `transactions`/`stagedTransactions`:

- `bankConnections` — uma linha por conta conectada a um provedor:
  `accountId` (FK `accounts`), `provider` (ex. `'pluggy'`, `'belvo'`),
  `providerItemId` (identificador do provedor para essa conexão),
  `consentExpiresAt`, `status` (`'active' | 'expired' | 'error' |
  'disconnected'`), `lastSyncedAt`, `lastError` (texto, nullable).
- `bankConnectionEvents` — log append-only de cada tentativa de sync
  (sucesso/erro, quantidade de transações recebidas, timestamp) — dá
  rastreabilidade sem inflar `bankConnections` com histórico.

`stagedTransactions` ganha um valor novo em sua coluna de origem
(`'open_finance'`, ao lado de `'csv'` já existente) — a tabela em si não
muda de forma, só a proveniência. Isso é deliberado: a sincronização é só
mais um produtor de linhas em staging, reusando 100% do pipeline de
revisão → categorização → commit que a importação de CSV já tem
(`docs/specs/import-and-categorization/spec.md`), em vez de um fluxo de
revisão paralelo.

## Contrato de API (rascunho)
| Rota | Método | Observação |
|---|---|---|
| `/bank-connections` | GET | Lista conexões por conta, status, última sincronização |
| `/bank-connections` | POST | Inicia o fluxo de consentimento do agregador para uma conta (retorna URL/token de conexão do provedor) |
| `/bank-connections/:id/sync` | POST | Força uma sincronização manual fora do agendamento |
| `/bank-connections/:id` | DELETE | Desconecta; conta volta a aceitar CSV manual |
| `/bank-connections/webhook` | POST | Recebido do agregador (nova transação disponível, consentimento expirado) — autenticado por assinatura do provedor, nunca pela anon key |

Sincronização periódica (polling, não só webhook) roda como um job
agendado — mecanismo concreto (`pg_cron` via Supabase, ou uma Edge
Function com invocação programada) é decisão de implementação, não deste
spec.

## Regras de negócio
- **Sync nunca commita direto no ledger.** Toda transação recebida do
  agregador vira uma linha em `stagedTransactions`, passa pela mesma
  detecção de duplicata e sugestão de categoria que uma linha de CSV
  passaria, e só vira `transactions` no commit explícito do usuário — ver
  princípio "nada entra sem revisão" (`docs/PRD.md` §4). Isto não é uma
  exceção nova, é o mesmo pipeline.
- **Conta com conexão ativa não aceita CSV manual do mesmo período por
  padrão** (evita duplicar o mesmo extrato por dois caminhos), mas o
  usuário pode forçar um upload manual explicitamente se desconfiar de uma
  lacuna — a extensão de `parserProfiles`/dedupe por `signature-hash`
  já existente cobre esse caso sem mudança de schema.
- **Consentimento expirado degrada para manual, nunca falha em silêncio.**
  `status: 'expired'` bloqueia novo sync automático e a conta some da
  lista de "sincronizadas automaticamente" na tela de Contas — mas
  continua aceitando CSV normalmente, sem estado intermediário quebrado.
  Ecoa a lição do achado de auditoria de 28/08/2026 sobre a tela de
  Backup: uma falha de integração nunca deve se disfarçar de "nenhum dado
  novo".
- **Cada evento de sync malsucedido é visível**, não só logado
  internamente — `bankConnectionEvents.lastError` aparece na tela de
  Contas para a conexão específica, não como um erro genérico de app.

## UI
Nova seção em `Settings.tsx` (mesma tela de "Contas e bancos"), ao lado dos
perfis de CSV já existentes: por conta, um botão "Conectar via Open
Finance" (abre o fluxo do agregador) ou, se já conectada, status + última
sincronização + botão "Sincronizar agora" + botão "Desconectar". A tela de
Importação (`Import.tsx`) permanece inalterada — ela já revisa
`stagedTransactions` sem saber se a origem foi CSV ou sync automático, o
que é o ponto principal deste desenho.

## Casos de borda
- Provedor não cobre o banco de uma conta específica: essa conta
  simplesmente nunca aparece com opção de conectar, continua só CSV — sem
  necessidade de uma lista de bancos suportados mantida à mão neste app,
  o agregador já expõe isso na própria tela de conexão dele.
- Sync automático encontra uma transação que também acabou de ser
  importada manualmente por CSV no mesmo período: resolvido pelo mesmo
  dedupe por assinatura (banco + data + valor + descrição normalizada) que
  já existe entre importações de CSV diferentes.
- Rate limit do agregador: cada `bankConnectionEvents` malsucedido por
  rate limit marca `status` como `'error'` com `lastError` explicando, sem
  derrubar outras conexões — um provedor lento não trava contas de outro
  banco.

## Fora de escopo (nesta primeira versão, quando for implementada)
- Webhook em tempo real como único mecanismo — v1 é polling agendado;
  webhook complementa, não substitui, para não depender de uma
  infraestrutura de recebimento sempre disponível desde o primeiro dia.
- Suporte a mais de um agregador simultâneo — escolher um provedor (ver
  custo abaixo) e integrar só esse primeiro; multi-agregador é uma
  evolução, não o v1.
- Qualquer modelo multi-usuário — este spec assume o mesmo usuário único
  de hoje; abrir para mais pessoas exigiria também o redesenho de
  autorização já apontado como dívida técnica na revisão de 28/08/2026
  (`docs/project-memory.md`).

## Custo e viabilidade (motivo do adiamento)
Isto não é uma limitação técnica — é a razão registrada de por que este
spec existe sem código ainda:

- Open Finance Brasil exige certificação de instituição participante;
  inviável para um app de uma pessoa se conectar direto ao ecossistema.
  A rota realista é um agregador que já tem essa certificação e expõe uma
  API própria por cima — ex. Pluggy, Belvo, Quanto (não avaliados a fundo
  aqui, citados como categoria de solução, não uma escolha já feita).
- Esses agregadores cobram recorrente, tipicamente por conexão ativa/mês
  — um custo operacional contínuo, diferente de todo o resto do stack
  deste projeto (Supabase, Vercel, BRAPI) que ou é de graça ou de custo
  já assumido.
- Antes de implementar: escolher o provedor (comparar cobertura de bancos
  PF/PJ que a persona usa, preço por conexão, e se o modelo de
  consentimento deles é compatível com o fluxo de UI acima) é o primeiro
  passo real, não escrever código.

## Desvios da implementação
N/A — nada foi implementado ainda.
