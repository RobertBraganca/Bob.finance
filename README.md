# Finanças — BEEKOFF®

App de gestão financeira pessoal e do negócio. Local-first: roda na sua máquina,
os dados ficam num único arquivo SQLite e nada sai para a nuvem.

O ledger (`transactions` e tudo que a área de importação/categorização produz)
é o motor. O que o usuário efetivamente lê é a camada por cima: Saúde
financeira, Motor financeiro, Investimentos e Precificação de projetos leem o
mesmo dado e devolvem só três tipos de resposta — Observação (fato já
ocorrido, ex. Health Score de hoje), Projeção (cenário no ritmo atual, ex.
Runway) ou Simulação (consequência de uma ação hipotética, ex. Simulador de
decisões). Uma quarta categoria, Recomendação, fica estruturalmente fora do
produto (`docs/decisions/0010`) — o app mostra a distância até cada meta
configurada, a decisão continua sempre do usuário.

```bash
npm install
npm run dev
```

Abre em <http://localhost:5173>. A API sobe em `127.0.0.1:3001`, migra e semeia o
banco no boot — não há passo de configuração.

Para explorar com dados realistas antes de importar extratos de verdade:

```bash
npm run demo
```

E para limpar tudo antes de usar com dados reais:

```bash
npm run db:reset
```

### Backup e recuperação

Um snapshot do banco é criado **automaticamente antes de toda migração de
schema** — não a cada boot, só quando o journal de migração muda de fato. Fora
isso, sob demanda:

```bash
npm run db:backup -- "antes de importar 2026"
```

Para listar e restaurar (a listagem é o comportamento sem argumento):

```bash
npm run db:restore
npm run db:restore -- 3 --yes
```

Sem `--yes` o comando mostra o que faria e sai sem tocar em nada. Restaurar
sempre salva o estado atual como um backup novo antes de sobrescrever, mesmo
que a restauração seja um engano. Depois de restaurar, reinicie o `npm run dev`:
o processo mantém um handle aberto do arquivo antigo.

Os snapshots ficam em `data/backups/`, indexados por `manifest.json` — um
arquivo, deliberadamente fora do banco que ele protege, porque recuperar de um
banco corrompido não pode depender de abrir esse mesmo banco. Limpeza é sempre
manual e nunca remove um backup manual:

```bash
npm run db:backup:prune -- --keep 5 --yes
```

Também há uma seção "Backups" em Contas e bancos, com a mesma lista e um botão
de restaurar que abre confirmação explícita. Ver `docs/specs/backup-and-recovery`
e `docs/decisions/0014`.

---

## Importando os extratos reais

A base atual foi carregada da pasta `CSV/CSV BANCOS`, organizada por banco e ano:

```bash
npm run db:reset
npm run import:real -- "D:/BEEKOFF®/02. Clientes/01. O BOB®/2026/CSV/CSV BANCOS"
npm run regras:locais
```

O `import:real` percorre a árvore, roteia cada arquivo para o perfil e a conta
certos e passa tudo pelo pipeline normal, então a deduplicação vale para o
conjunto inteiro. Ele importa em ordem alfabética de propósito: quando dois
extratos se sobrepõem, o mais antigo estabelece o lançamento e o mais novo entra
como duplicata marcada.

O `regras:locais` aplica `data/regras-locais.json` — as regras de clientes e
contrapartes desta pessoa, separadas do seed genérico. Esse arquivo é para editar:
a seção `revisar` lista as contrapartes recorrentes que o app não tem como
classificar sozinho, com a evidência de cada uma.

### PicPay é um caso especial

O PicPay não exporta tabela: exporta um relatório paginado em formato de PDF onde
cada transação ocupa três linhas (data, descrição + valor em largura fixa, hora),
intercaladas com 188 repetições de cabeçalho e rodapé. Isso não cabe num perfil de
parser e não deveria virar um `if` dentro do pipeline, então é normalizado antes:

```bash
npm run picpay:normalize -- entrada.csv saida.csv
```

O horário vai para a descrição de propósito: 30 dos 1.501 registros têm data,
descrição e valor idênticos a outro registro, e sem o horário a impressão digital
de deduplicação juntaria transações genuinamente distintas.

