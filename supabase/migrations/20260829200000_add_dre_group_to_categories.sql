-- DRE formal (specs/dre): classifica categorias-mãe em Dedução da
-- Receita / Custo do Serviço (CSP) / Resultado Financeiro / Imposto
-- sobre o Lucro. null continua sendo o padrão implícito (Receita Bruta
-- pra income, Despesa Operacional pra expense) — não precisa de um
-- valor explícito pros dois maiores baldes.
create type "dre_group" as enum ('deduction', 'cost', 'financial', 'tax');

alter table "categories" add column "dre_group" "dre_group";
