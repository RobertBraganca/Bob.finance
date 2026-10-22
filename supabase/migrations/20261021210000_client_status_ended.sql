-- Situação "Contrato encerrado" do cliente (docs/specs/clientes-e-negocios): o
-- histórico e o LTV ficam, mas ele sai dos ativos, dos recorrentes e do MRR.
alter type client_status add value if not exists 'ended' before 'archived';
