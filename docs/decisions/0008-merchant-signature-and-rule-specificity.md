# 0008. Assinatura de comerciante nunca guarda verbo/preposição; regra genérica precisa excluir o falso positivo conhecido

Status: aceita

## Contexto
Uma auditoria pedida pelo usuário sobre valores de agosto incorretos achou
duas causas raiz, não relacionadas ao lançamento específico que motivou a
pergunta:

1. `merchantSignature()` mantém os dois primeiros tokens não-ruído de uma
   descrição. Para "Transferência enviada PELO Pix - <nome> - ...", nem
   "transferencia" nem "pelo" estavam na lista de ruído — então a
   assinatura de qualquer transferência Pix virava `"transferencia pelo"`,
   um balde compartilhado por lançamentos completamente diferentes. Uma
   correção manual guardada nesse balde (`category_memory`) generaliza para
   TODO Pix futuro, não só para o comerciante que motivou a correção — foi
   assim que um pagamento de aluguel de R$1.500 acabou categorizado como
   receita.
2. A regra genérica `contains "mercado"` → Supermercado (prioridade 140,
   fallback de último recurso) casava com "MERCADO PAGO"/"MERCADO LIVRE"
   quando esses nomes apareciam como instituição/rede de pagamento dentro de
   uma transferência Pix qualquer — não como o nome de uma loja. 134
   lançamentos em todo o histórico (não relacionados a compra de mercado)
   estavam categorizados como Supermercado por esse motivo.

## Decisão
- `NOISE_TOKENS` (`server/src/core/normalize.ts`) ganhou `transferencia` e
  `pelo` — nenhum dos dois é identidade de comerciante, os dois são
  boilerplate de todo Pix enviado/recebido.
- A regra `mercado` (id 12) mudou de `contains` para `regex`:
  `mercado(?!\s*(pago|livre|credito))` — continua pegando "mercado",
  "supermercado", "mercadinho x" etc., mas nunca quando "mercado" é seguido
  por "pago"/"livre"/"credito" (as marcas dos produtos financeiros do
  Mercado Livre, não uma loja).
- Os 134 lançamentos históricos afetados foram limpos para "sem categoria"
  (nunca reatribuídos a um palpite) — mais honesto um branco do que um
  categoria errada, princípio já estabelecido em `categorize/engine.ts`.
- A memória genérica `"transferencia pelo"` (5 entradas, categorias
  misturadas) foi apagada via `forgetMemory` — sem isso, ela poderia
  promover a uma regra igualmente genérica na próxima correção manual.

## Alternativas consideradas
- **Corrigir só o lançamento que o usuário apontou:** deixaria os outros 133
  falsos positivos e a causa raiz intactos — o mesmo bug reapareceria no
  próximo mês.
- **Regra negativa separada apontando para "sem categoria":** o motor de
  regras (`Categorizer.matchRule`) não tem conceito de "regra que impede
  categorização" — só de "primeira regra que casa, ganha". Uma regex com
  negative lookahead na própria regra resolve sem precisar desse conceito
  novo.

## Consequências
- Qualquer palavra que só existe como parte do nome de uma instituição
  financeira ou de um verbo de transferência é candidata a `NOISE_TOKENS`
  quando descoberta — este ADR é o padrão a seguir, não um caso único.
- Uma regra `contains` genérica de baixa prioridade (fallback) deveria ser
  revisada com essa mesma pergunta: "esse padrão também aparece no NOME DO
  BANCO/REDE, não só no nome do comerciante?" antes de ser aceita.
