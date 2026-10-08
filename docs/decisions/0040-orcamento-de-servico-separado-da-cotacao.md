# 0040. Orçamento de serviço como documento separado da cotação

Status: aceita (05/10/2026; implementada conforme `specs/service-proposals`)

## Contexto
Precificação tem cotações (`project_quotes`): um preço calculado a partir de
horas, custos diretos e multiplicadores, congelado na simulação
(`decisions/0021`), com sete status e uma aprovação que gera a receita. Em
05/10/2026 o usuário pediu um gerador de orçamento de serviços a partir de
telas de referência: uma lista de serviços com preço e quantidade, desconto,
total, status simples e um documento para mandar ao cliente.

## Decisão
1. **Entidade nova** (`service_proposals` + itens), não uma extensão de
   `project_quotes`. A cotação continua sendo a calculadora; o orçamento é o
   documento. Um item pode nascer de uma cotação (preço recomendado), mas
   não fica preso a ela.
2. **Quatro status**: rascunho, enviado, aprovado, recusado.
3. **Aprovar gera receitas a receber**, uma por parcela, pendentes por
   padrão, ligadas ao orçamento (`transactions.source_proposal_id`). Sair de
   aprovado ou excluir apaga as pendentes e é recusado se alguma já foi
   recebida. Aprovado trava itens e desconto.
4. **PDF gerado no navegador** (`pdf-lib`, carregado sob demanda), com os
   dados do emissor e a logo cadastrados em Parâmetros; no celular vai para a
   folha de compartilhar do sistema. Compartilhar um rascunho o marca como
   enviado, só depois de concluído.
5. **Ligação automática com o extrato** (0039) passa a reconhecer também as
   receitas pendentes de orçamento.

## Alternativas consideradas
- **Itens dentro da cotação**: misturaria um preço congelado por simulação
  com uma lista editável, e os sete status da cotação não fazem sentido para
  o cliente.
- **Substituir as cotações**: perderia o funil e a análise que já existem.
- **Link público para o cliente**: exige rota sem login e expõe o orçamento a
  quem tiver o link. Fica para depois, se o app virar produto.
- **PDF por impressão do navegador ou gerado no servidor**: o primeiro tem
  mais passos no celular e não anexa direto; o segundo exige deploy a cada
  ajuste de layout.

## Consequências
- Precificação ganha a aba Orçamentos (padrão), antes de Cotações e
  Parâmetros.
- Novas tabelas, uma coluna em `transactions`, um bucket privado no Storage.
- Deploy das funções `pricing` e `ledger`.
