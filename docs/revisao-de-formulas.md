# Revisão das fórmulas contra a prática de mercado

Status: revisão pontual, datada de 09/09/2026. Não é documento vivo. É o
resultado de uma comparação entre cada fórmula descrita em
`resumo-tecnico-e-formulas.md` (verificada contra o código, não contra o
documento) e a prática estabelecida em matemática financeira, regulação
brasileira e engenharia de sistemas financeiros.

Escopo deliberado: só a MATEMÁTICA. Nenhuma recomendação aqui propõe uma
feature nova, um motor de decisão ou qualquer cálculo que diga ao usuário o
que fazer. O princípio "evidenciar, nunca prescrever" (`PRD.md` §4,
`decisions/0010`) delimita este documento tanto quanto delimita o produto.

## 0. O que foi verificado no código, antes de qualquer pesquisa

O anexo confere com a implementação nos pontos que importam. Verificado em:

- `debt.ts:375` (`monthlyRate`), `debt.ts:418-422` (comprometimento de renda),
  `debt.ts:469-580` (`projectPaydown`)
- `investments.ts:1491` (`compoundStep`), `investments.ts:1496-1508`
  (`requiredContribution`), `investments.ts:415-455` (`reserveStatus`)
- `financialHealth.ts:136-252` (os cinco indicadores),
  `financialHealth.ts:298-320` (composição), `financialHealth.ts:589` (Runway)
- `financialEngine.ts:641-644` (break-even com gross-up)

Três coisas que o anexo descreve com menos precisão do que o código merece, e
que mudam a resposta de dois tópicos inteiros da pesquisa:

1. **Não existe arredondamento por iteração em nenhuma simulação.**
   `compoundStep` e `projectPaydown` acumulam em ponto flutuante e só chamam
   `Math.round` na hora de escrever o ponto da série (`investments.ts:1410`,
   `debt.ts:558`) ou o total de juros (`debt.ts:571`). O acumulador nunca é
   arredondado e realimentado. Isso já é a prática correta, e derruba a
   premissa da pergunta sobre "deriva de centavos acumulada em 360 iterações":
   ela não acontece aqui.
2. **`projectPaydown` não joga o pool inteiro numa única dívida.** O laço de
   `debt.ts:539-545` percorre a lista ordenada e cascateia: se o pool zera a
   dívida-alvo e ainda sobra, o resto vai pra próxima no mesmo mês. Isso é mais
   correto do que o anexo descreve, e é o comportamento padrão da literatura.
3. **A janela do custo de vida tem padrão 3 meses, não N genérico**
   (`investments.ts:402`, `lookbackMonths: 3`), e o múltiplo padrão 6 já é
   configurável pelo usuário. Boa parte da pergunta "valeria tornar
   configurável" já está respondida pelo código.

## 1. Convenções de juros e composição

### 1.1 Conversão de taxa anual para mensal

**Prática estabelecida.** A matemática financeira brasileira separa dois
conceitos com nomes próprios: *taxa proporcional* (divisão linear, `i/12`),
válida só em regime de juros simples, e *taxa equivalente* (`(1+i)^(1/12)-1`),
a única correta em regime composto. Duas taxas são equivalentes quando,
aplicadas ao mesmo capital pelo mesmo prazo, produzem o mesmo montante.

O ponto que a pesquisa revelou e que não estava no radar: **no mercado de
crédito brasileiro, a taxa anual anunciada frequentemente é nominal com
capitalização mensal, não efetiva.** Quando um contrato diz "144% ao ano com
capitalização mensal", a taxa realmente aplicada é a proporcional, 12% ao mês,
capitalizada. A taxa efetiva anual daquela operação é `1,12^12 - 1 = 289,6%`,
o dobro do número anunciado. O CET (Resolução CMN 3.517/2007, revogada e
substituída pela Resolução CMN 4.881/2021) foi criado exatamente para forçar a
divulgação de um número comparável, e é expresso em forma anual **e** mensal.

**Comparação com o sistema.** `monthlyRate(aprBps) = (1 + apr)^(1/12) - 1`
está matematicamente correto **se e somente se** `aprBps` for uma taxa efetiva
anual. O campo que alimenta esse valor é rotulado apenas
"Taxa anual (%)" (`src/pages/Debt.tsx:944`), e a coluna da tabela,
"Taxa a.a." (`Debt.tsx:416`). Nada distingue efetiva de nominal.

O erro que isso produz não é de arredondamento, é de ordem de grandeza. Um
rotativo de cartão a 14% ao mês, se o usuário anotar "168% a.a." (14 × 12,
que é como a taxa costuma ser mentalmente convertida), gera
`(2,68)^(1/12) - 1 = 8,55% a.m.`. O sistema calcularia juro mensal ~39% menor
do que o real, e a projeção de quitação diria que a dívida acaba anos antes.

