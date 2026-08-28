# 0006. Atualização de cotação via BRAPI é sequencial, nunca em lote

Status: aceita

## Contexto
O plano gratuito da BRAPI (brapi.dev) foi testado diretamente contra a API
real antes de escrever qualquer código: uma chamada com múltiplos tickers
separados por vírgula devolveu um erro explícito,
`QUOTES_PER_REQUEST_EXCEEDED`, confirmando que o plano gratuito aceita
exatamente 1 ticker por requisição.

## Decisão
"Atualizar cotações" (todas as posições de uma vez) faz um loop com uma
requisição HTTP por ativo, nunca uma chamada em lote. Uma falha num ticker
não interrompe os demais — o resultado reporta status por ativo
(`updated` | `error` | `skipped`).

## Alternativas consideradas
- **Assumir que a API aceita lote** (a suposição inicial, antes do teste
  real): teria produzido código que falha 100% das vezes em produção para
  qualquer usuário no plano gratuito.
- **Paralelizar as requisições sequenciais:** rejeitado — um burst de
  chamadas simultâneas é mais propenso a rate limit do que as mesmas
  chamadas espaçadas uma após a outra.

## Consequências
- "Atualizar todas as cotações" com N ativos custa N requisições, nunca 1 —
  isso é aceitável porque o limite mensal (15 mil) é ordens de magnitude
  maior que qualquer uso realista de uma carteira pessoal.
- Qualquer nova integração externa deveria testar o contrato real da API
  (limites, formato de erro) antes de desenhar o código, não depois — este
  ADR existe porque isso mudou a forma da implementação.
