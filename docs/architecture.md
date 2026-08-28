# Arquitetura

## Stack

| Camada | Tecnologia | Por quê |
|---|---|---|
| Banco | SQLite (`better-sqlite3`) | Local-first: um arquivo, zero serviço externo. Ver [decisions/0001](decisions/0001-local-first-sqlite.md) |
| ORM / migrações | Drizzle ORM + drizzle-kit | Schema tipado em TS, migração gerada e revisada antes de aplicar |
| API | Fastify | Baixa sobrecarga, validação de schema nativa, TypeScript de primeira classe |
| Validação | Zod | Todo body/query de rota é `.parse()`d; erro de validação vira 400, não exceção não tratada |
| Frontend | React 19 + Vite | SPA simples, sem SSR — não há por que, é um app local de uma pessoa |
| Roteamento | react-router-dom | Rotas por página, sem nesting profundo |
| Estado de servidor | TanStack Query | Cache, invalidação e `placeholderData` para transição sem "flash" de loading |
| Gráficos | Recharts | Suporte nativo a eixo duplo proibido por regra de produto, tooltip + tabela gêmea |
| CSV | papaparse | Parser de CSV tolerante a variação de banco |
| Cotações | BRAPI (brapi.dev) | Único provedor gratuito de cotação B3 sem exigir corretora própria; plano free = 1 ticker/requisição, ver [decisions/0006](decisions/0006-brapi-sequential-quote-refresh.md) |

Todo o frontend e o backend vivem num único `package.json` (não é monorepo com
múltiplos workspaces) — o projeto é pequeno demais para pagar a complexidade
de orquestrar dois pacotes.

## Camadas (server/src)

```
db/         schema (Drizzle), migrações versionadas, seed idempotente, reset
core/       primitivas puras: dinheiro em centavos, datas ISO, normalização e hash de dedupe
csv/        perfis de banco (dados, não código), parser genérico, detecção por cabeçalho
categorize/ motor de regras por prioridade + memória de correções manuais
services/   toda a lógica de negócio e as agregações SQL — não há lógica de negócio em routes/
routes/     Fastify: `ledger.ts` (contas, import, categorias, lançamentos),
            `insights.ts` (tudo analítico/derivado), `pricing.ts`, `backups.ts`
            e `simulate.ts` (o único que só lê e nunca grava, por decisão)
```

Regra de dependência: `routes` chama `services`, `services` chama `db` e
`core`, nunca o inverso. Uma rota nunca monta SQL própria — se uma agregação
não existe ainda em `services/`, ela é criada lá primeiro.

## Camadas (src)

```
lib/        cliente HTTP (`api.ts`), formatação pt-BR (`format.ts`), tokens de gráfico
            (`chartTheme.ts`), estado de filtro global (`store.tsx` — período, conta),
            tema claro/escuro (`theme.tsx` — todo gráfico no escuro reusa a paleta "slab"
            já validada, nunca uma terceira paleta nova, ver `decisions/0009`)
components/ primitivos de UI (`ui/` — inclui `PeriodPickerPopover`, o seletor de
            período único do app), gráficos (`charts/`), shell (nav, PageHeader, RangeFilter)
pages/      uma pasta por área de produto (ver PRD seção 5), cada uma consumindo
            `services/` do servidor por HTTP, nunca acessando o banco diretamente
```

## Camada compartilhada (shared)

`shared/` guarda transformação pura que mais de um lado precisa, sem React,
sem Drizzle e sem acesso a rede. Hoje contém `accountFlowGraph.ts`, que monta
o grafo de duas colunas do Sankey de fluxo entre contas. Ela mora aqui porque
`scripts/verify.ts` verifica as invariantes desse grafo (acíclico, soma igual
ao total pareado, perna sem par fora) sem renderizar nada. O alias `@shared/*`
está nos dois `tsconfig` e no `vite.config.ts`. Regra: se a lógica precisa de
React ou de banco, ela não pertence aqui.

## Modelo de dados

32 tabelas em `server/src/db/schema.ts`, agrupadas por área:

