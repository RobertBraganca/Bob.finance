-- "Pausada": status intermediário para cotações paradas sem veredito
-- (nem aprovada, nem reprovada) — pedido do usuário em 10/09/2026 ao
-- reorganizar Precificação. Entra entre needs_changes e rejected na
-- ordem de exibição (services/pricing.ts, PricingCharts.tsx).
alter type "quote_status" add value if not exists 'paused' after 'needs_changes';
