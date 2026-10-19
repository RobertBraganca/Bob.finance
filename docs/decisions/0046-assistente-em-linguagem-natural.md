# 0046. Assistente em linguagem natural: o modelo lê e propõe, o usuário confirma

Status: aceita (19/10/2026; especificada em `specs/assistente`)

## Contexto
O usuário passou a descrever o que acontece com o dinheiro em frases soltas
("Receita Coral Opus de R$ 750,00, 50% finais, pagamento previsto para segunda,
dia 19"), e hoje cada uma dessas frases vira vários cliques: achar a pendência,
corrigir a data, escrever o comentário. A tentação é deixar um modelo de IA
fazer isso sozinho, o que é um risco: um erro de interpretação entraria no
extrato (que é a fonte de todos os números do app), e em investimentos pareceria
conselho (decisions/0010).

## Decisão
- Um chat em painel lateral, em todas as telas, que entende a frase e **propõe**
  ações: ajustar pendência (data, valor, comentário), comentar uma transação,
  criar lançamento, entrada do Diário, compra ou venda de ativo e aporte.
- O modelo (Claude, chamado só no servidor) tem ferramentas **de leitura**. Ele
  nunca grava. Quem grava é o `apply`, depois do Confirmar do usuário, e só o que o
  servidor guardou na proposta (nunca o que o navegador mandar), numa transação.
- Cada aplicação guarda o antes e o depois e tem Desfazer enquanto o registro não
  mudar. Pode haver vários `apply` da mesma proposta (Confirmar por card).
- Registro, não conselho: o assistente recusa "devo comprar, vender ou aportar"
  (decisions/0010). Compra, venda e aporte só entram com ativo, quantidade e
  preço; faltou algo, ele pergunta.
- Datas relativas são resolvidas e conferidas pelo servidor ("segunda, dia 19"
  precisa bater com o calendário; se não bater, pergunta).
- Privacidade: à API vai só a frase e os poucos candidatos (descrição, valor,
  data, conta). Nada de extrato completo, saldos ou cartões. A chave da API é
  segredo da função (`ASSISTANT_API_KEY`), nunca vai ao navegador nem ao banco.
- Modelo barato (Haiku) primeiro; o maior (Sonnet) uma vez só, quando o barato não
  entrega uma proposta válida ou só pergunta numa frase clara.
- **Provedor** (20/10/2026): o serviço fala o formato da API de mensagens e um adaptador
  traduz para o Gemini (Google AI Studio, camada gratuita), porque a chave da
  Anthropic exige conta paga. O provedor sai do formato da chave (`sk-ant-` é Anthropic,
  o resto é Gemini) ou de `ASSISTANT_PROVIDER`; os modelos padrão do Gemini são
  `gemini-2.5-flash` e `gemini-2.5-pro`, trocáveis por `ASSISTANT_MODEL_CHEAP` e
  `ASSISTANT_MODEL_STRONG` (sempre os dois). Com o Gemini, as frases vão ao Google.

## Consequências
- Uma função Edge nova (`assistant`) e uma tabela nova (`assistant_actions`:
  frase, proposta, o que foi aplicado, antes/depois).
- Os serviços de lançamento e de investimento ganham um parâmetro opcional
  `executor` para gravar dentro da transação do `apply`, sem mudar nenhum chamador.
- Custo variável de API, limitado por mensagens por minuto e por modelo barato
  primeiro.
- Lembrete do Edge: consultas sempre em sequência, nunca `Promise.all`.