- **Ledger:** `accounts`, `parserProfiles`, `importBatches`, `stagedTransactions`,
  `transactions` (a única fonte de verdade — todo dashboard é uma agregação
  sobre ela). `occurrencePeriod` fixa qual ocorrência de um `cashFlowForecast`
  ou `debt` uma linha materializada preenche, independente da `postedOn`
  editável pelo usuário — ver `specs/cash-flow-reconciliation`.
- **Categorização:** `categories` (árvore, um nível de aninhamento),
  `categoryRules` (prioridade + padrão), `categoryMemory` (frequência de
  correção manual por assinatura de comerciante).
- **Dívida:** `debts` (`accountId` opcional liga a dívida a uma conta para
  materializar parcela pendente), `debtSnapshots` (saldo medido, sobrepõe o
  principal de abertura), `debtPayments` (parcela paga vs. novo uso de
  limite/saque — também gravado automaticamente ao confirmar/marcar como
  paga uma pendência ligada à dívida).
- **Cartões:** `creditCards`, `creditCardSnapshots` (limite disponível medido
  ao longo do tempo).
- **Metas do mês:** `monthlyGoals`, `categoryCaps`.
- **Investimentos:** `assets`, `assetTrades` (compra/venda/provento —
  posição é sempre derivada disto), `assetValuations` (marcação a mercado),
  `investmentGoals`, `targetAllocations` (meta por classe), `criteria` +
  `assetCriteriaAnswers` ("Diagrama do Cerrado"), `emergencyReserveSettings`,
  `benchmarkReturns` (retorno mensal de CDI/IPCA/índices para a aba
  "Rentabilidade", ver `specs/investments`).
- **Inteligência financeira:** `financialHealthSettings` e
  `financialEngineSettings`, duas linhas singleton (id sempre 1), mais
  `pricingSettings`, `pricingMultiplierOptions` e `projectQuotes`
  (`specs/project-pricing`, capacidade produtiva e histórico de simulação
  de preço). Guardam exclusivamente escolha do usuário (pesos, limites,
  alíquota, margem, contas PJ/PF, capacidade horária), nunca um resultado de
  cálculo do ledger — a única exceção é `projectQuotes`, que congela o
  resultado de uma simulação específica no momento em que ela foi salva,
  para uma cotação já enviada a um cliente não mudar de valor depois. Health
  Score, runway, radar, disponível e ponto de equilíbrio continuam
  derivados a cada leitura.
- **Fluxo de caixa:** `cashFlowForecasts` (template recorrente/parcelado que
  materializa linhas pendentes reais em `transactions`),
  `reconciliationDismissals` (pares sugeridos que o usuário descartou),
  `skippedOccurrences` (ocorrências de um forecast/dívida que o usuário
  excluiu explicitamente — sem isso a próxima materialização recriaria a
  mesma pendência).

Todo valor monetário é `integer` em centavos. Toda data é `text` em ISO
`YYYY-MM-DD` (ordena cronologicamente como string, sem parsing).

## Padrões que se repetem entre áreas

Estes padrões não são de uma feature só — reaparecem porque resolvem a mesma
tensão em contextos diferentes. Uma feature nova deveria reconhecer qual
destes se aplica antes de inventar um mecanismo novo.

### Derivação em vez de saldo guardado
Saldo de conta, posição de investimento (quantidade e preço médio), saldo de
dívida corrigido: nenhum destes é uma coluna que se escreve — todos são
`SELECT`s sobre o histórico de lançamentos/trades/snapshots. Corrigir um
lançamento antigo corrige automaticamente todo painel que depende dele,
porque não existe segunda cópia do número para dessincronizar. Quando o
número derivado diverge do real (o extrato mostra outro saldo), a correção
também é mais uma linha em `transactions` — nunca uma edição direta do
campo derivado. `PATCH /accounts/:id` não aceita mais `currentBalanceCents`
por esse motivo: ver [decisions/0018](decisions/0018-reajuste-de-saldo-substitui-edicao-direta.md).

