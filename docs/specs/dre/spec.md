# Spec: DRE PJ x PF

Status: implementado

## Objetivo
Resultado por conta, lado a lado (PJ e PF), para separar o que é da empresa
do que é pessoal — sem que transferência entre as duas contas próprias
distorça nenhum dos dois lados.

## Histórias de usuário
- Como usuário, eu quero ver receita, despesa e resultado da conta PJ e da
  conta PF separadamente, no mesmo período.
- Como usuário, eu quero um resultado combinado das duas contas, com o
  repasse entre elas somado de volta (senão pareceria que a PF "recebeu"
  duas vezes: uma vez como repasse, outra como receita).
- Como usuário, eu quero categorizar em massa um grupo de lançamentos sem
  categoria, agrupados por quem enviou ou recebeu.

## Modelo de dados
Lê `transactions` filtrando por `accountId`, reaproveitando
`services/analytics.ts` (`totals`, `categoryBreakdown`) — nenhuma tabela
nova. `uncategorizedGroups()` agrupa por `merchantSignature`.

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/analytics/dre` | GET | `{accountId, from, to}` → totais, linhas de receita/despesa por categoria, grupos sem categoria |

## Regras de negócio
- **Exclui transferência entre contas próprias dos dois lados do cálculo**
  — sem isso, a mesma receita contaria duas vezes (uma vez quando o cliente
  paga a PJ, outra quando a PJ repassa à PF) e cada conta pareceria mais
  extrema do que é.
- **Repasse é somado de volta na visão combinada:** pareado por valor e
  data entre as duas contas (não pela categoria, que nem sempre bate nos
  dois lados do mesmo repasse) — deliberadamente por valor+data, e não por
  categoria, porque a mesma perna de repasse já foi observada com rótulos
  diferentes nos dois lados (ex. "Entre contas próprias" na PJ, "Pró-labore"
  na PF para o mesmo evento).
- **Pró-labore é despesa administrativa na coluna PJ.** Sozinho, o
  repasse é categorizado como transferência (fora do total de despesas, para
  não contar em dobro na visão combinada) — mas do ponto de vista contábil
  da empresa isoladamente, pró-labore é custo. A coluna PJ soma o valor do
  repasse (`netToPfCents`, o mesmo valor pareado usado para reconciliar as
  duas contas) às despesas totais e ao cálculo de margem/economia; a coluna
  PF e a visão combinada continuam tratando-o como transferência.
- **Ignora o filtro de conta global do Shell** — esta é justamente a tela
  que sempre mostra PJ e PF juntos; "todas as contas" ali não significaria
  nada aqui.
- **Categorização em massa por grupo** aplica a mesma categoria a todos os
  ids do grupo de uma vez, via `/transactions/categorize` — mesmo mecanismo
  usado em qualquer outra tela, nenhum atalho paralelo.

## UI
`Dre.tsx`: mesmo `PeriodPickerPopover` global do resto do app (sem filtro de
conta, que não se aplica aqui), card de
resultado combinado com veredito qualitativo (ex. "fluxo saudável" /
"conjunto no vermelho"), duas colunas (PJ, PF) com receita/despesa por
categoria, painel de grupos sem categoria.

## Casos de borda
- Nomes de conta diferentes de "Nubank PJ"/"Nubank PF": a tela espera esses
  nomes exatos e mostra aviso pedindo para confirmar em Contas e bancos —
  não adivinha qual conta é qual.

## Fora de escopo
- Regime de competência (accrual) — todo cálculo é por data de postagem no
  banco (regime de caixa), como o resto do app.
