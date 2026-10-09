# Plano: Saúde financeira, Diário e Patrimônio (specs/personal-picture)

Ordem pensada para cada etapa deixar o app coerente sozinha. Paradas para
autorização marcadas.

### Etapa 1: banco
- Migração: `debts.paid_via_card_id`, `monthly_snapshots`. Conferir as
  versões em `schema_migrations` antes de escolher o número.
- **Autorização**: aplicar (só colunas e tabela novas; nenhum dado muda).

### Etapa 2: dívida paga no cartão (B)
- `services/debt.ts`: não materializa pendência de dívida com
  `paidViaCardId`; `debtOverviewV2` desconta o saldo dela do limite usado do
  cartão e tira do calendário a parcela projetada correspondente do cartão.
- `services/budget.ts`: a parcela do mês dessas dívidas entra no grupo da TAG
  (prevista; realizada quando a fatura do mês fecha).
- DebtModal: "Paga na fatura do cartão".
- **Autorização**: ligar "Renegociação de crédito" ao cartão PicPay e apagar as
  13 pendências dela na conta PicPay (as 2 confirmadas e o reajuste de
  +R$ 223,92 ficam; se anulam). Conferir antes/depois: total do
  Endividamento, calendário, Orçamento de outubro e saldo da conta PicPay.

### Etapa 3: definições comuns (A)
- `budget.typicalPersonalSpending` e `budget.monthCap(period)` (soma dos
  grupos de categorias do plano).
- Testar contra os números de hoje (renda típica, gasto de outubro).

### Etapa 4: Saúde financeira (C)
- Score sem Liquidez; Endividamento, Reserva e Gastos pelas fontes de A.
- Radar com um comprometimento só; Runway pessoal + linha da empresa.
- Patrimônio vira uma linha com link; cada card diz a fonte.
- Motor financeiro: custos e impostos da Minha empresa; "Retirada planejada".

### Etapa 5: Patrimônio (E)
- `netWorth()` com `personal`, `company`, `debt` = total do Endividamento.
- Tela: patrimônio pessoal, empresa à parte; bem com data de aquisição.

### Etapa 6: fotos mensais (E)
- Rotina das 22:00 (`ledger` cron) grava a foto do mês corrente (upsert).
- Históricos leem as fotos quando existem e marcam o resto "reconstruído".

### Etapa 7: Diário (D)
- `/analytics/daily` com `upcoming` (7 dias) e `projectedBalance`; projeção do
  mês sem os lançamentos únicos grandes.
- Tela: "Próximos 7 dias" no topo, saldo pessoal projetado, gasto pessoal
  contra o teto do Orçamento, lançamento rápido abaixo.

### Etapa 8: verificação
- tsc, build, espelho Node/Deno, `deno check` (`insights`, `ledger`).
- Navegador desktop e 375px, claro e escuro, só leitura: os mesmos números
  em Saúde, Endividamento, Orçamento, Minha empresa e Patrimônio.
- Specs com status e desvios, ADR 0045 aceita, `docs/project-memory.md`;
  lembrar de publicar `insights` e `ledger`.
