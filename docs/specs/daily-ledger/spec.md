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
`Daily.tsx`: formulário de lançamento rápido + curva de intensidade por dia
(`SpendAreaChart`, Area Chart - Gradient, 29/08/2026) + termômetro de
gastos por dia da semana (`DailyHeatmap`, grade de calendário, 01/09/2026)
+ card de ritmo projetado. A curva e o termômetro leem a MESMA série
(`daily.data.days`) de duas formas: a curva mostra tendência ao longo do
mês, o termômetro separa por dia da semana — perguntas diferentes, nunca
uma segunda fonte de dado.

## Sequência de uso (Status: implementado, 30/08/2026)
Contador observacional de dias seguidos com lançamento (`source='daily'`),
puramente derivado (`analytics.dailyStreak()`, dias distintos de
`transactions`, sem tabela nova). Hoje ainda "conta" enquanto não vira meia-
noite, senão o contador zeraria toda manhã antes do usuário abrir o app.
Nunca prescritivo — nenhuma linguagem de "não quebre a sequência", só o fato
("X dias seguidos"). Ver estudo de viabilidade #1, 29/08/2026.

## Casos de borda
- Sem nenhum gasto ainda no mês: heatmap com todos os dias em zero, não
  vazio.
- Sem teto definido: ritmo é mostrado sem comparação, não escondido.

## Fora de escopo
- Edição em massa — isso é `Lançamentos`.
