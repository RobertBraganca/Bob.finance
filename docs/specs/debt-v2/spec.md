# Spec: Endividamento v2

Status: implementado (08/10/2026) · parte 2 de 2 (depende de `specs/card-summary-sync`)

## Objetivo
Responder **"quanto eu devo, quanto isso me custa e quando fico livre"**,
com o cartão junto, um calendário do que sai nos próximos meses, o custo do
crédito em reais e a renegociação registrada e simulada. Observação e
simulação, nunca recomendação (decisions/0010).

## Histórias de usuário
- Quero um número só do que devo: acordos, empréstimos e cartões.
- Quero ver, mês a mês, quanto sai de dívida e cartão nos próximos 6 meses
  contra a minha renda.
- Quero saber quanto pago de juros por mês e quanto paguei no último ano.
- Quero a data em que fico livre, coerente com os contratos.
- Quero registrar um acordo ligado à dívida de origem e simular uma
  proposta antes de aceitar.
- Quero que as parcelas das dívidas entrem no meu Orçamento.

## Telas e regras

### 1. "Quanto você deve hoje" (topo)
- **Total** = saldo das dívidas ativas + limite usado dos cartões (o
  limite usado já inclui as parcelas futuras do cartão).
- Por cartão: limite usado, % do limite (destaque acima de 80%), fatura
  aberta e vencimento (de `card-summary-sync`; manual se o cartão não
  estiver ligado).
- **Comprometimento da renda** = (parcelas das dívidas do mês + fatura do
  mês) ÷ **renda típica pessoal** (a do Orçamento: receitas das contas
  pessoais + repasse da PJ), em vez do faturamento bruto de todas as
  contas. Faixas de hoje (20/36/50%) com "como calculamos".

### 2. Calendário de saída (6 meses)
Por mês: parcelas das dívidas (o valor de cada parcela no cronograma, que
cai no SAC e fica fixo no Price/parcela fixa), fatura do cartão (a aberta
e as próximas, quando vierem da Pluggy; nos meses além delas, só as
parcelas futuras do cartão) e a renda típica pessoal. Marca o mês em que
cada dívida termina. Barras empilhadas por origem, tabela ao lado.

### 3. Custo do crédito em reais
- **Juros do mês**: dívidas (saldo × taxa mensal; em contrato amortizado,
  a parte de juros da parcela do cronograma) + encargos da última fatura
  de cada cartão.
- **Da parcela, quanto é juro e quanto abate o saldo** (por dívida).
- **Juros nos últimos 12 meses**: contratos amortizados pelo cronograma;
  dívidas antigas estimadas pela soma mensal de (saldo medido × taxa
  mensal), marcadas "estimado"; cartões pela soma dos encargos das faturas
  fechadas.

### 4. Quando fico livre
- Data por dívida e no total, pelo cronograma (dívida parcelada) ou pela
  projeção (rotativa).
- O aviso de taxa x contrato ganha **"Usar a taxa do contrato"**: grava a
  taxa implícita na dívida depois de confirmação (mostra antes e depois de
  juros por mês e prazo).
- O simulador de quitação com aporte extra fica um só (sai o modal
  duplicado), e a composição de uma fatia some quando há um tipo só.

### 5. Renegociação
- **Registrar acordo**: numa dívida existente ou no cadastro de uma nova,
  "este acordo renegocia" uma ou mais dívidas de origem. Guarda o saldo de
  origem na data do acordo e o total do acordo (parcela × parcelas).
  Mostra **desconto obtido** (origem − valor financiado do acordo, quando
  positivo) e **custo total do acordo** (total − valor financiado). A
  dívida de origem é encerrada como "renegociada" (não "quitada").
- **Simular proposta**: a partir de uma dívida, informar valor, taxa e
  prazo propostos (ou parcela e prazo, com a taxa implícita calculada) e
  ver lado a lado contra a dívida atual: parcela, total pago, juros, data
  livre. Nada grava; "Registrar como acordo" abre o cadastro preenchido.