### Materialização idempotente
`cashFlowForecasts` → `materialize()` gera linhas reais e pendentes em
`transactions` para um horizonte rolante (6 meses), verificando por
`forecastId` + período antes de inserir. O mesmo template nunca produz duas
linhas para o mesmo mês, mesmo chamado repetidamente. Editar o template
depois de materializar propaga para as ocorrências já geradas e ainda
pendentes — exceto qualquer ocorrência que o usuário já editou manualmente
(`transactions.manuallyEdited`, [decisions/0017](decisions/0017-materializacao-nao-sobrescreve-edicao-manual.md)):
sem essa exceção, editar o template de novo (por qualquer motivo, não só
para corrigir a data) apaga silenciosamente qualquer ajuste manual feito
numa ocorrência específica.

### Override de insumo em vez de segunda fórmula
Quando uma pergunta hipotética precisa do mesmo número com um insumo
diferente ("e se eu gastasse R$X?"), a função de produção ganha um
parâmetro de override com default vazio, e a hipótese chama a MESMA função.
`breakEven(period, overrides, { includeGoals })`,
`availableForAllocation(period, { consolidatedBalanceDeltaCents })` e
`runway(classes, { balanceDeltaCents, investmentsDeltaCents })` seguem esse
formato, e `gatherScoreInputs`/`composeScoreFromInputs` existem para o
Health Score poder ser recomposto com um indicador ajustado sem recalcular
os outros quatro. Uma segunda implementação da mesma fórmula divergiria da
real no primeiro ajuste que alguém fizesse só de um lado, e o número errado
seria justamente o hipotético, que ninguém confere contra o extrato. Ver
`decisions/0016`.

### Memória de cálculo viaja junto com o número
Um número derivado nunca sai sozinho: ele vem acompanhado dos insumos que o
produziram. Isso já acontecia de forma ad hoc (`debtOverview` devolve
`monthlyIncomeCents` ao lado do comprometimento, `reserveStatus` devolve
múltiplo e custo de vida ao lado da meta, `pace` devolve dias decorridos ao
lado do ritmo), e o ADR 0010 promoveu o hábito a contrato: na camada de
inteligência financeira, todo endpoint carrega um objeto `assumptions` com a
fórmula em palavras e cada termo usado. Chave em inglês como o resto da API,
valores em pt-BR porque são texto de tela. Um endpoint derivado novo deveria
nascer com esse campo, não ganhá-lo depois.

### Sugestão nunca é aplicação automática
Conciliação bancária (`reconciliationCandidates`), promoção de regra
aprendida (3 confirmações), detecção de banco no upload de CSV: todos
produzem uma sugestão com confiança, nunca gravam sozinhos. O usuário sempre
confirma com um clique explícito. Ver [decisions/0003](decisions/0003-unified-ledger-and-suggest-only-reconciliation.md).

### `kind` separa contabilidade de rótulo humano
Uma categoria tem um nome (para o usuário) e um `kind` — income / expense /
transfer / investment — que decide se ela entra nos totais e como. Isso
permite um rótulo como "Pró-labore" continuar legível para rastreamento
mesmo depois de sua contabilidade mudar de `income` para `transfer` (ver
[decisions/0004](decisions/0004-category-kind-vs-label-separation.md)). Ao
adicionar uma categoria nova, o `kind` importa mais que o nome.

### Perfil de banco é dado, não `if`
Delimitador, codificação, formato de data, convenção de sinal, mapa de
colunas, assinatura de cabeçalho: tudo isso é uma linha em `parser_profiles`.
Um banco novo é uma linha nova, nunca uma ramificação no pipeline de
importação.

### Nada destrutivo roda sem uma saída
"Sugestão nunca é aplicação automática" (acima) cobre gravação sobre o
ledger; o mesmo princípio se estende a operações de arquivo. Migração de
schema gera um snapshot versionado do banco antes de aplicar, e restaurar
um snapshot antigo sempre salva o estado atual primeiro, mesmo que o
usuário tenha certeza que quer descartá-lo — ver
[decisions/0014](decisions/0014-snapshot-versionado-antes-de-toda-migracao.md)
e `specs/backup-and-recovery`. O índice desses snapshots
(`data/backups/manifest.json`) vive deliberadamente fora do SQLite que ele
protege — a única exceção deste projeto à regra de "uma fonte de verdade",
porque a fonte de verdade é exatamente o que pode estar corrompido quando
o índice precisa ser lido.

