-- Dedução no IRPF por categoria (decisions/0047, supabase/functions/_shared/core/irpf.ts).
-- Nulo = o app decide pelo nome da categoria; 'none' = não deduz.
create type irpf_group as enum ('health', 'education', 'pension', 'alimony', 'none');
alter table categories add column if not exists irpf_group irpf_group;
