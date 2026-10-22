# Estudo: tarefas, Comercial e acesso do contador

Status: fases 0 a 5 implementadas em 22/10/2026 (seção 9). Faltam: aplicar as migrações, configurar o Google e publicar as funções.

## Decisões (22/10/2026)

| Pergunta | Decisão |
|---|---|
| Google Agenda | tarefas no app primeiro (C); depois a Google Calendar API (B) |
| Comercial | juntar Precificação e Receita de parceiros; plataformas **ao lado** do MRR de serviços, com a receita recorrente total no Painel |
| Saúde financeira | dissolver: checklist vira tarefas, score e runway vão para a Visão geral, radar para o Orçamento; a página sai do menu |
| Contador | pacote mensal por link primeiro; depois login só leitura, só PJ |

Pedido, em resumo:
1. Um sistema de **tarefas financeiras** (emissão de nota fiscal, DAS, lembrete de investimento, tudo que for tarefa financeira do sistema), integrado ao **Google Agenda**.
2. **Comercial**: juntar Precificação e Receita de parceiros numa seção só; talvez contar as plataformas como receita recorrente (MRR).
3. **Saúde financeira** é a tela menos visitada.
4. **Compartilhar acesso** e um **ambiente do contador**.

## 1. O que o sistema já tem que é tarefa

Quase toda obrigação financeira já existe no banco, com data. Falta um lugar que junte tudo e um "feito".

| Fonte | Onde | Data | Tem "feito"? |
|---|---|---|---|
| Contas a pagar e a receber pendentes | `transactions.pending`, `cashFlow.listPending` (já marca vencida) | `posted_on` | sim: baixar ou conciliar |
| Previsões recorrentes (aluguel, retainer etc.) | `cash_flow_forecasts` (`due_day`, parcelas) | dia do mês | sim: vira lançamento pendente |
| Fatura do cartão | `credit_cards.due_day`, `card_bills.due_date` | vencimento | não (fatura paga não é marcada) |
| Parcelas de dívida | `debts.due_day`, `debt_payments` | dia do mês | sim: pagamento registrado |
| DAS do MEI | `financial_engine_settings.das_monthly_cents` | não tem (o DAS vence dia 20) | derivado: existe saída com a TAG do DAS no mês |
| Aporte mensal de meta | `investment_goals.monthly_contribution_cents` | não tem | não |
| Fechamento do mês | `monthlyClosing` (4 itens, Saúde financeira) | mês | sim, por item |
| Saque de parceiro disponível | `partners` (`readyToWithdraw`) | quando passa do mínimo | sim: saque registrado |
| Emissão de nota fiscal | não existe | - | - |

## 2. Tarefas

### O que é uma tarefa
Uma ação financeira com data, que alguém precisa fazer e marcar como feita. Dois tipos:

- **Automáticas**: nascem das fontes acima, uma por ocorrência (ex.: "Pagar DAS de outubro", dia 20; "Fatura Nubank vence", dia 10; "Receber parcela 2/2 da LUMNA"). Quando a fonte resolve sozinha (o DAS apareceu no extrato, a pendência foi baixada), a tarefa se fecha sozinha.
- **Manuais e recorrentes**: o que o sistema não enxerga. Ex.: "Emitir NF da VIO FILMES todo dia 5", "Enviar extrato ao contador até o dia 10", "DASN-SIMEI até 31/05", "Aporte na reserva todo dia 15".

**Nota fiscal**: o ponto mais útil. A tarefa "Emitir NF" pode nascer de cada **cliente recorrente** (contrato mensal, dia de emissão) e de cada **orçamento aprovado** (por parcela). Marcar como feita pede o número da nota (opcional), que fica no lançamento da receita. Emitir a NF pelo sistema (integração com a prefeitura ou um emissor) é outra coisa, bem maior, e fica fora.

### Onde aparece
- Item novo no menu **Tarefas** (Acompanhar), com Hoje, Atrasadas e Próximos 30 dias, e um calendário do mês.
- Contador no sino de notificações e um card "Hoje" na Visão geral.
- Na ficha de cada fonte (cliente, dívida, cartão), as tarefas dela.

### Modelo
Uma tabela `tasks` (título, tipo, fonte e id da fonte, vencimento, recorrência, situação aberta, feita ou pulada, feita em, observação, id do evento no Google). As automáticas são geradas de forma idempotente por fonte e período, como a materialização das previsões já faz.

## 3. Google Agenda: três caminhos

