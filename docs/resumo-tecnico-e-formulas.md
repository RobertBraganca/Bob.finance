# Resumo técnico — funcionamento, integrações e fórmulas

Status: vivo, como o PRD e o architecture.md. Este documento existe pra reunir
num lugar só o que hoje está espalhado por ~15 arquivos de serviço no
backend: toda fórmula matemática real por trás de cada número que o app
mostra, mais as integrações externas e o funcionamento geral. Não substitui
`PRD.md` (o quê e por quê do produto) nem `architecture.md` (stack e
decisões de infraestrutura) — é o terceiro ângulo: como cada número é
calculado, exatamente.

Convenção usada em todo o documento: `Cents` = inteiro em centavos (nunca
float); `Bps` = basis points, inteiro de 0 a 10.000 representando 0% a 100%
(ou além de 100% quando o valor pode estourar um teto).

## 1. Funcionamento geral

Um app de finanças pessoais e de negócio para uma única pessoa que
administra contas PF e PJ ao mesmo tempo. A regra estrutural que atravessa
todo o sistema: **`transactions` é a única fonte de verdade** — nenhum saldo,
posição de investimento ou saldo de dívida corrigido é armazenado como
número solto; tudo é recalculado do histórico de lançamentos a cada leitura
("derivar, nunca guardar", `PRD.md` §4). As únicas exceções documentadas e
deliberadas a essa regra são medições, não saldos: `debt_snapshots` (uma
MEDIÇÃO re-derivável do saldo de uma dívida, `architecture.md`) e o valor já
calculado de um orçamento aprovado (`project_quotes`, guardado porque
recalcular mudaria um preço já fechado com o cliente).

**Ciclo de vida de um lançamento**: nada entra direto no ledger. Toda
importação (CSV ou lançamento manual) passa por staging → revisão →
commit explícito. Uma vez commitado, o motor de categorização
(`services/categorization.ts`) tenta classificar automaticamente, na ordem:
regra explícita → memória aprendida → categoria bruta do banco → sem
categoria (nunca um chute). Ver seção 5.11.

**Confirmado vs. pendente**: toda tela que soma dinheiro (Painel, Metas,
Motor financeiro, DRE) filtra `pending = false` por padrão — uma previsão
de fluxo de caixa, parcela futura ou conciliação ainda não confirmada nunca
infla um resultado já fechado.

## 2. Arquitetura e stack (resumo — ver `architecture.md` para o detalhe)

- **Frontend**: React + TypeScript + Vite, deploy contínuo no Vercel.
- **Backend de desenvolvimento**: Fastify (Node), rodando local via
  `npm run dev`.
- **Backend de produção**: Supabase Edge Functions (Deno) — árvore espelhada
  de `server/src/**` para `supabase/functions/_shared/**`, mantida
  manualmente em sincronia (rotas hand-mirrored, serviços quase byte-a-byte
  idênticos, com pontos de divergência deliberados e comentados onde o
  pooler de transação do Supabase exige sequencial em vez de `Promise.all`
  — ver `goals.ts#goalHistory` e vizinhos).
- **Banco**: Postgres via Supabase (migrado de SQLite local, decisions/0026).
  Drizzle como ORM em ambas as árvores.
- **Autenticação**: Supabase Auth, usuário único (decisions/0033) — o app
  deixou de ser "sem login" depois dessa migração.
- **Dinheiro**: inteiro em centavos em toda camada, nunca float.

## 3. Integrações externas

Só quatro chamadas de rede saem do backend, todas de leitura (nenhuma grava
nada do usuário do lado de fora):

| Integração | Uso | Chave/consentimento | Limite conhecido |
|---|---|---|---|
| **BRAPI** (`brapi.dev`) | Cotação de ações/FIIs (`services/quotes.ts`) e proxy de ETF pros índices B3 no comparativo de rentabilidade (`services/benchmarks.ts`) | Token próprio do usuário (`BRAPI_TOKEN`), sob consentimento explícito | Plano free: 1 ticker por requisição (nunca em lote — laço sequencial, decisions/0006); só ~3 meses de histórico diário por chamada, então o histórico de índice via ETF nunca é reconstruído de uma vez, só acumula a cada atualização |
| **SGS / Banco Central** (`api.bcb.gov.br`) | Série CDI (código 4390) e IPCA (código 433) mensal, pro comparativo de rentabilidade (`services/benchmarks.ts`) | Nenhuma chave | Devolve o histórico completo já na primeira chamada (sem limite de janela, ao contrário do BRAPI) |
| **Supabase** | Banco Postgres, Auth, hospedagem das Edge Functions | Chave de serviço/projeto | — |
| **Vercel** | Deploy e hospedagem do frontend | — | — |
| **Pierre Finance** (Open Finance via MCP) | Avaliado nesta sessão pra puxar extrato automaticamente; **pausado** — a conta do plano free não libera os endpoints financeiros ("no active subscription") | Chave própria do usuário, configurada como variável de ambiente referenciada em `.mcp.json`, nunca commitada | Integração de exploração (MCP do Claude Code), não incorporada ao app ainda — ver `docs/specs/open-finance-sync/spec.md`, que já desenha a arquitetura-alvo (staging unificado, nunca commit direto) para quando isso avançar |

