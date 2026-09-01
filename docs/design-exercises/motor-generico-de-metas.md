# Exercício de design: motor genérico de metas (candidata #10, versão completa)

Data: 01/09/2026. Não é um ADR — a candidata #10 do estudo de viabilidade
(29/08/2026), na sua versão "motor genérico completo" (unificação AND/OR
entre `monthlyGoals`, `investmentGoals` e `targetAllocations`), não é um
risco de princípio de produto, é um risco de engenharia. O retrofit pontual
de `investmentGoals` para o vocabulário `GoalState` (documentado em
`docs/project-memory.md`, segunda leva de 30/08/2026) já mostrou que
"unificar vocabulário" e "unificar fórmula" são coisas diferentes, e a
segunda pode não valer a pena. Este documento é o levantamento que precisa
existir antes de qualquer ADR ou código para a versão completa.

## Tabela comparativa, com dado real dos três domínios

| | `monthlyGoals` (Metas do mês) | `investmentGoals` (Metas de investimento) | `targetAllocations` (Alocação-alvo) |
|---|---|---|---|
| **Arquivo/função** | `goals.ts#getPeriodProgress` | `investments.ts#goalProjection` | `investments.ts#assetAllocationWithinClass` |
| **O que é "o alvo"** | Três formas DIFERENTES no mesmo domínio: `incomeTargetCents` (valor fixo, direção "atingir ou superar"), `spendCapCents` (valor fixo, direção "não ultrapassar", invertida), `savingsRateTargetBps` (uma taxa). Já existem DUAS funções pra isso hoje: `targetState()` (direção ≥) e `capState()` (direção ≤, com ritmo linear). | Um valor fixo (`targetValueCents`) + uma data-alvo OPCIONAL (`targetDate`). O "quando" não é obrigatório aqui, ao contrário de `monthlyGoals`. | Um PERCENTUAL do portfólio (`targetBps`) por classe de ativo. Categoricamente diferente das outras duas: é relativo ao TODO (soma de todas as posições), nunca um número absoluto independente. |
| **O que é "no ritmo"** | Já duas fórmulas diferentes DENTRO do mesmo domínio: `targetState` compara o valor ATUAL contra 85% do alvo FINAL, sem noção de quanto do período já passou; `capState` compara o gasto contra um ritmo LINEAR esperado até hoje (`cap × elapsedShare`) e contra 85% do teto. | Uma terceira fórmula, diferente das duas acima: usa a trajetória PROJETADA inteira (juros compostos mês a mês) comparada contra a data-alvo, não uma comparação pontual "atual vs. X% do alvo". Sem data-alvo, degenera para "a trajetória chega lá algum dia" (`reachedMonth !== null`). | Não existe. Só existe `driftBps` (diferença atual vs. alvo, em pontos percentuais) e `rebalanceCents` (quanto mover). Nenhuma classificação de estado, nenhum badge, nenhuma cor. |
| **Dimensão de tempo** | Obrigatória, e é a única "em andamento": todo período tem `isCurrent`/`daysElapsed`/`daysTotal`, com noção explícita de "quanto do mês já passou". | Existe, mas OPCIONAL, e é uma DATA-ALVO pontual (calendário), não um período em andamento — não há "quanto do prazo já passou" sendo comparado a "quanto do progresso já foi feito" a cada leitura. | Não existe. Sem período, sem data-alvo, sem noção de "ritmo até quando" — a alocação-alvo é atemporal, "deveria ser assim sempre". |
| **Ausência de meta** | Estado explícito `no_target`, com rótulo próprio na UI ("Sem meta"), tratado como um resultado real, nunca omitido. | Mesmo vocabulário `no_target` (retrofit do estudo #10 já feito), mas a fórmula que produz esse estado não tem nada em comum com `targetState`/`capState` — só o RÓTULO de saída é compartilhado. | Quando não há `targetBps` configurado pra uma classe, o campo vem `null` e a UI mostra uma célula vazia (`slice.driftBps === null ? '' : ...`, `src/pages/Investments.tsx`), sem nenhum rótulo "sem meta" — omissão silenciosa, não um estado positivo. |

## Achado

Os três domínios divergem em toda dimensão levantada: três formas
estruturalmente diferentes de "alvo" (absoluto-com-direção-para-cima,
absoluto-com-direção-para-baixo, relativo-ao-todo), pelo menos três fórmulas
diferentes de "no ritmo" já em produção (e uma quarta ausência total de
fórmula), dimensão de tempo obrigatória versus opcional versus inexistente,
e tratamento de ausência de meta como estado explícito versus omissão
silenciosa.

Isto não é um caso de três domínios parecidos que só ainda não foram
organizados sob uma interface comum — é um caso de três perguntas
genuinamente diferentes ("estou gastando dentro do combinado este mês?",
"minha carteira vai atingir R$X até a data Y?", "minha alocação está onde
configurei que deveria estar?") que só compartilham a palavra "meta" na
conversa entre humanos, não a mesma forma matemática por trás.

**Um motor genérico de FÓRMULA que cobrisse os três precisaria de ramos
especiais para praticamente cada linha da tabela acima** — na prática,
seria três implementações inteiras escondidas atrás de uma interface comum,
exatamente o anti-padrão que o retrofit pontual do estudo #10 já expôs numa
escala menor (dois domínios, uma incompatibilidade encontrada). Generalizar
para três não reduziria complexidade, deslocaria a mesma complexidade para
dentro de condicionais de uma função só, tornando-a mais difícil de auditar
que as três funções separadas de hoje.

## Conclusão

**Não vale a pena generalizar a FÓRMULA além do retrofit pontual já feito.**
Isto é um resultado válido e útil do exercício, não uma falha dele. Os três
domínios continuam com sua própria função de estado (`targetState`,
`capState`, a fórmula de `goalProjection`), cada uma correta para a pergunta
que resolve.

O que já valeu a pena, e continua valendo, é unificar só o VOCABULÁRIO de
saída (`GoalState`/`MeterState`) para que a mesma cor e o mesmo ícone
signifiquem a mesma coisa em qualquer badge do produto — isso já foi feito
para `monthlyGoals` e `investmentGoals` no retrofit pontual do estudo #10.

**Uma extensão pequena e de baixo risco, distinta de "construir o motor
genérico", fica registrada aqui como possível próximo passo, não decidida
neste exercício:** dar a `targetAllocations` uma classificação de estado
própria (ex. faixas de `driftBps`: dentro de ±N pontos é `on_track`, acima
disso é `at_risk`), só para consistência visual de badge — nunca
compartilhando fórmula com os outros dois domínios, e nunca resolvendo
sozinho a ausência de dimensão de tempo desse domínio (que é estrutural, não
uma lacuna a preencher). Isto ficaria de fora do escopo deste exercício e
exigiria sua própria decisão, se e quando o produto sentir falta do badge
ali.
