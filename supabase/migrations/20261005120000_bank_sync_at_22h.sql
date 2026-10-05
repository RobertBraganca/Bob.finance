-- Rotina diária do Open Finance passa das 07:00 para as 22:00 de Brasília
-- (01:00 UTC). A Pluggy atualiza cada conexão uma vez por dia entre 17h e 21h
-- de Brasília (medido em 05/10/2026); às 22:00 o que ela trouxe no dia já entra
-- no mesmo dia, em vez de esperar a manhã seguinte.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'bank-sync-daily'),
  schedule := '0 1 * * *'
);