**Recomendação: ajustar, e é o ajuste de maior impacto do documento.** Não
mudar a fórmula, que está certa. Mudar o *contrato do insumo*: o rótulo do
campo precisa dizer "Taxa efetiva anual (a.a.)" e o formulário precisa
oferecer entrada em taxa mensal com conversão explícita
(`(1+im)^12 - 1`), porque taxa mensal é a forma como cartão e rotativo são
publicados no Brasil. A memória de cálculo exigida pelo ADR 0010 deveria
mostrar a taxa mensal derivada ao lado da anual informada, que é onde o
usuário perceberia sozinho um valor absurdo.

**Confiança: alta** para a matemática (convenção universal e inequívoca),
**alta** para a existência do CET como norma, **média** para a afirmação de
que a taxa anunciada é comumente nominal (é prática de mercado documentada,
mas varia por produto e por instituição).

### 1.2 Passo de composição mensal

**Prática estabelecida.** `V(n+1) = V(n)·(1+r) + PMT` é a recorrência padrão
de valor futuro com fluxo periódico, idêntica à derivação fechada
`FV = PV(1+r)^n + PMT·[((1+r)^n - 1)/r]`. O princípio de engenharia que a
acompanha em toda referência séria é o mesmo: fazer o máximo de cálculo
intermediário sem arredondar e arredondar só o resultado final.

**Comparação com o sistema.** Concordância total, e por um motivo melhor do
que o anexo dá a entender: o acumulador é float e nunca é reciclado
arredondado. Um `double` IEEE 754 tem 15 a 17 dígitos decimais significativos;
em 1.200 iterações de multiplicação e soma, o erro relativo acumulado fica na
casa de 10⁻¹³. Sobre uma carteira de R$ 10 milhões isso é menos de um
centésimo de centavo. Não há problema a resolver.

**Recomendação: manter.** A alternativa "mais robusta" que a pergunta procura
(usar a fórmula fechada em vez do laço) seria mais rápida, não mais precisa, e
custaria a série mês a mês que a tela exibe.

**Confiança: alta.**

### 1.3 Anuidade ordinária vs. antecipada no aporte necessário

**Prática estabelecida.** As duas formas são padrão e se relacionam por um
fator exato: `PMT_antecipada = PMT_ordinária / (1+r)`. A convenção dominante em
planejamento de acumulação é a **ordinária** (pagamento no fim do período),
que é também a convenção padrão das funções `PMT` de planilha e das
calculadoras financeiras HP-12C em modo END.

**Comparação com o sistema.** `requiredContribution`
(`investments.ts:1496-1508`) implementa a anuidade ordinária corretamente,
incluindo o caso degenerado `r = 0` e a guarda `needed <= 0` para meta já
batida.

A diferença prática é pequena e sempre no sentido conservador: com retorno de
10% a.a. (`r ≈ 0,797% a.m.`), a anuidade ordinária pede **0,8% a mais** de
aporte do que a antecipada. Numa meta de R$ 3.000/mês, R$ 24.

**Recomendação: manter.** Trocar para antecipada reduziria o aporte exigido
com base numa premissa (o dinheiro entra no dia 1 e rende o mês inteiro) que
nem sempre é verdadeira, em troca de um ganho de precisão irrelevante. O erro,
se houver, deve ser para mais.

**Confiança: alta** para a matemática, **média** para a afirmação de que a
ordinária é a convenção dominante em planejamento pessoal (há literatura
usando as duas; a ordinária é a mais comum e a mais conservadora).

## 2. Redução de dívida e amortização

### 2.1 Modelo de simulação avalanche/bola de neve

**Prática estabelecida.** O modelo do sistema é exatamente o modelo canônico:
juro acumula, pagamentos mínimos são feitos, e todo excedente (incluindo o
pagamento liberado por dívidas quitadas, o "snowball" propriamente dito) vai
para uma dívida-alvo, com o resto cascateando. Avalanche por maior taxa
minimiza juro total; bola de neve por menor saldo maximiza a frequência de
quitações.

O achado relevante da literatura é empírico, não matemático: o estudo de Gal e
McShane (Kellogg School / Northwestern, 2012), sobre ~6.000 clientes de uma
empresa de renegociação, encontrou que fechar contas inteiras prevê melhor a
quitação completa do que priorizar a maior taxa. Ou seja, a bola de neve, que
é matematicamente pior, tem melhor taxa de conclusão real.

Métodos híbridos e realocação proporcional existem em calculadoras comerciais,
mas não têm base na literatura acadêmica nem convenção estabelecida.