## Contrato de API (visão por domínio)

Prefixo `/api` em tudo. Todo body e query passa por `.parse()` do Zod antes
de chegar num `service`.

| Domínio | Prefixo | Spec |
|---|---|---|
| Contas, import, categorias, regras, lançamentos | `/accounts`, `/import`, `/categories`, `/rules`, `/transactions` | [settings-accounts-profiles](specs/settings-accounts-profiles/spec.md), [import-and-categorization](specs/import-and-categorization/spec.md), [transactions-ledger](specs/transactions-ledger/spec.md) |
| Painel e analytics | `/dashboard`, `/analytics/*` | [dashboard](specs/dashboard/spec.md), [dre](specs/dre/spec.md) |
| Metas do mês | `/goals/*` | [monthly-goals](specs/monthly-goals/spec.md) |
| Dívida | `/debts/*` | [debt](specs/debt/spec.md) |
| Cartões | `/credit-cards/*` | [credit-cards](specs/credit-cards/spec.md) |
| Investimentos | `/investments/*`, `/criteria/*` | [investments](specs/investments/spec.md) |
| Fluxo de caixa pendente | `/cash-flow/*` | [cash-flow-reconciliation](specs/cash-flow-reconciliation/spec.md) |
| Backup e recuperação | `/backups/*` | [backup-and-recovery](specs/backup-and-recovery/spec.md) |
| Precificação de projetos | `/pricing/*` | [project-pricing](specs/project-pricing/spec.md) |
| Simulador de decisões | `/simulate/*` | [decision-simulator](specs/decision-simulator/spec.md) |
| Saúde financeira | `/financial-health/*` | [financial-health](specs/financial-health/spec.md) |
| Motor financeiro | `/financial-engine/*` | [motor-financeiro](specs/motor-financeiro/spec.md) |

As quatro últimas linhas usam caminho em inglês como todo o resto da API,
mesmo com a pasta do spec em pt-BR (`specs/motor-financeiro`).

## Verificação

`npm run verify` roda 546 checks ponta a ponta contra `data/verify.db` (nunca
o banco de trabalho), cobrindo cada área listada no PRD, e encadeia
`scripts/verify-backup.ts` (37 checks) na mesma chamada — separado porque
precisa do seu próprio banco e diretório de backup, escolhidos por variável
de ambiente na carga do módulo, então não cabe no mesmo processo do
`verify.ts` principal. `npm run typecheck` compila `server` e `src` sob
`tsconfig.build.json`/`tsconfig.json`. Uma feature nova deveria adicionar
seu próprio módulo de checks em `scripts/verify.ts` (ou um script de
verificação próprio, encadeado em `npm run verify`, se precisar de um banco
isolado como `verify-backup.ts`), não só depender de teste manual no
navegador.

## O que fica mais fácil / mais difícil com estas escolhas

- **Mais fácil:** adicionar uma área de produto nova (mais uma tabela, mais
  um `service`, mais uma rota, mais uma página) sem tocar nas existentes,
  porque nada é acoplado por estado compartilhado fora do banco.
- **Mais fácil:** confiar em qualquer número da tela, porque só existe um
  caminho até ele (a tabela `transactions` + agregação), nunca dois.
- **Mais difícil:** múltiplos usuários simultâneos — SQLite com
  `better-sqlite3` é single-writer; isso é aceitável hoje (uso de uma
  pessoa) e documentado como fora de escopo no PRD, não um acidente.
- **Mais difícil:** qualquer feature que dependa de dado que não veio do
  extrato do próprio usuário (ex. open finance) — o pipeline inteiro assume
  CSV revisado manualmente como única porta de entrada.