`refreshAllQuotes`/`refreshBenchmarks` nunca rodam sozinhos em segundo
plano — só sob clique explícito do usuário.

## 4. Fundamentos matemáticos compartilhados

Usados por praticamente toda fórmula das seções seguintes.

- **Classificação de fluxo** (income/expense/investment/transfer) — vem do
  `kind` da categoria do lançamento; só cai para o sinal do valor quando não
  há categoria: `flow = category.kind ?? (amountCents > 0 ? 'income' : 'expense')`.
- **Direção**: `directionOf(amountCents) = amountCents >= 0 ? 'in' : 'out'`.
- **Normalização de descrição**: remove acentos (NFD), minúsculas, troca
  `[*#|]` por espaço, remove tudo fora de `[a-z0-9\s/.-]`, colapsa espaços.
- **Assinatura de comerciante** (`merchantSignature`): da descrição
  normalizada, remove tokens com dígito ou menores que 3 caracteres e ~35
  palavras de ruído (banco/adquirente/preposição), pega os 2 primeiros
  tokens únicos. Existe pra uma correção de categoria "grudar" no
  comerciante ("PIX ENVIADO JOAO SILVA" → `joao silva`), não no trilho
  genérico de pagamento (decisions/0008).
- **Hash de deduplicação**: `sha256(accountId|postedOn|amountCents|descricaoNormalizada)`,
  truncado a 32 caracteres hex. Deliberadamente sem o id do lote de
  importação — o objetivo é justamente deduplicar entre importações
  diferentes do mesmo período.
- **Taxa de poupança**: `savingsRateBps = round((incomeCents - expenseCents) / incomeCents * 10_000)`, 0 sem receita.
- **Limite de risco "quase lá"**: `AT_RISK_AT = 85%` — reaparece em Metas do
  mês, Saúde financeira e nos estados de meta de investimento como o corte
  entre "no ritmo" e "em risco".

## 5. Fórmulas por área de produto

### 5.1 Metas do mês (`services/goals.ts`)

Dois vereditos, nunca uma terceira fórmula pro mesmo julgamento — reusados
por Motor financeiro e Investimentos.

- **`targetState(atual, alvo, éMêsCorrente)`** — "chegar num número até o fim
  do período": `met` se `atual >= alvo`; se ainda em andamento, `on_track`
  quando `atual >= alvo * 0.85`, senão `at_risk`; se o período já fechou e
  não bateu, `missed`; `no_target` se o alvo é nulo ou zero.
- **`capState(gasto, teto, ritmo, éMêsCorrente)`** — "não estourar um teto":
  `exceeded` se `gasto > teto`; `met` se o período já fechou sem estourar;
  `at_risk` se `gasto > ritmo` e `gasto/teto >= 0.85`; `on_track` caso
  contrário. `ritmo = teto * (diasDecorridos / diasTotais)` — o que já
  deveria ter sido gasto até hoje se o gasto fosse uniforme ao longo do mês.
- **Modo ano** (agregação anual, adicionada nesta sessão): soma o realizado
  de cada mês já decorrido do ano; a meta anual só soma os meses que TÊM
  meta configurada (ausência de meta não conta como meta zero). O mês em
  andamento pesa proporcional aos dias já passados no `ritmo`, os meses
  fechados entram com o teto cheio.

### 5.2 Endividamento (`services/debt.ts`)

