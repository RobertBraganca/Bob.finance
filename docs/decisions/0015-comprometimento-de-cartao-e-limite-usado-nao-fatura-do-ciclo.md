# 0015. Comprometimento de cartão é limite usado, nunca fabricar fatura do ciclo

Status: aceita

## Contexto
Uma avaliação de roadmap propôs separar, no comprometimento de cartão
exibido no Motor financeiro e no Radar de risco, "fatura do ciclo atual"
de "parcelamentos futuros" — dois números em vez de um.

Ao investigar como implementar isso, apareceu uma restrição real de dado,
não de código: `services/creditCards.ts` já documenta isto na própria
função (`listCards`, comentário de topo do arquivo) — "per-purchase credit
spend isn't broken out from the checking ledger yet". No banco de trabalho
real, os quatro cartões cadastrados têm `accountId` apontando para a
própria conta corrente vinculada (ex. cartão "Nubank PF" → conta corrente
"Nubank PF"), não para uma conta dedicada ao cartão. Isso significa que uma
compra no cartão e um Pix pela mesma conta são a mesma coisa no ledger —
não há coluna nem convenção que marque "este lançamento é uma compra de
cartão com N parcelas restantes".

O número que existe hoje, `usedCents` (limite total menos disponível
medido), é o único sinal real disponível: é uma **medição** (mesmo padrão
de `debtSnapshots`, "medido, não derivado"), não uma soma de lançamentos.
Ele mistura necessariamente o que vai vencer neste ciclo com o que ainda
vai revolver em parcelas futuras, porque a própria medição (limite
disponível) não distingue as duas coisas.

Fabricar uma separação "ciclo atual vs. parcelamento futuro" a partir desse
número único seria inventar precisão que o dado não tem — o tipo de coisa
que o ADR 0010 já proíbe para métrica derivada ("memória de cálculo
auditável... sem ela, linguagem instrumental não cumpre o princípio"): não
dá para ter uma fórmula honesta para separar algo que fisicamente não foi
medido separado.

## Decisão
Não separar. Em vez disso, duas correções de honestidade na linguagem, sem
mudar o número:

1. **Renomear** o termo, em toda a memória de cálculo (`assumptions` do
   Motor financeiro e do Radar de risco), de "fatura provisionada"/
   "fatura de cartão projetada" para **"limite de cartão comprometido"** —
   o nome atual promete um recorte mensal (fatura = o que vence este mês)
   que o número não entrega.
2. **Explicitar a limitação** no campo `assumptions`: "soma do limite
   usado de todos os cartões ativos; inclui parcelamentos em andamento e
   saldo revolvente, não separável do que vence neste ciclo sem o gasto
   por lançamento de cartão, que este app não rastreia separado da conta
   vinculada."

O cálculo em si (`cards.reduce((sum, c) => sum + c.usedCents, 0)`) não
muda em `services/financialEngine.ts` nem em `services/financialHealth.ts`
— os dois já usam a mesma fonte (`listCards()`), então a correção de
linguagem só precisa acontecer nos dois lugares que compõem a frase final,
não na fonte.

## Alternativas consideradas
- **Aproximar "fatura do ciclo" pela diferença entre dois snapshots de
  limite disponível ao redor da data de fechamento:** descartada — depende
  de o usuário medir o cartão bem perto de cada fechamento, o que não é
  garantido, e produziria um número que parece preciso mas depende de
  quando por acaso o usuário lembrou de medir.
- **Adicionar uma tabela de lançamentos de cartão com parcelas** (conta
  dedicada por cartão, cada compra com número de parcelas restantes):
  resolveria o problema de verdade, mas é uma feature bem maior — mudaria
  o pipeline de importação, o modelo de dados de `creditCards` e como o
  usuário cadastra o cartão. Registrado como proposta de roadmap separada,
  não faz parte desta decisão nem desta rodada de execução.
- **Deixar o nome como está, só documentando a limitação:** descartada —
  "fatura provisionada" continuaria prometendo algo específico (o boleto
  deste mês) que o número não é; o nome errado é o problema mais visível
  na tela, não só a ausência de nota de rodapé.

## Consequências
- `services/financialEngine.ts`: label da linha e chave de `assumptions`
  trocam de "Fatura de cartão provisionada" para "Limite de cartão
  comprometido", com a nova nota explicativa.
- `services/financialHealth.ts`: mesma troca na regra `card_share` do
  radar de risco.
- `specs/motor-financeiro/spec.md` e `specs/financial-health/spec.md`
  atualizados para descrever o termo corrigido.
- Uma feature de rastreamento de compra por lançamento de cartão (com
  parcelas) fica registrada como proposta de roadmap, não como parte desta
  execução — ver `specs/credit-cards/spec.md`, seção "Fora de escopo",
  onde já havia uma nota semelhante sobre análise preditiva de redução de
  custo.
