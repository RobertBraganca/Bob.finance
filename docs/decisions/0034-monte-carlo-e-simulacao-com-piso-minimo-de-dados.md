# 0034. Simulação de Monte Carlo é Simulação, nunca Projeção, e exige piso mínimo de dados

Status: aceita

## Contexto
A candidata #9 do estudo de viabilidade de features (29/08/2026) propõe rodar
uma simulação de Monte Carlo sobre a carteira de investimentos, produzindo
faixas de percentil ("em X% dos cenários, o patrimônio atinge a meta até a
data Y"). A avaliação anterior bloqueou a feature para implementação direta,
mas por um motivo diferente do resto da bateria bloqueada: aqui o risco não é
regulatório nem de fronteira com conselho financeiro (`decisions/0010`), é de
honestidade estatística.

A base de dados real de retorno por classe de ativo (`asset_valuations`
agregado por classe, ou `benchmark_returns` como proxy) tem hoje só alguns
meses acumulados por vez, curta demais para estimar uma distribuição de
retorno com qualquer estabilidade. Rodar Monte Carlo sobre isso produz um
número com aparência de rigor estatístico ("84% de chance de sucesso") a
partir de uma amostra que não sustenta essa confiança. O risco concreto não
é o usuário receber conselho disfarçado, é o usuário receber uma FALSA
precisão disfarçada de dado, o que é enganoso mesmo sem cruzar a fronteira
do `decisions/0010`.

## Decisão
**(a) Classificação: Simulação, nunca Projeção.** Na taxonomia do
`decisions/0010`, Projeção pressupõe confiança no dado de entrada ("mantido
o ritmo atual...") — o ritmo aqui é justamente o que está em dúvida, porque a
amostra de retorno é curta demais para caracterizar um "ritmo" com qualquer
estabilidade. Simulação ("consequência hipotética de uma ação/cenário não
confirmado") é a categoria correta: cada percentil é a consequência de UM
conjunto de premissas de distribuição escolhido, não um fato projetado do
comportamento real da carteira. A copy de toda tela desta feature segue a
mesma regra do `decisions/0010`: nunca "seu patrimônio vai atingir X",
sempre "SE a distribuição de retorno seguir os parâmetros configurados,
em X% dos cenários simulados o patrimônio atinge Y".

**(b) Piso mínimo de dados, por classe de ativo.** A feature fica
condicionada a **24 meses corridos de retorno mensal observado por classe**
(seja de `asset_valuations` agregado, seja de `benchmark_returns` usado como
proxy da classe) antes de rodar. Abaixo de 24 meses, a tela mostra
explicitamente "dado insuficiente para simular esta classe" em vez de rodar
a simulação com o que existe. 24 meses foi escolhido porque:
- Uma estimativa de desvio padrão sobre menos de ~24 pontos mensais é
  dominada por ruído amostral, não por sinal real da classe.
- Dois anos cobrem ao menos um ciclo de sazonalidade anual completo duas
  vezes (13º salário, sazonalidade de dividendos), o que um recorte menor
  nunca captura.
- É um piso alcançável em prazo razoável (a base de dados cresce mês a mês
  naturalmente, por uso contínuo do app), não uma trava permanente — a
  alternativa de rodar sempre, mesmo sem dado, é que travaria a feature
  numa mentira estatística para sempre, não numa espera temporária.

O piso é por CLASSE, não por carteira inteira: uma carteira com renda fixa
madura (24+ meses) e uma ação recém-comprada (2 meses) simula a parte com
dado suficiente e mostra a mensagem de dado insuficiente só para a classe
que ainda não maturou, em vez de bloquear a tela inteira por causa de uma
posição nova.

**(c) Memória de cálculo obrigatória.** Cumprindo o contrato já exigido pelo
`decisions/0010` para toda métrica derivada, o objeto `assumptions` da
resposta desta feature mostra, no mínimo: a fonte da distribuição usada por
classe (`asset_valuations` ou `benchmark_returns`), o tamanho da amostra em
meses, o método de amostragem (ex. bootstrap histórico vs. paramétrico) e o
número de cenários simulados. O usuário precisa poder ver de onde veio a
faixa de percentil, não só a faixa em si, exatamente como qualquer outro
`assumptions` já exigido no produto.

## Alternativas consideradas
- **Rodar a simulação de qualquer forma, mesmo com pouco dado, com um aviso
  genérico de "amostra pequena":** descartada. Um aviso de rodapé não
  desfaz o efeito de um número de percentil grande e específico ("84%") já
  ter sido mostrado com destaque visual — o usuário lembra do número, não
  do aviso. A honestidade estatística exige não gerar o número, não só
  avisar sobre ele depois de gerado.
- **Piso de 12 meses em vez de 24:** descartada — um ano cobre só um ciclo
  sazonal, insuficiente para distinguir "essa classe sempre se comporta
  assim em dezembro" de "esse dezembro específico foi atípico".
- **Piso de 60 meses (5 anos), padrão mais comum em relatórios
  institucionais de gestoras:** descartada por ora — inviabilizaria a
  feature por anos dado o histórico real de dados do produto (poucos meses
  desde a migração para Postgres, `decisions/0026`); 24 meses é o piso
  mínimo defensável, não o ideal estatístico, e pode subir depois se a
  experiência mostrar que ainda produz percentis instáveis.

## Consequências
- Nenhuma classe de ativo do produto atinge hoje o piso de 24 meses (a
  migração para Supabase, `decisions/0026`, e a maior parte do histórico de
  cotação real datam de 28/08/2026 em diante) — esta feature fica
  desbloqueada de PRINCÍPIO por este ADR, mas continua bloqueada de DADO até
  o piso ser atingido naturalmente pelo uso contínuo do app. Não é um
  trabalho pendente, é uma espera.
- `specs/investments` precisa de uma seção nova descrevendo a função que
  calcula "meses de retorno disponível por classe" como pré-condição
  reutilizável, chamada antes de qualquer simulação rodar.
- Se o produto vier a oferecer Monte Carlo comercialmente antes de
  reservas de investimento serem validadas juridicamente
  (`decisions/0010`), a mesma validação de enquadramento regulatório se
  aplica aqui também, por trabalhar sobre a mesma camada de investimentos.
