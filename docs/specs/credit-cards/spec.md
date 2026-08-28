# Spec: Cartões de crédito

Status: implementado

## Objetivo
Limite, ciclo de fatura e disponibilidade de cada cartão numa visão só, como
base para cruzar com o que é gasto no crédito e futuras análises de redução
de custo.

## Histórias de usuário
- Como usuário, eu quero ver, para cada cartão: banco, conta associada,
  data de fechamento, data de vencimento, limite disponível.
- Como usuário, eu quero registrar o limite disponível medido
  periodicamente, para acompanhar a evolução, não só o valor de agora.

## Modelo de dados
- `creditCards` — nome, instituição, conta associada, limite total, dia de
  fechamento, dia de vencimento.
- `creditCardSnapshots` — limite disponível medido ao longo do tempo (mesmo
  padrão de `debtSnapshots`: medido, não derivado).

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/credit-cards` | GET/POST | Lista/cria |
| `/credit-cards/:id` | PATCH/DELETE | — |
| `/credit-cards/:id/snapshot` | POST | Registra limite disponível medido |

## Regras de negócio
- **Próxima data de fechamento/vencimento** é calculada a partir do dia
  cadastrado e da data de hoje (`nextOccurrence`), nunca uma data fixa que
  fica velha.
- **Pagamento de fatura é `kind: transfer`** na categoria correspondente —
  nunca uma despesa (evitaria dobrar a conta: uma vez na compra, outra no
  pagamento da fatura). Ver `decisions/0004` para o princípio geral por
  trás disso.
- Card ignora o filtro de período global do dashboard — limite disponível é
  um fato de agora.

## UI
`CreditCards.tsx` (CRUD completo) e widget no Dashboard (tabela compacta,
com link "Gerenciar").

## Casos de borda
- Nenhum cartão cadastrado: estado vazio explícito no widget do dashboard.

## Fora de escopo
- Importação automática de fatura — hoje o gasto no cartão entra pelo
  mesmo pipeline de CSV de qualquer conta; este módulo é só limite e ciclo.
- Análise preditiva de redução de custo — mencionada como objetivo futuro
  no pedido original, ainda não implementada; quando entrar, ganha seu
  próprio spec.
