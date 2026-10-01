# Checklist por tela

Aplique em cada rota. Não é para marcar tudo como ok: é para procurar onde
não está.

## 1. Coerência financeira (prove com o número exato)

- **Aritmética visível fecha.** Resultado = Receitas − Despesas. Percentuais
  de uma quebra somam 100% (tolerância de arredondamento de 0,1 p.p. por
  linha). Total no centro de um anel = soma das fatias.
- **O mesmo número é igual em todas as telas** para o mesmo período e conta:
  despesas do mês (Visão geral, Metas do mês, DRE, Lançamentos filtrados),
  contagem de "sem TAG", repasse PJ→PF (Visão geral e DRE), saldo das contas
  (Visão geral, Contas e bancos, Patrimônio), dívida (Endividamento, Saúde
  financeira, Destino do dinheiro).
- **Escopo declarado bate com o escopo real.** Com uma conta filtrada, algum
  card continua somando todas? Um card "do período" que na verdade mostra
  "hoje" (saldo) diz isso?
- **Regras do domínio** (fonte: `docs/PRD.md`, `docs/architecture.md`,
  `docs/specs/*`):
  - pendente não entra em realizado; realizado não inclui previsão;
  - investimento e resgate não são despesa nem receita;
  - transferência entre contas próprias e pagamento de fatura não contam em
    dobro;
  - compra no cartão entra na competência certa (compra ou fatura, conforme a
    spec de cartões);
  - saldo é derivado dos lançamentos, nunca digitado;
  - PJ e PF identificadas por configuração (Motor financeiro), não por nome.
- **Sanidade.** Saldo em conta negativo, variação de +300%, gasto maior que a
  renda por meses: o app explica ou só exibe? Um número estranho sem contexto
  é achado mesmo que a conta esteja certa.
- **Derivado tem memória de cálculo.** Todo número calculado (metas,
  indicadores, projeções) tem o ⓘ "Como calculamos" com fórmula e insumos
  (`decisions/0010`). Abra e confira se os insumos reproduzem o número.
- **Evidenciar, nunca prescrever.** Texto em tom de recomendação ("você
  deveria", "invista em") é inconsistência de regra de negócio. Observação,
  projeção e simulação são permitidas.

## 2. UX e navegação

- A pergunta principal da tela é respondida no primeiro olhar? Existe um
  número ou gráfico claramente mais importante que o resto?
- Densidade: há parágrafos onde bastaria um número? Números demais sem
  hierarquia? O mesmo dado repetido em dois formatos na mesma tela?
- Terminologia consistente: "TAG" (nunca "categoria" em texto visível),
  nomes de menu iguais aos títulos das páginas, os mesmos rótulos para a
  mesma coisa em telas diferentes.
- Todo número clicável leva ao detalhe (anel → lançamentos daquela TAG, card
  de dívida → Endividamento)? Onde o usuário espera um link e não tem?
- Voltar funciona? O filtro de período e conta persiste entre telas? Deep
  link (colar a URL) reabre o mesmo estado?
- Rotas fora do menu, telas sem saída, atalho que leva para lugar diferente
  do rótulo.
- Formulários: rótulo visível, erro junto do campo, valor em R$ com máscara,
  data padrão sensata, ação primária clara, Cancelar sempre disponível,
  confirmação antes de excluir com a consequência escrita.
- Diferença entre os perfis: no modo Pessoal nada de jargão PJ vaza para
  telas que continuam visíveis?

## 3. UI

- Alinhamento, espaçamento e altura de cards na mesma linha (devem igualar).
- Hierarquia tipográfica: um título por card, rótulos menores que valores.
- Cor com significado: verde/vermelho só para direção ou status, e nunca
  sozinhos (sempre com sinal, ícone ou texto). No máximo um card escuro de
  destaque por tela.
- Tema escuro: texto legível, gráficos com as cores do tema, nenhum branco
  estourado.
- Ícones coerentes (Tabler filled), nenhum emoji como ícone.

## 4. Mobile (375px)

- Nada vaza na horizontal (medida no DOM igual a 0).
- Popovers, dropdowns e modais inteiros dentro da tela.
- Tabelas empilham ou rolam de forma evidente; a coluna de valor fica
  visível.
- Alvos de toque com pelo menos 44px nas ações principais.
- Cabeçalho: título, filtros e ações não empurram o conteúdo para longe.

## 5. Estados

- Carregando: esqueleto com a forma da tela, sem pulo de layout quando os
  dados chegam; botões assíncronos mostram progresso.
- Vazio: explica o motivo e o próximo passo (com link).
- Erro: diz o que aconteceu e o que fazer; a tela não quebra inteira por
  causa de um card.

## 6. Acessibilidade

- Navegação por teclado: Tab alcança filtros, abas e ações; foco visível;
  Esc fecha popovers e modais.
- Botões só com ícone têm nome acessível (`aria-label` ou `title`).
- Gráficos têm alternativa em tabela ("Ver tabela").
- Contraste: se desconfiar, meça (`getComputedStyle`) ou rode
  `node scripts/check-contrast.mjs`.

## 7. Stack vista do navegador

- `read_console_messages` com `onlyErrors`: erros e avisos do React.
- `read_network_requests`: respostas 4xx/5xx, requisições duplicadas para o
  mesmo endpoint na mesma tela, cascatas (uma requisição esperando outra sem
  necessidade), respostas lentas.
- Tempo até o primeiro número útil na Visão geral.
- `npm run build`: avisos de chunk grande indicam o que pesa no primeiro
  carregamento.
- Dev (Fastify) e produção (Supabase Edge Functions) devem ter as mesmas
  rotas: uma tela que funciona local e falha publicada é achado de
  Stack (rota não redeployada).