### 6. Parcelas no Orçamento
- Dívida ganha `category_id` (TAG das parcelas). Padrão na criação: a TAG
  de despesa "Empréstimos" sob "Financeiro" (achada pelo nome; sem ela, a
  primeira TAG de despesa de "Financeiro"), trocável no formulário.
- `materializeDebtInstallments` grava a TAG nas pendências novas, e a
  edição da dívida atualiza as pendências não editadas (o mesmo
  `syncMaterializedRows`). Uma migração preenche a TAG das dívidas ativas
  e das pendências delas sem TAG.

## Modelo de dados
- `debts.category_id` (FK categorias, set null).
- `debts.closed_reason` (enum: 'paid', 'renegotiated', 'manual'; nulo nas
  ativas).
- `debt_renegotiations` (nova): `debt_id` (o acordo), `origin_debt_id`,
  `origin_balance_cents`, `agreed_on`.

## Contrato de API (no `insights`)
- `GET /debts/overview-v2` (ou `GET /debts` ampliado): total, cartões,
  comprometimento, calendário de 6 meses, custo (mês e 12 meses), datas
  livres, acordos.
- `POST /debts/:id/use-implied-rate`: grava a taxa implícita (409 se não
  houver taxa que feche o contrato).
- `POST /debts/:id/renegotiation`: registra o acordo `{ originDebtIds }`.
- `POST /debts`, `PATCH /debts/:id`: aceitam `categoryId`.

## Casos de borda
- Cartão não ligado à Pluggy: usa o limite medido à mão; calendário sem
  fatura futura daquele cartão, com aviso.
- Dívida sem conta: não materializa parcelas (como hoje), mas entra no
  total e no calendário pelo cronograma.
- Acordo cujo valor financiado é maior que a origem: desconto 0, e o
  "custo do acordo" mostra a diferença como acréscimo.
- Renda típica pessoal zero: comprometimento "-".

## Fora de escopo
- Lançar compras do cartão (ver `card-summary-sync`).
- Portabilidade com consulta a bancos; score de crédito.

## Verificação
Contas puras (calendário, custo, desconto e custo do acordo, taxa
implícita) por script; dívidas atuais conferidas antes/depois; migração e
gravações reais só com autorização; navegador desktop e 375px.

## Desvios da implementação
- **Rota**: `GET /debts/overview-v2` separada; `GET /debts` continua igual
  (a Saúde financeira e o radar de risco ainda leem o comprometimento
  antigo, sobre a receita de todas as contas).
- **Parcelas já pagas no calendário** = o maior entre os pagamentos gravados
  em `debt_payments` e as parcelas da dívida já confirmadas em Lançamentos.
  Caso real: parcela confirmada sem o pagamento correspondente voltava como
  atrasada no mês corrente e dobrava a saída do mês. "Usar a taxa do
  contrato" usa a mesma contagem.
- **Custo de "Como está" no simulador**: em dívida com número de parcelas, o
  custo em reais é o total que falta pagar menos o saldo de hoje (a taxa
  cadastrada pode não fechar o contrato); na rotativa, os juros da projeção.
- **Um simulador de quitação só**: sai o botão "Simular quitação" do topo; o
  card "O que muda com o aporte" fica, e avisa quando a projeção (pela taxa
  cadastrada) e a data pelo cronograma não batem.
- **Cartões medidos à mão** ficam fora do calendário e do comprometimento
  (sem fatura do banco, o app não sabe quanto vence), com aviso na tela.
- **Juros de 12 meses** incluem as dívidas encerradas no período, com a data
  de encerramento no rótulo (várias têm o mesmo nome).
- **"Este acordo renegocia"** só no cadastro de uma dívida nova; um acordo já
  cadastrado não ganha origens depois.
- **TAG da migração**: a dívida ativa recebeu a TAG mais usada nas parcelas
  dela ("Financeiro"); como essa TAG não tinha grupo no Orçamento, a parcela
  caía em "Sem grupo", e a TAG foi trocada pela tela para "Financeiro ›
  Empréstimos" (Custos Fixos), levando as 13 pendências junto. A seção
  "Quitadas" virou "Encerradas", com o motivo (quitada, renegociada, à mão);
  as encerradas antes da coluna ficam sem motivo.
