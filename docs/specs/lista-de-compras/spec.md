# Spec: Lista de compras (Mercado)

Status: implementado com desvios (25/11/2026; ver "Desvios"). Falta a carga histórica dos prints (plano, etapa 8)

## Objetivo
Montar a lista de compras em casa, preencher preço e quantidade dentro do
supermercado e ver o total da compra em tempo real contra o orçamento de
Supermercado do mês — sem calculadora nem lista no WhatsApp — e, com o
histórico, medir quanto a mesma cesta de produtos encarece ao longo do ano.

## Histórias de usuário
- Como quem faz mercado, eu quero montar a lista em casa a partir dos meus
  produtos de sempre (ou repetindo a última compra) e ver quanto ela deve
  custar com os últimos preços pagos.
- Como quem está no corredor, eu quero tocar no item, digitar quantidade e
  preço e marcá-lo, e ver na hora o total real, o previsto e quanto sobra do
  orçamento de Supermercado do mês.
- Como quem está com sinal ruim no mercado, eu quero que nenhum check ou
  preço se perca e que o total nunca trave esperando a rede.
- Como quem já recebe o gasto pelo Open Finance, eu quero vincular a compra ao
  lançamento real, sem que o valor seja contado duas vezes.
- Como quem acompanha o custo de vida, eu quero ver o gasto anual com
  mercado, o ticket médio e a inflação da minha cesta (mesmos produtos), e
  quais produtos mais subiram.

## Decisões tomadas no brainstorming (25/11/2026)
- **A lista nunca cria lançamento.** O gasto real entra pelo Open Finance; a
  compra é só o detalhe por item e pode ser vinculada ao lançamento real.
- **Em casa mostra o previsto; no mercado mostra real + previsto + saldo do
  orçamento.**
- **Unidade por produto (`un`/`kg`/`L`), quantidade × preço unitário.**
  Comparação de preço sempre por unidade.
- **Um mercado só.** Sem campo de loja na v1.
- **Compras antigas entram por carga única** (prints → JSON revisado →
  script). Foto do cupom pelo app fica para depois.
- **Abordagem 1:** padrão atual (Supabase + Edge Functions `ledger`/
  `insights` + TanStack Query) com edição otimista e fila local na tela do
  mercado.
- Só no perfil Pessoal; não entra na PJ nem na DRE.

## Modelo de dados

Convenções do projeto: sem `user_id` (app de um usuário), RLS habilitada sem
policy (só as Edge Functions, via `service_role`, acessam), dinheiro em
`bigint` centavos, datas em `text` ISO, `created_at`/`updated_at` com
`now_iso()` e trigger `set_updated_at`.

### `grocery_products` (nova) — catálogo da lista-base
| coluna | tipo | o que é |
|---|---|---|
| id | bigint pk identity | |
| name | text not null | "Leite integral 1L" |
| name_key | text not null unique | nome normalizado (minúsculas, sem acento, espaços colapsados) — evita duplicata |
| unit | enum `grocery_unit` ('un', 'kg', 'L') not null | unidade do preço |
| default_qty | numeric(10,3) not null default 1 | quantidade sugerida ao entrar na lista |
| archived | boolean not null default false | some do catálogo, mantém histórico |
| created_at / updated_at | text | |

Não guarda preço: o último preço é derivado.

### `grocery_trips` (nova) — uma compra
| coluna | tipo | o que é |
|---|---|---|
| id | bigint pk identity | |
| status | enum `grocery_trip_status` ('planning', 'shopping', 'done') not null default 'planning' | |
| started_at | text | quando virou `shopping` |
| purchased_on | text | data da compra (`YYYY-MM-DD`), gravada ao concluir; editável (carga histórica) |
| transaction_id | bigint null references transactions(id) on delete set null, unique | vínculo com o lançamento real |
| created_at / updated_at | text | |

Índice único parcial: no máximo uma compra com `status in ('planning','shopping')`.

### `grocery_trip_items` (nova) — itens de uma compra
| coluna | tipo | o que é |
|---|---|---|
| id | bigint pk identity | |
| trip_id | bigint not null references grocery_trips(id) on delete cascade | |
| product_id | bigint not null references grocery_products(id) | |
| planned_qty | numeric(10,3) not null | quantidade planejada em casa |
| qty | numeric(10,3) null | quantidade real (null até preencher no mercado) |
| unit_price_cents | bigint null | preço por unidade do produto (null até preencher) |
| checked | boolean not null default false | |
| client_rev | bigint not null default 0 | contador do cliente para descartar escrita fora de ordem |
| created_at / updated_at | text | |

