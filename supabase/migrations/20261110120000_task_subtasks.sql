-- Tarefa principal e subtarefas. Uma tarefa de tipo 'group' só junta outras:
-- não vence, não vira evento na agenda, e o progresso sai das subtarefas.
-- Um nível só (a principal não fica dentro de outra; o serviço garante).
-- Excluir a principal leva as subtarefas junto.
alter type task_kind add value if not exists 'group';

-- Recorrência semanal: due_day passa a ser o dia da semana, 1 (segunda) a 7
-- (domingo). Ex.: "revisar a agenda toda sexta".
alter type task_recurrence add value if not exists 'weekly';

alter table tasks add column if not exists parent_id bigint references tasks (id) on delete cascade;
create index if not exists tasks_parent_idx on tasks (parent_id) where parent_id is not null;
