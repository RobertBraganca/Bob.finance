# Spec: Diário

Status: implementado

## Objetivo
Lançar um gasto do dia sem passar pelo fluxo de importação, e ver o ritmo do
mês contra o teto de gasto num heatmap.

## Histórias de usuário
- Como usuário, eu quero lançar um gasto rápido (valor, categoria, conta,
  nota) sem abrir uma tela de formulário completa.
- Como usuário, eu quero ver quais dias do mês gastei mais, num heatmap.
- Como usuário, eu quero saber se estou no ritmo certo para não estourar o
  teto do mês, dado quantos dias já passaram.

## Modelo de dados
Escreve direto em `transactions` com `source = 'daily'` — não existe tabela
separada para lançamento manual. Lê `monthlyGoals`/`categoryCaps` para o
teto (ver `specs/monthly-goals`).

## Contrato de API
| Rota | Método | Observação |
|---|---|---|
| `/transactions` (POST, via daily) | POST | Grava com `source: 'daily'` |
| `/analytics/daily` | GET | Série de gasto por dia do mês, para o heatmap |

## Regras de negócio
- Um lançamento do diário é indistinguível de um lançamento importado em
  qualquer agregação — a única diferença é o campo `source`, usado só para
  auditoria, nunca para filtrar totais.
- Ritmo projetado = gasto realizado ÷ dias decorridos × dias do mês,
  comparado ao teto vigente.

## UI
`Daily.tsx`: formulário de lançamento rápido + heatmap de intensidade por
dia (`SpendHeatmap`) + card de ritmo projetado.

## Casos de borda
- Sem nenhum gasto ainda no mês: heatmap com todos os dias em zero, não
  vazio.
- Sem teto definido: ritmo é mostrado sem comparação, não escondido.

## Fora de escopo
- Edição em massa — isso é `Lançamentos`.
