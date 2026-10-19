# Plano: Assistente em linguagem natural (specs/assistente)

Status: aguardando escolha do método de execução (19/10/2026). A spec foi
aprovada no mesmo dia. Nada implementado.

Cada etapa deixa o app funcionando sozinha e termina em verificação. Paradas
para a sua autorização estão marcadas com **Autorização**. Seguem as regras do
projeto: dado real só leitura, teste com `[teste]` e desfeito, migração só com
autorização, deploy de função é seu, **no Edge nunca `Promise.all` de consultas**
(docs/project-memory.md, 18/10/2026).

## Ponto de integração mais delicado (decidir já)
Os serviços de hoje usam o `db` global: `createTransaction`, `updateTransaction`
e a gravação de `asset_trades` não aceitam uma transação do chamador. O `apply`
precisa gravar várias ações de uma vez, tudo ou nada. Caminho escolhido: dar a
esses serviços um parâmetro opcional `executor` (a transação, `db` por padrão),
sem mudar nenhum chamador existente. O Edge usa o mesmo código por espelho.

### Etapa 0: preparação
- `docs/decisions/0046-assistente-em-linguagem-natural.md`: Claude pela API
  (chamada só no servidor), modelo só lê e propõe, nada grava sem Confirmar,
  sem conselho (0010), privacidade (só a frase e os candidatos).
- `npm run test:assistant` = `tsx --test scripts/assistant/*.test.ts` (node:test;
  o projeto não tem framework de teste e `scripts/verify.ts` está legado).
- **Autorização**: você cria a chave da API da Anthropic e a guarda como segredo
  das funções (`supabase secrets set ASSISTANT_API_KEY=...`). Só é preciso na
  etapa 7; eu não escrevo no Vault e não vejo a chave.

### Etapa 1: núcleo puro e testado (sem banco, sem rede)
- `shared/assistant.ts` (espelho em `_shared/core/assistant.ts`):
  - tipos das 6 ações em zod (`update_pending`, `add_note`, `create_transaction`,
    `diary_entry`, `record_trade`, `reserve_contribution`) e do formato da
    proposta (`summary`, `actions`, `questions`);
  - `resolveDate(text, today)`: "segunda dia 19", "amanhã", "dia 5", com a
    conferência do dia da semana (se não bater, devolve pergunta);
  - `parseMoney`: "R$ 750,00", "750", "1.250,50";
  - `scoreCandidate`: valor, texto normalizado (`normalizeDescription`) e janela
    de data, com `exact` / `likely` / `weak`.
- `scripts/assistant/core.test.ts`: cerca de 30 frases em português (datas
  relativas, "50% finais", vírgula e ponto, ambíguas, investimento incompleto).
- Verificação: `npm run test:assistant` verde, `tsc` limpo.

### Etapa 2: banco
- Migração `assistant_actions` (colunas na spec C), com índice por `proposal_id`
  e por `created_at`; `schema.ts` + espelho Deno. Conferir as versões em
  `schema_migrations` antes de escolher o número.
- **Autorização**: aplicar (só tabela nova; nenhum dado muda).

### Etapa 3: leitura e casamento (serviços)
- `services/assistant/matcher.ts`: `searchPending` (usa `listPending`) e
  `searchTransactions`, devolvendo no máximo 5 candidatos com `scoreCandidate`;
  `listContext` (contas, TAGs, ativos ativos) sem saldos nem cartões.
- Testes contra dados `[teste]` criados e removidos pelo próprio teste.
- Verificação: sob Deno com a configuração do Edge (`edge_sweep.ts`), sem travar.

### Etapa 4: aplicar e desfazer
- Parâmetro `executor` opcional em `createTransaction`, `updateTransaction` e na
  gravação de `asset_trades` (e `contributeToReserve`).
- `services/assistant/apply.ts`: valida cada ação contra o banco, aplica tudo em
  `db.transaction`, grava antes/depois em `assistant_actions`; `undo` reverte
  pela imagem "antes" e recusa se o registro mudou depois.
- Testes: tudo ou nada (uma ação inválida desfaz as outras), `undo` feliz e
  recusado, `apply` ignora ação que não está na proposta guardada.

### Etapa 5: modelo (LLM)
- `services/assistant/intent.ts`: chamada à API de mensagens com ferramentas de
  leitura (`search_pending`, `search_transactions`, `list_assets`,
  `list_accounts`), laço de no máximo 4 turnos, tempo limite, modelo barato
  primeiro e o maior só para ambiguidade; saída sempre validada pelo zod.
- Prompt do sistema em português: registra, não aconselha; recusa "devo
  comprar/vender/aportar"; pergunta em vez de adivinhar.
- Testes com o modelo simulado (as 30 frases), sem rede.
- Verificação opcional com a chave real (etapa 7), com 5 frases.

### Etapa 6: rotas
- `server/src/routes/assistant.ts` e função Edge `supabase/functions/assistant`
  (`/assistant/message`, `/assistant/apply`, `/assistant/undo`,
  `/assistant/history`), `requireAdmin`, limites (600 caracteres, 20/min,
  5 ações), `runInRequestScope`.
- `src/lib/api.ts`: `'/assistant'` aponta para a função `assistant`.
- Verificação: `tsc`, `deno check`, varredura sob Deno com a configuração do Edge.

### Etapa 7: tela
- `src/components/assistant/AssistantPanel.tsx` no `Shell`: botão fixo, painel
  lateral (tela cheia no celular), foco preso, `aria-live`, atalho de teclado.
- Cards de ação com antes/depois, **Confirmar**, **Editar**, **Cancelar** e
  **Desfazer**; estados: pensando, pergunta de volta, erro, proposta expirada.
- Invalidar as consultas afetadas depois de aplicar (`lib/invalidate.ts`).
- Verificação no navegador: desktop e celular, tema claro e escuro, teclado.

### Etapa 8: ao vivo e fechamento
- **Autorização**: publicar `assistant` (função nova), com o segredo já criado;
  rodar 5 frases reais de teste com `[teste]` e desfazer.
- Fluxograma de rotas regenerado, spec com os desvios, `project-memory.md`.

## Entregas em PRs (uma por vez, cada uma mesclável)
1. **Núcleo e banco**: etapas 0 a 2 (ainda sem efeito no app).
2. **Servidor**: etapas 3 a 6 (função nova, sem tela).
3. **Tela**: etapa 7 e fechamento.

## Riscos
- `executor` toca serviços usados em todo o app: só parâmetro opcional, com a
  varredura de números antes e depois (`edge_sweep.ts` e o teste local).
- Escopo escolhido ("tudo de uma vez"): se investimentos atrasarem, a etapa 4
  separa `record_trade` e `reserve_contribution` sem refazer o resto.
- Custo da API: modelo barato primeiro e limite de mensagens por minuto.
