# 0009. Toggle de tema claro/escuro, reaproveitando a paleta "slab" já validada

Status: aceita

## Contexto
`decisions/0002` rejeitou explicitamente um toggle de tema como alternativa,
pelo motivo de que ele "dobra o trabalho de validação de contraste e nenhuma
das duas superfícies teria a chance de ser otimizada para o que ela mostra
melhor". O usuário pediu depois um toggle de fato: casca clara para quem
prefere, modo escuro completo para quem prefere, sem exigir reabrir o app
num horário diferente do dia para ver a outra opção.

O risco real do pedido é exatamente o que 0002 previu: se "modo escuro"
significasse inventar uma terceira paleta de gráfico (nem a de papel claro,
nem a de tinta escura do cartão "slab"), cada cor de série e de status
precisaria de uma nova rodada de validação de contraste — o próprio custo
que 0002 já tinha descartado como não valendo a pena.

## Decisão
O toggle existe, mas **não introduz nenhuma paleta nova**. `data-theme` no
elemento raiz alterna os tokens de cor do papel/superfície (mesmo mecanismo
de retonalização que já existia para `.on-slab`, agora global). Todo gráfico
que pediria a superfície "paper" (clara) passa a pedir a superfície "slab"
(escura) quando o tema é escuro, via `useEffectiveSurface()` — ou seja, o
modo escuro reusa a MESMA paleta de cartão de tinta que já existe e já foi
validada para contraste em `decisions/0002`, nunca uma terceira paleta.

Isso resolve o motivo original da rejeição sem descartar a ideia: zero
trabalho de validação de contraste novo, porque zero cor nova entrou em
cena.

## Alternativas consideradas
- **Modo escuro com paleta própria** (a alternativa que 0002 já tinha
  rejeitado): descartada pelo mesmo motivo de antes — dobraria a validação
  de contraste para uma terceira superfície.
- **Sem toggle, mantendo só a decisão original de 0002**: descartada porque
  o usuário pediu explicitamente a opção, e a alternativa acima resolve o
  motivo da rejeição original sem custo extra de validação.

## Consequências
- `decisions/0002` continua válida quanto à existência das duas superfícies
  (papel claro + cartão de tinta escura coexistindo na mesma tela) — o que
  muda é que agora o usuário escolhe qual das duas domina a navegação/tabelas
  fora dos cartões `Slab` deliberadamente escuros, que continuam escuros nos
  dois temas.
- Uma paleta de gráfico nova, se um dia for necessária, ainda precisa ser
  validada nas duas superfícies reais antes de virar token — este ADR não
  afrouxa essa regra, só evita que o toggle por si só exigisse uma terceira.
- Um componente de gráfico nunca escolhe sua própria superfície com base no
  tema diretamente — sempre via `useEffectiveSurface(preferred)`, para que
  essa regra fique num lugar só.