- **Taxa mensal a partir da anual**: `monthlyRate(aprBps) = (1 + aprBps/10_000)^(1/12) - 1`
  — taxa EQUIVALENTE do regime composto, nunca a proporcional (divisão por
  12), que só vale em juros simples. `aprBps` é sempre uma taxa EFETIVA
  anual: essa é a unidade canônica do schema. O formulário de dívida aceita
  a taxa ao mês e converte na entrada (`(1+im)^12 - 1`), porque cartão
  rotativo e cheque especial são publicados ao mês no Brasil e multiplicar
  por 12 produziria uma taxa nominal onde o cálculo espera uma efetiva. Cada
  dívida também devolve `monthlyRateBps`, a mensal equivalente, exibida ao
  lado da anual para que uma taxa absurda se denuncie sozinha.
- **Juro do mês**: `monthlyInterestCents = round(saldoCents * monthlyRate(aprBps))`.
- **Participação no total**: `shareBps = round(saldoCents / saldoTotalCents * 10_000)`.
- **Taxa média ponderada**: `Σ(aprBps_i * saldoCents_i) / saldoTotalCents` — uma
  média simples subestimaria o dano de um saldo pequeno e caro.
- **Comprometimento de renda**:
  `debtToIncomeBps = round(parcelasProgramadasCents / rendaMensalTípicaCents * 10_000)`,
  onde a renda típica é a MEDIANA da receita dos meses com movimento numa
  janela de 6 meses fechados (`INCOME_WINDOW_MONTHS`), nunca a de um único
  mês. A persona é autônomo/PJ com receita irregular por definição, e um
  denominador de um mês só fazia o indicador oscilar por uma razão sem
  relação com dívida nenhuma, arrastando junto o indicador de endividamento
  da Saúde financeira e uma regra do radar de risco. Só entram meses com
  lançamento registrado: um mês vazio é ausência de dado, não um mês sem
  renda. `debtToAnnualIncomeBps` usa a mesma renda típica × 12. A renda do
  mês de referência continua sendo devolvida como `monthlyIncomeCents`, mas
  não é mais denominador de nada.
- **Projeção de quitação** (avalanche/bola de neve, `projectPaydown`):
  simulação mês a mês — (1) juro acumula em cada saldo aberto, (2) cada
  dívida recebe seu pagamento programado, e o que sobrar de dívidas já
  quitadas realimenta o "pool", (3) o pool inteiro (mais qualquer aporte
  extra) vai pra UMA dívida-alvo até zerar: maior taxa primeiro (avalanche)
  ou menor saldo primeiro (bola de neve). Detecta e reporta quando o
  pagamento nem cobre o juro (saldo nunca cai) em vez de desenhar uma linha
  reta por 50 anos.
- **Âncora da parcela 0** (`openedOn`): fixada na criação da dívida, nunca
  recomputada — corrige um bug de 03/09/2026 em que a parcela "próxima a
  pagar" era remapeada pro mês corrente a cada carregamento da tela,
  fabricando uma pendência extra por mês que passasse sem pagamento.

### 5.3 Investimentos (`services/investments.ts`, `criteria.ts`)

- **Reserva de emergência**: `alvoCents = custoMensalDeVidaCents * múltiplo`
  (múltiplo padrão 6×; custo mensal = MEDIANA da despesa dos meses com
  movimento numa janela de 6 meses fechados por padrão, ou um valor manual
  do usuário). Era média de 3 meses até 09/09/2026: com média, um único
  gasto atípico deslocava a base numa fração direta do seu valor, e essa
  base alimenta ao mesmo tempo o alvo da reserva, o Runway e o indicador de
  liquidez. A janela continua configurável, e uma configuração já salva
  mantém o valor que tem. `gapCents = max(0, alvo - atual)`;
  `progressBps = round(atual / alvo * 10_000)`. Ativo imobilizado nunca
  entra no `atual` — uma reserva que exige vender um bem pra virar dinheiro
  não é reserva.
- **Passo de composição mensal** (`compoundStep`, núcleo compartilhado entre
  projeção de meta e decumulação de aposentadoria — decisions/0035 proíbe
  duplicar): `novoValor = valorAtual * (1 + retornoMensal) + fluxoDoMês`
  (fluxo positivo = aporte, negativo = retirada).
- **Retorno mensal a partir do anual**: `(1 + retornoAnualBps/10_000)^(1/12) - 1`.
- **Aporte necessário pra bater uma meta numa data** (`requiredContribution`,
  fórmula clássica de anuidade, resolvida pro pagamento):
  `PMT = (alvoCents - presenteCents * (1+r)^n) * r / ((1+r)^n - 1)`, com `r`
  o retorno mensal e `n` os meses até a data-alvo; se `r = 0`, cai pra
  divisão linear `(alvo - presente) / n`.
