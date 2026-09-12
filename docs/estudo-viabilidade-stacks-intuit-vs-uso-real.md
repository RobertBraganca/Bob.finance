# Stacks Intuit x uso real do BOB Finanças — reconciliação com telemetria

Status: levantamento técnico, sem nenhuma implementação. Cruza o veredito já
escrito sobre as 12 stacks da Intuit (colado pelo usuário nesta sessão) contra
dado real de uso do próprio BOB Finanças, extraído direto de `usage_events` e
das tabelas de produção (banco vinculado, `supabase db query --linked`,
11/09/2026). Nenhuma opinião nova sobre "reciclável ou não" é reaberta aqui —
o objetivo é confirmar, temperar ou contestar cada veredito com número real,
não substituir a análise anterior.

## Nota preliminar: o arquivo-fonte não existe no repositório

`intuit-stacks-de-feature.md` (mencionado como fonte no texto colado) não foi
encontrado em nenhum lugar do repositório, incluindo os worktrees paralelos —
busca por esse nome exato e pela palavra "intuit" (fora falsos positivos de
"contraintuitivo") não achou nada. Isso quer dizer que a lista original das
12 stacks só existe hoje dentro do texto que você colou nesta conversa; se
foi gerada numa sessão anterior, não chegou a ser salva em disco neste
projeto. Não bloqueei o levantamento por causa disso — o texto colado já
lista, stack por stack, exatamente o que foi considerado reciclável, o que
basta para cruzar contra o uso real. Mas se você tiver o arquivo original em
outro lugar, vale colar de novo para eu conferir as stacks marcadas "não
reciclável" com a lista completa de features (hoje só tenho o motivo do
descarte, não a lista, pra essas).

## Achado de segurança, fora do escopo deste levantamento mas encontrado no caminho

`docs/backlog-ideias-produto.md` (linha 17) tem uma chave de API da Pierre
Finance em texto puro (`sk-aAZqumC05BMIqOPzIQKPtpuSKCwfpBlQ`), colada numa
conversa anterior e já sinalizada como comprometida no próprio arquivo. Não é
a mesma chave que ficou em `.claude/settings.local.json` (gitignorado) mais
cedo nesta mesma linha de trabalho — são duas chaves Pierre Finance
diferentes expostas em momentos diferentes. Nenhuma das duas foi usada por
mim além do teste já registrado. Se ainda não girou essa chave no painel da
Pierre Finance, vale fazer isso independente do resto deste documento.

---

## O que a telemetria realmente mostra (usage_events, 28/08 a 11/09/2026, 1.219 eventos, janela maior que a do backlog de 07/09)

| Feature | Views | Actions | Errors |
|---|---:|---:|---:|
| dashboard | 308 | 0 | — |
| transactions | 146 | 0 | — |
| daily | 76 | 0 | — |
| investments | 68 | 3 | — |
| financial-health | 65 | 0 | — |
| financial-engine¹ | 50 | 0 | — |
| patrimonio | 52 | 0 | — |
| pricing | 46 | 6 | — |
| dre | 48 | 0 | — |
| debt | 35 | 1 | — |
| goals | 34 | 1 | — |
| partners | 26 | 0 | — |
| aposentadoria² | 14 | 0 | — |
| categories | 10 | 0 | — |
| import | 7 | 6 | — |
| credit-cards | 6 | 0 | — |
| settings | 3 | 0 | — |
| insights (função, não página) | — | — | 203 (190×401, 6×500, 2×400, 2×404, 2×546, 1×504) |
| ledger (função, não página) | — | — | 5 (4×401, 1×400) |

¹ rota `/motor` foi absorvida por `/saude` nesta sessão (fusão de sessão
10/09) — esses 50 views são histórico anterior à fusão, a métrica futura
soma dentro de `financial-health`.
² idem, `/aposentadoria` já redireciona para `/investimentos` desde
07/09; contagem histórica, não crescerá mais sob esse nome.

