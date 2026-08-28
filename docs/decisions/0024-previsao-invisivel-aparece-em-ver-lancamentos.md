# 0024. Previsão além do horizonte aparece em "Ver lançamentos", não só num toast

Status: aceita

## Contexto
`specs/cash-flow-reconciliation`, seção "Visibilidade além do horizonte",
já documentava este exato problema: um template (`cashFlowForecasts`)
cuja primeira ocorrência cai além do horizonte rolante de 6 meses
(`MATERIALIZE_HORIZON_MONTHS`) não materializa nenhuma linha em
`transactions` ainda — correto por design — mas isso é indistinguível de
"o cadastro falhou" quando não existe nenhum outro lugar para conferir.
A seção já registrava que isso tinha gerado um cadastro duplicado num
teste de uso real, e a correção prevista era um toast na criação
(`Pendência registrada. Próxima ocorrência: ...`) mais "uma lista de
templates" que mostraria `nextOccurrencePeriod` permanentemente.

O toast foi implementado. A lista nunca foi. Resultado: em 25/08/2026 a
mesma confusão se repetiu — um usuário cadastrando uma receita recorrente
começando em fevereiro/2027 (um mês além do horizonte, que hoje cobre até
janeiro/2027) tentou de novo duas vezes, cada vez porque não achava a
previsão em lugar nenhum depois que o toast desaparecia. `GET
/cash-flow/forecasts` sempre devolveu `nextOccurrencePeriod` corretamente
— o dado sempre esteve disponível, só nunca foi consumido por nenhuma
tela.

## Decisão
`PendingCard`/`PendingListModal` (`src/pages/Dashboard.tsx`) — o mesmo
"Ver lançamentos" que o usuário já abre para conferir pendências reais —
passa a também buscar `GET /cash-flow/forecasts` e mostrar, numa segunda
tabela, toda previsão ativa cujo próximo vencimento ainda não tem
pendência materializada correspondente.

- Não é uma tela nova: é uma segunda seção dentro do modal que já existe,
  porque "onde o usuário já vai procurar" bate mais que "onde seria
  arquiteturalmente mais limpo colocar" — o ponto inteiro é reduzir a
  distância entre "salvei" e "confirmei que salvou".
- O botão "Ver lançamentos" passa a aparecer mesmo com zero pendências
  reais, se houver alguma previsão nesse estado — antes ele só aparecia
  com `rows.length > 0`, escondendo o único lugar que agora prova que a
  previsão existe.
- Cada linha tem um botão de remover que apaga a previsão inteira
  (`DELETE /cash-flow/forecasts/:id`), não uma pendência avulsa — dá ao
  usuário uma saída direta para limpar um cadastro de teste/duplicado
  sem precisar saber que o registro vive numa tabela diferente.
- O card ganha uma linha de aviso contando quantas previsões estão nesse
  estado, visível sem precisar abrir o modal.

## Alternativas consideradas
- **Aumentar `MATERIALIZE_HORIZON_MONTHS`:** descartada — não resolve o
  problema geral (qualquer horizonte finito tem um "um mês além" possível,
  ex. uma previsão para daqui a 3 anos), e materializar mais adiantado só
  para evitar esta confusão específica cria ruído desnecessário na lista
  de pendências normais.
- **Uma tela dedicada de "gerenciar previsões futuras":** descartada por
  ora — mais trabalho de navegação para o mesmo resultado; o usuário já
  vai ao "Ver lançamentos" quando quer conferir o que está por vir, então
  é ali que a resposta precisa estar. Não impede construir uma tela
  dedicada depois, se o número de templates crescer o bastante para
  justificar.
- **Só melhorar o texto do toast:** descartada — um toast por natureza
  desaparece; a informação precisa sobreviver além do momento do clique,
  porque é exatamente "voltar depois para conferir" que causou o
  recadastro duplicado.

## Consequências
- `src/pages/Dashboard.tsx`: `PendingCard` busca `/cash-flow/forecasts`
  além de `/cash-flow/pending`; `PendingListModal` recebe e renderiza
  `invisibleForecasts`; novo `removeForecast` mutation.
- `specs/cash-flow-reconciliation`, seção "Visibilidade além do
  horizonte", corrigida — a UI descrita ali agora existe de fato, com
  nota explícita de que a versão anterior (só o toast) não bastou.
- Nenhuma rota nova: reaproveita `GET /cash-flow/forecasts` e `DELETE
  /cash-flow/forecasts/:id`, que já existiam desde a rodada anterior.
