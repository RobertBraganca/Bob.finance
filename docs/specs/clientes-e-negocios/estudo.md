# Estudo: Precificação com clientes, negócios e status mais práticos

Status: estudo (21/10/2026), com as decisões abaixo. Fases 1 a 4 implementadas em 21/10/2026 (seção 7); o assistente criar cliente e mudar estágio por frase (pergunta 5) fica para depois.

## Decisões (21/10/2026)

| Pergunta | Decisão |
|---|---|
| O que unificar | **Cotações e Orçamentos** num fluxo só |
| Fonte do LTV, recorrência e MRR | **Dinheiro real do extrato + previsto** (orçamentos aprovados e pendentes) |
| Escopo | **B: negócio unificado, em fases** (status na lista, clientes, métricas, fluxo unificado) |
| Serviços | **Catálogo de serviços leve** escolhido ao montar o orçamento |
| Assistente criando cliente e mudando status | em aberto (pode entrar depois sem mudar o desenho) |

## 1. O que você pediu

1. Mudar o **status** de uma cotação ou orçamento **fora do card clicável** (hoje só dentro do detalhe).
2. **Unificar** cotações e orçamentos num fluxo só (a frase original fala em "cotações e investimentos"; ver pergunta 1).
3. Um **gerenciador de clientes** pequeno: lead ou empresa, com contatos, e-mail e descrição.
4. **Vincular** cada negócio ou orçamento a um cliente da lista.
5. Acompanhar por cliente: **LTV**, **recorrência**, **MRR** (você escreveu "MMR"; assumi receita mensal recorrente) e **serviços**.

## 2. Como é hoje (lido no código)

| Peça | Hoje |
|---|---|
| Telas | Precificação tem 3 abas: **Orçamentos**, **Cotações** e **Parâmetros** (`src/pages/Pricing.tsx`, 1.538 linhas) |
| Cotação (`project_quotes`) | a calculadora: horas, custos e multiplicadores viram 4 preços congelados. **7 status**: rascunho, enviada, em análise, precisa de ajustes, pausada, reprovada, aprovada |
| Orçamento (`service_proposals`) | o documento ao cliente, com itens, desconto, condições e PDF. **4 status**: rascunho, enviado, aprovado, reprovado |
| Ligação entre os dois | cada item do orçamento pode vir de uma cotação (`source_quote_id`), depois é independente |
| Cliente | **texto livre** (`client_label`) nas duas tabelas, sem cadastro, contato nem histórico |
| Aprovar | gera as **receitas a receber** (pendências no extrato) com `source_proposal_id` ou `source_quote_id`, em N parcelas |
| Mudar status | só dentro do detalhe; aprovar abre um modal (parcelas, conta, data) porque grava no extrato |

Dois achados que moldam o desenho:
- **Já existe um elo entre venda e dinheiro real.** As receitas geradas pela aprovação carregam o id do orçamento ou da cotação. Isso permite um LTV **a partir do extrato** (o que de fato entrou), não só do que foi orçado.
- **Receita recorrente que não nasceu de orçamento** (Pix de cliente mensal) não está ligada a ninguém. Hoje ela é só uma TAG ("Receita de Projetos Recorrentes / Clientes") e o nome de quem pagou na descrição.

## 3. Opções de arquitetura (as "stacks")

Todas continuam no que o app já usa (React + TanStack Query, Fastify e Edge Function Hono, Postgres com Drizzle). A pergunta é **quanto do modelo muda**.

| | **A. Camada de clientes** | **B. Entidade "Negócio"** (recomendada) | **C. Mini-CRM completo** | **D. CRM externo** |
|---|---|---|---|---|
| Ideia | `clients` + `client_id` nas duas tabelas; status editável na lista; telas continuam separadas | um **Negócio** por oportunidade, com cliente, estágio, valor, e **cotação e orçamento viram documentos dele** | B + atividades, tarefas, lembretes de follow-up e funil por etapas configurável | HubSpot, Pipedrive ou Notion com sincronização |
| Unifica cotação e orçamento | só na aparência (uma lista com as duas) | **de verdade** (um status, uma lista, um funil) | de verdade | depende do CRM |
| Cliente com contatos e LTV | sim | sim | sim | sim, fora do app |
| Esforço (estimativa) | baixo | médio | alto | médio (integração) e custo mensal |
| Risco | status continuam duplicados (4 e 7) | migrar cotações e orçamentos existentes para negócios | escopo cresce sem fim | dados de terceiros saem do seu banco, duplicação, quebra o "local-first" |
| Quando escolher | só quer ver cliente e mudar status | quer um fluxo comercial coerente | vai fazer prospecção ativa com muito lead | já usa um CRM e quer manter |

