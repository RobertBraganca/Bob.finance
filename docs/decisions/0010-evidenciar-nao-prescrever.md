# 0010. Evidenciar, nunca prescrever

Status: aceita

## Contexto
O produto está expandindo de um ledger derivado (seção 4 do PRD) para uma
camada de inteligência financeira: Health Score, alocação do disponível,
runway, ponto de equilíbrio de faturamento, desvio de alocação de
investimentos.

Essa camada corre o risco de deslizar de "mostrar dado" para "dar conselho",
o que colide com a seção 8 do PRD (fora de escopo: conselho financeiro
personalizado).

Para investimentos especificamente, existe risco regulatório concreto: a CVM
publicou em 19/01/2026 o Ofício-Circular CVM/SIN 2/2026, esclarecendo que
consultoria de valores mobiliários é a atividade profissional de orientação,
recomendação e aconselhamento sobre investimentos, e que essa caracterização
não depende de o cliente executar a decisão sozinho. Fonte: gov.br/cvm,
notícia de 19/01/2026.

A mesma regulação, por outro lado, reconhece relatórios gerenciais que
retratam composição e enquadramento de carteira à luz de política de
investimento definida pelo próprio usuário como categoria distinta de
consultoria, o que dá espaço seguro para o que este produto quer fazer,
desde que a linguagem não vire recomendação de ativo, classe ou operação.

## Decisão
Novo princípio de produto, a ser adicionado à seção 4 do PRD.md, mesmo nível
dos princípios já existentes (uma fonte de verdade, derivar nunca guardar,
nada entra sem revisão, sugestão nunca é aplicação automática, dinheiro é
inteiro em centavos, pt-BR em todo texto):

> Evidenciar, nunca prescrever. O sistema calcula, contextualiza e projeta
> com base em dados e parâmetros definidos pelo usuário. Nunca determina qual
> decisão financeira o usuário deve tomar. Toda métrica derivada se classifica
> em uma de três categorias, Observação, Projeção ou Simulação, e nunca numa
> quarta categoria de Recomendação, que fica estruturalmente fora do produto.
> Para investimentos, o sistema pode evidenciar o desvio entre a carteira
> atual e a política de alocação definida pelo próprio usuário, mas nunca
> recomenda ativo, classe ou operação específica.

Taxonomia das três categorias permitidas, para uso em todo o produto:

- **Observação:** descreve um fato já ocorrido. Ex: "sua despesa com
  alimentação aumentou 18% em relação à média dos últimos três meses."
- **Projeção:** calcula um cenário a partir do ritmo atual. Ex: "mantido o
  ritmo atual, o gasto mensal projetado é R$ 6.840."
- **Simulação:** mostra consequência hipotética de uma ação não confirmada.
  Ex: "se este lançamento de R$ 2.000 for realizado, o saldo projetado passa
  de R$ 4.300 para R$ 2.300."
- **Fora do produto: Recomendação.** Ex. do que nunca deve aparecer: "você
  deveria investir R$ 500 em renda fixa", "o melhor uso do seu dinheiro é...".

Regra de composição obrigatória: toda métrica derivada e exposta na UI
(Health Score, disponível para alocação, runway, ponto de equilíbrio, desvio
de alocação) deve ter uma seção "como calculamos" ou "premissas" visível,
mostrando a memória de cálculo. Isso não é um adicional de UX, é parte do
contrato deste princípio: linguagem instrumental sem memória de cálculo
auditável não cumpre este ADR.

## Alternativas consideradas
- **Não adicionar camada de inteligência alguma, manter só o ledger
  derivado:** descartada porque a seção 1 do PRD já promete responder "o que
  fazer com o próximo real disponível" como uma das três perguntas centrais
  do produto; evidenciar sem prescrever é o jeito de responder isso sem
  cruzar para conselho financeiro.
- **Permitir recomendação explícita de investimento, tratando o app como
  ferramenta pessoal de uso único:** descartada pelo risco regulatório
  descrito no Ofício-Circular CVM/SIN 2/2026, que não distingue por escala de
  uso, e porque colidiria com a seção 8 do PRD independentemente do risco
  regulatório.

## Consequências
- Specs novos (`specs/financial-health`, `specs/motor-financeiro`) e a
  extensão do spec de investimentos (`specs/investments`) devem seguir este
  ADR como norma de linguagem desde a primeira versão, não como revisão
  posterior.
- Antes de qualquer comercialização que envolva a camada de investimentos,
  validar juridicamente o enquadramento como relatório gerencial (não
  consultoria) com base no Ofício-Circular CVM/SIN 2/2026, isso é um
  requisito de produto a validar, não apenas uma questão de copy.
- Toda revisão de copy em telas de inteligência financeira passa por um
  checklist: a frase se encaixa em Observação, Projeção ou Simulação? Se não,
  reescrever ou remover.
- A seção 4 do PRD.md ainda não reflete este princípio; a atualização do PRD
  é tratada como tarefa separada, não parte deste ADR.