**Comparação com o sistema.** Concordância. E a decisão de produto está certa
pelo motivo certo: o sistema oferece as duas e não escolhe por ninguém, que é
a única resposta compatível com o ADR 0010 diante de um trade-off onde o
método ótimo no papel não é o com maior chance de dar certo na prática.

Um detalhe de implementação que está correto e vale registrar para não ser
"consertado" depois: a detecção de estagnação (`debt.ts:562`) compara o total
contra o total do início do mês com tolerância de meio centavo, e o
encerramento de dívida usa `balance <= 0.5` (`debt.ts:551`). Ambas as
tolerâncias sub-centavo são necessárias justamente porque o acumulador é
float.

**Recomendação: manter.** Nenhuma mudança. Se algo, a comparação avalanche vs.
bola de neve poderia expor o número de meses até a **primeira** quitação em
cada estratégia, que é o dado que a pesquisa do Kellogg torna relevante, e é
uma observação, não uma recomendação.

**Confiança: alta** para o modelo de simulação, **média-alta** para o achado
do Kellogg (estudo real e citado, mas com uma amostra específica de clientes
de renegociação, que não generaliza automaticamente). A estatística
"73% de aderência vs. 61%" que circula em blogs sobre o tema **não tem fonte
primária localizável e deve ser tratada como não verificável.**

### 2.2 Taxa média ponderada da carteira de dívidas

**Prática estabelecida.** `Σ(taxa_i × saldo_i) / Σsaldo_i` é a definição
padrão de *weighted average interest rate*, e é a métrica usada em
consolidação e refinanciamento de dívida em todo lugar.

**Comparação com o sistema.** Concordância exata (`debt.ts:415`).

A ressalva real não é sobre a fórmula, é sobre o que ela comunica. Uma média
ponderada por saldo responde "qual taxa única, aplicada ao saldo total,
produziria o mesmo juro deste mês". Ela não captura prazo: duas carteiras com
a mesma média ponderada, uma quitando em 6 meses e outra em 60, custam valores
completamente diferentes. O número que responde "custo real" sem ambiguidade
já existe no sistema e é o `totalInterestCents` da projeção de quitação.

**Recomendação: manter, com ressalva.** A fórmula está certa. A ressalva é de
apresentação: "Taxa média ponderada" ao lado de "juro do mês em R$" comunica
mais do que a taxa sozinha, e o segundo número já está calculado
(`debt.ts:89`). Não é mudança de matemática.

**Confiança: alta.**

### 2.3 Comprometimento de renda: denominador e limiares

**Prática estabelecida.** No Brasil não existe um limiar regulatório geral de
comprometimento de renda para crédito livre. O que existe:

- **Limite legal específico do consignado**, hoje em 35% da remuneração
  disponível (mais 5% para cartão consignado), definido em lei e regulamentado
  pelo INSS/CNPS. Aplica-se só a essa modalidade, mas é a origem do "35%" que
  circula como se fosse limite geral.
- **PEIC/CNC**, a pesquisa de referência sobre endividamento das famílias,
  que mede o comprometimento declarado e mostra a média nacional em torno de
  30% da renda. É medida estatística, não limiar normativo.
- **Banco Central**, que publica o indicador de comprometimento de renda das
  famílias com serviço da dívida no SFN, sobre a Renda Nacional Disponível
  Bruta das Famílias. É agregado macroeconômico, não parâmetro individual.

Sobre o denominador, a prática de crédito consolidada usa **renda líquida
comprovada** (o que efetivamente entra), não bruta, e para renda variável usa
**média de 6 a 12 meses**, precisamente porque um único mês não representa a
capacidade de pagamento.

**Comparação com o sistema.** Aqui está a segunda divergência mais séria do
documento. `debt.ts:418` calcula
`debtToIncomeBps = parcelas / rendaDoMêsCents`, com `rendaDoMêsCents` sendo a
receita de **um único mês fechado**. Para o público declarado do produto,
autônomo/PJ com receita irregular por definição (`PRD.md` §2), esse
denominador é a maior fonte de ruído do sistema inteiro.

Um mês com dois projetos faturados e um mês sem nenhum produzem
comprometimentos que diferem por um fator de 2 ou 3, sem que nada tenha
mudado na dívida. E o dano se propaga: esse número alimenta o indicador de
endividamento do Health Score (`financialHealth.ts:179`, com peso 20%) e uma
das cinco regras do radar de risco. O score composto oscila mês a mês por uma
razão que não tem relação com a saúde financeira.

`debtToAnnualIncomeBps` (`debt.ts:422`) piora o problema: multiplica a renda
desse único mês por 12, projetando a irregularidade de um mês sobre o ano
inteiro.

