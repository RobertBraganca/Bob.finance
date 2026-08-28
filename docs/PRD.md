# PRD — Finanças BEEKOFF®

Status: vivo. Este documento descreve o produto como ele existe hoje, não um
plano futuro; ele é atualizado junto com o código, não escrito uma vez e
esquecido.

## 1. Visão

Um app de finanças pessoais e de negócio, local-first, para uma única pessoa
que administra contas PF e PJ ao mesmo tempo (freelancer/PJ prestando serviço
com vida financeira pessoal misturada na prática, ainda que separada nos
extratos). Os dados nunca saem da máquina: um arquivo SQLite, sem login, sem
nuvem, sem trilha de terceiros.

O produto existe para responder, com dado real e nunca discordante entre
telas, três perguntas que aplicativos de banco não respondem juntas:

1. Quanto entrou e saiu, líquido de transferências entre as próprias contas?
2. Quanto da dívida, do custo de crédito e da meta de investimento essa
   entrada/saída realmente sustenta?
3. Quanto do próximo real ainda não está comprometido, e a que distância cada
   meta configurada (dívida, reserva de emergência, carteira) está de ser
   cumprida, dado tudo isso junto?

A terceira pergunta já foi redigida como "o que fazer com o próximo real".
Foi reescrita quando o ADR 0010 entrou (seção 4): o produto evidencia a
distância até cada meta que o próprio usuário configurou, e a decisão de para
onde mandar o dinheiro continua sendo dele. A pergunta que o app responde é
"quanto falta para cada coisa", nunca "faça isto".

## 2. Quem usa

Uma persona: profissional autônomo/PJ (BEEKOFF®) que:

- Recebe de clientes recorrentes e pontuais, tanto na conta PJ quanto
  diretamente (freelas avulsos).
- Transfere PJ → PF como pró-labore, com frequência que não é fixa.
- Tem cartões de crédito em mais de um banco, com ciclos de fechamento
  diferentes.
- Tem dívidas com parcelas fixas e dívida rotativa (cartão) ao mesmo tempo.
- Investe em ações, FIIs e outras classes, e quer que aporte novo respeite
  uma meta de alocação por classe e uma reserva de emergência antes de
  qualquer coisa.
- Importa extrato de banco em CSV manualmente; não há open finance nem
  integração bancária automática.

## 3. Problema

Sem este app, essas perguntas exigem abrir 4-5 extratos e uma planilha:
- Bancos mostram saldo, não resultado líquido de transferências internas.
- Nenhum banco cruza cartão + dívida + investimento numa visão só.
- Categorização manual em planilha não aprende e não se corrige sozinha.
- "Quanto aportar em quê" é uma decisão que hoje se faz de cabeça, sem
  considerar meta de alocação, nota de qualidade do ativo ou reserva de
  emergência ainda incompleta.

## 4. Princípios de produto (não negociáveis)

Estes princípios foram testados contra alternativas reais durante o
desenvolvimento — ver `decisions/` para o registro de cada um. Resumo:

- **Uma fonte de verdade.** `transactions` é a única tabela que qualquer
  painel lê. Não existe cache de relatório, rollup materializado ou cópia de
  lançamento em outro lugar.
- **Derivar, nunca guardar.** Saldo de conta, posição de investimento, saldo
  de dívida corrigido: tudo é calculado a partir do histórico de lançamentos
  a cada leitura, nunca armazenado como número solto que pode dessincronizar.
- **Nada entra sem revisão.** Toda importação passa por staging → tela de
  revisão → commit explícito.
- **Sugestão nunca é aplicação automática.** Conciliação bancária, promoção
  de regra aprendida, correspondência de duplicata: tudo aparece como
  sugestão com um botão de confirmação. Nada se aplica sozinho.
- **Dinheiro é inteiro em centavos.** Nunca float, em nenhuma camada.
- **pt-BR em todo texto voltado ao usuário**, sem travessão como separador de
  frase (ver ADR 0007) — vírgula, ponto, dois-pontos ou reestruturação da
  frase.
- **Evidenciar, nunca prescrever.** O sistema calcula, contextualiza e projeta
  com base em dados e parâmetros definidos pelo usuário. Nunca determina qual
  decisão financeira o usuário deve tomar. Toda métrica derivada se classifica
  em uma de três categorias, Observação, Projeção ou Simulação, e nunca numa
  quarta categoria de Recomendação, que fica estruturalmente fora do produto.
  Para investimentos, o sistema pode evidenciar o desvio entre a carteira
  atual e a política de alocação definida pelo próprio usuário, mas nunca
  recomenda ativo, classe ou operação específica. Ver ADR 0010, que também
  exige memória de cálculo auditável em toda métrica derivada exposta: sem
  ela, linguagem instrumental não cumpre o princípio.

## 5. Áreas de produto (specs)

Cada uma tem um `specs/<area>/spec.md` com histórias de usuário, modelo de
dados, contrato de API e regras de negócio detalhadas. Aqui, o resumo de
escopo:

