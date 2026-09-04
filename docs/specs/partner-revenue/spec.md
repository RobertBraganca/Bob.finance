# Spec: Receita de parceiros

Status: implementado

## Objetivo
Acompanhar comissões de plataformas parceiras que retêm o dinheiro até um
mínimo de saque, mostrando quanto está parado em cada uma, quanto falta para
poder sacar, e quanto da receita do mês já veio daí.

## Histórias de usuário
- Como freelancer com receita de afiliados, eu quero lançar cada comissão que
  uma plataforma me deve para saber quanto tenho parado lá sem abrir o painel
  de cada parceiro.
- Como usuário, eu quero ver quanto falta para bater o mínimo de saque de cada
  plataforma para saber quando vale a pena solicitar o resgate.
- Como usuário, eu quero que o saque caia como um lançamento normal na conta
  que eu escolher, para não ter que registrar a mesma entrada duas vezes.
- Como usuário, eu quero saber quanto a receita de parceiros representou do
  total do mês para saber se essa fonte está crescendo.

## Modelo de dados
Ver `server/src/db/schema.ts` e
`supabase/migrations/20260903120000_add_partner_platforms.sql`.

- **`partner_platforms`** — cadastro: nome (único, sem depender de caixa) e
  `min_withdrawal_cents`, editável a qualquer momento. Só configuração;
  nenhum valor de saldo. Mesma natureza de `credit_cards`.
- **`partner_commissions`** — log de competência: o que a plataforma passou a
  DEVER, com data e valor. Não é um lançamento, e não deve virar um: esse
  dinheiro não passou por conta nenhuma.
- **`transactions.partner_platform_id`** — FK anulável, preenchida só na
  entrada que um saque gera. Mesma forma de `source_quote_id` / `debt_id` /
  `forecast_id`, e invisível na tela de Lançamentos.

O saldo de uma plataforma **nunca é gravado**: é
`sum(commissions) - sum(saques confirmados)`. Ver `decisions/0037` para as
três alternativas de modelagem consideradas e por que esta ganhou.

## Contrato de API
Prefixo `/partners`, que `src/lib/api.ts` não lista em `LEDGER_PREFIXES` nem
trata como `/pricing` — então cai na function `insights` em produção, sem
nenhuma Edge Function nova para publicar.

| Rota | Método | Entrada | Saída | Observação |
|---|---|---|---|---|
| `/partners` | GET | `from`, `to`, `accountId?` | `PartnerOverview` | saldo total, plataformas, representatividade, `assumptions` |
| `/partners/evolution` | GET | `months` (2..60, padrão 12) | `PartnerEvolution` | saldo acumulado por plataforma, mês a mês |
| `/partners/commissions` | GET | `platformId?` | `{ commissions }` | 500 mais recentes |
| `/partners/platforms` | POST | `name`, `minWithdrawalCents?`, `notes?` | plataforma | 422 em nome duplicado |
| `/partners/platforms/:id` | PATCH | qualquer campo do cadastro | plataforma | 404 se não existe |
| `/partners/platforms/:id` | DELETE | — | `{ removed, keptTransactions }` | comissões vão em cascade, saques ficam |
| `/partners/commissions` | POST | `platformId`, `earnedOn`, `amountCents`, `notes?` | comissão | valor tem que ser > 0 |
| `/partners/commissions/:id` | DELETE | — | `{ removed }` | |
| `/partners/platforms/:id/withdraw` | POST | `accountId`, `amountCents`, `postedOn`, `categoryId?`, `notes?` | `{ transaction, platform }` | **o único caminho que escreve em `transactions`** |

## Regras de negócio
- **Saldo derivado.** `earnedCents - withdrawnCents`, contando só saques com
  `pending = false` — um saque lançado como pendência ainda não saiu da
  plataforma.
- **Progresso até o mínimo.** `balance / min` em bps, `null` quando o mínimo é
  zero: não existe progresso até um alvo que ninguém definiu, e 0/0
  desenharia uma barra cheia ou vazia por acidente.
