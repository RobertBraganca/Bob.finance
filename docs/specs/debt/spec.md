# Spec: Endividamento

Status: implementado

## Objetivo
O custo real de cada dívida (juros mensais, comprometimento de renda) e uma
projeção de quando ela acaba — no ritmo atual e num cenário acelerado — para
decidir se vale antecipar pagamento.

## Histórias de usuário
- Como usuário, eu quero ver quanto de juros pago por mês em cada dívida e
  no total.
- Como usuário, eu quero saber quantas parcelas já paguei e quantas faltam.
- Como usuário, eu quero comparar "no ritmo atual" com "se eu pagar R$X
  extra por mês", em meses e em juros economizados.
- Como usuário, eu quero saber se um pagamento está tão baixo que nunca vai
  quitar a dívida (reportado, não uma linha reta mentindo que quita algum
  dia).

## Modelo de dados
- `debts` — saldo de abertura, taxa anual, pagamento mínimo/programado,
  `installmentCount` (null = dívida rotativa, sem número fixo de parcelas),
  `accountId` (opcional — de qual conta a parcela sai; sem ele, a dívida
  nunca materializa pendência, ver `specs/cash-flow-reconciliation`),
  `dueDay`.
- `debtSnapshots` — saldo medido ao longo do tempo; **sobrepõe** o principal
  de abertura quando existe (é a verdade mais recente).
- `debtPayments` — `kind: 'payment'` conta como parcela paga;
  `kind: 'charge'` é novo uso de limite/saque, não reduz o contador de
  parcelas. Alimentado tanto pelo registro manual (`/debts/payments`) quanto
  automaticamente quando uma parcela pendente é marcada como paga ou
  conciliada (ver `specs/cash-flow-reconciliation`) — as duas telas
  concordam sobre quantas parcelas já foram pagas.

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/debts` | GET/POST | Lista/cria; `period` (`YYYY-MM`) na query escolhe o mês cuja renda real é usada no comprometimento de renda |
| `/debts/:id` | PATCH/DELETE | Editar `accountId`/`scheduledPaymentCents`/`dueDay` também atualiza as parcelas já materializadas e ainda pendentes, não só as futuras — exceto a parcela que o usuário já editou manualmente (`decisions/0017`) |
| `/debts/:id/snapshot` | POST | Registra saldo medido |
| `/cash-flow/pending/:id` | DELETE | Mesmo endpoint de `specs/cash-flow-reconciliation` — parcela de dívida materializada é uma `transaction` com `debtId`, mesmo mecanismo de escopo (`only`/`this_and_future`/`all`, ver `decisions/0020`). `'all'` desativa a dívida (`active = false`, `closedOn` preenchido), nunca apaga parcela já paga |
| `/debts/payments` | GET/POST/DELETE | Log de pagamentos/usos |
| `/debts/projection` | GET | Cenário atual vs. acelerado |

## Regras de negócio
- **Taxa média é ponderada pelo saldo**, não uma média simples entre as
  dívidas — uma dívida grande a 8% pesa mais que uma pequena a 300%.
- **Saldo medido (snapshot) sobrepõe o principal de abertura** no cálculo de
  projeção — corrigir a dívida com um saldo real mais recente não exige
  editar o cadastro original.
- **Pagamento abaixo dos juros nunca "quita"** — a projeção reporta `null`
  (nunca quita no cenário atual) em vez de desenhar uma linha até zero que
  seria falsa.
- **Avalanche ataca primeiro a dívida de maior taxa** no cenário acelerado.
- **Projeção travada interrompe cedo** em vez de desenhar 50 anos de gráfico
  para uma dívida que nunca amortiza no ritmo atual.
- **Comprometimento de renda é de um mês real específico**, nunca uma média
  — "como estava a situação em julho" é a pergunta que ajuda a decidir,
  enquanto uma média de vários meses esconde justamente a variação mês a
  mês que o usuário quer enxergar. O mês atual (ainda em andamento) nunca é
  a escolha padrão, para não subestimar o comprometimento com uma renda
  parcial.
- **Dívida com `accountId` materializa parcela pendente** igual a um
  `cashFlowForecast` — a mesma horizonte rolante de 24 meses (`decisions/0028`;
  este arquivo tinha ficado em 6, defasado desde que o cash-flow foi para 24 —
  corrigido na revisão de 29/08/2026), o mesmo mecanismo de "não recriar o que
  foi excluído" (ver `specs/cash-flow-reconciliation`). Sem conta associada, a
  dívida existe só para projeção/cálculo, sem aparecer em "Despesas
  pendentes".
- **Editar uma parcela de dívida pendente pelo widget do Painel (Visão
  geral) já pergunta o escopo** (`only`/`this_and_future`/`all`) — até
  29/08/2026, `listPending` não devolvia `debtId` e o modal do Painel só
  checava `forecastId`, então essa pergunta nunca disparava para dívida
  vinda daquela tela especificamente (a mesma edição em Lançamentos já
  funcionava). Corrigido nos dois pontos (edição e exclusão) do widget do
  Painel.

## UI
`Debt.tsx`: cards por dívida com parcelas pagas/restantes, modal de
pagamento e histórico (mesmo padrão do modal de aporte de investimentos —
compra/venda ali é pagamento/uso aqui), gráfico de cenário atual x
acelerado, comprometimento de renda com seletor compacto (`FilterSelect`)
listando os últimos 24 meses fechados.

## Casos de borda
- Sem nenhuma dívida cadastrada: total zero, comprometimento 0%, projeção
  "quitado" — estado vazio explícito, não ausência de dado.
- Dívida rotativa (sem `installmentCount`): nunca mostra "parcela X de Y".
- Mês selecionado sem nenhuma receita registrada: comprometimento não
  calcula (divisão por zero seria enganosa), mostra "sem renda registrada
  naquele mês" em vez de 0% ou 100%.

## Fora de escopo
- Negociação de dívida ou simulação de renegociação com o credor — o app
  projeta o que já está contratado, não modela uma proposta nova.
