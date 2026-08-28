# 0012. Motor de precificação de projeto reaproveita a Calculadora de Freelas

Status: aceita

## Contexto
O PRD (seção 5, `specs/motor-financeiro`) já calcula um ponto de equilíbrio
de faturamento mensal (custos PJ + pró-labore + impostos + investimento
planejado + reserva planejada + margem). Um relatório de avaliação anterior
apontou que esse número, dividido pela capacidade produtiva do usuário,
responde a uma pergunta que o produto ainda não responde: quanto cobrar por
um projeto específico.

O usuário mantém, num projeto irmão (`BOB.OS/calculadora-freelas`), um SaaS
completo de precificação para freelancers/estúdios (autenticação, planos,
CRM, contratos, Supabase) — fora de escopo para este app local-first de um
usuário só. Dentro dele, porém, o motor de cálculo em si
(`src/modules/pricing/lib/`) é uma peça de lógica pura, sem dependência de
banco de dados, auth ou UI, organizada em 3 camadas:

1. **Camada 1** (`layer1.ts`): valor-hora real = (despesas + pró-labore +
   reserva técnica + margem) ÷ horas faturáveis (horas disponíveis ×
   percentual de aproveitamento faturável, default 60%).
2. **Camada 2** (`layer2.ts`): preço base = horas estimadas × valor-hora +
   custos diretos do projeto (equipamento, terceiros, licenças).
3. **Camada 3** (`layer3.ts`, `multipliers.ts`, `gross-up.ts`): preço final
   = preço base × complexidade × urgência × porte do cliente × direitos de
   uso, com gross-up tributário (`preço ÷ (1 − alíquota)`, para que o
   imposto seja embutido no preço cobrado, não descontado do lucro) e
   margem extra opcional.

A Camada 1 desse motor é, quase termo a termo, o mesmo cálculo que
`services/financialEngine.ts` já faz para o ponto de equilíbrio mensal —
só falta dividir por horas. Reescrever esse numerador dentro de uma feature
nova violaria "uma fonte de verdade" (PRD seção 4): duas telas calculando
"quanto eu preciso faturar" de dois jeitos que podem divergir.

## Decisão
Um novo `specs/project-pricing/spec.md` adapta as camadas 2 e 3 do motor da
Calculadora de Freelas para este app, e a camada 1 é substituída por uma
leitura do endpoint que já existe:

> Hora base = `/motor-financeiro/ponto-equilibrio` (total) ÷ (horas
> disponíveis por mês × percentual de aproveitamento faturável).

Nenhum campo de custo, pró-labore, imposto ou margem mensal é duplicado —
`financialEngineSettings` continua sendo a única fonte desses parâmetros;
o novo spec só adiciona os dois parâmetros que faltam (capacidade: horas
disponíveis, percentual faturável) e um banco de multiplicadores editável
(complexidade, urgência, porte do cliente, direitos de uso), com os valores
da Calculadora de Freelas como default sugerido, não como constante fixa —
mesmo padrão já usado em `criteria` (banco de critérios do Diagrama do
Cerrado) e em `financialHealthSettings` (pesos e limites editáveis).

O gross-up tributário reaproveita `financialEngineSettings.taxRateBps` como
a mesma alíquota, em vez de introduzir uma segunda configuração de imposto
que poderia divergir da usada no ponto de equilíbrio.

Toda saída desta feature se classifica como Simulação (ADR 0010): o
usuário informa os parâmetros de um projeto hipotético e o sistema
calcula o preço que cobriria o custo configurado, nunca "quanto cobrar" como
fato objetivo. Nenhuma linguagem "aumente/diminua/cobre pelo menos" — só
o número e a memória de cálculo, no mesmo contrato `premissas` que toda
métrica derivada do produto já carrega.

## Alternativas consideradas
- **Importar o motor da Calculadora de Freelas como dependência de
  código:** descartada — os dois projetos têm stacks diferentes (Next.js
  + Supabase Postgres vs. Fastify + SQLite), e a lógica em si é pequena o
  suficiente (3 arquivos, ~300 linhas) para reescrever contra este schema
  sem ganho real de reuso de código, só de reuso de ideia.
- **Trazer também o benchmark de mercado (tabela ADEGRAF, RF09 do PRD da
  Calculadora de Freelas):** descartada por ora — exige curadoria
  contínua de dados de mercado, que este app não tem hoje nenhum mecanismo
  para manter atualizado. Registrado como fora de escopo no novo spec, não
  esquecido.
- **Manter a "premium" (recomendado × 1,3) do motor original como terceiro
  número de saída:** descartada — é uma constante de ancoragem comercial
  sem base de cálculo, o tipo de número que este produto evita expor sem
  memória de cálculo auditável (ADR 0010). O novo spec expõe só mínimo
  (piso técnico) e recomendado (pilha completa).

## Consequências
- Novo spec: `specs/project-pricing/spec.md`.
- Novas tabelas: `pricingSettings` (capacidade), `pricingMultiplierOptions`
  (banco editável por dimensão), `projectQuotes` (histórico de simulações).
  Nenhuma tabela nova duplica campo já existente em
  `financialEngineSettings`.
- `docs/PRD.md` seção 5 ganha uma linha nova para esta área.
- Quando `specs/client-projects` (proposta em aberto, ainda sem spec)
  existir, uma cotação aprovada poderá referenciar um projeto por id em vez
  de nome livre — não é um bloqueio para esta versão.
