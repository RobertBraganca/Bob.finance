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

`source` é de onde o dinheiro hipotético sai — não existe simulação sem
essa escolha, porque o impacto em Reserva e em Runway depende inteiramente
de qual saldo é reduzido.

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

## UI
Um modal ou página "Simular", acessível de Saúde financeira e de
Endividamento: formulário compacto (tipo de simulação, valor, origem do
dinheiro), resultado com os deltas lado a lado (Health Score antes/depois,
Runway antes/depois, disponível antes/depois), sem indicador visual de
"bom" ou "ruim" além dos que o Health Score e o Radar já usam por conta
própria.

## Casos de borda
- Origem "reserva" escolhida mas o usuário não tem reserva configurada
  (`emergencyReserveSettings` no default): simulação segue, reserva
  hipotética fica negativa, mesmo tratamento de "sem meta ainda" que o
  resto do produto já usa.
- Dívida escolhida em `/simulate/debt-payoff` já sem saldo (quitada): erro
  claro, não um cálculo de economia de juros sobre zero.

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
