# Spec: Saúde financeira, Diário e Patrimônio falando a mesma língua

Status: implementado com desvios (09/10/2026) · revisão em `docs/beta-reviews/2026-10-09-saude-diario-patrimonio.md` (local)

## Objetivo
Fazer as três telas responderem com as **mesmas definições** que as telas
donas já usam (Orçamento, Endividamento, Minha empresa, Investimentos), em
vez de cada uma recalcular renda, custo, teto e dívida do seu jeito:

- **Saúde financeira**: o resumo que liga as telas donas, sem régua própria.
- **Diário**: "o que vence nos próximos dias e se o dinheiro pessoal chega
  até o próximo recebimento", com o lançamento rápido abaixo.
- **Patrimônio**: o patrimônio **pessoal**, com a empresa numa linha à parte
  e a dívida igual à do Endividamento.

Observação e simulação, nunca recomendação (decisions/0010).

## Histórias de usuário
- Quero ver o mesmo comprometimento de renda na Saúde e no Endividamento.
- Quero saber o que vence esta semana e se fico no negativo antes de receber.
- Quero o meu patrimônio pessoal, sabendo à parte quanto está na empresa.
- Quero que a renegociação paga na fatura do cartão conte uma vez só.

## A. Definições comuns (uma fonte para cada número)

| Número | Fonte | Usado por |
|---|---|---|
| Renda típica pessoal | `budget.typicalPersonalIncome` (mediana de 6 meses fechados, contas pessoais + repasse da PJ) | Saúde, Diário, Endividamento |
| Custo de vida pessoal | **novo** `budget.typicalPersonalSpending`: mediana dos 6 meses fechados das despesas das contas pessoais, pelo mesmo escopo do Orçamento | Saúde (reserva, runway), Diário |
| Teto de gasto do mês | o plano do Orçamento: soma do previsto dos grupos de categorias (sem os grupos de aporte) | Saúde (controle de gastos), Diário |
| Quanto você deve | `debtOverviewV2().total` (dívidas + limite usado, já sem a parte que é dívida cadastrada, ver B) | Saúde, Patrimônio, Endividamento |
| Comprometimento | `debtOverviewV2().commitment` | Saúde (indicador e radar) |
| Retirável da empresa | `companyOverview().withdrawable` | Patrimônio (linha da empresa), Saúde (runway) |
| Reserva | a de Investimentos (já é a fonte) | Saúde |

O teto antigo de Metas do mês (`monthly_goals.spend_cap_cents`) deixa de ser
lido por estas telas.

## B. Dívida paga na fatura do cartão (corrige a contagem dupla)
- `debts.paid_via_card_id` (FK `credit_cards`, set null): a dívida é paga
  dentro da fatura daquele cartão (caso real: a renegociação do PicPay é o
  "TPARC" da fatura).
- Endividamento v2:
  - **Total**: dívidas + Σ cartões `max(0, limite usado − saldo das dívidas
    pagas nele)`.
  - **Calendário**: a parcela da dívida fica; a do cartão cai pelo valor das
    parcelas projetadas da compra correspondente (a de mesmo fim e valor mais
    próximo), para não somar R$ 111,96 + R$ 108,93 no mesmo mês.
  - **Custo**: os encargos da fatura continuam no cartão; os juros da dívida
    continuam na dívida.
- Parcelas da dívida paga no cartão **não** viram pendência na conta (o
  dinheiro sai pela fatura). A parcela do mês entra no Orçamento pela TAG da
  dívida, lida do cronograma, como previsto no mês e realizado depois que a
  fatura do mês fecha.
- O formulário da dívida ganha "Paga na fatura do cartão" (Select de
  cartões, opcional).

## C. Saúde financeira
- **Indicadores** (pesos configuráveis como hoje):
  - Endividamento: do comprometimento do Endividamento v2.
  - Reserva: reserva ÷ (custo de vida pessoal × múltiplo).
  - Controle de gastos: gasto do mês ÷ teto do Orçamento.
  - Alocação: como hoje.
  - Liquidez **sai** (o Runway responde melhor); o peso dela é redistribuído
    entre os outros quatro na proporção dos pesos configurados.
