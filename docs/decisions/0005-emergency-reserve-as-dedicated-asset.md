# 0005. Reserva de emergência tem um ativo dedicado, não só uma flag

Status: aceita

## Contexto
A meta de reserva de emergência já existia como um número calculado (multiple
× custo de vida médio) e um mecanismo que marca qualquer ativo existente como
"conta para a reserva" (`countsTowardReserve`). Isso funciona para quem já
guarda a reserva num CDB ou Tesouro Selic cadastrado. Mas para começar do
zero, o usuário não tinha um jeito de um clique para registrar um aporte à
reserva — precisava primeiro cadastrar um ativo manualmente, escolher uma
classe, depois marcar a flag, depois lançar o aporte.

## Decisão
Um ativo canônico chamado "Reserva de emergência" (classe `cash`, sempre
`countsTowardReserve = true`) é criado automaticamente no primeiro aporte —
nunca antes disso, para não poluir "Meus ativos" com um ativo vazio que o
usuário nunca pediu. Sua cota é fixada em R$1,00 (quantidade em reais é
literalmente o valor em centavos ÷ 100), então nunca precisa de cotação
registrada. O botão "Aportar na reserva" (no card da reserva e no passo
"prioridade zero" do planejador de aporte) grava direto contra esse ativo.

O mecanismo antigo (`countsTowardReserve` em qualquer ativo) continua
funcionando sem alteração — quem já guarda a reserva num CDB real marca esse
CDB, não o ativo dedicado. Os dois convivem porque a soma de progresso é
`sum(marketValueCents) where countsTowardReserve`, não amarrada a um ativo
específico.

## Alternativas consideradas
- **Campo solto fora da tabela `assets` (ex. uma coluna `reserveBalanceCents`
  em `emergency_reserve_settings`):** quebraria o princípio de "posição é
  sempre derivada de aporte" (ver `architecture.md`) — teria sido a única
  posição do sistema com saldo guardado em vez de calculado a partir de
  trades.
- **Exigir que o usuário cadastre o ativo manualmente antes de aportar:**
  mantém a fricção que motivou a feature; o ponto era eliminar o passo
  intermediário.

## Consequências
- "Reserva de emergência" aparece em "Meus ativos" sob a classe Caixa assim
  que existe — isso é intencional, não um efeito colateral a esconder.
- Qualquer relatório de posições precisa continuar tratando esse ativo como
  um ativo normal (ele passa por `positions()` sem tratamento especial),
  então nenhuma agregação existente precisou de exceção.
