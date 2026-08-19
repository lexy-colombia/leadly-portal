-- Cutover de Contactos + Órdenes (ver CLAUDE.md, ronda 2026-08-16). Antes de
-- migrar el frontend de Contactos a `contacts`, hace falta que esa tabla
-- quede sincronizada en vivo con `crm_contacts` -- que sigue siendo la
-- fuente de verdad para el webhook de WhatsApp, PQR (crm_pqrs.contact_id es
-- not null references crm_contacts, regla dura, nunca se toca), Aurora
-- (whatsapp-ai-tools: calendario/oportunidades/leads/hubspot/shopify) y
-- Oportunidades/Tareas/Calendario (ninguno migra en esta ronda).
--
-- Espejo bidireccional por trigger: cada insert/update en una tabla se
-- replica en la otra con el mismo `id`, usando el guard estándar de
-- Postgres para evitar loop infinito (pg_trigger_depth() > 1 corta la
-- propagación después de un solo salto). Así el webhook sigue escribiendo
-- en crm_contacts sin ningún cambio, y el frontend de Contactos puede
-- migrar a `contacts` sin romper nada que dependa de crm_contacts.

create or replace function public.mirror_contact_to_new()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.contacts (
    id, tenant_id, full_name, phone, email, company, stage, tags,
    assigned_to, hubspot_contact_id, deleted_at, deleted_by, created_at
  )
  values (
    new.id, new.tenant_id, new.full_name, new.phone, new.email, new.company, new.stage, new.tags,
    new.assigned_to, new.hubspot_contact_id, new.deleted_at, new.deleted_by, new.created_at
  )
  on conflict (id) do update set
    full_name = excluded.full_name,
    phone = excluded.phone,
    email = excluded.email,
    company = excluded.company,
    stage = excluded.stage,
    tags = excluded.tags,
    assigned_to = excluded.assigned_to,
    hubspot_contact_id = excluded.hubspot_contact_id,
    deleted_at = excluded.deleted_at,
    deleted_by = excluded.deleted_by;

  return new;
end;
$$;

create trigger trg_mirror_crm_contacts_to_contacts
  after insert or update on public.crm_contacts
  for each row execute function public.mirror_contact_to_new();

create or replace function public.mirror_contact_to_crm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.crm_contacts (
    id, tenant_id, full_name, phone, email, company, stage, tags,
    assigned_to, hubspot_contact_id, deleted_at, deleted_by, created_at
  )
  values (
    new.id, new.tenant_id, new.full_name, new.phone, new.email, new.company, new.stage, new.tags,
    new.assigned_to, new.hubspot_contact_id, new.deleted_at, new.deleted_by, new.created_at
  )
  on conflict (id) do update set
    full_name = excluded.full_name,
    phone = excluded.phone,
    email = excluded.email,
    company = excluded.company,
    stage = excluded.stage,
    tags = excluded.tags,
    assigned_to = excluded.assigned_to,
    hubspot_contact_id = excluded.hubspot_contact_id,
    deleted_at = excluded.deleted_at,
    deleted_by = excluded.deleted_by;

  return new;
end;
$$;

create trigger trg_mirror_contacts_to_crm_contacts
  after insert or update on public.contacts
  for each row execute function public.mirror_contact_to_crm();

-- Backfill único: contactos que ya existían en crm_contacts antes de que
-- este trigger existiera (incluye los que hoy tienen data de prueba en
-- crm_orders) arrancan el espejo sincronizados en vez de vacíos.
insert into public.contacts (
  id, tenant_id, full_name, phone, email, company, stage, tags,
  assigned_to, hubspot_contact_id, deleted_at, deleted_by, created_at
)
select
  id, tenant_id, full_name, phone, email, company, stage, tags,
  assigned_to, hubspot_contact_id, deleted_at, deleted_by, created_at
from public.crm_contacts
on conflict (id) do nothing;