**Achado estrutural, vale mais que qualquer stack individual**: de 1.219
eventos, só 17 são `action` (1,4%). O app é usado quase inteiramente em modo
observação — abrir, olhar, sair — mesmo em telas que TÊM ação instrumentada
(Precificação, Importar, Dívida, Metas, Investimentos). Isso não é
necessariamente ruim (parte é ferramenta de consulta por natureza), mas é o
dado mais importante para julgar qualquer stack da Intuit: features que
pressupõem MUITA atividade transacional (faturamento automático, contas a
pagar, conciliação em lote) partem de uma base de uso que hoje quase não
transaciona dentro do app. Já uma feature que enriquece o que já é
consultado sem exigir ação nova (insight no dashboard, por exemplo) encontra
o comportamento real do usuário no meio do caminho, não contra ele.

**Efeito colateral encontrado, fora do escopo das stacks mas real**: 190
`http_401` em `insights` na janela mais recente, contra 107 na janela do
backlog de 07/09 (crescendo, não diminuindo). O backlog anterior descreveu
isso como "mitigado" (race de refresh de token em sessão aberta durante a
madrugada) — o número maior sugere que a mitigação não eliminou o problema,
só talvez reduziu o impacto percebido. Não é uma stack da Intuit, mas é
literalmente o que mais gera "erro" no uso real hoje, então registra aqui
para não se perder.

---

## Reconciliação, stack por stack

### Stack 0 — Intuit Intelligence

- **AI Insights & Anomaly Detection** (candidata #1 do levantamento
  anterior): o dado reforça, não enfraquece. `dashboard` é a tela mais
  visitada de longe (308 views, 25% de todo o uso registrado) e tem ZERO
  ações — é pura leitura. Um insight surfaced ali encontra o maior público
  possível dentro do app, no formato exato que o usuário já pratica (olhar,
  não fazer). Continua sendo a aposta de maior alcance da lista inteira.
- **Custom Automations** (mapeada para `category_rules`): a base já é usada
  pesado — **182 regras de categorização ativas** no banco. Isso não é uma
  ideia especulativa, é um padrão comprovado: automação que reduz
  categorização manual já pegou. Reforça investir em deixar a criação de
  regra mais visível/configurável, como o levantamento anterior já apontava.
- **Continuous books quality checks** (mapeada para o checklist de
  fechamento mensal, `monthly_closing_reviews`): aqui o dado esfria o
  entusiasmo. A tabela tem **1 linha** — o checklist foi marcado como
  revisado uma única vez desde que existe (31/08/2026). A feature existe,
  está no ar, e o uso real é quase nulo. Antes de trazer mais padrão de
  "quality check contínuo" da Intuit pra cá, vale entender por que o que já
  foi construído nessa linha não pegou (descoberta? item manual único
  demais pra virar hábito? notificação zero, por design do PRD §8, corta o
  lembrete que normalmente traria alguém de volta?) — replicar mais do
  mesmo padrão sem resolver isso arrisca empilhar uma segunda feature não
  usada em cima da primeira.
- Demais itens da lista de "não aproveita" (Books Check-In, chat
  conversacional, verticais de folha/CRM/projeto): nenhum dado de uso muda
  esse veredito, porque são áreas que o BOB nem tem hoje — não há
  `usage_events` pra reconciliar contra algo que não existe.

### Stack 1 — Contabilidade

- **Auto-track fixed assets** (classe `illiquid`): **2 de 47 ativos** (4,3%)
  já estão marcados como ilíquidos. É uso real, pequeno em volume absoluto
  mas coerente com o perfil de usuário do PRD §2 (carteira majoritariamente
  líquida — ações, FIIs — com um imóvel/bem ocasional). Sinal positivo, sem
  superestimar: a feature já shippada está sendo usada pelo público que ela
  foi desenhada para atender, não mais que isso.