- **Estado de uma meta de investimento** (`goalProjection`): usa a
  trajetória projetada inteira contra a data-alvo, não `targetState` direto
  — comparar o valor atual contra 85% do alvo final marcaria "em risco"
  quase o tempo todo numa meta de anos, mesmo no ritmo perfeito.
- **Diagrama do Cerrado** (nota de qualidade/resistência de um ativo, em
  `criteria.ts`, apesar do nome sugerir `benchmarks.ts`): +1 por critério
  marcado, -1 por não marcado, critério não respondido não conta nada
  (nem +1 nem -1) — não puniria um questionário incompleto. Nota final
  travada em 0–10; `null` (não 0) quando nada foi respondido ainda, porque
  0 é uma nota válida ("tudo falhou") e não pode se confundir com "não
  avaliado".

### 5.4 Motor financeiro (`services/financialEngine.ts`)

- **Disponível para alocação**:
  `availableCents = saldoConsolidadoCents - compromissosFuturosCents - limiteDeCartãoComprometidoCents - jáDestinadoAMetasCents`.
- **Ponto de equilíbrio (break-even)**: como o imposto é uma fração da
  própria receita, é uma equação, não uma soma —
  `receita = custosFixos / (1 - alíquotaEfetivaBps/10_000)`. Somar o imposto
  em cima dos custos fixos subestimaria o alvo, porque o imposto devido
  cresce junto com a receita que o paga. `null` quando a alíquota é ≥100%
  (equilíbrio inatingível). A alíquota configurada é a EFETIVA, não a
  nominal da tabela: no Simples Nacional
  `alíquotaEfetiva = (RBT12 × nominal - parcelaADeduzir) / RBT12`, e digitar
  a nominal infla o equilíbrio e, por ele, todo preço da Precificação. O
  sistema não calcula essa alíquota (depende do anexo, do Fator R e de
  tabela que muda por lei), mas deriva o `rbt12Cents` do ledger e o exibe ao
  lado, para que uma alíquota errada ou envelhecida fique visível. Vale
  registrar por ser contraintuitivo: sob o Simples o gross-up NÃO é
  circular, porque o RBT12 é histórico e não inclui o mês corrente.
- **Modo "sem metas"** (`includeGoals: false`): zera reserva planejada E
  margem (as duas discricionárias), mas REMOVE a linha de investimento
  planejado em vez de zerá-la — uma linha "R$ 0,00" diria "a meta foi
  considerada e vale zero", quando na verdade ela nem entrou na conta.

### 5.5 Saúde financeira (`services/financialHealth.ts`)

Cinco indicadores, cada um `0–10.000` bps ou `null` ("sem dado", nunca 0):

| Indicador | Fórmula |
|---|---|
| Liquidez | `round(saldoDisponívelCents / custoMensalCents * 10_000)`, travado em [0, 10.000] |
| Endividamento | `10_000 - debtToIncomeBps * 2` (comprometer 50% da renda típica com dívida já zera) |
| Controle de gastos | `(1.5 - gastoCents/tetoCents) / 0.5 * 10_000` — nota cheia até o teto, zero em 150% do teto |
| Reserva | `round(atualCents / alvoCents * 10_000)` |
| Metas de alocação | `10_000 - médiaDoDesvioAbsolutoEmBpsEntreClasses` |

**Composição**: filtra aos indicadores com dado E peso > 0, redistribui o
peso proporcionalmente entre os ativos (padrão 20/20/20/20/20), e o score
final é a média ponderada direta:
`scoreBps = round(Σ(score_i * peso_i) / pesoAtivoTotal)`.

**Runway**: `meses = round((patrimônioConsiderado / custoMensalMédio) * 10) / 10`
(uma casa decimal), onde `patrimônioConsiderado = saldoEmConta + investimentosLíquidos - dívidaDeCurtoPrazo(30 dias)`.
Deliberadamente diferente do **Patrimônio consolidado**, que soma TODOS os
investimentos (não só os líquidos) e subtrai a dívida TOTAL (não só os
próximos 30 dias) — os dois números divergirem na tela é intencional, não
bug.

