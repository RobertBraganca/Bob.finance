# 0030. "A receber" no período Máximo passa a somar sem limite de data futura

Status: aceita

## Contexto
Usuário reportou (28/08/2026): "o a Receber na dashboard, quando
selecionado o período máximo não soma os valores futuros a receber".

Investigação encontrou a causa: `analytics.receivable(range)` sempre
limitou a soma a `t.posted_on between range.from and range.to`. O
preset "Máximo" do seletor principal (`src/lib/store.tsx`,
distinto do "Máximo" de `forwardBoundsFor` usado só pelos cartões de
pendência) é deliberadamente olhando só pra trás — `anchor` nunca
passa de hoje (comentário já existente: um lançamento mal datado no
futuro não pode arrastar "Mês atual" e todo preset construído em cima
dele). Isso sempre foi correto para Entradas/Saídas realizadas (que
não podem estar no futuro mesmo), mas significa que "A receber" nunca
enxergava nada além de hoje, em NENHUM preset — inclusive "Máximo",
onde a expectativa razoável é "tudo", não "tudo até agora". O aumento
do horizonte de materialização para 24 meses (`decisions/0028`) só
tornou o problema visível: agora existem meses reais de receita
pendente no futuro que "Máximo" simplesmente não contava.

## Decisão
`analytics.receivable(range, opts)` ganha `opts.includeFuture` — quando
`true`, remove o limite superior de data da consulta (`t.posted_on >=
range.from`, sem `<= range.to`), somando toda receita ainda pendente
dali em diante, sem teto. `analytics.dashboard(range, opts)` repassa
`opts.includeFutureReceivables` só para o cálculo do período ATUAL —
o período anterior (usado só como base de comparação) nunca olha pra
frente, porque "quanto tinha a receber no futuro no período anterior"
não tem leitura útil.

`GET /dashboard` aceita `futureReceivables` (query param, coerção
booleana). Frontend: `Dashboard.tsx` manda `futureReceivables: 1`
somente quando `range.preset === 'max'` — todo outro preset continua
com "A receber" restrito ao próprio período, comportamento inalterado.

A comparação percentual ("vs. período anterior") de "A receber" fica
`null` (sem base de comparação) sempre que `includeFutureReceivables`
está ativo — comparar "tudo que ainda falta receber, sem limite" contra
um período anterior que nunca olhou pra frente não seria uma leitura
real de mudança, só o efeito de somar mais meses.

Verificado ao vivo: com uma previsão recorrente de teste (24 meses
materializados), o mesmo intervalo (`from`/`to` = todo o histórico do
ledger até hoje) foi de R$5.640,00 (sem `futureReceivables`) para
R$259.120,00 (com) — a diferença batendo com os pagamentos futuros
reais que antes ficavam de fora.

## Alternativas consideradas
- **Estender `range.to` do preset "Máximo" para o futuro
  diretamente**: descartada — isso jogaria o `dashboard()` inteiro
  (série mensal, período de comparação, gráficos) para um modo
  "olhando pro futuro" que ninguém pediu; Entradas/Saídas realizadas
  continuam corretas só olhando pra trás. A mudança precisava ser
  cirúrgica, só em "A receber".
- **Aplicar `includeFuture` em todo preset, não só "Máximo"**:
  descartada — o usuário reportou especificamente o caso de "Máximo";
  presets mais curtos (ex. "mês atual") têm uma leitura útil de "a
  receber DENTRO deste mês", que se perderia se qualquer preset
  passasse a somar receita de anos à frente.
- **Limitar o "futuro" a uma janela (ex. 24 meses, igual ao horizonte
  de materialização) em vez de ilimitado**: descartada — "Máximo"
  já significa "sem limite" em todo outro lugar do app (é o próprio
  nome do preset); colocar um teto arbitrário aqui reintroduziria o
  mesmo tipo de corte que motivou o pedido original.

## Consequências
- `receivable()` chamado sem `opts` (todo outro caller existente)
  mantém o comportamento de sempre — mudança estritamente aditiva,
  sem quebra.
- A UI (`Dashboard.tsx`) não precisou de nenhuma indicação visual nova
  distinguindo "A receber limitado ao período" de "A receber sem
  limite" — o rótulo já genérico ("A receber") e a ausência do badge de
  comparação quando `futureReceivables` está ativo já são o sinal
  disponível; uma indicação mais explícita fica para se o usuário
  achar necessário depois de usar.
