-- Kanban de tarefas: além de feita ('done') e encerrada ('skipped'), a ocorrência
-- pode estar em andamento ('doing') ou pausada ('paused'). "A fazer" e "Atrasada"
-- continuam sem linha aqui: saem da data.
alter table task_completions drop constraint if exists task_completions_status_check;
alter table task_completions add constraint task_completions_status_check
  check (status in ('done', 'skipped', 'doing', 'paused'));
