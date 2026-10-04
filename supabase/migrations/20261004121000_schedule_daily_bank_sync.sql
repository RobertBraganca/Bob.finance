-- Sincronização diária do Open Finance (decisions/0039).
--
-- Todo dia às 07:00 de Brasília (10:00 UTC), depois da atualização diária
-- que a própria Pluggy faz nas conexões, o pg_cron chama a rota
-- /ledger/cron/bank-sync da Edge Function `ledger`, que sincroniza todas as
-- contas ligadas: o que não tem dúvida entra direto, o resto vai para a fila
-- de revisão.
--
-- Nenhum segredo neste arquivo. Os dois valores são lidos do Vault na hora
-- de cada execução, então este agendamento pode existir antes deles (a
-- chamada só falha, sem efeito nenhum, até eles serem criados):
--
--   select vault.create_secret('<valor de BANK_SYNC_CRON_SECRET>', 'bank_sync_cron_secret');
--   select vault.create_secret('<anon key do projeto>', 'bank_sync_anon_key');
--
-- O mesmo BANK_SYNC_CRON_SECRET precisa estar nos segredos das Edge
-- Functions (`supabase secrets set BANK_SYNC_CRON_SECRET=...`). A anon key
-- só atravessa o gateway das funções (verify_jwt); quem autoriza a rotina é
-- o segredo, conferido dentro da `ledger`.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Recria sem duplicar se a migração rodar de novo.
select cron.unschedule(jobid) from cron.job where jobname = 'bank-sync-daily';

select cron.schedule(
  'bank-sync-daily',
  '0 10 * * *',
  $$
  select net.http_post(
    url := 'https://ubgsgzlvugjbzyzbufel.supabase.co/functions/v1/ledger/cron/bank-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'bank_sync_anon_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bank_sync_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
