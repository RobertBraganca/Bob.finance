# Spec: &lt;nome da área&gt;

Status: rascunho | implementado | implementado com desvios (ver "Desvios")

## Objetivo
Uma frase: o que esta área resolve que nenhuma outra resolve.

## Histórias de usuário
- Como &lt;persona&gt;, eu quero &lt;ação&gt; para &lt;resultado&gt;.

## Modelo de dados
Tabelas tocadas, com o que cada uma representa (não repita o schema, referencie).

## Contrato de API
Rota | Método | Entrada | Saída | Observação

## Regras de negócio
O que decide um número ou um estado — a parte que um teste em
`scripts/verify.ts` deveria cobrir.

## UI
Telas/componentes principais e a decisão de layout que não é óbvia só
olhando o código.

## Casos de borda
O que acontece no estado vazio, no limite, no dado ambíguo.

## Fora de escopo
O que esta área explicitamente não faz (evita que a próxima feature tente
encaixar algo aqui que pertence a outra área).

## Desvios da implementação
Preencha só se o código final diverge do que este spec descreve — e
descreva o desvio, não delete a seção; o spec deve continuar descrevendo o
sistema real.
