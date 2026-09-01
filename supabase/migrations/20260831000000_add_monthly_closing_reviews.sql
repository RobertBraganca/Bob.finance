-- Checklist de fechamento mensal (estudo de viabilidade #7, 29/08/2026).
-- Todo item derivado (categorização, conciliação, Diário) é recomputado a
-- cada leitura, nunca guardado aqui. O único estado que não existe em
-- nenhum outro lugar do banco é "revisei a DRE deste mês" -- um julgamento
-- humano, não uma métrica -- e é o único que esta tabela guarda. Existência
-- de uma linha para o período = revisado; ausência = não revisado.
create table monthly_closing_reviews (
  id bigint generated always as identity primary key,
  period text not null,
  reviewed_at text not null default now_iso()
);
create unique index monthly_closing_reviews_period_uq on monthly_closing_reviews (period);

alter table monthly_closing_reviews enable row level security;
