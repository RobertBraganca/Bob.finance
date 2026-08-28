# Spec: Lançamentos

Status: implementado

`Transactions.tsx` nunca teve spec próprio — é referenciado de passagem em
`specs/daily-ledger` ("edição em massa — isso é Lançamentos") e
`specs/dashboard`, mas nenhum documento descreve a tela em si. Este spec
existe para fechar essa lacuna e documentar três ajustes de uma revisão de
uso real.

## Objetivo
A visão completa e editável do ledger: toda transação, de qualquer origem
(CSV, diário, manual, dívida, fluxo de caixa, reajuste), filtrável,
buscável, corrigível em lote.

## Histórias de usuário
- Como usuário, eu quero alternar entre ver só entradas, só saídas ou
  transferências, com um seletor, em vez de misturar tudo numa lista só.
- Como usuário, eu quero um formulário de lançamento manual com a mesma
  cara em qualquer lugar do app que eu lance algo à mão — Diário,
  Endividamento, Fluxo de caixa — data, descrição, categoria, conta, e se
  foi pago/recebido.
- Como usuário, eu quero clicar numa categoria-mãe num gráfico e ver as
  transações das categorias-filhas dela, sem trocar de tela.

## Modelo de dados
Nenhuma tabela nova. Lê e edita `transactions` diretamente
(`services/transactions.ts`), já documentado em
`specs/import-and-categorization`.

## Contrato de API
Reaproveita o que já existe: `/transactions` (GET com `direction`,
`categoryId`, `parentCategoryId`, `search`), `/transactions/categorize`,
`/transactions/:id` (PATCH). Nenhuma rota nova para o seletor de direção
nem para o formulário padronizado — são só front-end.

## Regras de negócio
- **Seletor de direção substitui os checkboxes atuais de "Entradas e
  saídas / Só entradas / Só saídas"**: um único controle com três estados
  (Entrada, Saída, Transferência), mapeado para `direction` (entrada/saída)
  e `categoryId`/`kind = transfer` (transferência) na query já existente —
  nenhum campo novo no backend, "transferência" já é distinguível pelo
  `kind` da categoria.
- **Formulário de lançamento manual é o mesmo componente em toda tela que
  lança à mão** — Diário (`specs/daily-ledger`), edição de pendência
  (`specs/cash-flow-reconciliation`), pagamento de dívida
  (`specs/debt`), reajuste de saldo (`specs/settings-accounts-profiles`).
  Campos: recebido/pago (booleano, mapeia para `pending`), data, descrição,
  categoria, conta. Sem campo de anexo — decisão deliberada, não lacuna:
  ver Fora de escopo.
- **Dropdown de categoria-mãe** nos gráficos de categoria (Dashboard e
  aqui): clicar numa fatia de categoria-mãe abre a lista de transações
  filtrada por `parentCategoryId`, reaproveitando o filtro que a rota
  `/transactions` já aceita — não uma tela nova.

## UI
`Transactions.tsx`: seletor de direção no lugar dos checkboxes atuais,
formulário de lançamento manual compartilhado (extraído para
`components/forms/TransactionForm.tsx`, reaproveitado pelas outras áreas
citadas acima). Gráficos de categoria-mãe (Dashboard) ganham o dropdown de
filhos.

## Casos de borda
- Transferência sem contraparte pareada ainda: aparece na lista de
  transferências normalmente, sem tentar advinhar o par — pareamento
  visual é assunto do Sankey (`specs/dashboard`), não desta lista.

## Fora de escopo
- Anexo de comprovante/nota fiscal por lançamento — decisão deliberada de
  não incluir nesta padronização; se voltar a ser pedido, é extensão à
  parte, com o próprio armazenamento local a decidir (`data/anexos/`, fora
  do SQLite).

## Busca unificada por descrição, categoria e data (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero digitar o nome de uma categoria, uma data
  (`15/08`, `agosto`, `2026-08`) ou uma palavra da descrição no MESMO
  campo de busca e achar o lançamento, sem precisar saber de antemão em
  qual desses três está o que eu lembro.

### Regras de negócio
- Um campo só, sempre — nunca um segundo campo nem um seletor de "buscar
  por". O termo digitado é testado em paralelo (OR) contra: descrição
  normalizada, categoria bruta da importação (já existia antes),
  **nome da categoria real atribuída** (contra `categories.name`, acento e
  caixa ignorados — resolvido em JS, não numa coluna normalizada nova,
  porque a tabela de categorias é pequena), e **data**, quando o termo
  parece uma (ver `decisions/0025`).
- Formatos de data reconhecidos: `DD/MM/AAAA`, `DD/MM` (qualquer ano),
  `AAAA-MM-DD`, `AAAA-MM`, nome de mês por extenso ou abreviado em
  português, com ou sem ano (`agosto`, `ago`, `agosto de 2026`,
  `ago/2026`). Um número solto nunca é tratado como data — combinaria
  com valores e descrições numéricas, um falso positivo pior que buscar
  e não achar nada.

### UI
Placeholder do campo atualizado para "Buscar por descrição, categoria ou
data…", único sinal visível de que o campo agora entende mais que
descrição.

## Exclusão com escopo, quando a linha pertence a um template (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero que excluir uma transação que tem parcelas
  futuras me pergunte se é só esta, esta e as futuras, ou todas — em vez
  de excluir só a que cliquei e deixar as outras se materializando
  sozinhas, ou de eu ter que caçar e excluir uma por uma.

### Regras de negócio
- Antes de excluir (`POST /transactions/delete`), se algum id selecionado
  tiver `forecastId` ou `debtId` preenchido e existir mais de uma
  ocorrência pendente do mesmo template, a exclusão pausa e abre o modal
  de escopo (`decisions/0020`) em vez de excluir direto. Uma transação sem
  template (a maioria — CSV, diário, manual) continua excluindo direto,
  sem nenhum modal extra.
- A ação de fato acontece via `DELETE /cash-flow/pending/:id` (o mesmo
  endpoint de `specs/cash-flow-reconciliation`), não uma segunda
  implementação — Lançamentos só decide QUANDO perguntar, o serviço que
  decide O QUE fazer com cada escopo já existe.

### UI
Modal com três opções (Apenas esta / Esta e as futuras / Todas), mesmo
padrão de confirmação explícita já usado em restauração de backup e
conciliação — nunca um clique único para a opção mais destrutiva
("Todas").
