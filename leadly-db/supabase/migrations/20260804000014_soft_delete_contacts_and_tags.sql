-- Soft-delete convention (see CLAUDE.md section 3): "eliminar" from the app
-- never runs a real DELETE on a business record -- it stamps deleted_at/
-- deleted_by instead, and listing queries filter deleted_at is null. Applies
-- here to the two tables that currently have a delete action in the UI:
-- crm_contacts (Clientes list) and conversation_tags (catalog in
-- Configuración). The DELETE RLS policies on both tables are left in place
-- as a backstop for direct SQL/support use, not exercised by app code.
alter table public.crm_contacts add column deleted_at timestamptz;
alter table public.crm_contacts add column deleted_by uuid references public.profiles(id) on delete set null;

-- The plain unique(tenant_id, phone) from the original migration would
-- otherwise permanently block re-creating a contact at the same phone once
-- one is soft-deleted (e.g. whatsapp-webhook's select-then-insert on a new
-- inbound message from that number) -- swap it for a partial unique index
-- that only applies to non-deleted rows.
alter table public.crm_contacts drop constraint crm_contacts_tenant_id_phone_key;
create unique index crm_contacts_tenant_id_phone_active_idx on public.crm_contacts(tenant_id, phone) where deleted_at is null;

alter table public.conversation_tags add column deleted_at timestamptz;
alter table public.conversation_tags add column deleted_by uuid references public.profiles(id) on delete set null;

-- Same reasoning as above: a deleted tag's name shouldn't block creating a
-- new tag with that same name.
alter table public.conversation_tags drop constraint conversation_tags_tenant_id_name_key;
create unique index conversation_tags_tenant_id_name_active_idx on public.conversation_tags(tenant_id, name) where deleted_at is null;
