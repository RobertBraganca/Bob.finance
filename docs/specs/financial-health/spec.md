# Spec: Saúde financeira (Health Score, Runway, Radar de risco)

Status: implementado

## Objetivo
Uma pontuação única que resume o mês, quantos meses o recurso atual sustenta
o custo de vida, e um radar de indicadores fora da faixa saudável, tudo
derivado do que já existe no ledger, sem guardar número novo e sem nunca
dizer ao usuário o que fazer com o resultado (ver `decisions/0010`).

## Histórias de usuário
- Como usuário, eu quero ver uma pontuação única que resume minha saúde
  financeira do mês, com a composição de cada indicador visível, para
  acompanhar progresso ao longo do tempo sem abrir 5 telas.
- Como usuário, eu quero ver quantos meses meus recursos atuais sustentam
  meu custo de vida, com as premissas usadas explícitas, separado por PF, PJ
  e consolidado.
- Como usuário, eu quero ser avisado quando um indicador (comprometimento de
  cartão, cobertura de reserva, desvio de meta) sai da faixa saudável, sem
  que isso vire notificação proativa, isso é sempre pull, na tela (PRD
  seção 8 já exclui push/e-mail).

## Modelo de dados
Camada de leitura pura, nenhuma tabela nova. Lê de:
- `transactions` (via `services/analytics.ts`), para receita, despesa e
  saldo.
- `debts`, `debtSnapshots`, `debtPayments` (ver `specs/debt`), para
  comprometimento de renda e dívida de curto prazo.
- `creditCards`, `creditCardSnapshots` (ver `specs/credit-cards`), para
  comprometimento de limite.
- `assets`, `assetTrades`, `assetValuations`, `investmentGoals`,
  `targetAllocations`, `emergencyReserveSettings` (ver `specs/investments`),
  para cobertura de reserva e desvio de meta.
- `monthlyGoals`, `categoryCaps` (ver `specs/monthly-goals`), para controle
  de gastos.

