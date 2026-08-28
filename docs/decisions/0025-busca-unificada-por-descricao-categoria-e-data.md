# 0025. Busca de lançamentos aceita categoria e data no mesmo campo

Status: aceita

## Contexto
O campo "Buscar por descrição…" em Lançamentos (`buildWhere`,
`server/src/services/transactions.ts`) só comparava o termo digitado
contra `descriptionNorm` e `rawCategory` (a categoria BRUTA do banco na
importação, não a categoria que o usuário de fato atribuiu). Um usuário
digitando o nome de uma categoria real ("Restaurante"), uma data
("15/08" ou "agosto") não encontrava nada, mesmo com lançamentos que
batiam exatamente com o que ele procurava — porque nenhum desses dois
sinais nunca foi comparado.

## Decisão
Um único campo continua existindo (nenhum segundo campo, nenhum modo de
busca para escolher) — o termo digitado passa a ser testado contra
QUATRO sinais em paralelo (OR, nunca AND entre eles: o usuário não
precisa saber em qual campo o que ele lembra está):

1. Descrição normalizada (já existia).
2. Categoria bruta da importação (já existia, `rawCategory`).
3. **Nome da categoria real atribuída** — comparação por substring,
   acento e caixa ignorados, contra `categories.name` (via IDs
   pré-filtrados em JS, não uma coluna normalizada nova: a tabela de
   categorias é pequena, então isso nunca vira um scan pesado).
4. **Data**, se o termo digitado parece uma — reconhece
   `DD/MM/AAAA`, `DD/MM` (qualquer ano), `AAAA-MM-DD`, `AAAA-MM`, e nome
   de mês por extenso ou abreviado em português (`agosto`, `ago`),
   com ou sem ano (`agosto de 2026`, `ago/2026`). Um número solto (ex.
   "15") NÃO é tratado como data — combinaria com quase toda descrição e
   valor, um falso positivo pior que não achar nada.

## Alternativas consideradas
- **Campos de busca separados (descrição / categoria / data):** descartada
  — o pedido explícito era "buscar pelos lançamentos... direto no campo
  de busca", ou seja, um campo só que entende tudo, não uma busca
  avançada com mais controles.
- **Coluna normalizada para nome de categoria** (equivalente a
  `descriptionNorm`): descartada — a tabela de categorias é pequena o
  bastante (algumas centenas de linhas, no máximo) para filtrar em JS a
  cada busca sem custo real, então não precisa da manutenção extra de
  manter uma segunda coluna sincronizada.
- **Reconhecer qualquer sequência numérica como possível dia:**
  descartada — geraria falsos positivos constantes (valor de R$ 15,00
  batendo com "dia 15" de qualquer mês), pior que a busca não achar nada.

## Consequências
- `server/src/services/transactions.ts`: `buildWhere` ganha
  `categoryIdsMatching` (JS, não SQL) e `parseSearchDate` (retorna uma
  condição SQL sobre `postedOn` ou `null` se o termo não parece data);
  os dois se somam ao `OR` que já existia para descrição/`rawCategory`.
- `src/pages/Transactions.tsx`: placeholder do campo atualizado para
  descrever as quatro possibilidades.
- `specs/transactions-ledger`, seção de busca, documenta os quatro
  sinais e os formatos de data reconhecidos.
- `scripts/verify.ts`: novo módulo cobrindo busca por categoria (nome
  real, não `rawCategory`), por cada formato de data reconhecido, e
  confirmando que um número solto não vira falso positivo de data.