| Caminho | Como funciona | Prós | Contras |
|---|---|---|---|
| **A. Agenda assinada (iCal)** | o app publica um endereço secreto `.ics` com as tarefas; você adiciona no Google Agenda "a partir do URL" | simples, sem login Google, nada guardado de você no Google | só leitura; o Google atualiza a cada 8 a 24 horas; os alertas costumam não valer em agenda assinada |
| **B. Google Calendar API** | você conecta sua conta Google uma vez; o app cria, muda e apaga eventos, com lembrete | eventos na hora, com lembrete do próprio Google; dá para marcar horário | precisa de projeto no Google Cloud, tela de consentimento e um token guardado no servidor; mais peças para manter |
| **C. Sem Google primeiro** | tarefas e lembretes no app (sino, e-mail opcional); Google depois | entrega valor antes | não aparece na sua agenda no começo |

Recomendação: **C seguido de B**. As tarefas no app são a base de qualquer caminho; a API (B) é a que de fato lembra você na hora. O iCal (A) é um meio-termo barato, mas o atraso e a falta de alerta pesam justamente em tarefa com prazo.

## 4. Comercial

Hoje: Precificação (Painel, Negócios, Clientes, Serviços, Parâmetros) e Receita de parceiros (plataformas de comissão: Wbuy, Hostinger, Nuvemshop, Adobe), em páginas separadas.

Proposta: um item **Comercial** no menu, com as abas Painel, Negócios, Clientes, Serviços, **Parceiros** e Parâmetros. O endereço `/parceiros` continua funcionando e abre a aba.

**Parceiros como MRR**: as comissões não são contrato: variam todo mês e a receita só é reconhecida no saque. Misturar no MRR faria o MRR de serviços oscilar com algo que você não vende. Recomendação: mostrar **lado a lado**, não somado:
- MRR de serviços (o atual).
- Receita recorrente de plataformas: média das comissões dos 3 últimos meses fechados (pela data em que foram ganhas).
- Receita recorrente total = as duas, num número só, no Painel.

## 5. Saúde financeira

Hoje a tela tem: Health Score do mês, evolução do score, composição do score, runway, patrimônio pessoal, evolução do patrimônio, radar de risco e checklist de fechamento.

Leitura: metade já aparece em outras telas (patrimônio em Patrimônio, runway e radar perto do Orçamento), e o checklist de fechamento é, na prática, uma lista de tarefas.

Opções:
- **Dissolver**: o checklist vira tarefas mensais; score e runway viram um card na Visão geral; radar de risco vai para o Orçamento; a página sai do menu (o endereço continua).
- **Enxugar**: manter só score, composição e radar, e tirar o que repete outras telas.
- **Manter** como está, mais abaixo no menu.

## 6. Acesso compartilhado e ambiente do contador

Hoje o sistema é de **um dono só**: o id do usuário administrador está fixo no servidor e toda rota recusa qualquer outro login. Não há tabela de usuários nem papéis.

O que muda para compartilhar:
- **Usuários e papéis**: dono, contador (só leitura, só a parte da empresa) e, depois, outros papéis se fizer sentido.
- **Convite por e-mail** (o Supabase manda o convite); o contador cria a própria senha.
- **Escopo por papel nas rotas**: cada função passa a perguntar "este papel pode ver isto?". O contador **não vê** contas e gastos pessoais, patrimônio pessoal, investimentos nem o assistente.
- **Registro de acesso**: quem entrou e o que exportou.

**Ambiente do contador** (o que ele vê):
- DRE e "Minha empresa" do mês e do ano.
- Extrato da conta PJ, com TAGs, e exportação (CSV e, se ele pedir, OFX).
- Receitas por cliente e as notas emitidas (vindas das tarefas de NF).
- DAS e obrigações do MEI, faturamento contra o teto.
- Pendências que ele levanta para você (comentário num lançamento: "falta a nota disto").

Alternativa mais leve, sem login: um **pacote mensal** (PDF do DRE e extrato PJ em CSV) que você gera e manda por link com validade. Resolve o fechamento sem abrir o sistema para outra pessoa.

Cuidados: é a primeira vez que outra pessoa entra no sistema. Errar o escopo expõe dado pessoal. Começar só leitura, só PJ, e testar cada rota com o papel do contador antes de convidar.

## 7. Fases sugeridas

| Fase | Entrega | Mexe no banco? |
|---|---|---|
| 0. Ordem da sidebar | feito em 22/10/2026 | não |
| 1. Tarefas no app | menu Tarefas, automáticas das fontes existentes, manuais recorrentes (NF, DAS, aporte), card na Visão geral | sim (`tasks`) |
| 2. Comercial | um item no menu, aba Parceiros, receita recorrente de plataformas ao lado do MRR | não |
| 3. Google Agenda | caminho escolhido (A ou B) | sim (token ou endereço secreto) |
| 4. Contador | pacote mensal, depois login só leitura com escopo PJ | sim (usuários e papéis) |
| Saúde financeira | conforme a decisão; se dissolver, entra junto da fase 1 (checklist vira tarefas) | não |