Nenhum resultado desta área é persistido: Health Score, Runway e Radar de
risco são recalculados a cada leitura, na mesma linha do princípio "derivar,
nunca guardar" (PRD seção 4). Pesos e thresholds usados no cálculo são
parâmetros configuráveis pelo usuário (ver Regras de negócio), guardados
como configuração, nunca o resultado do cálculo em si.

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/financial-health/score` | GET | `{period, scope: 'pf'\|'pj'\|'consolidado'}` → pontuação 0-100, composição por indicador (0-100 cada, peso aplicado), `premissas` com a fórmula e os parâmetros usados em cada indicador |
| `/financial-health/score/weights` | GET/PUT | Pesos configuráveis dos 5 indicadores, com default sugerido |
| `/financial-health/runway` | GET | `{scope: 'pf'\|'pj'\|'consolidado'}` → meses de cobertura, `premissas` com cada termo do cálculo (patrimônio considerado, custo mensal médio, janela usada) |
| `/financial-health/risk-radar` | GET | `{period}` → lista de indicadores com threshold configurado, valor atual, status (dentro/fora da faixa) |
| `/financial-health/risk-radar/thresholds` | GET/PUT | Thresholds configuráveis por regra, com default sugerido |

Toda resposta de `/financial-health/score` e `/financial-health/runway`
carrega o campo `premissas` no corpo da resposta, não só como algo exibido na
UI, isso é contrato de dado (ver Regras de negócio e `decisions/0010`).

## Regras de negócio
- **Health Score é a média ponderada de 5 indicadores**, cada um normalizado
  0-100, pesos configuráveis pelo usuário com default sugerido (default:
  20% cada):
  - **Liquidez** = saldo disponível ÷ custo mensal médio dos últimos 3 meses,
    capado em 100 (ex: 2x o custo mensal → 100; 0.5x → 50).
  - **Endividamento** = 100 − comprometimento de renda com dívida (ver
    `specs/debt`, "comprometimento de renda"), capado entre 0 e 100 (0% de
    comprometimento → 100; 50%+ → 0).
  - **Controle de gastos** = 100 se dentro do teto do mês configurado em
    `specs/monthly-goals`; decresce linearmente até 0 quando o gasto real
    chega a 150% do teto. Sem meta definida (`no_target`), este indicador
    fica de fora da média (peso redistribuído entre os demais, nunca tratado
    como 0 ou 100).
  - **Reserva** = saldo da reserva de emergência ÷ meta da reserva (ver
    `specs/investments`, "reserva de emergência"), capado em 100.
  - **Metas de investimento** = 100 menos o desvio médio absoluto entre
    alocação atual e meta de alocação por classe (ver `specs/investments`,
    `targetAllocations`), capado entre 0 e 100.
  - Cada indicador com dado insuficiente (ex: nenhuma dívida cadastrada, sem
    meta de investimento) fica de fora da média daquele mês, com peso
    redistribuído proporcionalmente entre os indicadores restantes, e é
    reportado como "sem dado" em `premissas`, nunca como 0 ou 100.
- **Runway** = patrimônio considerado ÷ custo mensal médio configurado.
  Patrimônio considerado = saldo em conta + investimentos líquidos
  configuráveis pelo usuário (toggle por classe de ativo, ver
  `specs/investments`) − dívida de curto prazo (parcelas previstas nos
  próximos 30 dias, ver `specs/debt`). Calculado separado para PF, PJ e
  consolidado, filtrando por `accountId` do mesmo jeito que `specs/dre`.
  Custo mensal médio usa a mesma janela configurável (default 3 meses) em
  todos os três escopos.
- **Radar de risco** é uma lista de regras de threshold sobre indicadores já
  existentes, cada uma com o threshold configurável pelo usuário, nunca
  hardcoded no código:
  - Limite de cartão comprometido ÷ receita média > threshold (default
    35%) — "limite comprometido", não "fatura", porque o número soma o
    limite usado de todos os cartões, incluindo parcelamento em andamento
    e saldo revolvente; não é separável do que vence só neste ciclo sem o
    gasto por lançamento de cartão, que este app não rastreia separado da
    conta vinculada (ver `decisions/0015`).
  - Cobertura de reserva < threshold (default 100% da meta).
  - Desvio de alocação de investimento > threshold em pontos percentuais
    (default 10 p.p., ver extensão de `specs/investments`).
  - Gasto do mês > threshold do teto configurado (default 100%, ver
    `specs/monthly-goals`).
  Uma regra sem dado suficiente (ex: nenhum cartão cadastrado) não aparece
  no radar, não é tratada como "dentro da faixa".
- **Nenhuma métrica desta área é uma Recomendação** (ver `decisions/0010`):
  toda copy usa construção declarativa ("seu indicador X está...",
  "considerando as premissas configuradas..."), nunca segunda pessoa
  imperativa ("invista", "corte", "reduza"). O Health Score e o Radar de
  risco classificam-se sempre como Observação (fato do mês) ou Projeção
  (Runway); nenhum dos três produz uma quarta categoria de saída.

## UI
Cartão de Health Score com a pontuação e um breakdown por indicador (barra ou
anel por indicador, com o peso aplicado visível), cartão de Runway com PF/PJ/
consolidado lado a lado, lista de Radar de risco com status visual (dentro/
fora da faixa) e o valor do threshold configurado ao lado de cada item. Toda
métrica tem um link ou disclosure "como calculamos" que expande a memória de
cálculo (`premissas` da API), nunca escondida atrás de um tooltip só.

## Histórico do Health Score (Status: implementado, 30/08/2026)
`GET /financial-health/score-history` — série dos últimos N meses, cada
ponto uma chamada de `healthScore(period)` sem alterá-la, em loop
(`financialHealth.ts#healthScoreHistory`), nunca um valor persistido. Um
snapshot gravado ficaria defasado se uma transação de um mês antigo fosse
corrigida depois; recalcular sempre evita isso por completo, mesmo espírito
de "derivar, nunca guardar". Sequencial de propósito, não `Promise.all`,
pelo mesmo risco de travamento de pooler já documentado em
`goalHistory`/`homeBanners` sob Edge Functions. Mês sem dado suficiente vira
um buraco na linha do gráfico (`ScoreHistoryChart`), nunca um zero. Ver
estudo de viabilidade #3, 29/08/2026.

## Histórico de patrimônio líquido (Status: implementado, 31/08/2026)
`GET /financial-health/net-worth-history` — série dos últimos N meses, mesmo
padrão de `score-history`: cada ponto reconstitui saldo em conta, investimentos
e dívida naquela data e soma (`financialHealth.ts#netWorthHistory`), nunca um
valor persistido. O ponto em aberto do estudo #8 ("`positions()` suporta corte
de data?") foi resolvido estendendo `investments.positions(asOfDate?)` e
`analytics.accountBalances(asOfDate?)` com um parâmetro opcional — omitido,
comportamento idêntico a antes — em vez de criar uma segunda função paralela
"posições/saldos no passado". O lado da dívida reusa `debt.debtTrend()`
diretamente (já é uma série histórica de verdade, um ponto por
`debt_snapshots.as_of`), com forward-fill até a data de corte de cada mês.
Sequencial de propósito, mesmo risco de pooler das demais séries desta área.
Ver estudo de viabilidade #8, 29/08/2026.

