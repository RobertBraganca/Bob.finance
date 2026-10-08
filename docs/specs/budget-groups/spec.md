# Spec: Orçamento por grupos

Status: implementado (07/10/2026); falta a etapa 6 do plano (gravar a ligação das TAGs e conferir os cards com a configuração real)

## Objetivo
Dividir a renda do mês em grupos com um percentual cada (Custos Fixos,
Conforto, Prazeres, Conhecimento, Metas, Liberdade Financeira) e mostrar,
por grupo, o previsto, o realizado e o que resta. Unifica com as Metas do
mês (`specs/monthly-goals`) numa tela só, "Orçamento".

Os grupos dizem **por que** o dinheiro saiu; as TAGs continuam dizendo
**com o quê**. Cada TAG pertence a um grupo. Os percentuais são metas que o
usuário configura; o texto nunca prescreve (decisions/0010).

## Histórias de usuário
- Como pessoa que organiza a renda em grupos, eu quero definir o % de cada
  grupo e ver, no mês, quanto cada um já levou e quanto resta.
- Como quem já tem TAGs, eu quero ligar cada TAG a um grupo uma vez só, com
  uma proposta inicial, e não classificar lançamento por lançamento.
- Como quem investe, eu quero que aportar o planejado conte como meta
  cumprida em Metas e Liberdade Financeira, não como gasto.
- Como quem tem conta PJ, eu quero que os custos da empresa fiquem fora do
  orçamento pessoal.
- Como quem muda de ideia, eu quero mudar os % sem reescrever os meses que
  já passaram.

## Modelo de dados

### `budget_groups` (nova)
| coluna | tipo | o que é |
|---|---|---|
| id | bigint pk | |
| name | text not null | nome exibido |
| color | text not null | cor do grupo (tokens de série) |
| sort_order | int not null default 0 | ordem dos cards |
| source | enum `budget_group_source` ('categories', 'goal_contributions', 'other_contributions') default 'categories' | de onde vem o realizado |
| archived | boolean default false | removido sem apagar histórico |
| created_at | text | |

No máximo um grupo ativo por `source` de aporte (`goal_contributions`,
`other_contributions`); o servidor recusa um segundo. Semente (criada na
primeira leitura se a tabela estiver vazia):

| grupo | source | % do método |
|---|---|---|
| Custos Fixos | categories | 30 |
| Conforto | categories | 15 |
| Prazeres | categories | 10 |
| Conhecimento | categories | 5 |
| Metas | goal_contributions | 15 |
| Liberdade Financeira | other_contributions | 25 |

### `budget_plans` (nova)
| coluna | tipo | o que é |
|---|---|---|
| id | bigint pk | |
| effective_period | text not null unique | `YYYY-MM` a partir do qual vale |
| allocations | jsonb not null | `[{ groupId, targetBps }]`, soma 10000 |
| updated_at | text | |

O mês M usa o plano de maior `effective_period ≤ M`; meses anteriores ao
primeiro plano usam o primeiro (o orçamento é novo, e mostrar o passado com
os % de hoje é a leitura possível). Salvar os % grava (ou substitui) o
plano do mês corrente: meses passados nunca mudam.

### `categories` (duas colunas novas)
- `budget_group_id` bigint null → budget_groups(id) on delete set null.
- `budget_excluded` boolean not null default false: "fora do orçamento"
  (ex.: Negócio numa conta pessoal).

Grupo efetivo de uma TAG: o próprio `budget_group_id`; senão o da mãe;
senão nenhum ("Sem grupo"). `budget_excluded` herda do mesmo jeito. Só
TAGs `kind = 'expense'` entram; `income`, `transfer` e `investment` nunca
são gasto de grupo. A ligação não é versionada: reclassificar uma TAG
muda também os meses passados (é classificação, não meta).

Nenhuma mudança em `monthly_goals` e `category_caps`.

## Regras de negócio

### Contas pessoais
Todas as contas, exceto a conta PJ configurada no Motor financeiro
(`financial_engine_settings.pj_account_id`). Sem conta PJ configurada, todas
as contas são pessoais.

### Renda do mês
- Receitas confirmadas (`kind = 'income'`, não pendentes, não ignoradas) nas
  contas pessoais, no mês.
- Mais o repasse PJ → PF lançado como transferência, pela mesma derivação
  do Motor (`proLaboreFor`), para o pró-labore não sumir quando foi
  categorizado como transferência. Um repasse lançado como receita já está
  na primeira parcela e não é somado de novo.
- **Mês corrente:** se a renda recebida ainda é menor que a renda típica
  (mediana de 6 meses fechados das mesmas contas), o previsto usa a renda
  típica e a tela diz "estimado pela sua renda típica até a renda do mês
  entrar". Mês fechado usa sempre o recebido.