## 8. Perguntas em aberto
1. Google Agenda: API (B), agenda assinada (A), ou tarefas no app primeiro (C)?
2. Comercial: juntar as duas páginas? E as plataformas: ao lado do MRR, somadas, ou fora?
3. Saúde financeira: dissolver, enxugar ou manter?
4. Contador: login só leitura, pacote mensal por link, ou os dois em fases?

## 9. Implementado (22/10/2026)

| Fase | O que entrou |
|---|---|
| 0. Sidebar | Acompanhar: Visão geral, Tarefas, Patrimônio, Minha empresa, Lançamentos, Diário. Planejar: Orçamento, Investimentos, Endividamento, Comercial. Configurações ganhou "Contador" |
| 1. Tarefas | menu **Tarefas** (`/tarefas`): atrasadas, hoje, próximos 7 dias e mais adiante; feitas; "Suas tarefas" (manuais, com "Emitir nota fiscal" por cliente e o número da nota ao concluir). Automáticas calculadas na leitura (`server/src/services/tasks.ts`): pendências a pagar e a receber, faturas dos cartões, DAS (dia 20, fecha sozinho quando aparece no extrato PJ), DASN-SIMEI (31/05), fechamento do mês anterior (até o dia 5), aportes das metas (fim do mês) e saques de parceiro. Card "Tarefas" na Visão geral. Migração `20261022120000_tasks` (só `tasks` e `task_completions`) |
| Saúde financeira | saiu do menu; score e runway viraram o card "Saúde financeira" na Visão geral, o radar de risco foi para o Orçamento, o checklist virou tarefas. `/saude` continua no ar, com os detalhes e os ajustes |
| 2. Comercial | Precificação virou **Comercial**, com a aba **Parceiros** (`/parceiros` abre a aba). No Painel, "Receita recorrente" = MRR de serviços + média das comissões dos 3 últimos meses fechados, mostrados lado a lado (`/partners/recurring`) |
| 3. Google Agenda | card "Google Agenda" em Tarefas: conectar, sincronizar, desconectar. Cada tarefa aberta vira um evento às 9h, com lembrete na hora e um dia antes; marcar como feita apaga o evento. Retorno do consentimento em `/tarefas/google`. Migração `20261022130000_google_calendar` |
| 4. Pacote do contador | página **Contador** (`/contador`): prévia do mês só com a parte PJ, "Gerar pacote do mês" (PDF com resumo, notas e extrato, e CSV do extrato PJ), guardado no bucket privado `accountant-packages`, com links de 7 dias e a mensagem pronta para copiar; revogar apaga os arquivos |
| 5. Login do contador | convite por e-mail na página Contador; função Edge nova **`accountant`**, a única que aceita outro login, só com leituras da PJ (`/accountant/me`, `/month`, `/packages`); quem entra como contador vê só a "Área do contador". Revogar apaga a conta. Migração `20261022140000_accountant_access` (bucket, políticas e `app_users`) |

### Para pôr no ar
1. Aplicar as migrações `20261022120000_tasks`, `20261022130000_google_calendar` e `20261022140000_accountant_access` (com autorização).
2. Publicar as funções: `insights` (tarefas, Google, plataformas), `pricing` (sem mudança de rota, mas o `_shared` mudou) e a nova `accountant` com `--no-verify-jwt` (ela confere o login e o papel em toda rota, como as outras).
3. Google Agenda (uma vez):
   - Google Cloud Console: criar um projeto, ativar a **Google Calendar API**.
   - Tela de consentimento OAuth: tipo Externo; escopos `calendar.events`, `openid`, `email`. **Publicar o app** (modo Produção): em modo de teste o Google faz o acesso expirar em 7 dias. Para uso pessoal, a tela de "app não verificado" aparece uma vez e basta continuar.
   - Credenciais, ID do cliente OAuth, Aplicativo da Web, com os URIs de redirecionamento `https://bob-finance-nu.vercel.app/tarefas/google` e `http://localhost:5173/tarefas/google`.
   - Num arquivo fora do git (ex.: `supabase/functions/.env.google`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_REDIRECT_URI=https://bob-finance-nu.vercel.app/tarefas/google`, e `npx.cmd supabase secrets set --env-file supabase/functions/.env.google`.
4. Convite do contador: no Supabase, Authentication, URL Configuration, incluir `https://bob-finance-nu.vercel.app` nos Redirect URLs (o link do convite volta para o app, que pede a senha).