**Recomendação: ajustar.** Trocar o denominador por uma média (ou mediana) dos
últimos 6 a 12 meses fechados, expondo a janela na memória de cálculo. É a
prática de mercado para renda variável e a única leitura defensável para esta
persona. Manter os limiares atuais (30% no radar) como estão: eles são
razoáveis e configuráveis, e não existe norma geral para citar contra eles. O
que precisa mudar é o número que entra na conta, não o corte.

**Confiança: alta** para o limite do consignado e para a prática de média
plurianual em renda variável; **média** para o "30% como limiar de risco", que
é convenção de mercado sem base normativa; **alta** para o diagnóstico do
ruído, que é aritmética direta sobre o código.

### 2.4 Arredondamento e deriva em simulações longas

**Prática estabelecida.** *Round half to even* (banker's rounding) é o modo
padrão do IEEE 754 e existe exatamente para eliminar o viés positivo de
arredondar todo empate para cima quando o mesmo arredondamento se repete
milhões de vezes. Vale notar que a convenção legal nem sempre acompanha: o
regulamento de conversão do euro exige half-up.

Mas o princípio que precede a escolha do modo é mais importante do que ela:
não arredondar valores intermediários. Se você não realimenta um valor
arredondado, o modo de arredondamento não pode acumular viés, porque ele só é
aplicado uma vez.

**Comparação com o sistema.** O sistema já segue o princípio principal. Não há
arredondamento intermediário realimentado em nenhuma das simulações. A questão
de banker's rounding é, portanto, discutível.

Existe uma assimetria real, porém pequena, e ela não é a que a pergunta
procurava: **`Math.round` do JavaScript não é half-up, é half-toward-positive-
infinity.** `Math.round(2.5) = 3` mas `Math.round(-2.5) = -2`. Em toda parte do
sistema que arredonda valores que podem ser negativos (resultado líquido, DRE,
séries de fluxo), empates em valor negativo são arredondados na direção
oposta aos empates positivos. O efeito é de no máximo um centavo por operação
e não se acumula, porque não é realimentado.

**Recomendação: manter.** Migrar para banker's rounding aqui resolveria um
problema que o sistema não tem, ao custo de tornar os números menos previsíveis
para o usuário (o arredondamento deixaria de ser explicável em uma frase).
Vale documentar a assimetria de `Math.round` em negativos como comportamento
conhecido, não corrigi-la.

Sobre inteiro em centavos vs. `decimal`: a prática de referência para
armazenamento e transporte de dinheiro é inteiro na menor unidade (é o que
Stripe e Modern Treasury fazem, pelo motivo de que inteiro é exato e float
não). Ela não se estende a *taxas*, que não são dinheiro e devem ter mais
casas. O sistema já faz isso certo: `aprBps` é bps para armazenamento, mas
`monthlyRate` devolve float de precisão total, e é esse float que entra na
simulação (`debt.ts:484`).

**Confiança: alta** em tudo neste item.

## 3. Reserva de emergência e custo mensal de vida

### 3.1 O múltiplo

**Prática estabelecida.** 3 a 6 meses é a faixa mais citada para renda
estável. Para renda variável, autônomo, PJ e comissionado, a orientação
consistente entre fontes de planejamento financeiro é maior: **6 a 12 meses**,
com 9 a 12 aparecendo como faixa central para autônomo em várias delas. O
argumento é direto: a reserva cobre o intervalo até a próxima entrada, e esse
intervalo é justamente o que é imprevisível em renda variável.

**Comparação com o sistema.** O múltiplo já é configurável
(`emergencyReserveSettings.multiple`, `investments.ts:402`). O que está em
questão é só o **padrão de 6**, que fica na borda inferior da faixa
recomendada para exatamente a persona deste produto.

**Recomendação: manter com ressalva.** Não mudar o padrão silenciosamente:
mudar de 6 para 9 alteraria o alvo, o gap e o indicador de reserva de todo
mundo que nunca tocou na configuração, e um número que muda sozinho é pior do
que um número conservador. O ajuste correto é de interface, não de fórmula:
a tela de configuração do múltiplo deveria evidenciar a faixa de referência
(3 a 6 para renda estável, 6 a 12 para renda variável) e deixar a escolha
onde ela já está, com o usuário.

**Confiança: média.** A faixa 3-6 é praticamente universal; a extensão para
9-12 em autônomos é consenso amplo entre fontes de planejamento financeiro,
mas é heurística profissional, não resultado quantitativo.

### 3.2 A base: custo mensal de vida

**Prática estabelecida.** A literatura de planejamento é específica sobre o
que entra na base da reserva: **despesas essenciais** (moradia, utilidades,
alimentação, transporte, seguros e pagamentos mínimos de dívida), não a
despesa total. A reserva existe para atravessar um período sem receita, e nesse
período o gasto discricionário é a primeira coisa que cai.

**Comparação com o sistema.** `reserveStatus` (`investments.ts:428-431`) usa
`totals({from, to}).expenseCents / lookbackMonths`, ou seja, **média aritmética
simples de toda despesa registrada na janela de 3 meses, de todas as contas,
PF e PJ juntas**. O próprio código já reconhece o problema num comentário: a
média mistura pessoal e empresa e pode superestimar o custo de vida pessoal,
e é por isso que existe a sobrescrita manual.

São três fragilidades empilhadas, e este número alimenta simultaneamente a
reserva de emergência, o Runway (`financialHealth.ts:589`) e o indicador de
liquidez (`financialHealth.ts:150`):

1. **Média em vez de mediana.** Com janela de 3 meses, um único gasto atípico
   (IPVA, um equipamento, uma viagem) desloca a base em 33% do seu valor e
   contamina os três indicadores por um trimestre inteiro.
2. **Janela curta.** 3 meses é pequeno demais para absorver sazonalidade em
   receita e despesa irregulares.
3. **Despesa total em vez de essencial.** Infla o alvo da reserva e, ao mesmo
   tempo, encurta o Runway. Os dois erros vão na direção pessimista, o que é
   menos grave do que o contrário, mas ainda é erro.

**Recomendação: ajustar, e é o terceiro ajuste de maior impacto.** Em ordem de
custo-benefício:

- **Trocar a média pela mediana das despesas mensais da janela.** É a correção
  de maior efeito por menor esforço, é robusta a outlier por construção, e não
  exige nenhum dado novo nem nenhuma classificação adicional.
- **Aumentar a janela padrão de 3 para 6 meses**, que já é um parâmetro
  existente. Com mediana, uma janela maior fica melhor, não pior.
- **Permitir marcar categorias como essenciais** e derivar a base só delas.
  É a correção mais fiel à literatura e a mais cara: exige coluna nova e
  decisão do usuário por categoria. Fica como opção, não como prioridade.

**Confiança: alta** para "essencial, não total" (é definição consistente entre
fontes); **alta** para a superioridade da mediana sobre a média em presença de
outlier (estatística básica); **média** para a janela ideal, que não tem
convenção fixa.

## 4. Score de saúde financeira composto

### 4.1 Construção do índice

**Prática estabelecida.** A referência metodológica é o *Handbook on
Constructing Composite Indicators* (OECD/JRC, 2008). O que ele diz sobre o
desenho em uso aqui:

- **Agregação linear implica compensabilidade total e constante.** Um
  indicador péssimo é integralmente compensado por outros bons. Agregação
  geométrica dá compensabilidade parcial: quanto pior um componente, menos ele
  é compensável.
- **Ausência de sinergia ou conflito entre indicadores é condição necessária**
  para admitir agregação linear ou geométrica. Indicadores correlacionados
  duplicam peso sem que o peso declarado mude.
- Pesos devem seguir o marco teórico, e correlação e compensabilidade precisam
  ser tratadas explicitamente ou assumidas como característica do fenômeno.

**Comparação com o sistema.** A média ponderada com redistribuição de peso
(`financialHealth.ts:298-320`) é uma construção padrão e a redistribuição está
implementada corretamente. Duas armadilhas do Handbook são reais aqui:

1. **Correlação entre liquidez e reserva.** Ambos são derivados do mesmo
   `monthlyCostCents` no denominador, e o saldo disponível e a reserva se
   movem juntos com frequência. Com pesos padrão, "quanto dinheiro parado você
   tem em relação ao seu custo de vida" responde por 40% do score, embora a
   configuração diga 20% + 20% de coisas distintas. Um erro na base do custo
   de vida (seção 3.2) entra no score duas vezes.
2. **Compensabilidade total.** Comprometer 50% da renda com dívida zera o
   indicador de endividamento, e ainda assim o score pode ficar em 80 se os
   outros quatro forem cheios. É uma consequência conhecida e aceitável da
   agregação linear, desde que seja consciente.

**Recomendação: manter, com ressalva documentada.** Não trocar por agregação
geométrica: ela quebraria com qualquer indicador valendo zero (o produto zera
o score inteiro) e tornaria o número inexplicável para o usuário, o que
colide com a exigência de memória de cálculo auditável do ADR 0010. O que
falta é registro: a sobreposição liquidez/reserva deveria estar em
`architecture.md` ou no spec de Saúde financeira como característica
conhecida, para que ninguém a "descubra" como bug e para que a escolha de
pesos pelo usuário seja informada.

**Confiança: alta** (Handbook OECD/JRC é a referência canônica do tema).

### 4.2 A faixa linear do controle de gastos

**Prática estabelecida.** Não existe convenção estabelecida para converter
"uso do orçamento" em nota de 0 a 100. Não é uma lacuna de pesquisa: é um
problema sem resposta canônica, porque a escala depende de quanto o dono do
orçamento considera tolerável estourar. Curvas não lineares (penalização
progressiva) são comuns em scoring, mas escolher o expoente é tão arbitrário
quanto escolher o corte de 150%.

**Comparação com o sistema.** `(1,5 - uso) / 0,5`, travado em [0, 1]. O corte
de 150% é arbitrário, e é honestamente arbitrário: está numa constante nomeada
(`SPENDING_FLOOR_MULTIPLE`, `financialHealth.ts:183`), com comentário
explicando a intenção, e a memória de cálculo o expõe.

Duas observações mais úteis do que trocar a curva:

- **A arbitrariedade não está isolada.** O indicador de endividamento
  (`10_000 - dti × 2`) é igualmente uma reta com corte arbitrário, e o de
  liquidez (nota cheia com 1 mês de cobertura) também. Trocar só o de gastos
  por uma curva sofisticada tornaria os cinco indicadores menos coerentes
  entre si, não mais precisos.
- **O corte de liquidez merece mais atenção do que o de gastos.** Nota cheia
  com 1 mês de custo de vida em conta, num produto que ao mesmo tempo diz ao
  usuário que ele precisa de 6 meses de reserva, é uma inconsistência interna
  de escala. Os dois números falam de cobertura em meses e discordam por um
  fator de 6.

**Recomendação: manter a fórmula de gastos; revisar o teto do indicador de
liquidez.** A linearidade não é o defeito. O defeito, se houver um, é que
`SPENDING_FLOOR_MULTIPLE` está fixo em código enquanto todos os pesos e
limiares vizinhos são configuráveis pelo usuário (`healthSettings`). Promover
a constante a configuração resolve a arbitrariedade da única forma compatível
com "evidenciar, nunca prescrever": o corte passa a ser do usuário.

**Confiança: alta** para "não há convenção estabelecida" (ausência de fonte
canônica após busca); **alta** para a inconsistência de escala entre liquidez
e reserva (é comparação aritmética direta dentro do próprio sistema).

## 5. Precificação e ponto de equilíbrio

**Prática estabelecida.** Quando o imposto é uma fração `t` da própria receita,
`R = C / (1 - t)` é a solução exata de `R - tR = C`. Está correto e é a forma
padrão do gross-up.

O problema é o `t`. Para o PJ brasileiro no Simples Nacional, a alíquota é
efetiva e progressiva:

```
alíquotaEfetiva = (RBT12 × alíquotaNominal - parcelaADeduzir) / RBT12
```

onde RBT12 é a receita bruta acumulada dos **12 meses anteriores** ao período
de apuração. Exemplo real do Anexo III, 2ª faixa: RBT12 de R$ 250.000, alíquota
nominal 11,20%, parcela a deduzir R$ 9.360, alíquota efetiva **7,46%**. Quem
usasse a nominal erraria o imposto em 50% para mais.

Há um detalhe que muda a resposta e que vale registrar, porque é
contraintuitivo: **sob o Simples, o gross-up não é circular.** A alíquota
efetiva do mês depende do RBT12, que é histórico e não inclui o mês corrente.
Então o imposto do mês é de fato proporcional à receita do mês, a uma taxa
fixada pelo passado. A equação `R = C / (1 - t)` continua exata. O que precisa
estar certo é o `t`.

**Comparação com o sistema.** `financialEngine.ts:641-644` implementa o
gross-up corretamente, com a guarda de inatingibilidade em `t >= 1`. O mesmo
`taxRateBps` é reusado pela precificação (`pricing.ts`), o que é a decisão
certa (`decisions/0012`, um único número de imposto no sistema).

A imprecisão é que `taxRateBps` é um único número fixo digitado pelo usuário.
Três consequências:

1. Se o usuário digitar a alíquota **nominal** da tabela em vez da efetiva,
   superestima o imposto de forma relevante (7,46% vs. 11,20% no exemplo
   acima), inflando o break-even e, por consequência, o valor-hora e todo
   preço recomendado (`pricing.ts`, que deriva do break-even).
2. A alíquota efetiva **muda a cada mês** conforme o RBT12 se move, e mais
   ainda quando a receita cresce de faixa. Um número fixo digitado uma vez
   envelhece.
3. Um break-even calculado num nível de receita muito diferente do RBT12 atual
   usa uma alíquota que não vale naquele nível.

**Recomendação: ajustar, com escopo contido.** A correção proporcional ao
problema não é implementar as cinco tabelas do Simples: é (a) rotular o campo
como **alíquota efetiva** e não apenas "imposto", com a fórmula do Simples na
ajuda, e (b) expor na memória de cálculo o RBT12 implícito, que o sistema já
consegue derivar do ledger (receita bruta dos 12 meses anteriores). Com o
RBT12 na tela ao lado da alíquota digitada, um valor desatualizado fica
visível sem que o sistema precise decidir nada pelo usuário.

Implementar a tabela do anexo aplicável e calcular a alíquota efetiva
automaticamente é possível e seria mais preciso, mas depende do anexo, do
Fator R e de manutenção anual da tabela. Cabe como escopo próprio, não como
ajuste de fórmula.

**Confiança: alta** para a matemática do gross-up e para a fórmula da alíquota
efetiva (é texto de lei, LC 123/2006 com as tabelas vigentes); **alta** para a
definição de RBT12 como os 12 meses anteriores.

## 6. Ajustes de maior impacto

Ranqueados por quanto reduzem erro ou ruído real, não por volume de fonte.

Os ajustes 1 a 4 foram **aplicados em 09/09/2026**. Ver a seção seguinte
para o que cada um mudou de fato nos números reais.

| # | Ajuste | Onde | Impacto | Esforço |
|---|---|---|---|---|
| 1 | Desambiguar taxa anual **efetiva** vs. nominal na entrada de dívida, e aceitar entrada em taxa mensal | `Debt.tsx:944`, memória de cálculo | Erro de ordem de grandeza no juro, na projeção de quitação e no indicador de endividamento | Baixo |
| 2 | Comprometimento de renda sobre média/mediana de 6 a 12 meses, não sobre um único mês | `debt.ts:418-422` | Remove a maior fonte de oscilação do Health Score para renda variável | Médio |
| 3 | Custo mensal de vida por **mediana**, janela padrão de 6 meses | `investments.ts:428-431` | Um número que alimenta reserva, Runway e liquidez ao mesmo tempo deixa de ser refém de um gasto atípico | Baixo |
| 4 | Rotular `taxRateBps` como alíquota **efetiva** e expor o RBT12 derivado do ledger | `financialEngine.ts`, tela do Motor | Corrige break-even, valor-hora e todo preço recomendado quando o usuário digita a nominal | Baixo a médio |
| 5 | Revisar o teto do indicador de liquidez (1 mês = nota cheia) contra a escala de 6 meses da reserva | `financialHealth.ts:150` | Elimina uma inconsistência de escala interna que confunde o score | Baixo |
| 6 | Promover `SPENDING_FLOOR_MULTIPLE` a configuração do usuário | `financialHealth.ts:183` | Resolve a arbitrariedade da faixa do jeito compatível com o ADR 0010 | Baixo |
| 7 | Documentar a correlação liquidez/reserva e a compensabilidade total do score | `specs/financial-health/spec.md` | Não muda número nenhum; evita que a sobreposição seja tratada como bug e informa a escolha de pesos | Baixo |
| 8 | Expor "juro do mês em R$" ao lado da taxa média ponderada | tela de Endividamento | Comunica custo real da carteira sem depender da taxa isolada | Baixo |

### Resultado medido dos ajustes 1 a 4

Medido contra o ledger real em 09/09/2026, janela terminando em 2026-08.

**Ajuste 2 (renda típica).** A receita dos 6 meses fechados foi R$ 5.479,99,
R$ 5.276,58, R$ 5.935,16, R$ 6.989,00, R$ 5.274,94 e R$ 4.162,42. Agosto foi
o mês mais fraco do semestre, 25% abaixo da mediana. Com ele como
denominador, o comprometimento de renda dava **33,05%** e o radar de risco
disparava (limiar de 30%). Com a mediana de R$ 5.378,29, dá **25,58%** e não
dispara. O indicador de endividamento do Health Score sai de 33,9 para 48,84,
uma diferença de ~15 pontos num indicador de peso 20%, ou ~3 pontos no score
composto, causada inteiramente por qual mês caiu no denominador.

**Ajuste 3 (mediana do custo de vida).** Na janela salva de 3 meses
(R$ 5.836,14, R$ 3.699,54, R$ 4.895,72) a média dava R$ 4.810,47 e a mediana
dá R$ 4.895,72: o alvo da reserva sobe R$ 511,50. A diferença é pequena aqui
porque a dispersão do trimestre é simétrica, que é exatamente quando média e
mediana concordam. O ganho não está neste número, está em não haver um
trimestre futuro em que um IPVA desloque a base sozinho. Com a janela nova de
6 meses a mediana seria R$ 4.919,99 (reserva de R$ 29.519,94).

**Ajustes 1 e 4** não mudam número nenhum sozinhos: corrigem o contrato de
entrada. A alíquota configurada hoje é 0, então o break-even ainda não aplica
gross-up nenhum, e o RBT12 derivado do ledger é R$ 50.668,35 com os 12 meses
cobertos. As taxas de dívida já cadastradas continuam sendo lidas como
efetivas anuais, que é como sempre foram calculadas; o que mudou é que a tela
agora diz isso e mostra a mensal equivalente ao lado.

### O que **não** deve mudar

- `compoundStep` e a recorrência de composição. Estão corretos, e a deriva de
  arredondamento que a pesquisa procurava não existe, porque não há
  arredondamento intermediário realimentado.
- Anuidade ordinária em `requiredContribution`. A diferença para a antecipada
  é de 0,8% e no sentido conservador.
- Banker's rounding. Resolveria um problema que o sistema não tem.
- Inteiro em centavos. É a prática de referência e está aplicada no lugar
  certo, com taxas mantidas em float de precisão total.
- O modelo de simulação avalanche/bola de neve. É o modelo canônico, e oferecer
  os dois sem escolher é a resposta certa a um trade-off onde o método ótimo no
  papel não é o de maior taxa de conclusão real.
- Agregação linear no Health Score. A alternativa geométrica quebra com
  qualquer indicador zerado e é inexplicável ao usuário.
- `receita = custosFixos / (1 - t)`. A fórmula está exata; o que precisa de
  cuidado é o `t`.

## Fontes

Alta confiança (norma, lei ou convenção matemática):

- [Resolução CMN 3.517/2007 (CET)](https://normativos.bcb.gov.br/Lists/Normativos/Attachments/48005/Res_3517_v4_P.pdf), Banco Central do Brasil
- [Cartilha do Custo Efetivo Total](https://www.itaucred.com.br/icredline/financiamento/formularios/cartilha_CET.pdf)
- [CET, Ministério da Justiça, Boletim Consumo e Finanças](https://www.gov.br/mj/pt-br/assuntos/seus-direitos/consumidor/Anexos/boletimconsumofinancas08-cet-2013-custo-efetivo-total.pdf)
- [Taxas equivalentes em capitalização composta, Portal da OBMEP/IMPA](https://cdnportaldaobmep.impa.br/portaldaobmep/uploads/material/old357d92tc0w.pdf)
- [Handbook on Constructing Composite Indicators, OECD/JRC (2008)](https://www.oecd.org/content/dam/oecd/en/publications/reports/2008/08/handbook-on-constructing-composite-indicators-methodology-and-user-guide_g1gh9301/9789264043466-en.pdf)
- [Cálculo da alíquota efetiva do Simples Nacional](https://www.contabilizei.com.br/contabilidade-online/calculo-simples-nacional/)
- [Anexo III do Simples Nacional, tabela e alíquota efetiva](https://www.soluzionecontabil.com.br/anexo-iii-do-simples-nacional/)
- [Round half to even, IEEE 754](https://docs.jerasoft.net/docs/knowledge-base/accounting/round_half_to_even/)
- [Floats Don't Work For Storing Cents, Modern Treasury](https://www.moderntreasury.com/journal/floats-dont-work-for-storing-cents)
- [Precision Matters: cents instead of floating point, HackerOne](https://www.hackerone.com/blog/precision-matters-why-using-cents-instead-floating-point-transaction-amounts-crucial)

Confiança média (prática de mercado, consistente entre fontes mas sem norma):

- [Taxas proporcionais e taxa equivalente](https://www.topinvest.com.br/blog/taxas-proporcionais-e-taxa-equivalente/)
- [PEIC, Confederação Nacional do Comércio](https://pesquisascnc.com.br/pesquisa-peic/)
- [CNC: endividamento das famílias, Agência Brasil](https://agenciabrasil.ebc.com.br/economia/noticia/2026-08/cnc-endividamento-das-familias-sobe-para-82-mas-inadimplencia-cai)
- [Emergency Fund Guidelines: 3 to 12 Months by Situation](https://www.financewonk.com/references/emergency-fund-guidelines)
- [Emergency Funds: How Much is Enough?, Financial Independence Planning](https://www.myfipadvisor.com/insights/blog/emergency-funds-how-much-is-enough/)
- [Debt experts recommend avalanche but snowball works too, CBC](https://amp.cbc.ca/news/business/debt-experts-recommend-avalanche-strategy-but-snowball-works-too-1.2886215) (cobertura do estudo Gal e McShane, Kellogg/Northwestern, 2012)

Baixa confiança, sinalizado como tal e **não usado** como base de nenhuma
recomendação:

- A estatística "73% de aderência à bola de neve vs. 61% à avalanche em 6
  meses", atribuída ao *Journal of Consumer Research* em conteúdo de blog, não
  tem fonte primária localizável.