- **Estado do badge.** O classificador é o `targetProgressState` compartilhado
  (100% = `met`, ≥85% = `on_track`, abaixo = `at_risk`), com os rótulos desta
  tela: "Pronto para saque", "Quase no mínimo", "Abaixo do mínimo". Mínimo
  zero com saldo positivo também lê "Pronto para saque"; sem saldo, "Sem
  mínimo".
- **Saque acima do saldo é barrado** (422), porque o saldo derivado ficaria
  negativo para sempre.
- **Saque abaixo do mínimo é permitido**, com aviso no modal: o mínimo é regra
  do parceiro, não do app.
- **A entrada gerada é `income`, não transferência.** A comissão nunca passou
  pelo ledger, então o saque é o momento em que a receita é reconhecida.
  Categoria padrão: "Comissões" (já existe sob "Receitas de Trabalho"). Se ela
  tiver sido renomeada ou apagada, o lançamento entra sem categoria em vez de
  falhar, e cai em `income` pelo sinal (ver `FLOW_KIND` em `analytics.ts`).
- **Representatividade** = saques confirmados no período ÷ receita total do
  período, com a receita total vindo da mesma `totals()` que alimenta o Painel
  e o DRE. A comparação com o período anterior é em PONTOS percentuais
  (`Delta unit="points"`), não em porcentagem: é a diferença entre duas
  porcentagens.

## UI
`src/pages/Partners.tsx`, rota `/parceiros`, seção "Planejar" da navegação.
Quatro cards no `Bento` de duas colunas iguais:

| Card | Span | Forma |
|---|---|---|
| Hero consolidado | 6 | `Slab accent` + `HeroFigure` com lista lateral (mesma variante do hero de Patrimônio) |
| Representatividade | 6 | `StatTile large` com seta de tendência + três linhas de composição |
| Plataformas | 12 | Lista com `Meter` + `StatusBadge` + quatro ações por linha |
| Evolução | 12 | `PartnerEvolutionChart`, mesmo desenho de "Evolução do patrimônio" |

Decisões de layout que não são óbvias no código:

- O hero diz "Acumulado nas plataformas", não "Saldo": esse dinheiro não está
  em conta, e o rótulo é a primeira linha de defesa contra ler o número como
  caixa disponível.
- A barra de progresso só aparece quando existe mínimo configurado.
- A quinta plataforma em diante dobra em "Outros" no gráfico, porque a paleta
  categórica da marca tem quatro cores por decisão (`lib/chartTheme.ts`).
- O botão "Sacar" fica `primary` só quando a plataforma já bateu o mínimo, e
  desabilita sem saldo.

## Casos de borda
- **Nenhuma plataforma cadastrada:** `EmptyState` no card Plataformas com o
  atalho de cadastro; o hero mostra `R$ 0,00` e uma linha explicando.
- **Nenhuma comissão ainda:** a Evolução cai no `EmptyState` do `ChartFrame`.
- **Receita total zero no mês:** `shareBps` é `null` e o card lê "sem receita
  no mês" em vez de dividir por zero.
- **Sem período anterior comparável:** `deltaPoints` é `null` e o `Delta`
  renderiza "sem base de comparação".
- **Série toda zerada:** uma plataforma que é zero em todos os meses não vira
  linha no gráfico — ela ficaria colada no eixo e gastaria uma cor da paleta.
- **Saldo de abertura do gráfico:** o que aconteceu antes da janela de 12
  meses entra no primeiro ponto, não é descartado.

## Fora de escopo
- **Integração automática com as plataformas.** Lançamento é manual nesta
  fase; nada consulta API de parceiro.
- **Estorno de comissão.** `amount_cents > 0` é uma constraint: um negativo
  passaria batido no saldo derivado. Corrigir hoje é excluir e relançar.
- **Comissão em moeda estrangeira.** Adobe e afins pagam em USD em alguns
  programas; tudo aqui é BRL, como o resto do app.
- **Previsão de comissão futura.** Isso é `cash_flow_forecasts`, não esta
  área.
- **Reconhecimento por competência.** Ver `decisions/0037`: a receita é
  reconhecida no saque, e mudar isso é mudar o que "receita do mês" significa
  no app inteiro.

## Desvios da implementação
Nenhum.
