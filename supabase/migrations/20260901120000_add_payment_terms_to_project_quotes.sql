-- Condições de pagamento na cotação (pedido do usuário, 01/09/2026):
-- "condições parceladas não aparecem atualmente no sistema".
--
-- Ficam ao lado de `client_label` na categoria de campo COMERCIAL, não de
-- insumo de cálculo: mudar o parcelamento não altera hora base, mínimo,
-- recomendado nem premium, então continua editável mesmo depois da
-- aprovação (ao contrário de horas/custos/multiplicadores, que o
-- `decisions/0021` trava quando a cotação já virou lançamento no ledger).
alter table project_quotes add column installments integer not null default 1;
alter table project_quotes add column payment_terms text;
