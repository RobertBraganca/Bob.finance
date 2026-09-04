# 0037. Comissão de parceiro acumula no domínio; o saque é que escreve no ledger

Status: aceita

## Contexto
A seção "Receita de parceiros" acompanha comissões de plataformas (Wbuy,
Hostinger, Nuvemshop, Adobe, e outras a cadastrar). O dinheiro fica retido
DENTRO da plataforma até o saldo bater um mínimo de saque configurável, e só
então é transferido para uma conta real.

Isso cria um estado que o modelo de dados atual não tinha: dinheiro que já é
do usuário, com valor e data conhecidos, mas que não está em conta nenhuma.
O pedido também exigia explicitamente não criar "uma tabela financeira
paralela fora do modelo de dados atual de lançamentos/contas" e não alterar
nenhuma outra página do app.

## Decisão
A comissão acumula numa tabela de domínio (`partner_commissions`) e a
REALIZAÇÃO — o saque — é que escreve a linha real em `transactions`, na conta
de destino escolhida pelo usuário, com `transactions.partner_platform_id`
preenchido.

É exatamente a relação que `project_quotes` já tem com `transactions`: a
cotação guarda o valor e `approveQuote` é que gera o lançamento, marcado com
`source_quote_id`. A coluna nova tem a mesma forma e o mesmo propósito das
três que já existem para isso (`forecast_id`, `debt_id`, `source_quote_id`):
uma FK anulável que diz qual objeto de domínio produziu a linha, invisível na
tela de Lançamentos.

Nenhum saldo é gravado. O saldo de uma plataforma é sempre
`sum(partner_commissions.amount_cents)` menos os saques confirmados, como
manda "Derivação em vez de saldo guardado" (`architecture.md`).

**Consequência aceita e visível na tela:** a receita é reconhecida no SAQUE,
não na competência da comissão. Uma comissão ainda não sacada não aparece em
Receitas nem no DRE. O card de Representatividade mede saques contra a
receita total justamente por isso — as duas pontas do percentual vêm do mesmo
ledger, pela mesma `totals()` que alimenta o Painel e o DRE. Comparar
competência (comissão) com caixa (receita do mês) daria um percentual que não
fecha com nenhuma outra tela. Para o acumulado não ficar invisível (o
silêncio que o `decisions/0024` evita), ele é o número hero da própria seção,
e o card de Representatividade mostra as comissões do mês ao lado do sacado,
rotuladas como competência.

## Alternativas consideradas

- **A plataforma é uma conta (`accounts`, `kind: 'partner'`).** Era a
  candidata mais elegante: saldo derivado pela máquina que já existe,
  comissão e saque virando linhas normais do ledger, zero tabela nova, e o
  percentual de receita saindo de uma única fonte. Descartada por medição, não
  por gosto: NENHUMA das cinco agregações que somam saldo de conta filtra por
  `kind` — `accountBalances()` (que alimenta o "Saldo" do Painel via `/meta`),
  `availableForAllocation()` no Motor financeiro, `runway()` e `snapshot()` em
  Saúde financeira, e o saldo de abertura de `cashFlowProjection()`. R$ 900
  parados na Wbuy entrariam como caixa disponível nas três telas, e `runway()`
  ainda criaria um escopo "Wbuy" próprio na tela de Saúde, porque ela mapeia
  um escopo por conta. Corrigir isso é mexer em três serviços para mudar
  números de três páginas que ninguém pediu para mudar — mais arriscado que a
  feature inteira.

- **A comissão é uma pendência (`pending = true`, `decisions/0003`).**
  Semanticamente é o vizinho mais próximo: dinheiro confirmado que o banco
  ainda não postou. Duas coisas quebram. A conciliação de pendência é 1:1
  (mesma conta, mesmo valor exato, ±15 dias) e um saque cobre N comissões de
  uma vez, então nada casaria. E `transactions.account_id` é `not null`: a
  pendência exigiria escolher a conta de destino no momento da comissão, meses
  antes de o saque existir, que é precisamente a fricção que o
  `decisions/0005` removeu no caso da reserva.

- **Guardar `balance_cents` em `partner_platforms`.** Seria a única posição do
  sistema com saldo gravado em vez de calculado — a mesma alternativa que o
  `decisions/0005` já recusou para a reserva de emergência.

## Consequências
- Apagar uma plataforma leva as comissões dela (cascade), mas os saques
  ficam: aquele dinheiro entrou na conta de verdade, e apagar extrato porque
  um cadastro saiu seria perder histórico. Por isso a FK é
  `on delete set null`, e a resposta do DELETE informa quantos lançamentos
  foram mantidos.
- Um saque acima do acumulado é barrado. Não por rigor contábil: o saldo é
  derivado, então ele ficaria negativo para sempre, e nenhuma barra de
  progresso do app sabe desenhar isso.
- Um saque ABAIXO do mínimo é permitido, com aviso. O mínimo é regra do
  parceiro, não do app: quem sabe se ele foi liberado ou se houve exceção é o
  usuário.
- `createTransaction` passou a gravar `notes`, que estava no tipo
  `ManualEntry` desde sempre e nunca era inserido — nenhum chamador passava o
  campo, então a perda nunca apareceu. O saque de parceiro é o primeiro a
  usá-lo.
- A paleta categórica tem quatro cores por decisão de marca
  (`lib/chartTheme.ts`: "Do not add a 5th colour"). Como o usuário já citou
  quatro plataformas e disse que há mais para cadastrar, o gráfico de Evolução
  dobra da quinta em diante em "Outros", ranqueando pelo saldo atual — a mesma
  leitura que a lista de plataformas mostra, para as duas concordarem sobre
  quem são as quatro maiores.
