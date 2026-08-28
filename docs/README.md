# Documentação do projeto

Esta pasta segue Spec-Driven Development (SDD): a especificação de um
comportamento é escrita e revisada antes (ou junto) da implementação, e toda
decisão que fixa um caminho e descarta alternativas fica registrada, não só na
memória de quem escreveu o código.

Isto é **puramente aditivo** — nada em `server/src` ou `src` muda de lugar por
causa desta pasta. O objetivo é dar ao projeto uma estrutura que aguenta
crescer em número de features e de pessoas trabalhando nele, sem depender de
uma pessoa lembrar por que cada escolha foi feita.

## Estrutura

```
docs/
  README.md          este arquivo
  PRD.md              visão de produto, personas, requisitos, stack, roadmap
  architecture.md     como o sistema é montado: camadas, dados, padrões-chave
  decisions/          uma decisão por arquivo, numerada, nunca reescrita
    0001-*.md
  specs/              uma pasta por área de produto
    <area>/spec.md
```

## Como usar isto ao adicionar uma feature nova

1. **Escreva o spec primeiro.** Copie `specs/_template.md` para
   `specs/<area>/spec.md` (ou edite o existente, se a área já tem um) e
   preencha objetivo, histórias de usuário, modelo de dados, contrato de API e
   regras de negócio antes de escrever a primeira linha de código.
2. **Implemente contra o spec.** Se a implementação precisar desviar do que
   foi escrito, o spec é atualizado no mesmo PR — ele descreve o sistema como
   ele é, não como foi imaginado no dia 1.
3. **Toda decisão que caberia em uma segunda opinião vira um ADR.** Se você
   escolheu X em vez de Y e alguém plausivelmente perguntaria "por que não
   Y?", isso é uma decisão: crie `decisions/000N-titulo-curto.md` com o
   template abaixo. Decisões nunca são editadas depois de aceitas — uma
   mudança de rumo é um novo arquivo que referencia e supera o antigo, para
   que o histórico de "por que" nunca se perca.

### Template de decisão (ADR)

```markdown
# 000N. Título curto no imperativo

Status: aceita | supersedida por 000M

## Contexto
Qual problema ou tensão forçou uma escolha.

## Decisão
O que foi decidido, em uma frase.

## Alternativas consideradas
O que foi descartado e por quê.

## Consequências
O que isso trava para o futuro; o que fica mais fácil, o que fica mais difícil.
```

## Por que isso ajuda a escalar

- Um spec por área de produto significa que adicionar a décima feature não
  exige reler o código das outras nove para entender o contrato — o contrato
  está escrito.
- ADRs isolados (um arquivo, uma decisão) crescem por adição, nunca por
  edição — não existe "seção de decisões" que fica enorme e difícil de
  navegar conforme o projeto cresce.
- `architecture.md` documenta os padrões que se repetem entre áreas
  (derivação em vez de saldo guardado, materialização idempotente, sugestão
  nunca automática) para que a próxima feature os reconheça e reuse em vez de
  reinventar.