**Recomendação: B**, em fases (seção 7). A é um bom primeiro passo e cabe dentro de B, então começar por A não se perde. D não recomendo: contatos de clientes são dados pessoais de terceiros (LGPD), e o app foi pensado para o dado ficar no seu banco.

## 4. Status unificado (peça central de B)

Hoje: cotação com 7 status, orçamento com 4. Proposta de **um conjunto só**, mapeando os dois:

| Estágio unificado | Vem de (cotação) | Vem de (orçamento) |
|---|---|---|
| Rascunho | rascunho | rascunho |
| Enviado | enviada | enviado |
| Em negociação | em análise, precisa de ajustes | (novo: hoje o orçamento não tem) |
| Pausado | pausada | (novo) |
| Aprovado | aprovada | aprovado |
| Reprovado | reprovada | reprovado |

Regras que precisam ser preservadas:
- **Aprovar nunca é um clique solto.** Aprovar grava receitas a receber no extrato; então escolher "Aprovado" na lista **abre o modal de aprovação** (parcelas, conta, data), como hoje. Os outros estágios mudam direto.
- **Reabrir** um aprovado precisa dizer o que acontece com as receitas já geradas (hoje elas ficam; manter e avisar).
- O assistente passa a poder fazer isto por frase ("marquei o orçamento da KL Store como enviado"), reaproveitando as mesmas rotas.

**Mudar o status fora do card:** um seletor no próprio item da lista (selo clicável com menu) e, se você quiser, um **quadro Kanban** com arrastar e soltar. O seletor não exige biblioteca nova; o Kanban pede `dnd-kit` (cerca de 15 KB) e uma alternativa por teclado e leitor de tela para ser acessível.

## 5. Clientes (peça de A, B e C)

### Dados propostos
**`clients`**: nome, tipo (`lead` ou `company`, e pessoa física como variante), situação (`ativo`, `inativo`, `arquivado`), segmento, e-mail, telefone, documento (CNPJ/CPF, opcional), site, origem (indicação, rede social...), descrição, recorrente (sim ou não), criado em.
**`client_contacts`**: cliente, nome, cargo, e-mail, telefone, contato principal.
**Vínculos**: `client_id` em cotações e orçamentos (ou no negócio, em B). O texto livre atual fica como "nome no documento" e vira o rótulo do cliente na migração.

### Migração do que já existe
Criar um cliente para cada `client_label` distinto (hoje há poucos: ex. LUMNA FITNESS, KL STORE) e ligar os documentos. Um passo único, revisado por você antes de gravar.

### Tela
Nova aba **Clientes** em Precificação: lista com busca e filtros (lead, ativo, recorrente), e uma **ficha** do cliente com resumo, contatos, negócios e receita. Um cliente é escolhido num campo de busca ao criar cotação ou orçamento, com "criar cliente" na hora.

### Privacidade
E-mail e telefone de terceiros ficam no seu Supabase, nada vai a serviço externo; o assistente de linguagem natural **não recebe** esses campos (hoje só recebe frase e candidatos de lançamento).

## 6. Métricas por cliente: de onde vem o número

Aqui está a decisão que mais muda o resultado (pergunta 2).

| Fonte | Como calcula | Prós e contras |
|---|---|---|
| **1. Só orçamentos aprovados** | soma de `approved_amount_cents` por cliente | simples; mede o que foi vendido, não o que entrou; ignora Pix recorrente |
| **2. Extrato (dinheiro real)** (recomendada) | soma das receitas **liquidadas** ligadas ao cliente: as geradas pela aprovação (`source_*_id`) **mais** receitas recorrentes que você vincula a ele | é o número que de fato entrou e fecha com a Visão geral; exige vincular os Pix recorrentes (uma regra por nome do pagador resolve a maior parte) |
| **3. Híbrido** | extrato como verdade; orçamentos aprovados e pendentes como "previsto" | LTV realizado e LTV previsto lado a lado; um pouco mais de tela |

