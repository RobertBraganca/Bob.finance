# Spec: Contas, bancos e categorias

Status: implementado

## Objetivo
O ponto único de configuração que toda outra área depende de: quais contas
existem, como ler o CSV de cada banco, e a árvore de categorias usada em
todo o app.

## Histórias de usuário
- Como usuário, eu quero cadastrar uma conta nova (banco, tipo, saldo
  inicial) antes de importar seu extrato.
- Como usuário, eu quero criar ou ajustar um perfil de leitura de CSV para
  um banco novo sem precisar de código.
- Como usuário, eu quero arquivar uma conta que não uso mais sem perder o
  histórico de lançamentos que ela já tem.
- Como usuário, eu quero organizar categorias em árvore (pai/filho), cada
  uma com uma das 4 cores categóricas da identidade visual.

## Modelo de dados
- `accounts` — nome, instituição, tipo, saldo inicial (o saldo exibido é
  sempre derivado dos lançamentos, nunca este campo isoladamente — editar o
  saldo nunca cria, apaga ou altera um lançamento, ver "Conferência de
  saldo" abaixo).
- `parserProfiles` — ver `specs/import-and-categorization`.
- `categories` — árvore de um nível (pai → filhos), com `kind`.

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/accounts` | GET/POST | Lista/cria |
| `/accounts/:id` | PATCH/DELETE | Não aceita mais saldo em nenhuma forma (ver `decisions/0018`) — editar arquiva se já houver lançamento; exclui só se a conta estiver vazia |
| `/transactions` (POST, `source: 'adjustment'`) | POST | Conferência de saldo grava aqui, ver abaixo |
| `/import/profiles` (CRUD) | — | Perfil de leitura de CSV |
| `/categories` (CRUD em árvore) | — | Ver `specs/import-and-categorization` para regras e memória |

## Regras de negócio
- **Saldo nunca é editado direto, só conferido.** `decisions/0018`
  substitui o campo "Saldo atual" por uma tela de conferência: o usuário
  informa o saldo real (do extrato do banco), o app mostra a diferença
  contra o saldo derivado, e oferece duas ações — "lançar como reajuste"
  (`source: 'adjustment'`, categoria "Financeiro/Reajuste de saldo",
  `kind: 'transfer'`, não conta como receita nem despesa) ou "lançar como
  despesa/receita" (`source: 'manual'`, categoria escolhida pelo usuário —
  para dinheiro que realmente entrou/saiu e nunca foi lançado, ex. saque em
  espécie). As duas gravam uma `transaction` normal; nenhuma mexe em
  `openingBalanceCents`.
- **Excluir uma conta com lançamentos a arquiva**, nunca apaga o histórico
  — a conta some das listas e filtros, os lançamentos continuam existindo.
- **Nome de perfil de leitura de CSV é único** (`parser_profiles.name`
  tem índice único) e nunca usa travessão (ver `decisions/0007`) — inclui o
  banco e o tipo de extrato, ex. "Nubank Conta", "Itaú Extrato".
- **Cor de categoria é uma das 4 cores categóricas da marca**, validadas
  para daltonismo nas duas superfícies do app (ver `decisions/0002`);
  vermelho e amarelo ficam de fora porque já são reservados para status.

## UI
`Settings.tsx`: cards de Contas, Perfis de leitura de CSV (tabela com
delimitador, formato de data, convenção de sinal, codificação). O mesmo
editor de conta (`AccountModal`, sem campo de saldo) e a mesma
"Conferência de saldo" (`BalanceCheckModal`) são reaproveitados pelo card
"Contas" do Dashboard — uma só implementação de cada, dois pontos de
entrada.
`Categories.tsx`: árvore de categorias com seletor de cor, CRUD de regras
com prioridade, editor de memória aprendida.

## Casos de borda
- Perfil sem nenhum ativo ainda cadastrado nele: mostra vazio, não erro.

## Fora de escopo
- Multiusuário / permissão por conta — fora do PRD (seção 8).

## Reorganização da navegação (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero uma seção "Configurações" única (contas, cartões,
  categorias, objetivos, importação, tema/idioma), para não ter itens de
  infraestrutura competindo na barra lateral com as telas que abro todo dia.

### Regras de negócio
- Nenhum endpoint muda. É reorganização de onde a mesma tela já existente
  é montada, não uma feature nova — `CreditCards.tsx`, `Categories.tsx` e a
  própria `Settings.tsx` continuam sendo os mesmos componentes.
- `Sidebar` (`src/components/shell/Shell.tsx`) ganha um item único
  "Configurações" no grupo "Configurar", com sub-navegação (abas ou menu
  interno) para Contas, Cartões, Categorias e regras, Importar, Aparência.
  Cartões deixa de ter rota própria na barra lateral (`/cartoes` continua
  existindo como URL, só sai da lista principal).

### UI
Nenhum componente novo — reagrupamento do que já existe em `NAV`
(`Shell.tsx`) e uma tela-índice simples para a nova seção "Configurações".