**Radar de risco**: cinco regras (comprometimento de cartão > 35%, cobertura
de reserva < 100%, desvio de alocação > 10 p.p., teto de gasto > 100%,
comprometimento de renda com dívida > 30%), cada uma só aparece se o dado
existir. O comprometimento de cartão soma o limite usado de TODOS os
cartões ativos (parcelamento e rotativo incluídos) — não isola só a fatura
deste ciclo, porque o app não rastreia gasto de cartão separado da conta
vinculada.

### 5.6 Precificação de projetos (`services/pricing.ts`)

- **Valor-hora real**: vem do break-even do Motor financeiro, nunca
  recalculado à parte —
  `horasFaturáveis = horasDisponíveisPorMês(176) * percentualFaturável(60%)`;
  `valorHoraCents = round(pontoDeEquilíbrioSemImpostoCents / horasFaturáveis)`.
- **Preço mínimo** (piso, nenhum multiplicador pode empurrá-lo pra baixo):
  `mínimoCents = round(horasEstimadas * valorHoraCents)`.
- **Preço recomendado**: `base = mínimo + custosDiretos`; multiplica pelos 4
  multiplicadores (complexidade, urgência, porte do cliente, direitos de
  uso — cada um em bps, 10.000 = neutro); aplica o gross-up do MESMO
  `taxaDeImpostoBps` do Motor financeiro (`preçoComImposto = ajustado / (1 - taxaBps/10_000)`);
  soma a margem extra.
- **Preço "premium"**: `recomendado * 1.3` — só uma terceira âncora de
  negociação, nunca um preço que a aprovação de orçamento aceita.
- **Parcelamento**: divide em partes iguais por `floor`, e a ÚLTIMA parcela
  absorve o resto da divisão (nunca a primeira).

### 5.7 Simulador de decisões (`services/simulator.ts`)

Regra de ouro: nunca duplica fórmula — reusa literalmente as mesmas funções
de produção (Saúde financeira, Motor financeiro, projeção de dívida,
composição de investimento) com um único insumo hipotético alterado, e
nada é gravado (decisions/0016).

- **Gasto único hipotético**: a saída afeta saldo, reserva ou investimento
  conforme a origem escolhida — retirar da reserva ou de investimento
  nunca move o Health Score (nenhum dos 5 indicadores lê o valor total da
  carteira), só Runway e Disponível.
- **Quitação de dívida**: reusa o juro economizado já calculado pela
  projeção de quitação no ritmo atual, nunca recalcula.
- **Decumulação de aposentadoria**: mesmo `compoundStep` do aporte, com o
  fluxo invertido (retirada em vez de aporte); horizonte padrão de 360
  meses (30 anos), teto de 1200 (100 anos). **Nunca calcula "quanto dá pra
  sacar com segurança"** — o usuário informa o valor de retirada e o
  retorno esperado; o simulador só mostra a consequência (esgota no mês X,
  ou não esgota no horizonte), consistente com "evidenciar, nunca
  prescrever" (decisions/0010, decisions/0035).

### 5.8 DRE PJ x PF (`services/dre.ts`)

- **DRE simples**: cada categoria-folha é sua própria linha (nunca agrupada
  em "Outras"); lançamentos sem categoria são agrupados por assinatura de
  comerciante, ordenados pelo valor absoluto.
- **DRE formal (cascata)**: cada categoria tem um `dre_group` configurado
  (custo, dedução, financeiro, imposto, ou nenhum = bucket padrão por
  receita/despesa operacional bruta).
  ```
  receitaLíquida = receitaBruta - deduções
  lucroBruto = receitaLíquida - custos
  resultadoOperacional = lucroBruto - despesasOperacionais
  lucroLíquido = resultadoOperacional + (receitaFinanceira - despesaFinanceira) - impostos
  ```

### 5.9 Cartões de crédito (`services/creditCards.ts`)

- **Limite usado**: `usadoCents = max(0, limiteCents - limiteDisponívelCents)`
  (do snapshot mais recente; sem nenhum ainda, assume o limite cheio
  disponível). `usedBps = round(usadoCents / limiteCents * 10_000)`.
- **Ciclo de fatura**: fecha/vence no dia configurado, travado ao tamanho
  real do mês (dia 31 configurado contra fevereiro cai no último dia
  existente). "Fatura atual" soma TODOS os ciclos com fechamento ≥ o
  próximo fechamento (não só o ciclo mais próximo) — uma parcela lançada
  numa data futura nunca some silenciosamente da tela.

### 5.10 Receita de parceiros (`services/partners.ts`, decisions/0037)