- **Radar**: as duas regras de comprometimento ("com dívida" e "com limite de
  cartão") viram uma só, do Endividamento v2; o limite configurável continua.
- **Runway**: pessoal (contas pessoais + reserva − o que vence em 30 dias,
  agora com faturas) ÷ custo de vida pessoal; a empresa aparece como "+ N
  meses se retirar o retirável da Minha empresa".
- **Patrimônio**: sai daqui; fica um resumo de uma linha com link para
  /patrimonio.
- **Histórico do score**: foto mensal gravada daqui em diante (ver E); os
  meses anteriores ficam como hoje, marcados "reconstruído".
- **Motor financeiro**: "Custos PJ" e impostos vêm da Minha empresa (custo
  fixo e DAS); "Pró-labore" vira "Retirada planejada".
- Cada card diz de que tela vem o número e leva até ela.

## D. Diário
- **Topo: "Próximos 7 dias"**, por dia: saídas pendentes (parcelas de dívida,
  previsões), faturas dos cartões no vencimento (fatura aberta do Open
  Finance; à mão, sem valor) e entradas previstas.
- **Saldo pessoal projetado** até o próximo recebimento previsto: saldo das
  contas pessoais hoje − saídas + entradas, dia a dia. Mostra o dia em que
  fica abaixo de zero, se ficar; nunca diz o que fazer.
- **Gasto do mês**: escopo pessoal do Orçamento, contra o teto do Orçamento.
  A projeção deixa de ser linear: gasto realizado + pendências conhecidas do
  mês + ritmo dos gastos variáveis (sem os maiores lançamentos únicos, ver
  "Casos de borda").
- **Lançamento rápido** desce para depois do topo; tabela com todas as
  fontes do dia ao clicar num dia do gráfico.

## E. Patrimônio
- **Patrimônio pessoal** (número principal): contas pessoais + investimentos +
  imobilizado − "Quanto você deve" (A).
- **Empresa à parte**: saldo da conta PJ e o retirável da Minha empresa, numa
  linha separada, fora do número principal.
- **Evolução**: foto mensal (`monthly_snapshots`) gravada pela rotina diária
  das 22:00: a última gravação do mês é a foto do mês. Meses antes da
  primeira foto ficam com a reconstrução de hoje, marcados "reconstruído".
- **Bem**: ganha data de aquisição (o degrau do gráfico cai no mês certo) e o
  aviso "valor de N meses atrás" quando passar de 12 meses (informa, não
  pede).

## Contrato de API
- `GET /financial-health/score|risk-radar|runway` passam a usar as fontes de A.
- `GET /financial-health/net-worth` ganha `personal`, `company`
  (`balanceCents`, `withdrawableCents`) e `debt` igual ao total do
  Endividamento; os campos antigos ficam até a tela migrar.
- `GET /analytics/daily` ganha `upcoming` (7 dias) e `projectedBalance`.
- `PATCH /debts/:id` aceita `paidViaCardId`.

## Modelo de dados
- `debts.paid_via_card_id` (B).
- `illiquid` (posição de bem): data de aquisição.
- `monthly_snapshots` (nova): `period` (único), `score_bps`, `net_worth_cents`
  (pessoal), `company_cents`, `debt_cents`, `taken_at`, `details` (jsonb com os
  componentes).

## Casos de borda
- Sem conta PJ configurada: o Patrimônio não mostra a linha da empresa e diz
  "todas as contas".
- Cartão medido à mão: sem fatura no "Próximos 7 dias", só o vencimento.
- Lançamento único grande (aluguel): fora do ritmo variável da projeção do
  Diário, contado uma vez.
- Sem plano no Orçamento: controle de gastos "sem dado" (como hoje, com o
  motivo).

## Fora de escopo
- Importar compras de cartão.
- Mudar como o Orçamento, o Endividamento ou a Minha empresa calculam.

## Decisões (09/10/2026, com o usuário)
1. Dívida paga no cartão não lança pendência na conta.
2. Teto de gasto = soma do previsto dos grupos de categorias do plano do mês
   (sem Metas e Liberdade Financeira).
3. Liquidez sai do score.
4. Evolução por foto mensal daqui em diante; o passado fica reconstruído e
   marcado.

## Desvios da implementação
- **Cartão da empresa**: cartão cuja conta de pagamento é a conta PJ vai para
  a linha da empresa no Patrimônio e fica fora do runway e do Diário
  pessoais. O Endividamento continua com todos ("quanto você deve" total).
- **Reserva**: o custo de vida automático passou a ser sempre o pessoal do
  Orçamento (mediana de 6 meses); a janela configurável da reserva deixou de
  valer para o cálculo automático. O valor manual continua valendo.
- **Projeção do Diário**: realizado + pendências do mês + mediana do gasto por
  dia nos 90 dias anteriores × dias que faltam (em vez de tirar os maiores
  lançamentos únicos). "Próximos 7 dias" se estende até o próximo
  recebimento previsto nas contas pessoais, até 45 dias.
- **Runway**: sem linhas por conta; uma linha "Com o retirável da empresa".
  Do editor de pesos saíram Liquidez e a janela de custo.
- **Motor financeiro**: "Custos PJ" = custo fixo mensal da Minha empresa
  (mediana dos meses, DAS incluso), não o gasto parcial do mês. Isso subiu o
  ponto de equilíbrio da Precificação (no dado real de 10/2026, +R$ 163,07).
  "Quanto ainda não tem destino" continua descontando o limite usado
  inteiro dos cartões (fora deste desenho).
- **Parcela paga no cartão no Orçamento**: entra como linha calculada no grupo
  da TAG; não aparece na lista de Lançamentos filtrada pelo grupo.
- **Diário**: clicar num dia do gráfico para ver os lançamentos dele ficou de
  fora.
- `debtOverviewV2`, a Saúde e o Patrimônio leem em sequência (pooler das
  Edge Functions), nas duas cópias.
