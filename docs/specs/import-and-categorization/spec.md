# Spec: Importação e categorização

Status: implementado

## Objetivo
Transformar um extrato de banco em CSV num conjunto de lançamentos revisados,
deduplicados e categorizados, sem exigir código novo por banco.

## Histórias de usuário
- Como usuário, eu quero enviar o CSV de qualquer um dos 6 bancos que uso e
  ter o formato detectado automaticamente, para não escolher manualmente
  toda vez.
- Como usuário, eu quero ver cada linha antes de gravar, para pegar uma
  linha malformada ou uma duplicata antes que ela entre no ledger.
- Como usuário, eu quero que uma regra que eu já ensinei categorize
  automaticamente o próximo lançamento parecido.

## Modelo de dados
- `accounts` — conta de destino de cada importação.
- `parserProfiles` — um perfil por dialeto de banco: delimitador,
  codificação, formato de data, separadores, convenção de sinal, mapa de
  colunas, assinatura de cabeçalho, padrões de linha a ignorar.
- `importBatches` — um registro por upload, com o perfil e a conta usados.
- `stagedTransactions` — linhas cruas do CSV, com erro de parsing (se
  houver) e uma sugestão de categoria, antes de qualquer commit.
- `transactions` — destino final. `sourceBatchId` rastreia de onde veio.
- `categories`, `categoryRules`, `categoryMemory` — ver seção de regras.

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/import/detect` | POST | Recebe o CSV bruto, devolve o perfil detectado (ou candidatos) e `suggestedSkipRows` |
| `/import/stage` | POST | Faz o parsing contra um perfil e grava em `stagedTransactions`, com sugestão de categoria por linha |
| `/import/commit` | POST | Move linhas de staging para `transactions`, marcando duplicata |
| `/accounts`, `/accounts/profiles` (CRUD) | — | Gestão de contas e perfis, ver `specs/settings-accounts-profiles` |
| `/categories`, `/rules`, `/rules/memory/:signature`, `/rules/recategorize` | CRUD + ação | Árvore de categorias, regras, memória aprendida, recategorização em massa |
| `/transactions` | POST | Cria um lançamento à mão (entrada ou saída, qualquer data) — não passa por staging/commit, pois não veio de um CSV. Complementa o lançamento rápido do Diário (`specs/daily-ledger`), que é só saída e sempre hoje |
| `/transactions/categorize` | POST | Categoriza uma lista de ids; `learn` grava memória; `saveAsRule` promove direto a regra |

## Regras de negócio
- **Detecção por assinatura de cabeçalho:** varre as primeiras 15 linhas
  procurando a que casa com `headerSignature` de algum perfil; devolve
  `suggestedSkipRows` para extratos com preâmbulo (ex. Inter, 5 linhas).
- **Convenção de sinal** é dado do perfil, uma de quatro: `signed` (uma
  coluna, `−` é saída), `signed_inverted` (fatura de cartão: positivo é
  compra), `debit_credit` (colunas separadas), `type_flag` (valor absoluto +
  coluna D/C).
- **Dedupe por impressão digital:** hash de `conta + data + valor +
  descrição normalizada` (`dedupeHash`, `core/normalize.ts`). Detecta
  repetição dentro do arquivo e contra o que já existe; reimportar o mesmo
  extrato marca tudo como duplicata e grava zero linhas novas.
- **Categorização em duas camadas** (`categorize/engine.ts`):
  1. Regras, ordenadas por prioridade (menor primeiro), primeira que casa
     ganha. `match_type` é `contains` | `starts_with` | `equals` | `regex`,
     avaliado contra `descriptionNorm` (ou `raw_category`).
  2. Memória: frequência de correção manual por `merchantSignature`. Só
     sugere; nunca decide sozinha. Promove a regra automaticamente na
     terceira confirmação (`AUTO_PROMOTE_AT = 3`).
  3. Categoria bruta do banco, se o nome bater com uma categoria existente.
  4. Sem categoria — nunca um palpite. Ver `decisions/0008` para o motivo
     de uma regra genérica de baixa prioridade precisar excluir seus falsos
     positivos conhecidos.
- **`merchantSignature`** descarta tokens de ruído (verbos de
  transferência, boilerplate de adquirente, dígitos) e mantém os dois
  primeiros tokens de identidade — nunca uma palavra puramente gramatical
  (ver `decisions/0008`).
- **Prioridade de regra reflete intenção:** 20 = regra salva explicitamente
  pelo usuário; 50 = promovida de correção repetida; 80+ = padrão genérico
  do seed.

## UI
`ImportPage` (`src/pages/Import.tsx`): drop de CSV → detecção → tela de
revisão (linha por linha, com erro visível, não descartado em silêncio) →
commit. `CategoriesPage` (`src/pages/Categories.tsx`): árvore de categorias,
CRUD de regras, editor de memória aprendida.

## Casos de borda
- Linha malformada: preservada com o erro visível, nunca descartada sem
  aviso.
- Banco não reconhecido: aparece como tal na tela, nunca assume um perfil
  errado.
- PicPay não exporta tabela — é normalizado por `scripts/normalize-picpay.ts`
  antes de entrar no pipeline genérico (ver README, seção "PicPay é um caso
  especial").

## Fora de escopo
- Qualquer integração bancária automática (open finance). Importação é
  sempre um upload manual de arquivo.
- Categorização por machine learning — deliberadamente só regra + memória
  de frequência (ver comentário em `categorize/engine.ts`).
