# 0007. Nenhum travessão em texto voltado ao usuário

Status: aceita

## Contexto
Texto gerado ao longo do desenvolvimento usava travessão (—) como separador
de frase com frequência ("frase — continuação"). O usuário pediu
explicitamente a remoção, escolhendo escopo "em todo o app" quando
perguntado se deveria valer só para telas novas ou para tudo.

## Decisão
Nenhum travessão em string ou nó de texto JSX renderizado ao usuário —
título, subtítulo, placeholder, tooltip, texto de toast, nome de perfil de
importação. Cada ocorrência é reescrita com o que a frase pede: vírgula,
ponto e vírgula, dois-pontos, parênteses, conector ("e", "então") ou a frase
dividida em duas. Nunca um hífen simples como substituto genérico — cada
reescrita respeita a pontuação que a frase específica pede.

Comentário de código (`//`, `/* */`) fica de fora do escopo: não é texto que
o usuário vê. Log de servidor (`app.log.info`, stdout) também fica de fora
pelo mesmo motivo — é console de desenvolvimento, não tela do produto.

Um caractere de travessão usado como placeholder de "sem dado" numa célula
de tabela (`'—'` sozinho, sem ser parte de uma frase) foi trocado por hífen
simples (`'-'`) — mesmo símbolo genérico, tipograficamente diferente do
travessão.

## Alternativas consideradas
- **Escopo só para telas novas:** foi a recomendação inicial, rejeitada
  explicitamente pelo usuário em favor do escopo total.
- **Substituir travessão por hífen em toda frase:** rejeitado — troca um
  travessão por um hífen ainda seria um separador de pausa, só mais curto;
  a instrução era reescrever a frase, não trocar o caractere.

## Consequências
- Nomes de perfil de importação armazenados no banco (`parser_profiles.name`,
  ex. "Nubank — Conta") também precisaram ser renomeados em produção, não só
  no seed — uma migração de dado em `data/finance.db`, feita preservando o
  `id` de cada perfil para não invalidar `import_batches` existentes que
  referenciam esse id.
- Qualquer string nova voltada ao usuário deveria já nascer sem travessão —
  não é uma regra de lint automática, é uma convenção de revisão manual.
