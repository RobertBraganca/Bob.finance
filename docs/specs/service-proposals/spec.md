# Orçamentos de serviço

Status: implementado (05/10/2026). Decisão: `decisions/0040`. Plano: `plan.md`.

Desvios do que foi especificado:
- O pacote do PDF (`pdf-lib` + `@pdf-lib/fontkit` + fontes) ficou com ~507 KB
  comprimidos, não ~200 KB; continua carregado só no primeiro Compartilhar.
- O status também quebra linha no celular (`segmented--nav`), como as abas.

## Objetivo

Montar, enviar e acompanhar orçamentos de serviço para clientes dentro de
Precificação: título, cliente, uma lista de serviços com preço e quantidade,
desconto, total, condições comerciais, um PDF com a marca do negócio para
mandar ao cliente, e a aprovação gerando as receitas a receber.

Referência visual: cinco telas de app (lista, filtro, formulário, serviço,
detalhe) entregues pelo usuário em 05/10/2026, adaptadas ao design system
atual (cards, `KpiTile`, selos `.badge`, `Modal`, `Segmented`, tabelas
`table--stack-mobile`), funcionando no computador e a 375px.

## O que muda em relação às cotações

As cotações (`project_quotes`) continuam sendo a calculadora: preço a partir
de horas, custos e multiplicadores, congelado na simulação (`decisions/0021`).
O orçamento é o documento que vai ao cliente. Cada serviço do orçamento pode
ser digitado à mão ou trazido de uma cotação salva, com o preço recomendado
dela; a partir daí o item é independente (apagar a cotação não muda o item).

## Dados

### `service_proposals`
| Coluna | Tipo | Observação |
|---|---|---|
| `id` | bigint identity | |
| `number` | int, único | sequencial, exibido como `#0001` |
| `title` | text, obrigatório | |
| `client_label` | text, obrigatório | texto livre, como nas cotações (`decisions/0012`) |
| `status` | enum `proposal_status`: `draft`, `sent`, `approved`, `rejected` | default `draft` |
| `discount_bps` | int, 0 a 10000 | desconto em % sobre o subtotal |
| `validity_days` | int | default vem de `proposal_issuer_settings.default_validity_days` |
| `installments` | int ≥ 1 | default 1; vira o padrão da aprovação |
| `payment_terms` | text | ex.: "50% na entrada, 50% na entrega" |
| `delivery_terms` | text | ex.: "30 dias úteis após aprovação" |
| `notes` | text | observações no fim do documento |
| `sent_at` | text (data) | primeira vez que foi compartilhado |
| `approved_amount_cents` | int | total congelado na aprovação; nulo fora dela |
| `created_at`, `updated_at` | text | `now_iso()` |

### `service_proposal_items`
| Coluna | Tipo | Observação |
|---|---|---|
| `id` | bigint identity | |
| `proposal_id` | FK `service_proposals`, `on delete cascade` | |
| `title` | text, obrigatório | |
| `description` | text | |
| `unit_price_cents` | int ≥ 0 | |
| `quantity` | double precision > 0 | aceita decimais (12,5 horas) |
| `sort_order` | int | |
| `source_quote_id` | FK `project_quotes`, `on delete set null` | cotação de origem, se veio de uma |

### `proposal_issuer_settings` (uma linha só, `id = 1`)
`business_name`, `document` (CPF ou CNPJ, só dígitos), `email`, `phone`,
`logo_path` (caminho no Storage), `default_validity_days` (default 15).

### `transactions.source_proposal_id`
FK `service_proposals`, `on delete set null`, com índice. Liga cada receita
gerada pela aprovação ao orçamento, igual a `source_quote_id`.

### Logo
Bucket privado `proposal-assets` no Storage, política de acesso só para o
usuário admin (`ADMIN_USER_ID`). Upload pelo cliente Supabase autenticado;
o PDF busca a imagem por URL assinada de curta duração. PNG ou JPG, até 1 MB.

### Totais
Nunca guardados (PRD: "derivar, nunca guardar"). Funções puras em
`shared/proposals.ts` (tela e servidor Node, como `shared/accountFlowGraph.ts`)
com espelho idêntico em `supabase/functions/_shared/core/proposals.ts` (as
Edge Functions não alcançam `shared/`):
- `subtotal = Σ round(unit_price_cents × quantity)`
- `discount = round(subtotal × discount_bps / 10000)`
- `total = subtotal − discount`
- `splitInstallments(total, n)`: parcelas iguais em centavos, a sobra de
  arredondamento na última.

## Servidor

Rotas em `/pricing/proposals` (Fastify `server/src/routes/pricing.ts` e Edge
Function `supabase/functions/pricing`), serviço `services/proposals.ts` com
espelho Deno idêntico exceto imports.

