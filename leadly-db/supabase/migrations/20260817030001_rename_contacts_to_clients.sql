-- Renombra `contacts` a `clients` -- pedido explícito del usuario
-- (2026-08-17): el nombre interno de la tabla debía reflejar la misma
-- decisión de copy ("Contactos" -> "Clientes") ya aplicada en la UI.
-- Postgres seguí las FKs por OID, no por nombre, así que las columnas
-- sales_orders.contact_id/opportunities.contact_id/tasks.contact_id que ya
-- apuntan a esta tabla no necesitan tocarse -- solo se renombra la tabla y
-- sus objetos internos (constraints/índices/policies/trigger) para que
-- todo quede consistente con el nombre nuevo.

alter table public.contacts rename to clients;

alter table public.clients rename constraint contacts_pkey to clients_pkey;
alter table public.clients rename constraint contacts_assigned_to_fkey to clients_assigned_to_fkey;
alter table public.clients rename constraint contacts_deleted_by_fkey to clients_deleted_by_fkey;
alter table public.clients rename constraint contacts_stage_check to clients_stage_check;
alter table public.clients rename constraint contacts_tenant_id_fkey to clients_tenant_id_fkey;

alter index public.contacts_tenant_id_idx rename to clients_tenant_id_idx;
alter index public.contacts_tenant_id_phone_active_idx rename to clients_tenant_id_phone_active_idx;

alter policy contacts_select on public.clients rename to clients_select;
alter policy contacts_insert on public.clients rename to clients_insert;
alter policy contacts_update on public.clients rename to clients_update;
alter policy contacts_delete on public.clients rename to clients_delete;

alter trigger contacts_set_updated_at on public.clients rename to clients_set_updated_at;