Definições propostas (editáveis):
- **LTV realizado**: receita liquidada do cliente desde o primeiro negócio. **LTV previsto**: realizado mais as pendências a receber.
- **Cliente recorrente**: marcado como recorrente **ou** com receita em pelo menos 3 meses diferentes **ou** 2 ou mais negócios aprovados.
- **MRR**: soma, por mês, da receita dos clientes recorrentes (média dos 3 últimos meses por cliente para suavizar atraso de pagamento). Mostrar também **clientes recorrentes ativos** e **concentração** (quanto do MRR vem do maior cliente, para o risco ficar visível).
- **Ticket médio** por cliente, **taxa de aprovação** por cliente e **tempo médio até fechar**.
- **Serviços**: itens dos orçamentos agrupados por título: quantas vezes foi vendido, receita total e por cliente; "serviços mais vendidos" e "serviço que mais cresce". Hoje os itens são texto livre (`title`); agrupar por título exato pode fragmentar ("Logo" e "Logotipo"), então vale um **catálogo de serviços** leve (pergunta 4).

Estes números só **observam**; não dizem "foque em tal cliente" (decisão 0010).

## 7. Fases sugeridas (cada uma entrega valor sozinha)

| Fase | Entrega | Mexe no banco? |
|---|---|---|
| **1. Status na lista** (implementada em 21/10/2026, branch `feat/precificacao-status-na-lista`) | selo clicável com menu de status em Orçamentos e Cotações; aprovar abre o modal; sair de aprovado pede confirmação (no orçamento, as receitas pendentes saem); o servidor recusa aprovar de novo uma cotação que já gerou receita | não |
| **2. Clientes** (implementada em 21/10/2026, mesma branch) | migração `20261021120000_clients_and_deals`: `clients`, `client_contacts`, `client_id` em cotações e orçamentos, um cliente por nome dos orçamentos atuais (as cotações só se ligam quando o rótulo bate exatamente, porque o campo delas é "cliente ou projeto"); aba **Clientes**, ficha em `/precificacao/clientes/:id` e "Cliente da lista" ao criar ou editar cotação e orçamento | sim (migração, com autorização) |
| **3. Métricas** (implementada em 21/10/2026) | ficha com LTV realizado e a receber, recorrência, MRR, ticket e taxa de aprovação; "nomes no extrato" (`client_payer_aliases`) ligam Pix sem orçamento ao cliente, com sugestões tiradas das entradas; aba **Serviços** com o catálogo (`service_catalog`, `service_id` no item) e o que cada serviço vendeu | mesma migração |
| **4. Fluxo unificado** (implementada em 21/10/2026) | aba **Negócios** (padrão): orçamentos e cotações numa lista só, com seis estágios (Rascunho, Enviado, Em negociação, Pausado, Aprovado, Recusado), em lista ou quadro; o orçamento ganhou "Em negociação" e "Pausado" no enum; na cotação, "Em revisão" e "Em ajuste" leem como "Em negociação" (nenhum dado de status migrado). "Calcular preço" abre a simulação; a aba Cotações continua como a calculadora com os gráficos | mesma migração (só valores novos no enum) |

A fase 1 é pequena e resolve a primeira dor sozinha. As 2 a 4 são a decisão de arquitetura (A, B ou C).

## 8. Perguntas em aberto

1. **"Unificar cotações e investimentos"**: você quis dizer cotações e **orçamentos**? (No orçamento, o preço ao cliente costuma ser chamado de "investimento". Se o pedido era outro, me diga.)
2. **De onde vem o LTV**: dinheiro real do extrato, só os orçamentos aprovados, ou os dois lado a lado?
3. **Quanto construir**: só camada de clientes (A), negócio unificado (B), ou mini-CRM com tarefas e follow-up (C)?
4. **Serviços**: agrupar pelo título digitado, ou criar um catálogo de serviços (nome, preço de referência) para escolher ao montar o orçamento?
5. **Assistente**: quer que ele também crie cliente, mude status e registre contato por frase? (Pode entrar depois, sem mudar o desenho.)

## 9. Riscos e cuidados

- **Aprovar grava no extrato**: qualquer atalho de status precisa passar pelo modal de aprovação. É a regra mais fácil de quebrar.
- **Migração de status** (fase 4): mexe em dados existentes; só com cópia verificada e a sua autorização.
- **Pooler do Edge**: as consultas de métricas rodam em sequência, nunca `Promise.all` (project-memory, 18/10/2026).
- **Dado pessoal de terceiros**: e-mail e telefone ficam só no seu banco, com RLS ligado como nas outras tabelas.
- **Tamanho**: `Pricing.tsx` já tem 1.538 linhas; a fase 4 é a hora de separar a tela em arquivos por aba antes de crescer.
