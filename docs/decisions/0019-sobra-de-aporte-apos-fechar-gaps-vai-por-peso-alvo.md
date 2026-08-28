# 0019. Sobra de aporte, depois que todo gap fecha, se distribui por peso-alvo

Status: aceita

## Contexto
O ADR 0013 (aporte proporcional ao gap entre classes) tem um caso
deliberadamente não resolvido: quando o aporte é maior que a soma dos
gaps de todas as classes elegíveis, cada classe recebe exatamente o seu
gap, e o excedente vira `unallocatedCents` — nenhuma classe já na meta
recebe mais nada. Isso está certo para o problema que o ADR 0013
resolvia, mas um teste de uso real expôs a consequência prática: um
aporte de R$38 mil contra uma carteira cujos gaps somam bem menos deixa
uma fração grande do aporte "parada em conta", quando a expectativa do
usuário é que 100% de um aporte marcado para investir seja de fato
investido.

## Decisão
Novo 4º nível na cascata, só ativado quando `unallocatedCents > 0` pelo
motivo específico de "todo gap fechou" (não pelo motivo "nenhum ativo
elegível pôde absorver", que continua honestamente reportado como
sobra):

- Depois que toda classe elegível está exatamente na própria meta
  (`deltaCents = 0` em todas), o restante do aporte se distribui
  proporcional ao **peso-alvo original** de cada classe
  (`targetAllocations.targetBps`), não mais ao gap, que já é zero para
  todas — não há mais "quem está mais atrasado" para desempatar.
- Dentro de cada classe, o rodízio por setor já existente
  (`allocateAcrossSectors`) continua exatamente como está.
- Este 4º nível **não** reabre a decisão do ADR 0013 de nunca empurrar uma
  classe além da própria meta com base em gap — ele só existe porque, com
  gap zero em todas, "proporcional ao gap" e "proporcional à meta" convergem
  para o mesmo resultado matematicamente impossível de calcular (divisão
  por zero); usar o peso-alvo é a extensão natural, não uma segunda regra
  concorrente.
- Continua nunca sugerindo venda, e um ativo com nota 0 continua nunca
  recebendo aporte — as mesmas duas regras do Diagrama do Cerrado que já
  valiam nos outros três níveis.

## Alternativas consideradas
- **Manter o excedente sempre como `unallocatedCents`, documentando que é
  esperado:** descartada — o teste de uso real mostrou que isso lê como
  falha de produto ("carteira ficando com gordura sem alocação"), não como
  comportamento correto explicado; o próprio ADR 0010 exige que uma
  métrica derivada seja compreensível, e "sobra sem explicação nem destino"
  falha esse padrão quando existe uma extensão honesta disponível.
- **Distribuir o excedente igualmente entre todas as classes:**
  descartada — ignoraria a política de alocação que o próprio usuário
  configurou (`targetAllocations`), que é exatamente o dado que deveria
  decidir isso.

## Consequências
- `suggestContribution` (`services/investments.ts`) ganha um passo depois
  do nível de classe: se `totalDeltaCents === 0` e ainda sobrar
  `remaining > 0`, redistribuir por `targetBps` em vez de retornar
  direto para `unallocatedCents`.
- `specs/investments`, seção "Cascata de aporte", documenta o 4º nível.
- `scripts/verify.ts`, módulo 7/8: novo caso — aporte muito maior que a
  soma de todos os gaps, confirmando que o total é 100% alocado (ou o
  mais próximo disso que os ativos elegíveis permitirem) e que a
  distribuição do excedente segue `targetBps`, não os pesos de nota
  isolados.