| Rota | O que faz |
|---|---|
| `GET /pricing/proposals?q=&status=&sort=` | lista com totais derivados; `sort`: `recent`, `oldest`, `value_desc`, `value_asc`; `status` aceita vários |
| `GET /pricing/proposals/summary` | aguardando resposta (soma dos `sent`), aprovados no ano (soma), taxa de aprovação (aprovados ÷ (aprovados + recusados)) |
| `GET /pricing/proposals/:id` | orçamento com itens, totais e receitas geradas |
| `POST /pricing/proposals` | cria (rascunho por padrão) |
| `PATCH /pricing/proposals/:id` | edita campos e substitui a lista de itens |
| `POST /pricing/proposals/:id/duplicate` | cópia como rascunho, número novo, "(cópia)" no título, sem datas de envio/aprovação |
| `POST /pricing/proposals/:id/status` | `draft`, `sent` ou `rejected`; ver regras |
| `POST /pricing/proposals/:id/mark-sent` | chamado depois do compartilhamento; só muda `draft` → `sent` e grava `sent_at` |
| `POST /pricing/proposals/:id/approve` | ver regras |
| `DELETE /pricing/proposals/:id` | ver regras |
| `GET /pricing/proposals/item-suggestions?q=` | títulos já usados, com a última descrição e o último preço |
| `GET`/`PUT /pricing/proposal-issuer` | dados do emissor |

### Regras
1. **Enviar ou aprovar exige pelo menos um serviço.** Rascunho pode ficar vazio.
2. **Aprovar** recebe `accountId`, `firstDueOn`, `installments` (default o do
   orçamento) e `firstAlreadyReceived` (default `false`):
   - divide o total em parcelas mensais (`splitInstallments`);
   - cria uma receita por parcela, descrição `Orçamento #0001: <título>`
     (com `(1/3)` quando parcelado), `source_proposal_id` preenchido, sem TAG;
   - todas pendentes, exceto a primeira quando `firstAlreadyReceived`;
   - grava `status = approved` e `approved_amount_cents = total`.
3. **Aprovado trava o valor.** Itens e desconto não mudam enquanto aprovado
   (o servidor recusa); validade, condições, prazo e observações continuam
   editáveis, como em `decisions/0021` para as cotações.
4. **Sair de aprovado** (para `draft`, `sent` ou `rejected`) apaga as receitas
   do orçamento que ainda estão pendentes. Se alguma já foi confirmada
   (`pending = false`), a mudança é recusada com a lista do que já entrou.
5. **Excluir** segue a mesma regra do item 4.
6. **Validações**: título e cliente não vazios, preço ≥ 0, quantidade > 0,
   desconto entre 0 e 100%, parcelas ≥ 1.

### Ligação automática com o extrato (extensão de `decisions/0039`)
Hoje a importação liga sozinha um pagamento só a parcela pendente de
previsão ou dívida. Passa a reconhecer também receitas pendentes com
`source_proposal_id`:
- `pendingScheduleCandidates` inclui pendências com `source_proposal_id`;
- `linkToSchedule`, numa pendência de orçamento: apaga a pendência e grava
  no lançamento real o `source_proposal_id` (e a TAG da pendência, se o real
  não tiver);
- `unlinkFromSchedule` (desfazer importação): recria a pendência com o
  valor, a data e a descrição do lançamento real e o mesmo
  `source_proposal_id`.

## Telas

Precificação passa a ter três abas no cabeçalho (padrão de Investimentos):
**Orçamentos** (padrão) | **Cotações** | **Parâmetros**, com o botão primário
**Novo orçamento** na aba Orçamentos e **Nova cotação** na aba Cotações.

### Lista (`/precificacao` e `?aba=orcamentos`)
- Subtítulo: "N em rascunho" quando houver.
- `kpi-row--3`: Aguardando resposta (destaque), Aprovados no ano, Taxa de
  aprovação, cada um com ⓘ.
- Busca (título ou cliente) e botão **Filtrar e ordenar**.
- Tabela: título e cliente, status (selo), serviços, atualizado, total. No
  celular, `table--stack-compact` em cartões. Clicar abre o detalhe.
- Selos: rascunho `.badge`, enviado `.badge--info`, aprovado `.badge--good`,
  recusado `.badge--critical`.
- Vazio: estado vazio com "Criar primeiro orçamento".

### Filtrar e ordenar
`Modal` com status em caixas de seleção e ordenação em opções únicas (Mais
recente, Mais antigo, Maior valor, Menor valor); **Limpar filtros** e
**Aplicar**. Filtros e ordenação ficam no endereço (`?status=`, `?ordem=`).

