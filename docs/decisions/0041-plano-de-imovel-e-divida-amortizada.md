# 0041. Plano de imóvel e dívida com sistema de amortização

Status: aceita (07/10/2026; implementada conforme `specs/property-plan`, com os desvios listados lá)

## Contexto
Em 06/10/2026 o usuário pediu um jeito de projetar a compra de um imóvel:
juntar entrada (10% a 20%) sem se descapitalizar, saber quando chega lá e, ao
comprar, ver o financiamento como dívida regressiva. Três limites do app
apareceram:
- toda dívida tem parcela fixa e o pagamento inteiro abate o saldo, o que
  serve para cartão e empréstimo simples, mas não para SAC (parcela cai todo
  mês) nem para separar juros de amortização;
- toda meta mede o progresso contra a carteira inteira, então uma meta de
  imóvel contaria o mesmo dinheiro que a reserva e as outras metas;
- o propósito `buy_property` era só um rótulo.

## Decisão
1. **Plano como extensão da meta** (`property_plans`, um por meta de
   propósito `buy_property`), não uma área nova: reaproveita aporte, retorno
   esperado e a aba Metas. Uma calculadora irmã em Calculadoras usa as mesmas
   funções puras sem gravar nada.
2. **Dinheiro necessário inclui a reserva recalculada com a parcela**
   (custo de vida − gasto que some + 1ª parcela, vezes o múltiplo). O que
   faltar na reserva sai do dinheiro do imóvel.
3. **Ativos ligados à meta** (`assets.goal_id`), opcional e exclusivo com a
   reserva. Meta sem ativo ligado segue medindo a carteira inteira.
4. **Dívida com `amortization` opcional** (`sac` | `price`) e
   `monthly_fees_cents`. Nulo mantém o comportamento antigo para todas as
   dívidas existentes. Com sistema, cada parcela tem valor próprio e o
   pagamento abate só a amortização.
5. **A dívida só nasce ao concretizar a compra**, com os números do
   contrato. Até lá o financiamento é projeção dentro do plano.
6. **O imóvel entra no Imobilizado na compra** (opcional, marcado por
   padrão), pelo caminho que qualquer bem imobilizado já usa: ativo
   `illiquid`, compra de quantidade 1 e avaliação no valor pago. O patrimônio
   líquido reflete imóvel menos saldo devedor.

## Alternativas consideradas
- **Criar a dívida já na simulação**: misturaria uma compra que não
  aconteceu nos totais de dívida e no fluxo de caixa.
- **Converter todas as dívidas parceladas para Price**: mudaria saldos e
  parcelas de contratos que hoje estão certos para o usuário.
- **Carteira menos reserva como dinheiro do imóvel**: simples, mas continua
  contando o mesmo dinheiro em várias metas.
- **Correção por TR/IPCA**: precisão maior, ao custo de séries externas;
  fica como premissa declarada (taxa constante).

## Consequências
- `materializeDebtInstallments`, `recordPaymentSnapshot` e `projectPaydown`
  ganham um ramo para contratos amortizados; o ramo antigo não muda.
- Publicar exige `insights` e `ledger`.
- A decisão geral sobre metas que dividem a carteira (segunda etapa de
  Investimentos) fica mais barata: o dado já existe.
