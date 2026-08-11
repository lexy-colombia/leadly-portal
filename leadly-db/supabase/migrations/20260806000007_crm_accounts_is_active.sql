-- "Cliente activo" badge on the Empresa detail screen -- needs a real column,
-- not a fabricated always-true badge. Same default-true pattern as
-- ai_assistants.is_active.
alter table public.crm_accounts add column is_active boolean not null default true;