## Casos de borda
- Nenhum dado suficiente para nenhum dos 5 indicadores do Health Score (app
  recém-instalado): estado explícito de "sem dado suficiente ainda", nunca
  uma pontuação 0 ou 50 arbitrária.
- Custo mensal médio igual a zero (nenhuma despesa no histórico): Runway e
  indicador de liquidez não calculam (divisão por zero seria enganosa),
  mostram "sem despesa registrada para calcular" em vez de infinito ou 0.
- Radar de risco sem nenhuma regra aplicável no mês: lista vazia explícita,
  não card ausente.

## Fora de escopo
- Qualquer recomendação de ação (o que cortar, quanto investir, qual dívida
  antecipar) — evidenciar é o limite desta área, ver `decisions/0010`.
- Notificação proativa (push, e-mail) do radar de risco — PRD seção 8 já
  exclui isso; o radar é sempre consultado na tela.
- Alteração de dado em qualquer tabela de origem — esta área é somente
  leitura.

## Radar de risco — sinal positivo (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero ver quando um indicador está claramente **acima**
  do que configurei (não só "fora da faixa" para o lado ruim), para saber
  quando um mês foi bom, não só quando algo precisa de atenção.

### Modelo de dados
Nenhuma tabela nova. Mesmas cinco regras já existentes, calculadas com o
mesmo dado.

### Regras de negócio
- Cada regra já tem `direction` (`'above' | 'below'`) e `outsideRange`.
  Uma regra ganha um terceiro estado, `exceedsPositively: boolean` — verdade
  quando o valor está do lado bom por uma margem configurável (default: 20
  pontos percentuais de folga sobre o threshold, editável junto dos outros
  thresholds de `financialHealthSettings`). Ex.: cobertura de reserva com
  threshold "abaixo de 100%" e valor real de 130% dispara
  `exceedsPositively`, não só `outsideRange: false`.
- **Continua Observação, nunca comemoração prescritiva.** A frase é "sua
  cobertura de reserva está 30 p.p. acima do limite configurado", nunca
  "parabéns" ou "continue assim" — mesma disciplina de linguagem do
  restante desta área.
- Uma regra sem dado suficiente não entra em nenhum dos dois lados
  (positivo ou negativo) — mesma regra já existente para "fora da faixa".

### UI
Mesma lista do Radar, um selo visual diferente (verde) para linhas com
`exceedsPositively`, ao lado do selo vermelho já existente para
`outsideRange` — não uma lista separada.

## Patrimônio consolidado (Status: implementado)

### Histórias de usuário
- Como usuário, eu quero ver, num só lugar, patrimônio, dívida,
  investimentos e liquidez consolidados — hoje esses números vivem em três
  telas diferentes (Painel, Endividamento, Investimentos) e nunca aparecem
  somados.

### Modelo de dados
Nenhuma tabela nova. O numerador do Runway (`patrimônio considerado = saldo
em conta + investimentos líquidos configuráveis − dívida de curto prazo`,
ver seção "Runway" acima) já soma exatamente os três primeiros números;
este card só expõe essa mesma soma decomposta em linhas, mais o total menos
dívida como "liquidez".

### Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/financial-health/net-worth` | GET | `{scope: 'pf'\|'pj'\|'consolidado'}` → saldo em conta, investimentos (total, não só os que contam para reserva), dívida total (não só de curto prazo), liquidez (saldo + investimentos − dívida total) |

Deliberadamente uma dívida TOTAL aqui, diferente da dívida de curto prazo
que o Runway usa — Runway pergunta "quanto tempo eu sustento", patrimônio
consolidado pergunta "quanto eu tenho versus quanto devo", e as duas
perguntas usam um recorte de dívida diferente por natureza.

### UI
Card único no Painel (ou em Saúde financeira, ao lado do Runway): quatro
números lado a lado (patrimônio em conta, investimentos, dívida,
liquidez), sem veredito qualitativo.

### Casos de borda
- Nenhuma dívida cadastrada: dívida total é R$ 0,00 explícito, não "sem
  dado".
- Nenhum investimento: mesma regra.