### Por grupo
- **Previsto** = renda do mês × `targetBps` do plano do mês.
- **Realizado**:
  - `categories`: despesas confirmadas, não ignoradas, nas contas pessoais,
    cujas TAGs têm este grupo efetivo (valor absoluto). Estorno lançado como
    despesa positiva na mesma TAG abate.
  - `goal_contributions`: compras (`asset_trades.kind = 'buy'`, quantidade ×
    preço + taxas) no mês em ativos com `goal_id` (decisions/0041).
  - `other_contributions`: compras no mês nos demais ativos negociáveis
    (fora `illiquid`), **incluindo** os ativos da reserva de emergência.
- **Restante** = previsto − realizado (negativo = "passou R$ X do previsto").
- **Uso** = realizado ÷ renda (o % do selo do card), e realizado ÷ previsto
  (a barra).
- **A pagar no mês**: despesas pendentes do mês nas TAGs do grupo, mostradas
  à parte; não entram no realizado.
- **Sem grupo**: despesas de TAGs sem grupo efetivo e não excluídas viram um
  card próprio, sem previsto, com o link "Escolher grupo".
- **Transações**: contagem dos lançamentos que formam o realizado
  (grupos de TAG) ou das compras (grupos de aporte).

### Topo
- **Sua renda**: a renda do mês (com o aviso de estimada, se for o caso).
- **Gastos do mês**: soma do realizado dos grupos de TAG mais "Sem grupo",
  com % da renda. Aportes não entram aqui.
- **Saldo restante**: renda − gastos do mês − aportes do mês.

### Percentuais
- Salvar exige soma exatamente 100% (10000 bps); a tela mostra
  "Alocado X% / 100%" e bloqueia o Salvar fora disso.
- **Voltar ao método**: 30/15/10/5/15/25 nos seis grupos da semente (grupos
  criados pelo usuário ficam em 0%).
- **Meu histórico**: para cada grupo, realizado ÷ renda nos últimos 6 meses
  fechados (média ponderada pela renda). "Usar meu histórico" normaliza
  esses valores para somar 100% e preenche os campos; nada grava até
  Salvar. Mês sem renda não entra na média.

### Proposta inicial de TAGs
Na primeira abertura com alguma TAG de despesa sem grupo, a aba "TAGs dos
grupos" pré-seleciona pelo nome (normalizado, sem acento), e só grava ao
Salvar:
- Custos Fixos: Moradia (e filhas), Supermercado, Padaria e café, Saúde
  (Plano de saúde, Farmácia, Consultas e exames), Transporte (Combustível,
  Transporte público, Manutenção veículo, IPVA e licenciamento), Financeiro
  (Juros e multas, Tarifas bancárias, Seguros), Pets, Mensalidade.
- Conforto: Academia, App de transporte, Estacionamento, Assinaturas,
  Vestuário, Beleza.
- Prazeres: Restaurante, Delivery, Lazer, Presentes, Flores.
- Conhecimento: Educação (Cursos, Livros).
- Fora do orçamento: Negócio (e filhas).
- O resto fica sem grupo para o usuário escolher.

### Linguagem
Observação, nunca recomendação: "passou R$ X do previsto", "resta R$ Y",
"15% da renda". Nada de "reduza", "você deveria".

## Contrato de API
Rotas no `insights` (onde moram as Metas do mês).

| Rota | Método | Entrada | Saída |
|---|---|---|---|
| `/budget/:period` | GET | | `{ period, income: { cents, receivedCents, estimated, typicalCents }, totals: { spentCents, contributedCents, remainingCents }, groups: [{ id, name, color, source, targetBps, plannedCents, actualCents, remainingCents, shareBps, pendingCents, count }], ungrouped: { actualCents, count, categoryIds }, plan: { effectivePeriod }, assumptions }` |
| `/budget/settings` | GET | | `{ groups, plan (do mês corrente), history: [{ groupId, shareBps }], categories: [{ id, parentId, name, kind, budgetGroupId, budgetExcluded, effectiveGroupId, suggestedGroupId }] }` |
| `/budget/groups` | POST | `{ name, color }` | grupo (`source = categories`) |
| `/budget/groups/:id` | PATCH | `{ name?, color?, sortOrder?, archived? }` | grupo |
| `/budget/plan` | PUT | `{ allocations: [{ groupId, targetBps }] }` | plano do mês corrente; 400 se a soma ≠ 10000 ou grupo arquivado |
| `/budget/categories` | PUT | `{ items: [{ categoryId, budgetGroupId: number \| null, budgetExcluded }] }` | lista atualizada |
| `/transactions` | GET | + `budgetGroupId` (ou `budgetGroup=none`) | lançamentos do realizado do grupo no período |

