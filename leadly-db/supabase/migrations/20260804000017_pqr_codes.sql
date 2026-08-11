-- Human-readable case codes: a per-tenant sequential number on crm_pqrs
-- ("PQR-7") and a per-PQR sequential number on crm_pqr_updates ("seguimiento
-- #2 of PQR-7") -- lets a customer or agent reference a case by a short
-- number instead of a uuid. Assigned via trigger so both human-created and
-- AI-created rows (via whatsapp-ai-tools) get one automatically, with no
-- changes needed at any insert call site.
alter table public.crm_pqrs add column code integer;
alter table public.crm_pqr_updates add column seq integer;

-- Backfill any rows that existed before this migration (created_at order,
-- per tenant / per pqr) so the not-null constraint below doesn't fail.
with numbered as (
  select id, row_number() over (partition by tenant_id order by created_at) as rn
  from public.crm_pqrs
)
update public.crm_pqrs p set code = n.rn from numbered n where n.id = p.id;

with numbered as (
  select id, row_number() over (partition by pqr_id order by created_at) as rn
  from public.crm_pqr_updates
)
update public.crm_pqr_updates u set seq = n.rn from numbered n where n.id = u.id;

create or replace function public.set_crm_pqr_code()
returns trigger
language plpgsql
as $$
begin
  select coalesce(max(code), 0) + 1 into new.code from public.crm_pqrs where tenant_id = new.tenant_id;
  return new;
end;
$$;

create trigger trg_crm_pqrs_set_code before insert on public.crm_pqrs
  for each row execute function public.set_crm_pqr_code();

create or replace function public.set_crm_pqr_update_seq()
returns trigger
language plpgsql
as $$
begin
  select coalesce(max(seq), 0) + 1 into new.seq from public.crm_pqr_updates where pqr_id = new.pqr_id;
  return new;
end;
$$;

create trigger trg_crm_pqr_updates_set_seq before insert on public.crm_pqr_updates
  for each row execute function public.set_crm_pqr_update_seq();

alter table public.crm_pqrs alter column code set not null;
alter table public.crm_pqr_updates alter column seq set not null;

create unique index crm_pqrs_tenant_id_code_idx on public.crm_pqrs(tenant_id, code);
create unique index crm_pqr_updates_pqr_id_seq_idx on public.crm_pqr_updates(pqr_id, seq);