### Detecção com preâmbulo

O extrato do Inter começa com cinco linhas de cabeçalho de relatório antes da linha
de colunas. A detecção varre as primeiras 15 linhas em busca da que casa com a
assinatura de algum perfil e devolve `suggestedSkipRows` — sem isso, todo arquivo
do Inter apareceria como "banco não reconhecido" na tela de importação.

---

## Como está montado

```
server/src
  db/         schema (Drizzle), migrações, seed idempotente, reset, backup/restore
  core/       dinheiro em centavos, datas ISO, normalização e hash de dedupe
  csv/        perfis de banco, parser genérico, detecção por cabeçalho
  categorize/ motor de regras + memória de correções
  services/   toda a lógica de negócio e as agregações SQL
  routes/     Fastify, validação com Zod: ledger (contas, import, lançamentos),
              insights (tudo derivado), pricing, backups
shared
  transformação pura que o front e o harness de verificação usam igual, sem
  React e sem banco (hoje: o grafo de duas colunas do Sankey de fluxo entre
  contas). Alias `@shared/*`
src
  lib/        tokens de gráfico, formatação pt-BR, cliente HTTP, estado de filtro
  components/ primitivos de UI, gráficos, shell
  pages/      as telas do produto (ver docs/PRD.md, seção 5)
scripts
  make-fixtures.ts   gera extratos sintéticos dos 6 bancos
  verify.ts          harness de verificação ponta a ponta (contagem em "Verificação")
  verify-backup.ts   verificação da camada de backup, banco e diretório próprios
  backup.ts          snapshot manual sob demanda
  restore.ts         lista os snapshots e restaura um, com confirmação explícita
  backup-prune.ts    limpeza manual, preservando todo backup manual
  check-contrast.mjs valida contraste dos tokens de texto
  demo.ts            carrega dados de demonstração
```

### Decisões que sustentam o resto

**`transactions` é a única fonte de verdade.** Todo painel — visão geral, diário,
metas, dívida — é uma agregação SQL sobre essa tabela. Não existe tabela de
relatório, rollup em cache nem cópia de lançamento em outro lugar. É por isso que
nenhuma tela discorda de outra.

**Um banco novo é uma linha, não um `if`.** Delimitador, codificação, formato de
data, separadores, convenção de sinal, mapa de colunas, assinatura de cabeçalho e
padrões a ignorar ficam em `parser_profiles`. O pipeline de importação lê o perfil
e nunca ramifica por banco. As quatro convenções de sinal cobertas:

| Convenção | Quando | Exemplo |
|---|---|---|
| `signed` | uma coluna de valor, `−` é saída | Itaú, Inter, Nubank conta |
| `signed_inverted` | fatura de cartão: positivo é compra | Nubank cartão |
| `debit_credit` | colunas separadas | Bradesco |
| `type_flag` | valor absoluto + coluna D/C | Santander |

**Nada entra no ledger sem revisão.** Arquivo → *staging* → tela de revisão →
commit. Linhas que o banco exportou fora do padrão ficam visíveis com o erro, em
vez de serem descartadas em silêncio.

**Dedupe por impressão digital.** `conta + data + valor + descrição normalizada`.
Detecta repetição dentro do arquivo e contra o que já existe. Reimportar o mesmo
extrato marca tudo e grava zero.

**Transferência não é despesa.** Movimentação entre contas próprias e pagamento de
fatura de cartão são `kind: transfer` e ficam fora dos dois lados do cálculo.
Contar a fatura como gasto duplicaria cada compra do cartão — uma vez quando ela
posta, outra quando a fatura é paga.

**Categorização determinística primeiro, aprendizado depois.** Regras ordenadas
por prioridade decidem; a primeira que casa ganha. Correções manuais alimentam uma
tabela de frequência por comerciante e, na terceira confirmação, viram regra. A
prioridade reflete intenção do usuário:

| Prioridade | Origem |
|---|---|
| 20 | regra que você mandou salvar explicitamente |
| 50 | promovida de correções repetidas |
| 80+ | padrões genéricos do seed |

Uma correção aprendida precisa vencer o genérico, senão corrigir "Mercado Livre"
perderia para sempre para a regra ampla "mercado" e o aprendizado não teria efeito
observável.

**Dinheiro é sempre inteiro em centavos.** Nenhum valor monetário existe como
float em nenhum ponto do sistema.

**Posições de investimento são derivadas.** Quantidade e preço médio saem dos
lançamentos de aporte, nunca de um saldo guardado — corrigir um aporte antigo
corrige a carteira inteira. Sem cotação registrada, o custo médio é usado como
referência, e a tela diz isso.

**Evidenciar, nunca prescrever.** O app calcula, contextualiza e projeta a
partir de parâmetros que o usuário definiu; ele nunca diz qual decisão tomar.
Toda métrica derivada é Observação, Projeção ou Simulação, e nunca uma quarta
categoria de Recomendação. Na prática isso é uma regra de contrato, não de
copy: cada endpoint da camada de inteligência devolve um objeto `assumptions`
com a fórmula em palavras e cada termo usado, e a tela mostra isso num
"como calculamos" ao lado do número. Linguagem instrumental sem memória de
cálculo auditável não cumpre o princípio.

Para investimentos a linha é mais estreita ainda: o app evidencia o desvio
entre a carteira e a política de alocação que o próprio usuário configurou, mas
nunca recomenda ativo, classe ou operação — nem por texto, nem por um campo no
JSON, nem por ordenar uma lista por "urgência" calculada. É por isso que a
cascata de aporte só direciona dinheiro novo e nenhuma tela sugere vender. Ver
`docs/decisions/0010` (e `0011` para o caso específico do rebalanceamento).

**Nenhuma migração roda sem rede de segurança.** Um arquivo SQLite único como
fonte de verdade só é seguro se existir caminho de volta: todo ajuste de schema
dispara um snapshot versionado antes de aplicar, e restaurar nunca sobrescreve
o estado atual sem salvá-lo primeiro. Ver "Backup e recuperação" acima.

---

## Design

Casca clara em papel quente para tudo — navegação, tabelas, formulários e os
cards de KPI/medidor/heatmap (`.slab`) que antes eram de tinta quase preta.
Essa direção híbrida (cartões escuros mesmo no modo claro) foi a escolha
original de 19/08/2026 e foi revertida em 25/08/2026 a pedido direto do
usuário: `.slab` hoje renderiza igual a `.card` no modo claro. O tema escuro
(alternável, não é o padrão) continua usando a mesma paleta quase preta de
sempre em todo o app, `.slab` incluído — a reversão foi só do modo claro.

As cores vêm da identidade visual da BOB.OS (`BOB.OS Design System/tokens/colors.css`):
vermelho `#FF0000` para ações e foco, amarelo `#FFC700`/vermelho/verde `#32D74B` para
status, e azul `#007BFF`/rosa `#FF2EA6`/verde/roxo `#BA2BE2` como categórico — as 4
cores que a marca reserva para identidade, fora do que já é status.

As cores de série **não** são escolha estética. Cada uma foi revalidada contra as
duas superfícies reais do app (`#ffffff` e `#080808`): faixa de luminosidade, piso
de croma, separação para daltonismo em pares adjacentes, piso de visão normal e
contraste. O verde da marca (`#32D74B`) é claro demais para o papel branco
(1,9:1) — nesse caso o papel usa um passo mais escuro do mesmo tom (`#1E8E3C`) e o
cartão de tinta usa a cor da marca sem alteração, porque é ali que ela foi desenhada
para ficar (o produto da BOB.OS abre no tema escuro por padrão). Azul, rosa e roxo
passam sem nenhum ajuste nas duas superfícies. Antes de alterar qualquer
`--series-*` ou `--status-*`, rode o validador da paleta e o contraste dos tokens
de texto:

```bash
node scripts/check-contrast.mjs
```

Regras que os gráficos seguem sem exceção:

- **Nunca dois eixos Y.** Duas medidas de escalas diferentes viram dois gráficos.
- Entradas x saídas usa azul/rosa (identidade), não verde/vermelho — verde e
  vermelho são cores reservadas de status e o pior par possível para daltonismo.
- Legenda sempre presente com duas ou mais séries; série única não ganha caixa de
  legenda, porque o título já diz o que está plotado.
- Rótulo direto é seletivo: o ponto final, o extremo, a série que é a história.
  Nunca um número em cada ponto.
- Todo gráfico tem uma **tabela gêmea**. Tooltip enriquece, nunca é o único caminho
  para um valor.
- Rosca no máximo com **4 fatias** — a marca só reserva 4 cores fora do status; a
  cauda vira "Outras". Uma quinta cor categórica quebraria a garantia de
  daltonismo.
- Grade e eixos são fio de cabelo sólido — tracejado lê como "projeção".
- Status nunca é só cor: sempre ícone + rótulo.
- Todo gráfico tem estado vazio desenhado, não um eixo vazio.
- **Eixo em zero é regra de barra e área, não de índice.** Onde a marca codifica
  magnitude, o comprimento tem que ser proporcional ao valor e o eixo começa em
  zero. Num gráfico de índice (base 100), zero não é alcançável e ancorar ali
  desperdiça a altura: o comparativo de rentabilidade usava 76% do plot com
  espaço vazio e as oito séries espremidas numa faixa fina. Lá o eixo abraça os
  dados, sempre inclui 100, e uma linha de referência tracejada em "base 100"
  declara o corte em vez de escondê-lo.
- **Sinal muda de lado, não só de cor.** Onde um valor pode ser negativo e faz
  parte de uma pilha (ganho x perda de capital por mês), a barra usa
  `stackOffset="sign"`: o que é perda desce abaixo da linha do zero em vez de
  ser abatido silenciosamente dentro da pilha.
- **Uma marca por linha, não atravessando o gráfico.** Uma referência que
  descreve uma categoria (a meta daquela classe de ativo) é desenhada dentro da
  faixa daquela linha. Uma `ReferenceLine` de altura total com sete classes vira
  sete linhas cruzando todas as barras, sem dizer qual pertence a qual.

Tipografia: **Barlow Condensed** (BOB.OS) nos numerais grandes e nos títulos de
tela, **Inter** no resto, **JetBrains Mono** em valor técnico que precisa alinhar
em coluna. A troca de Space Grotesk para Barlow Condensed veio do mesmo
alinhamento de paleta com a BOB.OS Design System — ver `src/styles/tokens.css`
para a fonte de verdade dos tokens. Figuras proporcionais nos números grandes;
`tabular-nums` só em colunas que precisam alinhar.

---

## Verificação

```bash
npm run verify      # 546 checks ponta a ponta + 37 de backup, banco descartável
npm run typecheck
```

O harness roda contra `data/verify.db`, nunca contra o banco de trabalho. Cobre,
por módulo:

1. **Importação** — detecção dos 6 perfis pelo cabeçalho, as 4 convenções de sinal,
   datas e valores normalizados, linhas de saldo ignoradas, duplicata dentro do
   arquivo, linha malformada preservada com erro e não gravada, reimportação
   marcando tudo como duplicata e gravando zero.
2. **Categorização** — regra disparando em 100% das linhas de um comerciante,
   cobertura ≥ 60%, correção manual persistida na memória, promoção a regra na
   terceira confirmação, regra aprendida vencendo a genérica, atribuição manual
   preservada em recategorização em massa.
3. **Painel** — estado vazio devolvendo zeros (não nulos), reconciliação entre
   série mensal e totais, quebra por categoria somando o total de saídas,
   participações somando 100%, saldos derivados batendo com a soma do ledger, a
   guarda de dupla contagem do pagamento de fatura, reajuste de saldo mudando
   `accountBalances()` exatamente pela diferença informada (nenhuma rota aceita
   mais `currentBalanceCents`), e o filtro `categoryKind` pegando transferência
   nos dois sentidos sem depender de `direction`.
4. **Diário** — heatmap com todos os dias do mês, soma diária batendo com o total,
   lançamento rápido gravado com `source=daily` e aparecendo no dia.
5. **Metas** — sem meta é `no_target` e não zero, teto folgado x estourado, teto em
   categoria-mãe somando as filhas, sugestões pelo histórico, cópia entre meses sem
   reescrever o mês de origem, sequência contando só meses fechados.
6. **Dívida** — taxa média ponderada pelo saldo (diferente da simples), composição
   somando 100%, cenário acelerado quitando antes e com menos juros, avalanche
   atacando a maior taxa primeiro, saldo medido sobrepondo o principal, pagamento
   abaixo dos juros reportado como "nunca quita" em vez de linha reta, e uma
   parcela editada manualmente (`manuallyEdited`) sobrevivendo intacta a uma
   edição do template — só as parcelas nunca tocadas continuam sincronizando.
7. **Investimentos** — posição derivada de aportes, taxas no custo, valor de mercado
   caindo para custo médio sem cotação, venda devolvendo capital, alocação x meta com
   ajustes que se cancelam, e o aporte necessário atingindo a meta na data (erro < 1%).
8. **Diagrama do Cerrado** — nota de resistência somando +1/-1 por critério respondido
   e nunca penalizando o que ainda não foi respondido, cascata de aporte priorizando a
   classe mais atrasada e depois o ativo mais atrasado dentro dela, rodízio por setor
   em vez de concentrar tudo no maior nota, sugestão sempre em cotas inteiras, e o 4º
   nível (depois que todo gap fecha, a sobra se distribui por peso-alvo em vez de
   ficar presa em `unallocatedCents`).
9. **Saúde financeira** — Health Score como média ponderada dos 5 indicadores com
   redistribuição de peso quando falta dado, runway zerando em vez de dividir por zero
   sem despesa, e radar de risco não avaliando regra sem dado suficiente.
10. **Motor financeiro** — disponível para alocação batendo saldo menos compromissos
    menos fatura menos já destinado, e ponto de equilíbrio somando cada linha da
    composição até o total.
11. **Desvio de alocação** — percentual atual e meta lidos da mesma posição derivada
    usada no resto do spec de investimentos, sem campo de ação sugerida no contrato.
12. **Fluxo entre contas** — pareamento de pernas de transferência por valor e data
    virando duas arestas do Sankey (uma por direção), soma das arestas batendo o total
    pareado do resumo textual, e perna sem par nunca inventando um nó.
13. **Precificação de projetos** — hora base derivada do ponto de equilíbrio já
    calculado no motor financeiro (nunca um segundo cálculo), preço mínimo nunca
    reescrito pelos multiplicadores de contexto, gross-up usando a mesma alíquota
    do motor, cotação salva congelando o número mesmo se a configuração mudar depois,
    e aprovar uma cotação criando exatamente um lançamento de receita (aprovar duas
    vezes falha com erro claro, nunca duplica).
14. **Simulador de decisões** — o "depois" de cada hipótese conferido contra a
    conta feita à mão com os mesmos insumos (para provar que o delta ligou no
    indicador certo), juro economizado numa quitação igual ao que a projeção de
    dívida já publica, e a contagem de linhas de `transactions`, `debt_payments`
    e `asset_trades` idêntica antes e depois de simular — que é como se verifica
    "nunca grava" em vez de assumir.

Além disso, `scripts/verify-backup.ts` (37 checks, encadeado no mesmo `npm run
verify`) cobre a camada de backup e recuperação num banco e diretório próprios:
versão sequencial nunca reutilizada mesmo depois de um prune, snapshot automático
só quando há migração pendente (não um por boot do servidor), restauração sempre
gerando um `pre-restore` do estado atual primeiro, e nenhuma ação de prune/restore
sem confirmação explícita.

---

## Notas

- O bundle fica em ~1,0 MB (277 kB gzip), dominado por Recharts. Aceitável para
  app local; se incomodar, `React.lazy` por rota resolve.
- Multiconta já está no schema e nas queries (filtro de conta no topo), mesmo com a
  v1 sendo de um usuário só.
- O schema é relacional e agnóstico: migrar para Postgres é trocar o driver do
  Drizzle, sem mexer nas agregações.
- `FINANCE_DB` aponta o arquivo do banco; `FINANCE_API_PORT` a porta da API
  (deliberadamente não `PORT`, que ferramentas de dev usam para o servidor web).
