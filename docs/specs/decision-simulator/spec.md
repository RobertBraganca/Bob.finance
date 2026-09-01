# Spec: Simulador de decisões

Status: implementado

## Objetivo
Responder "e se eu fizesse X?" sobre uma ação financeira ainda não
confirmada — comprar algo específico, quitar uma dívida — mostrando o
impacto nos números que o app já deriva (Health Score, Runway, disponível
para alocação), sem gravar nada e sem nunca dizer se a ação é uma boa
ideia.

## Histórias de usuário
- Como usuário, eu quero testar "e se eu comprar um equipamento de R$X"
  antes de decidir, e ver o impacto na minha reserva, no runway e no meu
  Health Score, sem esse teste aparecer em nenhum relatório real.
- Como usuário, eu quero testar "e se eu quitasse esta dívida agora", e
  ver quanto de juro futuro eu economizaria contra quanto minha reserva ou
  investimento diminuiria para pagar.
- Como usuário planejando decumulação/aposentadoria, eu quero testar "e se
  eu retirasse R$X/mês da minha carteira a partir de agora", e ver até
  quando o patrimônio projetado dura, sem o sistema me dizer qual valor de
  retirada "é seguro" (`decisions/0035`).

## Modelo de dados
Nenhuma tabela nova, nenhuma escrita em nenhuma tabela existente — a
simulação é uma função pura sobre o estado atual mais um parâmetro
hipotético, nunca persistida. Se o usuário quiser guardar o resultado de
uma simulação para comparar depois, isso é fora de escopo desta versão
(ver Fora de escopo).

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/simulate/one-time-expense` | POST | `{amountCents, source: 'balance'\|'reserve'\|'investment', accountId?}` → impacto em Health Score, Runway, disponível para alocação |
| `/simulate/debt-payoff` | POST | `{debtId, source: 'balance'\|'reserve'\|'investment'}` → juro futuro economizado (reusa `specs/debt`, cenário acelerado com pagamento total), impacto em Health Score, Runway, disponível |
| `/simulate/decumulation` | POST | `{monthlyWithdrawalCents, expectedReturnBps, horizonMonths?}` → série mês a mês do patrimônio da carteira sob retirada fixa, e o mês em que se esgota (ou `null`, se não esgotar dentro do horizonte) |

`source` é de onde o dinheiro hipotético sai nos dois primeiros tipos — não
existe simulação sem essa escolha, porque o impacto em Reserva e em Runway
depende inteiramente de qual saldo é reduzido. `/simulate/decumulation` não
tem `source`: a retirada sai sempre do valor total da carteira de
investimentos (`portfolioSummary().marketValueCents`), e sua saída é uma
SÉRIE (mês a mês), não um par antes/depois como os outros dois — é a
mesma diferença de forma que já existe entre `goalProjection` (série) e o
resto de `investments.ts` (leitura pontual).

## Regras de negócio
- **Cada função de leitura usada aqui é a mesma função de produção, nunca
  uma segunda fórmula.** `healthScore`, `runway`, `disponivelParaAlocacao`
  (Motor financeiro) já calculam a partir de insumos numéricos (saldo,
  valor de reserva, dívida de curto prazo); a simulação chama essas mesmas
  funções com o insumo hipoteticamente ajustado (ex. saldo menos
  `amountCents`), nunca duplica a fórmula num cálculo próprio. Se alguma
  dessas funções hoje só lê direto do banco sem aceitar um valor de
  substituição, adicionar esse parâmetro (mesmo padrão que
  `financialEngine.breakEven` já usa com `overrides: Partial<BreakEvenParams>`)
  é parte desta implementação, não uma dependência de outra spec.
- **Nunca escreve.** Nenhuma rota desta área grava em `transactions`,
  `debtPayments`, `assetTrades` ou qualquer outra tabela — é sempre
  leitura mais aritmética sobre o resultado.
- **Classificação obrigatória: Simulação, nunca as outras duas.** A
  taxonomia do `decisions/0010` já define Simulação como "mostra
  consequência hipotética de uma ação não confirmada" — esta é a única
  área do produto cuja razão de existir é justamente essa categoria; nunca
  produz Observação (fato já ocorrido) nem uma quarta categoria de
  Recomendação.
- **Nenhuma linguagem de veredito.** "Sua saúde financeira cairia de 78
  para 71" é permitido (mostra a consequência calculada); "isso não é uma
  boa ideia" ou "considere não fazer isso" não é — a diferença entre
  mostrar o número e opinar sobre o número é o limite exato desta área.
- **`amountCents` maior que o saldo/reserva/investimento disponível na
  origem escolhida**: a simulação continua (o usuário pode estar
  simulando exatamente para descobrir que não cabe), e o resultado mostra
  o saldo hipotético negativo como está, sem bloquear a chamada.
- **`premissas` obrigatório**, com cada função reaproveitada citada pela
  origem (ex. "Health Score recalculado com `reserveStatus.currentCents`
  reduzido em R$X") — mesmo contrato de memória de cálculo do ADR 0010.
- **Decumulação nunca calcula "quanto retirar" (`decisions/0035`).** O
  retorno esperado e o valor de retirada mensal são sempre insumo do
  usuário, nunca uma saída do sistema. A projeção reusa `compoundStep`
  (mesmo passo de `investments.ts#goalProjection`), com o fluxo mensal
  invertido — nenhuma segunda fórmula de juros compostos.

