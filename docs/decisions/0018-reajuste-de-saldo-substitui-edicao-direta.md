# 0018. Reajuste de saldo é uma transação auditável, nunca mais um campo editável

Status: aceita

## Contexto
Uma auditoria anterior desta mesma sessão de trabalho já tinha marcado
como achado crítico que "Saldo atual" em Contas (`PATCH /accounts/:id`,
campo `currentBalanceCents`) resolve `openingBalanceCents` para trás em
silêncio: sem data, sem registro, sem rastro. A âncora mais consequente do
app (todo saldo, toda posição de runway, todo disponível para alocação
depende dela) era, na prática, um campo de formulário fingindo ser
derivação.

Um teste de uso real chegou à mesma conclusão por outro caminho, e propôs
uma solução melhor do que a cogitada antes: em vez de uma tabela de
snapshot paralela (`accountSnapshots`, que teria sido uma segunda fonte de
verdade sobre saldo, ao lado de `transactions`), oferecer duas ações
explícitas quando o saldo exibido não bate com o extrato real: "lançar
como reajuste" ou "lançar como despesa/receita".

## Decisão
`PATCH /accounts/:id` perde o campo `currentBalanceCents`. No lugar, uma
tela de "Conferência de saldo" (mesmo padrão de confirmação explícita já
usado em conciliação e restauração de backup) oferece, quando o saldo
exibido diverge do que o usuário informa como saldo real:

- **Lançar como reajuste** — cria uma `transaction` normal, com
  `source: 'adjustment'` (novo valor no enum, ao lado de `csv`, `manual`,
  `daily`), categoria "Financeiro/Reajuste de saldo" (nova categoria de
  seed, `kind: 'transfer'` — um reajuste não é receita nem despesa real,
  é uma correção de registro, mesmo raciocínio de "transferência não é
  despesa" já usado para pagamento de fatura), valor igual à diferença,
  data escolhida pelo usuário (default hoje).
- **Lançar como despesa/receita** — mesmo fluxo, mas com `source: 'manual'`
  e categoria escolhida pelo usuário — para o caso em que a diferença é
  dinheiro que realmente saiu ou entrou (ex. saque em espécie nunca
  lançado), não um erro de registro.

Em ambos os casos, o saldo derivado (`accountBalances()`,
`openingBalanceCents + soma de transações confirmadas`) volta a bater
sozinho, porque a correção é só mais uma linha na única fonte de verdade —
nenhuma segunda tabela, nenhum campo especial em `accounts`.

## Alternativas consideradas
- **Tabela `accountSnapshots` (saldo medido, sobrepõe o cálculo)**,
  proposta numa revisão anterior desta sessão: descartada em favor desta,
  porque criaria uma segunda fonte de verdade sobre saldo de conta ao lado
  de `transactions` — exatamente o que o princípio "uma fonte de verdade"
  (PRD seção 4) existe para evitar. `debtSnapshots`/`creditCardSnapshots`
  fazem sentido porque não existe "lançamento" que explique uma dívida ou
  limite de cartão sozinho; saldo de conta corrente já tem lançamento como
  unidade natural, então a correção também deveria ser um lançamento.
- **Manter a edição direta, só adicionar um campo de data:** descartada —
  ainda seria um número sem explicação no ledger, só que com timestamp;
  não resolve o problema de auditabilidade, só adia.

## Consequências
- `PATCH /accounts/:id` remove `currentBalanceCents` do contrato.
- Nova rota (ou reuso de `POST /transactions` com os campos já existentes
  mais `source: 'adjustment'`) para o fluxo de reajuste.
- `categories`: nova categoria seed "Financeiro/Reajuste de saldo",
  `kind: 'transfer'`.
- `specs/settings-accounts-profiles` documenta o novo fluxo, substituindo
  a descrição atual de "Saldo atual" editável.
- Toda tela que hoje mostra "Saldo atual" com lápis de edição direta
  (Dashboard, Settings) passa a abrir a conferência em vez de um campo de
  texto solto.