- **AI-powered reconciliation** (`reconciliationCandidates`): **5
  dispensas** registradas (`reconciliation_dismissals`) — a sugestão está
  sendo vista e julgada, pelo menos o suficiente pra gerar recusas
  conscientes. Não há uma tabela separada de "confirmações" pra contar o
  outro lado (decisions/0003 conciliação é ação direta na própria
  transação, não um registro à parte), então esse número sozinho mostra
  engajamento mas não fecha a taxa de acerto da sugestão.
- **Anomaly detection and resolution** (metade "guia o conserto"): nenhum
  dado novo muda a tensão de princípio já registrada — ADR 0010 continua
  sendo o teto, não uso real.

### Stack 4/5/7 — Vendas, Cliente, Projeto (todas amarradas à Precificação)

- Precificação teve **46 views e 6 actions** na janela mais longa (3
  `quote_saved` + 3 `quote_approved`) — a maior taxa view→action da lista
  inteira depois de Importar. Olhando direto na tabela: **4 cotações no
  total, 2 aprovadas** (50% de conversão, amostra pequena mas real). Isso
  reforça os três vereditos "parcialmente reciclável — só o que já conecta
  com Precificação": não é uma aposta especulativa, é a área com o segundo
  melhor engajamento de ação do produto inteiro, então investir mais aqui
  (fatura recorrente puxando do orçamento aprovado, campo de
  cliente/projeto mínimo) tem histórico real a favor, mesmo com N pequeno.
  A ressalva de amostra pequena (4 cotações) é real e vale repetir essa
  reconciliação daqui a mais algumas semanas de uso.

### Stack 11 — Plataforma conectada

- **Backup and restore**: não instrumentado em `usage_events` (não é
  página, é automático por trás de toda migração, decisions/0014) — não há
  como nem por que medir "uso" aqui por telemetria de tela. O veredito
  anterior ("já está no padrão certo, nada a importar") continua de pé,
  só que por natureza da feature, não por dado de uso.
- Demais itens (Users, permissões, class/location tracking): sem mudança,
  aplicativo continua single-user (PRD §8), nenhum dado de uso é relevante
  pra algo que depende de multiusuário.

### Stacks não recicláveis (2, 3, 6, 8, 9, 10)

Nenhum dado de `usage_events` muda esses vereditos — são áreas que o BOB
não tem e o motivo do descarte já era estrutural (perfil de usuário do PRD
§2, não falta de engajamento numa feature parecida que já existe). Não
reabri essa parte.

---

## Prioridade atualizada, agora com uso real

1. **AI Insights & Anomaly Detection no Dashboard** — sobe de "candidata
   mais alinhada ao ADR 0010" pra "candidata mais alinhada ao ADR 0010 E
   com o maior público real possível dentro do app" (308 views, 0 ações,
   maior tela do produto).
2. **Investigar por que o checklist de fechamento mensal quase não é usado**
   — antes de trazer mais padrão de "continuous quality check" da Intuit,
   vale um levantamento pequeno e específico (não coberto aqui) sobre essa
   única feature: 1 revisão em duas semanas é sinal de descoberta ruim ou
   de a ação não valer o clique, e isso é decisão de produto, não de dado.
3. **Precificação (customer field mínimo + fatura recorrente)** — mantém
   prioridade alta, agora com evidência de conversão real (50% das cotações
   viram aprovação) reforçando que é a área mais "quente" fora de
   Investimentos e Importação.
4. **Auto-track fixed assets** — já validado por uso real, baixa prioridade
   de ação adicional (a feature já existe e já é usada pelo público certo).
5. **Girar a chave da Pierre Finance exposta no backlog doc**, e considerar
   revisar por que `http_401` em `insights` cresceu (190 vs 107) apesar da
   mitigação anterior — nenhum dos dois é uma stack da Intuit, mas os dois
   apareceram no caminho deste levantamento e são reais.