Único `(trip_id, product_id)`.

### `grocery_settings` (nova, singleton id = 1)
| coluna | tipo | o que é |
|---|---|---|
| id | int pk check (id = 1) | |
| category_id | bigint null references categories(id) | categoria cujo teto e gasto valem como "orçamento de mercado"; na primeira leitura, se nula, procura categoria **não arquivada** chamada "Supermercado" (normalizada; hoje: Alimentação › Supermercado, id 19 — a id 82 de mesmo nome está arquivada). O orçamento é o teto dessa categoria em Orçamento (`category_caps`); em 25/11/2026 ainda não havia teto cadastrado, e a UI mostra "Definir teto" levando a `/metas` |

Guarda só escolha do usuário, nenhum resultado.

## Contrato de API
Lógica em `supabase/functions/_shared/services/grocery.ts` (cálculo puro em
`grocery-calc.ts`, sem I/O, testável). `/grocery` entra em
`LEDGER_PREFIXES` de `src/lib/api.ts` para as escritas; leituras analíticas
vão para `insights` com o prefixo `/grocery-insights`.

| Rota | Método | Função | Entrada | Saída | Observação |
|---|---|---|---|---|---|
| `/grocery/products` | GET | ledger | `?archived=` | produtos + `lastUnitPriceCents`, `lastPurchasedOn` | |
| `/grocery/products` | POST | ledger | `{ name, unit, defaultQty? }` | produto | nome repetido (por `name_key`) devolve o existente com 200 |
| `/grocery/products/:id` | PATCH | ledger | `{ name?, unit?, defaultQty?, archived? }` | produto | `unit` recusada (409) se o produto tem preço em compra concluída |
| `/grocery/trips/active` | GET | ledger | — | compra `planning`/`shopping` com itens e último preço de cada produto, ou `null` | |
| `/grocery/trips` | POST | ledger | `{ from: 'empty' \| 'last' }` | compra | 409 se já há compra ativa; `last` copia produtos e `qty` (ou `planned_qty`) da última concluída |
| `/grocery/trips` | GET | ledger | `?year=` | compras concluídas com total e status do vínculo | histórico |
| `/grocery/trips/:id` | GET | ledger | — | compra com itens | detalhe |
| `/grocery/trips/:id` | PATCH | ledger | `{ purchasedOn }` | compra | só compra `done` |
| `/grocery/trips/:id` | DELETE | ledger | — | 204 | só `planning` (descartar lista) |
| `/grocery/trips/:id/items/:productId` | PUT | ledger | `{ plannedQty, qty, unitPriceCents, checked, clientRev }` | item | upsert idempotente pelo par (trip, product); ignora se `clientRev` ≤ gravado; só em `planning`/`shopping` |
| `/grocery/trips/:id/items/:productId` | DELETE | ledger | — | 204 | tira da lista |
| `/grocery/trips/:id/status` | POST | ledger | `{ status: 'shopping' \| 'done', purchasedOn? }` | compra | `done` grava `purchased_on` (padrão hoje) |
| `/grocery/trips/:id/link-candidates` | GET | ledger | — | lançamentos candidatos | ver regra de vínculo |
| `/grocery/trips/:id/link` | POST/DELETE | ledger | `{ transactionId }` | compra | só compra `done`; lançamento já vinculado a outra compra → 409 |
| `/grocery/settings` | GET/PUT | ledger | `{ categoryId }` | settings | |
| `/grocery-insights/budget` | GET | insights | `?period=YYYY-MM` | `{ capCents \| null, spentCents, activeTripLinked }` | |
| `/grocery-insights/analytics` | GET | insights | `?year=` | KPIs, série do índice, ranking por produto, gasto mensal ano atual × anterior, nº de compras sem vínculo | |

## Regras de negócio
Tudo abaixo é função pura em `grocery-calc.ts` e roda igual no cliente (para
o total em tempo real) e no servidor.

- **Subtotal do item** = `round(qty × unit_price_cents)` em centavos
  (arredondamento meio-para-cima por item; o total é a soma dos subtotais já
  arredondados).
- **Último preço de um produto** = `unit_price_cents` do item desse produto na
  compra `done` mais recente (`purchased_on`, desempate por id) com preço não
  nulo.
- **Previsto** = Σ `planned_qty × último preço` dos itens da lista; itens sem
  último preço ficam fora da soma e são contados como `semPreco`.
- **Real** = Σ subtotal dos itens com `checked = true` e preço preenchido;
  marcados sem preço contados como `marcadosSemPreco`.