- **Sem coluna de saldo armazenada** — sempre derivado:
  `saldoCents = Σ comissõesAcumuladas - Σ saquesJáConfirmados`.
- **Reconhecimento só no saque**: comissão acumula numa tabela própria; só
  o saque escreve uma transação real no ledger (categoria "Comissões",
  entrada de receita). Uma comissão nunca sacada literalmente não aparece
  em Receitas nem no DRE — decisão deliberada (0037), não lacuna.
- **Representatividade**: compara saques (não comissão acumulada) contra a
  receita total do mesmo período — misturar competência (acumulado) com
  caixa (sacado) produziria uma porcentagem que não bate com nenhuma outra
  tela.

### 5.11 Categorização (`services/categorization.ts`)

- **Ordem de prioridade**: regra explícita do usuário (prioridade 20) →
  regra aprendida automaticamente (prioridade 50) → categoria bruta do
  banco → sem categoria (nunca um chute).
- **Memória aprendida**: cada correção do usuário soma 1 ponto pra
  `(assinatura do comerciante, categoria)`; correções conflitantes pra essa
  mesma assinatura perdem 1 ponto (nunca abaixo de 1) — a memória converge
  pra intenção mais recente do usuário. Ao atingir 3 acertos, promove
  automaticamente a uma regra real.

### 5.12 Transferências entre contas (`services/transfers.ts`)

Pareia uma saída de uma conta com uma entrada de outra conta, mesmo valor
absoluto, mesma data (ou ±1 dia), exigindo que **pelo menos um** dos dois
lados já esteja classificado como transferência — não os dois, porque
alguns bancos (ex. PicPay) nunca classificam um Pix recebido
automaticamente, e uma regra "os dois lados" nunca pariria essa perna.

## 6. Pontos que não são óbvios (vale ler antes de mudar qualquer coisa aqui)

- Runway e Patrimônio consolidado divergem de propósito (investimento
  líquido vs. total, dívida de 30 dias vs. total) — não é bug quando os
  dois números da tela não batem.
- O radar de "comprometimento de cartão" nunca isola só a fatura do ciclo
  atual — soma o limite usado de todos os cartões ativos, por limitação
  arquitetural real (o app não separa gasto de cartão da conta vinculada).
- Comissão de parceiro só vira receita reconhecida no saque — a
  Representatividade compara saque contra receita total, nunca comissão
  acumulada contra receita total.
- O simulador de decumulação nunca calcula "taxa segura de retirada" —
  só projeta a consequência do que o usuário já decidiu retirar.
- "Diagrama do Cerrado" mora em `criteria.ts`, não em `benchmarks.ts`
  (que é só o comparativo CDI/IPCA/índice B3).
- BRAPI trata 1 ticker por requisição como limite rígido (nunca em lote) e
  só devolve ~3 meses de histórico por chamada — por isso o histórico de
  índice via ETF nunca é reconstruído de uma vez, só cresce a cada
  atualização manual.
- SGS (CDI/IPCA) não precisa de chave; BRAPI precisa da chave própria do
  usuário — as únicas duas chamadas de rede do app além da própria API
  local.
- O funil de orçamentos (Precificação) é inferido só do status atual, sem
  log de transição — e o agrupamento por período usa a data de CRIAÇÃO do
  orçamento, não uma data de aprovação que não existe como coluna.
- A dívida guarda taxa EFETIVA anual, sempre. Um número digitado como taxa
  nominal ("14% ao mês × 12 = 168% ao ano") vira uma taxa mensal ~39% menor
  que a real e a projeção de quitação erra por anos. É por isso que o
  formulário aceita entrada ao mês e mostra a conversão enquanto se digita.
- Renda típica (mediana de 6 meses) e renda do mês de referência convivem na
  mesma resposta de `debtOverview` e são coisas diferentes: a primeira é
  denominador de comprometimento, a segunda é observação de um mês. Trocar
  uma pela outra reintroduz o ruído que a mediana existe para tirar.
- O RBT12 exibido no Motor financeiro não entra em conta nenhuma. É base de
  conferência da alíquota efetiva, não insumo do equilíbrio.
- Nenhuma simulação arredonda por iteração: `compoundStep` e `projectPaydown`
  acumulam em float e só arredondam ao escrever o ponto da série. Não existe
  deriva de centavos acumulada, e reintroduzir `round()` dentro do laço a
  criaria. Ver `revisao-de-formulas.md`.
