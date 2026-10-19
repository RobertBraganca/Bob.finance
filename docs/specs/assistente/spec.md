# Spec: Assistente em linguagem natural

Status: proposta (18/10/2026), aguardando revisão. Nada implementado.

## Objetivo
Deixar o usuário **escrever uma frase solta** e o sistema fazer o cadastro:
achar a pendência certa, corrigir a data de pagamento se estiver fora e gravar
um comentário na transação. Vale para receitas, despesas, Diário, aportes,
compras e vendas de ativos.

Exemplo que guia o desenho:

> "Receita Coral Opus de R$ 750,00, 50% finais, pagamento previsto para
> segunda-feira dia 19."

O assistente acha a pendência "Coral Opus" de R$ 750,00, muda a data para
19/10/2026 (segunda-feira) e grava "50% finais" em `notes`.

Registro e organização, nunca recomendação (decisions/0010).

## Histórias de usuário
- Quero avisar uma mudança de data ou valor em uma frase, sem abrir a pendência.
- Quero lançar uma receita ou despesa nova só descrevendo.
- Quero registrar uma entrada do Diário, um aporte, uma compra ou uma venda
  falando do jeito que eu falaria.
- Quero ver exatamente o que vai mudar **antes** de gravar, e poder desfazer.
- Quero que o chat pergunte quando a frase for ambígua, em vez de adivinhar.

## Decisões já tomadas (com o usuário, 18/10/2026)
| Decisão | Escolha |
|---|---|
| Gravação | **Mostrar e confirmar**: nada grava sem o Confirmar do usuário; há Desfazer |
| Escopo da 1ª versão | Tudo de uma vez: pendências, lançamentos, Diário, aportes, compras e vendas |
| Onde fica | Painel lateral em todas as telas (tela cheia no celular) |
| Arquitetura | Modelo com ferramentas **de leitura**, que propõe ações; o servidor valida e aplica |

## Fora de escopo
- Conselho: o que comprar, vender ou quanto aportar (decisions/0010).
- Gravar sem confirmação, em qualquer caso.
- Criar ativos, contas, TAGs, metas ou dívidas novas (só usa as que existem).
- Ler ou enviar o extrato inteiro ao modelo.
- Voz, anexos e importação de arquivos pelo chat.

## A. Fluxo
1. O usuário escreve a frase no painel.
2. `POST /assistant/message` recebe `{ text, conversationId? }` e monta o
   contexto: data de hoje em America/Sao_Paulo, contas, TAGs e a lista curta
   de ativos. **Não** envia o extrato.
3. O modelo (Claude) usa ferramentas de **leitura**:
   - `search_pending({ amountCents?, text?, from?, to?, flow? })`;
   - `search_transactions({ amountCents?, text?, from?, to? })`;
   - `list_assets()`;
   - `list_accounts()`.
   O casamento (valor, texto normalizado e janela de data) é feito por código
   nessas ferramentas; o modelo escolhe entre os candidatos ou pergunta.
4. O modelo devolve uma **proposta**:
   `{ summary, actions: Action[] (até 5), questions: string[] }`.
5. O servidor valida cada ação (A.1), guarda a proposta e devolve
   `{ proposalId, summary, cards[], questions[] }`. `cards` traz o antes e o
   depois de cada campo, com destaque quando algo diverge (valor diferente,
   data muito distante).
6. O usuário confirma, edita ou cancela cada card.
7. `POST /assistant/apply` recebe **só** `{ proposalId, confirmedActionIds[] }`.
   O servidor aplica o que ele mesmo guardou (nunca o corpo do navegador), numa
   única transação, e grava o antes/depois.
8. A resposta traz o resultado e um `undoToken`. `POST /assistant/undo`
   reverte pela imagem "antes" enquanto nada tiver mudado desde então.

A proposta expira em 15 minutos. Frase ambígua gera `questions` e nenhuma ação.

### A.1 Ações da primeira versão (zod, `core/assistant.ts`)
| Ação | Campos | Chama |
|---|---|---|
| `update_pending` | `pendingId`, `postedOn?`, `amountCents?`, `notes?` | `cashFlow` (pendência) |
| `add_note` | `transactionId`, `note` (acrescenta, não substitui) | `transactions` |
| `create_transaction` | `flow` income/expense, `description`, `amountCents`, `postedOn`, `accountId`, `categoryId?`, `pending`, `notes?` | `transactions` |
| `diary_entry` | `postedOn`, `description`, `amountCents`, `accountId`, `categoryId?` | mesmo caminho do lançamento rápido do Diário |
| `record_trade` | `assetId`, `kind` buy/sell, `quantity`, `unitPriceCents`, `tradedOn`, `feesCents?` | `investments` |
| `reserve_contribution` | `amountCents`, `contributedOn`, `assetId?` | `investments` (aporte na reserva) |

