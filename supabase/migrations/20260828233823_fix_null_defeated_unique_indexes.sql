-- Achado da revisão de acompanhamento de 28/08/2026: skipped_occurrences_uq
-- e target_alloc_uq têm o mesmo defeito que txn_forecast_occurrence_uq /
-- txn_debt_occurrence_uq tinham antes da migração 20260828163633 — um
-- índice único não parcial sobre coluna nullable, onde toda linha real tem
-- exatamente uma dessas colunas NULL por desenho. Postgres nunca considera
-- dois NULL iguais, então a constraint nunca disparava de verdade: dava
-- falsa confiança de que estava deduplicando, sem de fato bloquear nada.
-- Verificado antes de aplicar: zero linhas existentes violam qualquer uma
-- das quatro constraints novas abaixo.

drop index if exists skipped_occurrences_uq;

create unique index skipped_occurrences_forecast_uq on skipped_occurrences (forecast_id, period)
  where forecast_id is not null;

create unique index skipped_occurrences_debt_uq on skipped_occurrences (debt_id, period)
  where debt_id is not null;

drop index if exists target_alloc_uq;

create unique index target_alloc_goal_uq on target_allocations (goal_id, asset_class)
  where goal_id is not null;

create unique index target_alloc_global_uq on target_allocations (asset_class)
  where goal_id is null;