- **Saldo do orçamento** (só se houver teto em `category_caps` para a
  categoria configurada no período): `teto − gastoDoMês − (compraAtivaVinculada ? 0 : real)`.
  `gastoDoMês` usa a mesma agregação de gasto por categoria (incluindo
  filhas) que `specs/monthly-goals`. Na tela de casa, o saldo usa o previsto
  no lugar do real.
- **Vínculo — candidatos:** lançamentos de despesa da categoria configurada
  (ou filhas), sem vínculo com outra compra, com data entre `purchased_on − 1`
  e `purchased_on + 5` dias; ordenados pela proximidade de valor com o real
  da compra e depois pela data. Diferença exibida = valor do lançamento − real.
- **Índice da cesta entre a compra-base B e a compra C:** considerando os
  produtos com preço em B e em C,
  `índice = 100 × Σ(qty_B × preço_C) / Σ(qty_B × preço_B)`. A resposta traz
  "baseado em N de M produtos de B". Na série, B é a primeira compra `done`
  e cada ponto é uma compra posterior.
- **Inflação da cesta 12 meses:** mesmo cálculo, com B = primeira compra
  `done` com `purchased_on` ≥ hoje − 12 meses e C = a mais recente.
- **Gasto anual e mensal com mercado** vem do ledger (categoria configurada),
  não das listas — é o valor real pago. **Ticket médio** = média do real das
  compras `done` do ano.
- **Variação por produto** = último preço ÷ primeiro preço − 1, entre as
  compras `done`; o ranking "mais subiram" ordena por isso.
- **Previsto × real** (KPI): Σ(real − previsto) das compras `done` do ano,
  em que o previsto de cada compra é recalculado na leitura com `planned_qty`
  × o último preço de compras **anteriores** a ela. Nada é congelado no
  banco (derivação em vez de resultado guardado).

## UI
Rota `/mercado`, item "Mercado" no menu do perfil Pessoal, perto de
Orçamento. Três abas (mockup revisado no brainstorming):

1. **Lista** — produtos da compra `planning` com quantidade (− / +) e último
   preço em cinza; produto sem preço em amarelo ("sem preço ainda");
   "Repetir última compra" e "+ produto" (nome + unidade). Rodapé fixo:
   previsto, "N sem preço", barra do orçamento e "Sobra do orçamento após a
   lista". Botão primário "Começar compra". Sem compra ativa: estado vazio
   com "Nova lista" e "Repetir última compra".
2. **No mercado** — pendentes no topo, marcados descem riscados. Toque na
   linha abre folha inferior com quantidade e preço unitário (teclado
   numérico, preço pré-preenchido com o último, subtotal ao vivo); "OK"
   grava e marca. Variação contra o último preço em vermelho (subiu) ou verde
   (caiu). "+ item avulso" cria produto e adiciona. Rodapé fixo: real (maior),
   previsto, contador `marcados/total`, barra do orçamento (vermelha se
   estourar), saldo. Indicador de sincronização: "salvando…", "salvo",
   "offline · N pendentes". "Concluir compra" → data da compra → sugestão de
   vínculo (pode pular e vincular depois).
3. **Análise** — 4 KPIs (gasto no ano, ticket médio, cesta desde o início,
   cesta 12 meses), aviso "N compras sem lançamento vinculado" (abre o
   vínculo), linha do índice da cesta (base 100), barras de gasto mensal
   (ano atual × anterior), tabela de produtos (preço atual, primeiro preço,
   variação, minilinha; ordenável; toque abre histórico do produto),
   histórico de compras (data, real, vínculo, detalhe).

Segue `docs/design-system-bob-finance.md` e os tokens de gráfico existentes
(`chartTheme.ts`, paleta "slab" no escuro). Layout pensado primeiro para
celular, uma mão.

### Fila offline (só na aba "No mercado" e "Lista")
- Toda edição de item atualiza o cache do TanStack Query imediatamente e
  grava na fila em `localStorage`, chaveada por `tripId:productId`; uma nova
  edição do mesmo item substitui a pendente (envia só o último estado) e
  incrementa `clientRev`.
- Envio em ordem, com retry exponencial (1s → 30s) e disparo no evento
  `online` e ao voltar o foco para a aba.
- Ao abrir a tela, pendências da fila são reaplicadas sobre o que veio do
  servidor antes de renderizar (o app pode ter sido fechado offline).
- "Concluir compra" só envia o status depois da fila vazia; offline, mostra
  "Concluiremos quando a conexão voltar" e conclui sozinho ao sincronizar.
- Leitura/escrita do `localStorage` em try/catch; sem armazenamento, a tela
  funciona online normalmente.