Cada ação se valida contra o banco antes de virar card: o `pendingId` existe e
está pendente, o `assetId` existe e não está arquivado, a conta existe, o valor
é positivo.

## B. Regras de segurança
1. **O modelo nunca grava.** Só o `apply`, depois do Confirmar.
2. **Datas relativas são do servidor.** O modelo manda a data resolvida; o
   servidor confere o dia da semana citado ("segunda, dia 19": 19/10/2026 é
   segunda). Se não bater, vira pergunta, não correção.
3. **Investimentos exigem os três campos**: ativo, quantidade e preço. Faltou
   algum, o chat pergunta. Ativo que não existe: o chat avisa e não cria.
4. **Sem conselho.** O prompt do sistema e um filtro de saída recusam
   "devo comprar/vender/aportar" e respondem só que registra, não aconselha.
5. **Dados mínimos para a API:** a frase e os candidatos (descrição, valor, data,
   conta). Nada de extrato completo, saldos ou dados de cartão.
6. **Limites:** frase de até 600 caracteres, 20 mensagens por minuto, 5 ações
   por proposta.
7. **Auditoria:** `assistant_actions` guarda frase, proposta, o que foi aplicado
   e o antes/depois. Dados de teste usam o rótulo `[teste]`.
8. **A chave** da API é segredo da função (`ASSISTANT_API_KEY`), nunca vai ao
   navegador nem ao banco.

## C. Dados
Tabela nova `assistant_actions` (migração, com autorização):

| Coluna | Tipo |
|---|---|
| `id` | serial |
| `proposal_id` | uuid |
| `phrase` | text |
| `proposal` | jsonb |
| `applied` | jsonb (ações aplicadas, com antes/depois) |
| `status` | enum `proposed` / `applied` / `undone` / `expired` |
| `created_at`, `applied_at`, `undone_at` | timestamptz |

Sem coluna nova em `transactions`: o comentário usa `notes`, que já existe.

## D. API
- `POST /assistant/message`, `POST /assistant/apply`, `POST /assistant/undo`
  na função Edge `assistant` e no Fastify (`server/src/routes/assistant.ts`).
- `GET /assistant/history?limit=` para reabrir conversas recentes.
- O serviço fica em `server/src/services/assistant/` (`intent.ts`, `matcher.ts`,
  `actions.ts`, `apply.ts`) com espelho em `supabase/functions/_shared`.
- **Regra do pooler (Edge):** consultas em sequência, nunca `Promise.all`.

## E. Interface
- Botão fixo no canto, em todas as telas; abre o painel de conversa.
- Mensagens do usuário e do assistente; cada proposta vira cards com
  **Confirmar**, **Editar** (campos do card) e **Cancelar**.
- Depois de aplicar, o card mostra o resultado e **Desfazer**.
- Estados: pensando, pergunta de volta, erro do modelo, proposta expirada.
- Acessível: painel com foco preso, atalho de teclado, `aria-live` nas respostas.

## F. Falhas
| Situação | Comportamento |
|---|---|
| Chave ausente ou API fora do ar | mensagem clara; nada grava |
| Nenhum candidato | pergunta se é um lançamento novo |
| Vários candidatos | lista para o usuário escolher |
| Valor diverge do cadastro | card destacado, nunca corrige sozinho |
| Proposta expirada ou já aplicada | pede para reenviar |
| Falha no meio do `apply` | transação desfeita; nada fica pela metade |

## G. Testes
- **Unitários (modelo simulado):** cerca de 30 frases em português cobrindo
  datas relativas, "50% finais", valores com vírgula e ponto, frases ambíguas e
  investimentos incompletos; o casamento e a validação são determinísticos.
- **Aplicação:** transação única, antes/depois corretos, `undo` revertendo e
  recusando quando algo mudou.
- **Segurança:** `apply` ignora ações que não estão na proposta guardada;
  recusa de conselho; limites.
- **Integração:** dados `[teste]` no banco real, desfeitos ao final.
- **Edge:** varredura sob Deno com a configuração do pooler de transação
  (`scratchpad/edge_sweep.ts`) antes de publicar.

## H. Riscos e pontos em aberto
- **Escopo grande de uma vez** (escolha do usuário): aporte, compra e venda são
  os de maior risco; a regra B.3 e o Confirmar são a defesa. Se a primeira
  entrega atrasar, investimentos podem sair para uma segunda etapa sem mudar o
  desenho.
- **Modelo e custo:** Haiku 5.5 para extração (barato) com Sonnet 5.5 quando a
  frase for ambígua; a escolha final sai do primeiro teste com as 30 frases.
- **Quem paga a API:** o usuário cria a chave e a guarda como segredo da função;
  eu não escrevo no Vault.
- **Histórico de conversa:** nesta versão só o das últimas mensagens da sessão;
  memória de longo prazo fica fora.
