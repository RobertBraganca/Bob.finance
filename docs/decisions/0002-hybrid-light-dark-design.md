# 0002. Direção visual híbrida: casca clara + cartões de tinta escura

Status: aceita

## Contexto
O produto precisa de duas linguagens visuais ao mesmo tempo: navegação,
tabelas e formulários pedem uma superfície neutra e legível por muito tempo
seguido; KPIs, medidores e heatmaps pedem contraste alto para o número
saltar aos olhos. Uma única superfície (tudo claro ou tudo escuro) sacrifica
um dos dois usos.

## Decisão
Casca clara em papel quente (`#ffffff`-ish) para navegação, tabelas e
formulários. Cartões de "tinta" quase preta (`#080808`-ish) para KPIs,
medidores e heatmaps. As duas superfícies coexistem na mesma tela — o
contraste entre elas é a própria ideia visual, não um modo a escolher.

Cores de série de gráfico e de status são revalidadas contra AMBAS as
superfícies reais antes de entrar em uso (`scripts/check-contrast.mjs`) —
uma cor que passa no cartão de tinta pode falhar no papel claro (caso do
verde da marca, `#32D74B`, que recebe um passo mais escuro `#1E8E3C` só no
papel).

## Alternativas consideradas
- **Modo claro único:** perde o impacto visual que um cartão de tinta dá a
  um número que precisa saltar (KPI hero, meta de reserva).
- **Modo escuro único (dark mode completo):** tabelas densas e formulários
  de revisão de importação ficam mais cansativos para leitura longa do que
  em superfície clara.
- **Toggle de tema (usuário escolhe):** dobra o trabalho de validação de
  contraste e nenhuma das duas superfícies teria a chance de ser otimizada
  para o que ela mostra melhor. *Revisitada em `decisions/0009`: o app
  ganhou um toggle depois, mas sem paleta nova — o modo escuro reaproveita a
  mesma paleta "slab" já validada aqui, então o custo de validação que esta
  seção descreve nunca se concretizou.*

## Consequências
- Toda paleta nova precisa ser validada nas duas superfícies antes de virar
  token — não existe "só funciona no escuro" como resposta aceitável.
- Um componente nunca pode assumir qual superfície o envolve; classes como
  `.on-slab` existem exatamente para isso.
