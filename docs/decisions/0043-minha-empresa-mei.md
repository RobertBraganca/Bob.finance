# 0043. "Minha empresa" para o MEI no lugar da DRE

Status: aceita (08/10/2026; implementada conforme `specs/company-mei`, com os desvios listados lá)

## Contexto
A revisão de 08/10/2026 (beta-user + impeccable) achou que a DRE não
responde à dor do usuário, que é MEI e a própria empresa: a DRE formal
terminava num lucro igual à receita (sem as retiradas), não provisionava o
DAS, o lado PF lia uma conta só e havia cinco "linhas finais" que
discordavam. A pergunta do usuário é "quanto posso tirar da empresa este
mês".

## Decisão
1. A tela passa a se chamar **Minha empresa** e responde primeiro a
   **retirada possível** do mês: caixa da PJ − DAS a pagar − contas da PJ a
   pagar − colchão (meses de custo fixo da PJ, configurável).
2. A cascata do MEI (faturamento → DAS → custos → retiradas → ficou na
   empresa) substitui CSP/EBIT; a DRE contábil fica recolhida.
3. **Teto do MEI** com projeção pelo ritmo dos últimos 3 meses.
4. **Retiradas** com uma função só, compartilhada com o Orçamento.
5. O lado PF lê todas as contas pessoais.

## Alternativas consideradas
- **Consertar só a DRE formal**: resolveria a incoerência, não a pergunta.
- **Imposto por alíquota sobre o faturamento** (como no Motor): errado para
  o MEI, cujo DAS é fixo.
- **Colchão em valor fixo ou nenhum**: o usuário escolheu meses de custo.

## Consequências
- Quatro colunas novas em `financial_engine_settings`.
- O Orçamento passa a usar `pjWithdrawals` para o repasse.
- Publicar `insights` (e `ledger` se `_shared` de transações mudar).