## Carga inicial (compras antigas)
1. O usuário envia prints das compras antigas no chat.
2. Claude extrai para `data/grocery-seed.json` (fora do git, como os demais
   dados pessoais em `data/`):
   `{ products: [{ name, unit }], trips: [{ purchasedOn, items: [{ name, qty, unitPriceCents }] }] }`.
3. O usuário revisa o JSON.
4. `scripts/grocery-seed.ts` grava via service (idempotente por
   `purchased_on` + conjunto de itens; rodar duas vezes não duplica), criando
   compras `done` sem vínculo. Env passado via Node, nunca `source .env`.

## Casos de borda
- Uma compra ativa por vez (índice parcial); abrir em outro aparelho mostra a
  mesma compra.
- Marcado sem preço conta R$ 0 no real e aparece como "N marcados sem preço".
- Item avulso com nome já existente (por `name_key`) reaproveita o produto,
  inclusive arquivado (que é desarquivado).
- Unidade de produto com histórico não muda (409, mensagem: "Crie outro
  produto para a nova unidade").
- Índice da cesta com zero produtos em comum: não exibe valor ("sem produtos
  em comum"); com 1 compra só: "precisa de 2 compras".
- Sem teto de Supermercado no mês ou sem categoria configurada: rodapé sem
  barra, só previsto/real; Análise mostra o gasto do ledger só se houver
  categoria.
- Lançamento vinculado apagado: `on delete set null`, compra volta a
  "sem vínculo".
- Produto arquivado continua no histórico e no índice; some do catálogo da
  lista.
- Quantidade 0 ou negativa e preço negativo recusados (400).
- Escrita de item em compra `done` recusada (409). Na v1, de uma compra
  concluída só se editam a data e o vínculo (ver Fora de escopo).

## Testes
- `grocery-calc` (Deno test): subtotal com 3 casas e arredondamento,
  previsto com itens sem preço, real com marcados sem preço, saldo com e sem
  vínculo e sem teto, índice (cesta fixa, produto ausente numa ponta, base
  100, mudança de quantidade não altera o índice), variação por produto,
  último preço com desempate.
- Fila (vitest/teste puro do módulo): colapso por item, `clientRev`
  crescente, reaplicação sobre dados do servidor, ordem de envio.
- Serviço: upsert idempotente e descarte de `clientRev` antigo; 409 em segunda
  compra ativa, unidade com histórico, lançamento já vinculado.
- RLS: as tabelas novas não são legíveis com a chave anon (mesma checagem
  das demais).
- Navegador (preview): montar lista → começar → preencher e marcar → ficar
  offline, marcar mais itens, voltar online → concluir → vincular → conferir
  Análise.

## Fora de escopo
- Foto do cupom com leitura por IA e QR Code da NFC-e (evolução futura).
- Mais de um supermercado / campo de loja.
- Código de barras, marca, promoções.
- Compartilhar a lista com outra pessoa / edição simultânea.
- Editar itens de uma compra já concluída (v1: só o vínculo e a data).
- Criar lançamento a partir da compra (decisão: nunca).
- Orçamento próprio da lista: o orçamento é sempre o teto da categoria em
  `specs/monthly-goals`.

## Desvios da implementação
- **Histórico de preço só dos itens marcados.** Item que ficou na lista sem
  ir para o carrinho não entra no último preço, no índice nem no ranking,
  mesmo que tenha preço digitado.
- **"Anterior" desempata pela ordem da compra.** O último preço de uma
  compra concluída (e o previsto dela) usa compras com data menor **ou**
  mesma data e id menor: duas compras no mesmo dia se enxergam.
- **Concluir exige pelo menos um item marcado** (422).
- **Folha inferior virou o `Modal` do app**, com o **preço como primeiro
  campo** (o modal foca o primeiro campo; no corredor o que se digita é o
  preço). Toque no checkbox de item com último preço marca direto com ele;
  sem preço nenhum, abre o modal.
- **A pergunta de vínculo depois de concluir mora na página**, não na aba
  No mercado: sem compra ativa a página volta para a aba Lista.
- **A fila grava a resposta do servidor no cache antes de soltar a
  pendência**, para a tela não voltar por um instante ao estado antigo.
- `clientRev` é o relógio do aparelho (nunca menor que o anterior), não um
  contador a partir de 0.
- Gasto do mês e do ano usa SQL próprio com os mesmos filtros do teto em
  Orçamento (escopo pessoal, efetivado, não ignorado, sem ajuste, saída,
  categoria + filhas), em vez de chamar `getPeriodProgress`, que só traz
  categorias com teto.