### Formulário (`/precificacao/orcamentos/novo`, `/precificacao/orcamentos/:id/editar`)
- Cards: Informações gerais (título; cliente com sugestões dos já usados),
  Status (`Segmented` com os quatro; escolher Aprovado abre a aprovação),
  Serviços incluídos (lista com editar; **Adicionar serviço**; **Trazer de
  uma cotação**), Condições (validade em dias com "válido até dd/mm",
  parcelas, condições de pagamento, prazo de entrega, observações),
  Investimento (itens, subtotal, desconto % com o valor em reais, total).
- Computador: duas colunas, Investimento fixo à direita ao rolar. Celular:
  uma coluna.
- Rodapé: **Cancelar** e **Salvar**. Sair com alterações não salvas pede
  confirmação.
- Orçamento aprovado: serviços e desconto aparecem só para leitura, com a
  explicação de que voltar o status libera a edição.

### Janela de serviço
Título (com sugestões dos já usados, que preenchem descrição e preço),
descrição, preço em R$ e quantidade com − e +; **Excluir** (ícone) e
**Salvar**. "Trazer de uma cotação" abre a lista de cotações salvas
(cliente, horas, preço recomendado) e cria o item com título editável,
descrição "Estimativa de N horas" e o preço recomendado.

### Detalhe (`/precificacao/orcamentos/:id`)
- Cabeçalho "Orçamento #0001" com o selo de status e voltar.
- Card do orçamento: título, cliente, criado em, atualizado em, válido até.
- Serviços incluídos, Investimento (selo "8% off" quando houver desconto),
  Condições e Observações.
- Ações em ícone: Excluir, Duplicar, Editar. Ação principal por status:
  rascunho **Compartilhar**; enviado **Marcar como aprovado** (com
  Compartilhar e Recusado secundários); aprovado **Compartilhar** e o link
  "Ver receitas geradas" (Lançamentos filtrado); recusado **Duplicar**.

### Janela de aprovação
Conta (contas correntes), data do primeiro recebimento, parcelas (default do
orçamento), "a primeira parcela já foi recebida" (desmarcada), e o resumo
"3 receitas de R$ 1.282,50, a partir de dd/mm".

### Parâmetros: card "Dados do orçamento"
Nome comercial, CPF/CNPJ (com máscara), e-mail, telefone, logo (envio com
prévia e remover), validade padrão em dias.

## PDF e compartilhar

- `pdf-lib` + `@pdf-lib/fontkit`, carregados por `import()` só no primeiro
  Compartilhar. Fontes: os mesmos `.ttf` da Barlow que o app já usa
  (`src/assets/fonts`, importados com `?url`, também sob demanda).
- A4, margens de 18 mm. Cabeçalho com logo e dados do emissor; número,
  título, cliente, emissão e "válido até"; tabela de serviços (serviço e
  descrição, quantidade, unitário, total), repetindo o cabeçalho ao quebrar
  página; subtotal, desconto e total; condições de pagamento, prazo de
  entrega, observações; rodapé "página 1 de 2".
- Arquivo: `Orcamento-0001-<cliente-sem-acentos>.pdf`.
- Compartilhar: `navigator.canShare({ files })` → folha de compartilhar do
  sistema; sem suporte, download. Só depois de concluir (compartilhado ou
  baixado) chama `mark-sent`. Fechar a folha sem enviar (`AbortError`) não
  muda nada.
- Sem dados do emissor: o primeiro Compartilhar leva ao card de Parâmetros.
  Logo que não carrega: o PDF sai sem ela e o aviso diz isso.

## Fora de escopo
- Link público para o cliente aceitar online.
- Catálogo de serviços separado (as sugestões vêm do histórico).
- Cadastro de clientes (`decisions/0012`).
- Assinatura digital, impostos destacados (ISS), moedas além de real.
- Aprovação recorrente (retainer) a partir de orçamento: existe só nas cotações.

## Verificação
- `shared/proposals.ts`: script `tsx` com os casos de borda (desconto 0 e
  100%, quantidade decimal, parcelas com sobra de centavos, total zero).
- `tsc` do projeto e do build, `vite build`, `deno check` das funções
  `pricing` e `ledger`, espelhos Node/Deno idênticos exceto imports.
- Navegador, computador e 375px, só leitura nas telas.
- Fluxo completo (criar, compartilhar, aprovar, voltar, excluir) com um
  orçamento "[teste]" só com autorização do usuário, apagado no fim junto
  das receitas geradas.

## Para publicar
Migração (tabelas, enum, coluna em `transactions`, bucket e política do
Storage); deploy das funções `pricing` (orçamentos) e `ledger` (ligação
automática estendida).