## UI
Um modal "Simular", acessível de Saúde financeira, Endividamento e — desde
30/08/2026 (estudo de viabilidade #6, 29/08/2026) — também do Painel, como
espaço exploratório de uso casual, não só quando há decisão real em jogo.
Mudança só de entrada/UX: o modal continua o mesmo, `decisions/0016`
inalterado (nunca persiste, sempre reusa as funções de produção).
Formulário compacto (tipo de simulação, valor, origem do dinheiro),
resultado com os deltas lado a lado (Health Score antes/depois, Runway
antes/depois, disponível antes/depois), sem indicador visual de "bom" ou
"ruim" além dos que o Health Score e o Radar já usam por conta própria. O
terceiro tipo, decumulação, troca o resultado de deltas por um gráfico da
série projetada (mesmo padrão visual das demais séries temporais do
produto) com o mês de esgotamento em destaque quando existir.

## Casos de borda
- Origem "reserva" escolhida mas o usuário não tem reserva configurada
  (`emergencyReserveSettings` no default): simulação segue, reserva
  hipotética fica negativa, mesmo tratamento de "sem meta ainda" que o
  resto do produto já usa.
- Dívida escolhida em `/simulate/debt-payoff` já sem saldo (quitada): erro
  claro, não um cálculo de economia de juros sobre zero.
- Retirada mensal maior que o suportado pelo retorno configurado: o
  patrimônio esgota antes do fim do horizonte, `depletionMonth` marca
  exatamente qual mês, e a série para de crescer em módulo ali (não
  continua projetando valor negativo).
- Retorno esperado configurado alto o bastante para nunca esgotar dentro
  do horizonte simulado (padrão de 360 meses): `depletionMonth` volta
  `null`, e a UI mostra "não se esgota no horizonte simulado", nunca
  interpreta isso como "a retirada é segura para sempre" — é só o que o
  horizonte simulado conseguiu mostrar.

## Fora de escopo
- Salvar ou comparar simulações passadas — cada chamada é isolada e
  descartada; se isso se tornar necessário, é uma extensão futura com spec
  própria, não parte desta versão.
- Simular um novo compromisso mensal recorrente (ex. "e se eu assinasse
  outro serviço de R$50/mês") — exigiria compor com `cashFlowForecasts`
  hipotético, mais complexo que os dois casos desta versão; registrado como
  extensão futura.
- Qualquer simulação sobre investimentos específicos (comprar/vender um
  ativo) — o Diagrama do Cerrado já cobre "onde alocar aporte novo"
  (`specs/investments`); simular uma venda entraria em conflito direto com
  o princípio "nunca sugere vender" da mesma área.