## UI

### Tela "Orçamento" (rota `/metas`, rótulo do menu "Orçamento")
- Cabeçalho com o seletor de mês de hoje e "Ajustar orçamento".
- Três KPIs: Sua renda, Gastos do mês, Saldo restante (o primeiro é o card
  de destaque).
- Grade de cards dos grupos (3 colunas no desktop, 1 no telefone): ponto de
  cor, nome, selo com % da renda, barra realizado/previsto, "Gasto" e
  "Previsto" (ou "Aportado" nos grupos de aporte), "resta"/"passou",
  "a pagar R$ Z" quando houver, e "N transações" (abre Lançamentos
  filtrado). Card "Sem grupo" ao fim, quando houver.
- Abaixo, a tela de Metas do mês de hoje, inalterada: meta de receita e
  teto geral, tetos por TAG ("Detalhe por TAG"), histórico de 6 meses.
- Estado vazio: sem renda no mês e sem renda típica → "Sem renda registrada
  neste mês" com o previsto em "-".

### "Ajustar orçamento" (página `/metas/ajustar`, também ligada pelo Perfil)
- **Percentuais**: meio-círculo com a distribuição e legenda; por grupo, um
  controle deslizante (passo de 1%) com campo numérico, o valor em R$ com a
  renda do mês e, em cinza, "seu histórico: X%"; "Alocado X% / 100%";
  botões "Voltar ao método", "Usar meu histórico" e "Salvar". Renomear,
  mudar cor, criar ("Novo grupo") e remover (arquivar) grupos.
- **TAGs dos grupos**: lista das TAGs de despesa (mães com as filhas
  recuadas), cada uma com um seletor de grupo ("Herdar da mãe", os grupos,
  "Fora do orçamento"); a proposta inicial chega marcada como "sugerido".
  Salvar grava tudo de uma vez.

## Casos de borda
- Plano salvo com grupo depois arquivado: o mês segue mostrando o grupo
  arquivado (o plano é a verdade daquele mês); o próximo Salvar exige
  redistribuir.
- Grupo criado depois do plano do mês: entra com 0% até o próximo Salvar.
- Renda zero e sem renda típica: previsto 0, uso e barras mostram "-".
- Despesa numa TAG `budget_excluded` não aparece em lugar nenhum do
  orçamento; continua no DRE e no Painel.
- Venda de ativo não abate aporte (o realizado é compra); resgate para a
  entrada do imóvel não deixa Metas negativo.
- TAG mãe num grupo e filha em outro: vale o da filha.
- Conta PJ configurada depois: os meses passados passam a excluí-la também
  (a regra de contas é leitura, não snapshot).

## Fora de escopo
- Orçamento por pessoa ou por conta.
- Alertas push de grupo estourado (os banners do Painel podem vir depois).
- Versionar a ligação TAG → grupo.
- Mudar o DRE, o Motor financeiro ou os tetos por TAG existentes.

## Verificação
1. Contas puras (renda, previsto, realizado por fonte, histórico
   normalizado, plano vigente por mês) com casos de borda num script.
2. `tsc`, build, espelhos Node/Deno, `deno check` em `insights` e `ledger`
   (se `transactions` mudar).
3. Migração com autorização.
4. Navegador (desktop e 375px, claro e escuro), só leitura: Orçamento do mês
   atual e de um mês fechado batendo com a soma dos Lançamentos filtrados
   por grupo; Ajustar com Cancelar. Gravar plano e ligações de TAG só com
   autorização (são configurações reais do usuário).

## Desvios da implementação
- **Pró-labore lançado como transferência**: em vez da derivação do Motor
  (`accountFlows`, que pareia também entradas já lançadas como receita e
  contaria duas vezes), uma consulta própria soma a entrada numa conta
  pessoal que pareia (mesmo valor, até 1 dia) com uma saída da conta PJ e
  não está lançada como receita.
- **Lançamentos sem TAG** não entram em "Sem grupo" (uma saída sem TAG pode
  ser transferência entre contas próprias); ficam fora do orçamento e isso
  está nas premissas da tela.
- **Aporte medido pela meta atual do ativo**: compras antigas de um ativo
  que hoje está separado para uma meta contam em Metas também nos meses
  passados.
- **"N transações"** abre Lançamentos com o período global trocado para o
  mês do card e o filtro `?grupo=`; o nome do grupo vai na URL só para o
  selo do filtro.

### Verificado em 07/10/2026
Contas puras por script (23 casos); migração aplicada; leitura de agosto,
setembro e outubro; a soma do card "Sem grupo" de agosto bateu com os
Lançamentos filtrados (77 lançamentos); desktop e 375px sem vazamento;
detector sem achados.