| Área | O que resolve |
|---|---|
| [Importação e categorização](specs/import-and-categorization/spec.md) | CSV de 6 bancos → ledger revisado, deduplicado, categorizado por regra + memória aprendida |
| [Painel (dashboard)](specs/dashboard/spec.md) | KPI do período, cartões de crédito, pendências, fluxo entre contas, quebra por categoria |
| [Diário](specs/daily-ledger/spec.md) | Lançamento rápido do dia a dia e ritmo de gasto contra o teto do mês |
| [Metas do mês](specs/monthly-goals/spec.md) | Meta de receita, teto de gasto geral e por categoria, sequência de acertos |
| [Endividamento](specs/debt/spec.md) | Custo real da dívida, parcelas, avalanche vs. cenário atual, comprometimento de renda |
| [Investimentos](specs/investments/spec.md) | Carteira derivada de aportes, alocação por classe, "Diagrama do Cerrado" (nota de resistência), reserva de emergência, cotação BRAPI |
| [Cartões de crédito](specs/credit-cards/spec.md) | Limite, ciclo de fatura, disponibilidade — base para cruzar com gasto no crédito |
| [DRE PJ x PF](specs/dre/spec.md) | Resultado por conta, lado a lado, para separar o que é da empresa do que é pessoal |
| [Conciliação de fluxo de caixa](specs/cash-flow-reconciliation/spec.md) | Receita/despesa futura já confirmada, unificada ao ledger, conciliada por sugestão manual |
| [Contas, bancos e categorias](specs/settings-accounts-profiles/spec.md) | Perfis de leitura de CSV por banco, árvore de categorias, regras |
| [Backup e recuperação](specs/backup-and-recovery/spec.md) | Snapshot versionado antes de toda migração, backup manual sob demanda, restauração com confirmação explícita |
| [Lançamentos](specs/transactions-ledger/spec.md) | Visão completa e editável do ledger: seletor de direção, formulário de lançamento padronizado, filtro por categoria-mãe e filhas |
| [Saúde financeira](specs/financial-health/spec.md) | Health Score composto de 5 indicadores, runway por conta e consolidado, radar de indicadores fora da faixa configurada |
| [Motor financeiro](specs/motor-financeiro/spec.md) | Quanto do saldo ainda não está comprometido com nenhuma meta, e qual faturamento cobriria tudo que já está configurado |
| [Precificação de projetos](specs/project-pricing/spec.md) | Valor-hora real derivado do ponto de equilíbrio, preço mínimo e recomendado por projeto a partir de complexidade, urgência, porte do cliente e direitos de uso |
| [Simulador de decisões](specs/decision-simulator/spec.md) | Impacto hipotético de um gasto único ou quitação de dívida em Health Score, Runway e disponível, sem gravar nada |

As quatro últimas são camadas de leitura pura sobre o ledger e sobre as
áreas acima: não introduzem lançamento nem posição, só cruzam o que já
existe. A única coisa que gravam é a configuração do próprio usuário
(pesos, limites, parâmetros de cálculo e o histórico de simulações de
precificação, que guarda o número já calculado, não os insumos para
recalculá-lo depois) — o Simulador de decisões não grava nem isso, cada
chamada é isolada e descartada (`decisions/0016`). Nunca o resultado de um
cálculo do ledger em si, e toda resposta carrega a memória de cálculo
exigida pelo ADR 0010.

## 6. Requisitos não-funcionais

- **Local-first, zero configuração.** `npm run dev` sobe API + web sem
  variável de ambiente obrigatória; migração e seed correm no boot.
- **Sem autenticação.** Uso de uma pessoa só, numa máquina só; login
  adicionaria fricção sem reduzir risco real neste contexto.
- **Sem nuvem, sem telemetria.** Nenhuma chamada de rede além das próprias
  requisições do frontend para a API local e de duas fontes públicas de
  cotação/índice, sempre lidas, nunca gravando nada do usuário nelas: BRAPI
  (cotação de ativos, sob consentimento explícito e chave própria do
  usuário) e a série SGS do Banco Central (CDI/IPCA, sem chave, para
  `specs/investments`, "Rentabilidade").
- **Portátil para Postgres.** O schema é relacional e agnóstico ao Drizzle
  SQLite — migrar de driver não deveria exigir reescrever agregação.
- **Nenhuma migração roda sem rede de segurança.** Um único arquivo SQLite
  como fonte de verdade (seção 4) só é seguro se existir um caminho de
  volta — todo ajuste de schema gera um snapshot versionado automático
  antes de aplicar, e uma restauração nunca sobrescreve o estado atual sem
  confirmação explícita e sem salvá-lo primeiro. Ver `specs/backup-and-recovery`
  e `decisions/0014`.
- **Contraste e daltonismo validados.** Toda cor de série de gráfico e status
  é checada contra as duas superfícies reais do app antes de entrar em uso
  (`scripts/check-contrast.mjs`).
- **546 verificações ponta a ponta** (`npm run verify`) cobrindo importação,
  categorização, painel, diário, metas, dívida, investimentos, saúde
  financeira, motor financeiro e precificação de projetos contra um banco
  descartável — nunca o banco de trabalho. Mais 37 checks de backup e
  recuperação (`scripts/verify-backup.ts`, encadeado no mesmo comando),
  que precisam de banco e diretório próprios e por isso rodam como
  processo separado.

## 7. Stack

Ver [architecture.md](architecture.md#stack) para a lista completa com o
porquê de cada escolha.

## 8. Fora de escopo (deliberadamente)

- Open finance / integração bancária automática — importação é sempre CSV
  manual, por decisão de superfície de risco e por não haver acesso de API
  aos bancos usados.
- Multiusuário e autenticação — o schema já suporta múltiplas contas, mas o
  produto é de um usuário só.
- Conselho financeiro personalizado ou execução de ordem de compra/venda —
  o app organiza e projeta; a decisão e a execução são sempre do usuário.
  A camada de inteligência financeira (seção 5) não afrouxa isso: ela
  evidencia, e o ADR 0010 define o limite exato entre evidenciar e
  prescrever.
- Notificação/alerta proativo (push, e-mail) — todo dado é pull, na tela.

## 9. Como este documento evolui

Uma mudança de princípio (seção 4) ou de escopo (seção 8) vira um ADR em
`decisions/` antes de ser refletida aqui. Uma área de produto nova ganha uma
linha na seção 5 e um `specs/<area>/spec.md` próprio.
