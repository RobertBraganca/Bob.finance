-- "Ignorar transação": o lançamento fica na lista, riscado, e sai de todos os
-- totais e saldos. Só acrescenta uma coluna com padrão falso.
alter table transactions add column if not exists ignored boolean not null default false;
