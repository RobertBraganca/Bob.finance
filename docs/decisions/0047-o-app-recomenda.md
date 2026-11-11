# 0047. O app recomenda: fim do "evidenciar, nunca prescrever"

Status: aceita (11/11/2026). Substitui `0010`. Revoga as partes de `0011`,
`0035`, `0036` e `0046` que proibiam dizer o que fazer.

## Contexto
O PRD (§4) e a `0010` trataram o produto como se fosse oferecido a terceiros:
toda métrica derivada era Observação, Projeção ou Simulação, nunca
Recomendação. A regra se espalhou: o Motor ordenava destinos em ordem
alfabética para a ordem não parecer urgência, o rebalanceamento escondia as
classes acima da meta, o plano de dívida calculava avalanche e bola de neve sem
dizer qual vence, a decumulação nunca dizia quanto retirar e o assistente
bloqueava pedidos de conselho na entrada e na saída. Cerca de 34 arquivos
carregam o aviso "nunca recomendação".

Em 11/11/2026 o dono pediu para eliminar essa camada: o app é pessoal, sem uso
comercial, e precisa interagir mais e dizer o que fazer com os números que já
calcula.

## Decisão
- O app recomenda. Onde o dado já existe, a tela diz o que fazer e por quê
  ("Recomendado: avalanche, paga R$ X a menos de juros"; "Comece pela reserva:
  faltam R$ Y"; "Próximo aporte em FII; pare de comprar ações").
- Toda recomendação mostra a razão e os números que a sustentam. O contrato do
  `Assumptions` ("como calculamos") continua valendo.
- Recomendar não é aplicar. Gravar algo em nome do usuário continua pedindo
  confirmação (assistente, conciliação, regras de categorização na revisão do
  staging), como na `0003` e na `0039`.
- Quando o dado não sustenta uma recomendação (pouco histórico, meta não
  definida), a tela diz isso em vez de chutar.
- O assistente pode aconselhar com base nos dados do usuário; o filtro de
  conselho sai.

## Consequências
- PRD §4 e §8 ("conselho" e "alertas proativos" fora de escopo) ficam
  desatualizados nesse ponto; esta decisão vale sobre eles.
- Os avisos "Observação, nunca recomendação" no código saem conforme cada tela
  ganha recomendação; os que restarem não valem mais como regra.
- Primeiras telas (11/11/2026): Endividamento, Motor financeiro,
  rebalanceamento em Investimentos, teto do MEI, categorização com regra por
  padrão, assistente.
